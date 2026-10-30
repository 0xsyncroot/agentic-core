import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SessionEvent, ToolDefinition, ToolExecutionPolicy, TurnControlPolicy, TurnObservationRequest } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { createUserInputToolsPlugin } from "@0xsyncroot/plugins-base";
import { activeHost, answer, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/**
 * A policy's read marked best-effort (`TurnObservationRequest.bestEffort`) is a convenience: when it would pause, fails or
 * runs out of time, the model sees nothing of it, the turn goes on, and the journal says why.
 */
const read = (id: string, execute: ToolDefinition["execute"]): ToolDefinition => ({
  id, version: "1", description: id, requiredPermissions: [], sideEffect: "none", timeoutMs: 5_000,
  inputSchema: { type: "object" }, outputSchema: {}, execute,
});
const tools = [
  read("screen_ok", async () => ({ screen: "SCREEN-OK" }) as JsonValue),
  read("screen_paused", async () => ({ screen: "SCREEN-PAUSED" }) as JsonValue),
  read("screen_broken", async () => { throw new Error("tab closed"); }),
  read("screen_slow", () => new Promise<JsonValue>(() => undefined)),
];
const needsApproval: ToolExecutionPolicy = {
  discover: async (offered) => offered,
  authorize: async (input) => ({
    decisionId: "d", policyRevision: "p", actionDigest: `a-${input.tool.id}`, outcome: input.tool.id === "screen_paused" ? "require_approval" : "allow",
    reason: "test", ...(input.tool.id === "screen_paused" ? { approvalPresentation: { summary: "s", action: "a", target: "t", impact: "i" } } : {}),
  }),
};

async function run(observation: TurnObservationRequest, extra: Parameters<typeof activeHost>[1] = [], args: JsonValue = {}) {
  const policy: TurnControlPolicy = {
    id: "opening", revision: "v1",
    beforeModelStep: async (state) => state.stepIndex === 1 ? { observations: [{ ...observation, arguments: args }] } : {},
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const { adapter, requests } = scriptedModel([answer("Done.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("screens", tools), ...extra]);
  try {
    const started = Date.now();
    const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { turnControlPolicy: policy, toolExecutionPolicy: needsApproval })
      .runTurn({ sessionId: `best-effort-${observation.toolId}`, content: "open the sheet", security: security() });
    return { result, requests, elapsedMs: Date.now() - started };
  } finally { await host.shutdown(); }
}

const request = (toolId: string, bestEffort?: TurnObservationRequest["bestEffort"]): TurnObservationRequest =>
  ({ toolId, arguments: {}, reason: "the screen at the start", ...(bestEffort ? { bestEffort } : {}) });
const policyResults = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "tool/result" &&
  (event.payload as { initiator?: string }).initiator === "policy").map((event) => event.payload as Record<string, JsonValue>);
const shown = (requests: Awaited<ReturnType<typeof run>>["requests"]) => requests[0]!.messages.some((message) => message.context?.provenance === "policy-observation");

test("a best-effort read that succeeds reaches the first request like any policy read", async () => {
  const { result, requests } = await run(request("screen_ok", { timeoutMs: 1_000 }));
  assert.equal(result.outcome, "completed");
  assert.ok(requests[0]!.messages.some((message) => message.content?.includes("SCREEN-OK")));
  const [row] = policyResults(result.events);
  assert.deepEqual([row!.state, row!.bestEffort, row!.skipped ?? null], ["succeeded", true, null]);
});

test("a best-effort read that would need approval attaches nothing, asks nobody, and the turn goes on", async () => {
  const { result, requests } = await run(request("screen_paused", { timeoutMs: 1_000 }));
  assert.equal(result.outcome, "completed");
  assert.equal(shown(requests), false);
  assert.ok(!requests[0]!.messages.some((message) => message.content?.includes("SCREEN-PAUSED")));
  assert.equal(result.events.some((event) => event.type === "approval/requested"), false);
  const [row] = policyResults(result.events);
  assert.deepEqual([row!.state, row!.dispatched, row!.skipped], ["not_started", false, "approval-required"]);
});

test("a best-effort read that asks the user for input attaches nothing, opens no question, and says interaction-required", async () => {
  const { result, requests } = await run(request("request_user_input", { timeoutMs: 1_000 }), [createUserInputToolsPlugin()],
    { message: "Which region?", fields: [{ id: "region", label: "Region", type: "select", required: true, choices: [{ value: "north", label: "North" }, { value: "south", label: "South" }] }] });
  assert.equal(result.outcome, "completed");
  assert.equal(shown(requests), false);
  assert.equal(result.events.some((event) => event.type === "interaction/requested" || event.type === "approval/requested"), false);
  const [row] = policyResults(result.events);
  assert.deepEqual([row!.state, row!.dispatched, row!.skipped], ["not_started", false, "interaction-required"]);
});

test("a best-effort read that fails attaches nothing and says why in the journal", async () => {
  const { result, requests } = await run(request("screen_broken", { timeoutMs: 1_000 }));
  assert.equal(result.outcome, "completed");
  assert.equal(shown(requests), false);
  assert.ok(!requests[0]!.messages.some((message) => message.content?.includes("tab closed")));
  const [row] = policyResults(result.events);
  assert.deepEqual([row!.state, row!.skipped], ["failed", "failed"]);
});

test("a best-effort read stops at its own bound, far below the tool's timeout, and attaches nothing", async () => {
  const { result, requests, elapsedMs } = await run(request("screen_slow", { timeoutMs: 60 }));
  assert.equal(result.outcome, "completed");
  assert.equal(shown(requests), false);
  assert.ok(elapsedMs < 2_000, `the turn waited ${elapsedMs} ms`);
  const [row] = policyResults(result.events);
  assert.equal(row!.skipped, "timeout");
});

test("a read that is not best-effort keeps its behaviour: a failure is shown to the model, an approval is still asked", async () => {
  const failed = await run(request("screen_broken"));
  assert.equal(shown(failed.requests), true);
  assert.equal(policyResults(failed.result.events)[0]!.bestEffort, undefined);
  const paused = await run(request("screen_paused"));
  assert.equal(paused.result.events.some((event) => event.type === "approval/requested"), true, "a required read that needs approval still asks, and its step fails");
});

test("a best-effort bound must be a positive whole number of milliseconds", async () => {
  for (const timeoutMs of [0, -5, 1.5]) {
    const refused = await run(request("screen_ok", { timeoutMs }));
    assert.equal(refused.result.events.some((event) => event.type === "tool/intent"), false, `timeoutMs ${timeoutMs} is refused before any call`);
  }
});
