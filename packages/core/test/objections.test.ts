import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SessionEvent, ToolDefinition, TurnControlPolicy } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { activeHost, answer, call, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/**
 * The turn's one objection count (`objectionsHeard`, turn-end.ts): every objection the runtime sends back, to an answer or
 * to a call, counts until the runtime brings new evidence itself. A policy's objection ends on its fallback at the third, the
 * work-remains gate's at the fourth. The model's own new results never reset the count
 * (docs/incidents/2026-10-11-core-reconciliation-laps.md), and neither does a different objection.
 * turn-end-replay.test.ts holds the recorded runs to the same rule.
 */
const read: ToolDefinition = {
  id: "test_read", version: "1", description: "read", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {}, execute: async (invocation) => ({ page: (invocation.arguments as { page?: number }).page ?? 0 }) as JsonValue,
};
const write: ToolDefinition = { ...read, id: "test_write", description: "write", sideEffect: "idempotent" };

const decisions = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "turn/control-decision")
  .map((event) => `${(event.payload as { phase: string }).phase}:${(event.payload as { decision: string }).decision}`);

async function run(policy: TurnControlPolicy, replies: Parameters<typeof scriptedModel>[0], sessionId: string, maxSteps = 48) {
  const { adapter, requests } = scriptedModel(replies);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read, write])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps }, { turnControlPolicy: policy })
      .runTurn({ sessionId, content: "reconcile the sheets", security: security() });
    return { result, requests };
  } finally { await host.shutdown(); }
}

test("the model's new reads between answers do not reset the objections: two are sent back, the third ends on the fallback", async () => {
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1", beforeModelStep: async () => ({}),
    reviewTerminal: async () => ({ decision: "continue", feedback: "The totals do not match.", fallback: "The totals are not reconciled yet." }),
  };
  const { result, requests } = await run(policy, [answer("Totals A."), call("r1", "test_read", { page: 1 }), answer("Totals B."),
    call("r2", "test_read", { page: 2 }), answer("Totals C.")], "reads-do-not-reset");
  assert.equal(requests.length, 5, "every lap read something new, and still the third objection ended the turn");
  assert.equal(result.outcome, "partial");
  assert.equal(result.content, "The totals are not reconciled yet.");
  assert.deepEqual(decisions(result.events), ["terminal:continue", "terminal:continue", "terminal:fallback"]);
  const guided = (index: number) => requests[index]!.messages.some((message) => /sent back again[\s\S]*not reconciled yet/u.test(message.content ?? ""));
  assert.deepEqual([1, 2, 3].map(guided), [false, false, true], "the way out is offered with the second objection");
});

test("different objections count together: the third ends the turn, whatever each one says", async () => {
  let reviews = 0;
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1", beforeModelStep: async () => ({}),
    reviewTerminal: async () => ({ decision: "continue", feedback: `Check number ${reviews += 1} failed.`, fallback: "Not verified." }),
  };
  const { result, requests } = await run(policy, [answer("Done.")], "different-objections", 12);
  assert.equal(requests.length, 3, "was the step ceiling: no two objections had the same words");
  assert.equal(result.content, "Not verified.");
});

test("an objection to a call counts with the objections to answers, under the same reset", async () => {
  const objection = { decision: "continue" as const, feedback: "Read every page before writing.", fallback: "Nothing was written.", workRemains: true };
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1", beforeModelStep: async () => ({}),
    reviewToolCalls: async ({ toolCalls }) => toolCalls.some((entry) => entry.name === "test_write") ? objection : { decision: "accept" },
    reviewTerminal: async () => objection,
  };
  const { result, requests } = await run(policy, [call("w1", "test_write", { page: 9 }), call("r1", "test_read", { page: 1 }), answer("Draft A."),
    call("r2", "test_read", { page: 2 }), answer("Draft B."), call("r3", "test_read", { page: 3 }), answer("Draft C."), answer("Closing.")], "call-and-answers");
  assert.deepEqual(decisions(result.events), ["tool-call:continue", "terminal:continue", "terminal:continue", "terminal:close", "terminal:accept"]);
  assert.equal(requests.length, 8, "the refused write, three reads, three drafts, then the closing step");
  assert.equal(requests.at(-1)!.tools.length, 0);
  assert.equal(result.content, "Closing.\n\nNothing was written.");
});

test("a read the policy makes itself is the runtime's evidence: it resets the count", async () => {
  // The policy reads the next page itself on the third step only; that read brings a new result, so the objections start over.
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1",
    beforeModelStep: async (state) => state.stepIndex === 3 ? { observations: [{ toolId: "test_read", arguments: { page: 3 }, reason: "next page" }] } : {},
    reviewTerminal: async () => ({ decision: "continue", feedback: "Two sheets are unread.", fallback: "Two sheets are still unread.", workRemains: true }),
  };
  const { result, requests } = await run(policy, [answer("One."), answer("Two."), answer("Three."), answer("Four."), answer("Five."), answer("Six."), answer("Closing.")], "runtime-evidence");
  assert.deepEqual(decisions(result.events).filter((decision) => decision === "terminal:continue").length, 5, "two before the read, three after it");
  assert.equal(requests.length, 7);
  assert.equal(result.content, "Closing.\n\nTwo sheets are still unread.");
});

test("a read the policy makes that brings nothing new is no evidence: the count goes on", async () => {
  // The model read page 1 itself; the policy reads the same page on the third step, and that result is a repeat.
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1",
    beforeModelStep: async (state) => state.stepIndex === 3 ? { observations: [{ toolId: "test_read", arguments: { page: 1 }, reason: "page 1 again" }] } : {},
    reviewTerminal: async () => ({ decision: "continue", feedback: "The totals do not match.", fallback: "The totals are not reconciled yet." }),
  };
  const { result, requests } = await run(policy, [call("r1", "test_read", { page: 1 }), answer("Totals A."), answer("Totals B."), answer("Totals C."), answer("Totals D.")], "repeated-policy-read");
  const policyRead = result.events.find((event) => event.type === "tool/result" && (event.payload as { initiator?: string }).initiator === "policy");
  assert.equal((policyRead?.payload as { informationGain?: string } | undefined)?.informationGain, "repeated", "the policy's read ran and repeated the model's");
  assert.deepEqual(decisions(result.events).filter((decision) => decision.startsWith("terminal:")), ["terminal:continue", "terminal:continue", "terminal:fallback"],
    "was a reset and two more laps");
  assert.equal(requests.length, 4);
});

test("the same answer after a new result is weighed again, not closed as unchanged", async () => {
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1", beforeModelStep: async () => ({}),
    reviewTerminal: async () => ({ decision: "continue", feedback: "Work remains.", fallback: "Not done.", workRemains: true }),
  };
  const { result } = await run(policy, [answer("Same."), call("r1", "test_read", { page: 1 }), answer("Same."), answer("Same."), answer("Closing.")], "same-after-read");
  assert.deepEqual(decisions(result.events), ["terminal:continue", "terminal:continue", "terminal:close", "terminal:accept"],
    "the read between the first two answers lets the second one stand as an answer; the third repeats it with nothing new");
});

test("the same answer after a work call that failed is weighed again once: the model acted on the objection", async () => {
  const failing: ToolDefinition = { ...read, id: "test_calc", description: "calc", execute: async () => { throw new Error("cannot read property 'rows' of undefined"); } };
  const { adapter } = scriptedModel([answer("Same."), call("c1", "test_calc", {}), answer("Same."), answer("Same."), answer("Closing.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read, failing])]);
  try {
    const policy: TurnControlPolicy = {
      id: "p", revision: "v1", beforeModelStep: async () => ({}),
      reviewTerminal: async () => ({ decision: "continue", feedback: "Work remains.", fallback: "Not done.", workRemains: true }),
    };
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48 }, { turnControlPolicy: policy })
      .runTurn({ sessionId: "same-after-failed-call", content: "reconcile the sheets", security: security() });
    const calc = result.events.find((event) => event.type === "tool/result" && (event.payload as { toolId?: string }).toolId === "test_calc");
    assert.equal((calc?.payload as { state?: string } | undefined)?.state, "failed", "the call reached its tool and failed");
    assert.deepEqual(decisions(result.events), ["terminal:continue", "terminal:continue", "terminal:close", "terminal:accept"],
      "was closed at the second answer: the failed call now lets it stand as an answer; the third repeats it with nothing new");
  } finally { await host.shutdown(); }
});
