import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SessionEvent, ToolDefinition, TurnControlPolicy, WorkPlanStep } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { createWorkPlanningPlugin } from "@0xsyncroot/plugins-base";
import { activeHost, answer, call, calls, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/**
 * A policy's best-effort read is the runtime's, not work done under the plan step in progress: it is never stamped with that
 * step and never counts as the evidence that completes it when the turn ends. One the model was not shown leaves no
 * fingerprint either, so the model's own identical read is new information, not a repeat.
 */
const payloadOf = (event: SessionEvent) => event.payload as Record<string, unknown>;
const screen = (reply: () => JsonValue): ToolDefinition => ({
  id: "probe_screen", version: "1.0.0", description: "screen", inputSchema: { type: "object" }, outputSchema: {}, requiredPermissions: [],
  sideEffect: "none", timeoutMs: 5_000, execute: async () => reply(),
});
const PLAN = { goal: "g", steps: [{ id: "a", description: "A", status: "in_progress" }, { id: "b", description: "B", status: "pending" }] };

async function run(read: boolean, reply: () => JsonValue, replies: Parameters<typeof scriptedModel>[0]) {
  const policy: TurnControlPolicy = {
    id: "probe", revision: "v1",
    beforeModelStep: async (state) => read && state.stepIndex === 2
      ? { observations: [{ toolId: "probe_screen", arguments: {}, reason: "screen", bestEffort: { timeoutMs: 500 } }] } : {},
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const { adapter, requests } = scriptedModel(replies);
  const { host, router } = await activeHost(adapter, [toolPlugin("s", [screen(reply)]), createWorkPlanningPlugin()]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 12 }, { turnControlPolicy: policy })
      .runTurn({ sessionId: `best-effort-credit-${Math.random()}`, content: "làm A rồi B", security: security() });
    const steps = (result.events.filter((event) => event.type === "work/plan-updated").map(payloadOf).at(-1)!.steps as WorkPlanStep[])
      .map((step) => [step.id, step.status]);
    const results = result.events.filter((event) => event.type === "tool/result" && payloadOf(event).toolId === "probe_screen").map(payloadOf);
    return { result, requests, steps, results };
  } finally { await host.shutdown(); }
}

for (const [name, reply] of [
  ["a soft-failed", () => ({ status: "unavailable", message: "tab closed" }) as JsonValue],
  ["a succeeded", () => ({ screen: "payroll.sheet" }) as JsonValue],
] as const) {
  test(`${name} best-effort read under a step in progress leaves that step as the turn without it leaves it`, async () => {
    const replies = [calls([{ id: "plan", name: "plan_update", args: PLAN }]), answer("Đây là câu trả lời."), answer("Đây là câu trả lời.")];
    const without = await run(false, reply, replies);
    const withRead = await run(true, reply, replies);
    // A completed answer closes the steps no call was attributed to, so the read must not show up as one of them.
    assert.deepEqual(without.steps, [["a", "completed"], ["b", "completed"]]);
    assert.deepEqual(withRead.steps, without.steps, "the read credits no step");
    const attributed = withRead.result.events.filter((event) => event.type === "work/step-progress")
      .flatMap((event) => (payloadOf(event).subGoals as { calls: unknown[] }[]).flatMap((subGoal) => subGoal.calls));
    assert.deepEqual(attributed, [], "no step progress record carries the read");
    assert.equal(withRead.results.length, 1);
    assert.equal(withRead.results[0]!.initiator, "policy");
    assert.equal("workStepId" in withRead.results[0]!, false, "the read is not stamped with the step in progress");
  });
}

test("the model's own read after a skipped best-effort read of the same result is new information, not a repeat", async () => {
  const { results } = await run(true, () => ({ status: "unavailable", message: "tab closed" }) as JsonValue, [
    calls([{ id: "plan", name: "plan_update", args: PLAN }]),
    call("own", "probe_screen", {}),
    answer("Màn hình chưa mở được."),
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.skipped, "failed");
  assert.equal(results[1]!.initiator, undefined);
  assert.equal(results[1]!.informationGain, "new");
});
