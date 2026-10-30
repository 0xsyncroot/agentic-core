import assert from "node:assert/strict";
import { test } from "node:test";
import { createEchoToolPlugin } from "@0xsyncroot/adapter-echo";
import type { SessionEvent, ToolDefinition, ToolExecutionPolicy, TurnControlPolicy } from "@0xsyncroot/contracts";
import { DefaultAgentLoop, PermissionToolExecutionPolicy } from "@0xsyncroot/core";
import { InMemorySessionStore } from "@0xsyncroot/persistence-memory";
import { createSystemPromptPlugin } from "@0xsyncroot/plugins-base";
import { PLAN_TOOL_ID, activeHost, answer, calls, planningPlugin, scriptedModel, security, toolPlugin, writeTool } from "./turn-harness.js";

/**
 * The plan closes from the evidence at an answer (`closeForOutcome`): every open step a settled, non-failed call attributed to
 * it shows done becomes completed, status only, in the terminal `work/plan-updated` row; on a completed answer so does every
 * open step no call was attributed to (reading what was in hand, writing the answer), while a step with a call that did not go
 * through keeps its status; a partial answer or a pause closes no step without a call. Before the review, only the steps the model left behind close
 * (`closeDone`); the step in progress is judged as the model left it. The model is asked for no reply that only marks steps.
 */
const ECHO = "agentic_echo";
const plan = (id: string, steps: readonly { id: string; status: string; outcome?: string }[]) =>
  ({ id, name: PLAN_TOOL_ID, args: { goal: "g", steps: steps.map((step) => ({ description: step.id.toUpperCase(), ...step })) } });
const echo = (id: string) => ({ id, name: ECHO, args: { value: id } });
/** The plan as the turn left it: the last row the runtime's close wrote. */
const terminal = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "work/plan-updated")
  .map((event) => event.payload as { cause?: string; state?: string; steps?: { id: string; status: string; outcome?: string }[] })
  .filter((payload) => payload.cause === "terminal").at(-1);
const statuses = (row: ReturnType<typeof terminal>) => Object.fromEntries((row?.steps ?? []).map((step) => [step.id, step.status]));

/** Writes run without a card, the way a product allows them. */
const allowAll: ToolExecutionPolicy = (() => {
  const baseline = new PermissionToolExecutionPolicy();
  return { discover: (tools, context) => baseline.discover(tools, context), authorize: async (input) => ({ ...(await baseline.authorize(input)), outcome: "allow", reason: "test" }) };
})();

async function run(sessionId: string, replies: Parameters<typeof scriptedModel>[0], extra: {
  readonly tools?: readonly ToolDefinition[]; readonly policy?: TurnControlPolicy; readonly allowWrites?: boolean;
} = {}) {
  const { adapter } = scriptedModel(replies);
  const { host, router } = await activeHost(adapter, [
    createSystemPromptPlugin(), createEchoToolPlugin(), planningPlugin(), ...(extra.tools ? [toolPlugin("extra", extra.tools)] : []),
  ]);
  try {
    return await new DefaultAgentLoop(router, new InMemorySessionStore(), {}, {
      ...(extra.policy ? { turnControlPolicy: extra.policy } : {}), ...(extra.allowWrites ? { toolExecutionPolicy: allowAll } : {}),
    })
      .runTurn({ sessionId, content: "work", security: security() });
  } finally { await host.shutdown(); }
}

test("a completed answer closes every open step a call shows done, and with it every open step no call was attributed to", async () => {
  const result = await run("close-done", [
    calls([plan("p1", [{ id: "a", status: "in_progress" }, { id: "b", status: "pending" }, { id: "c", status: "pending" }, { id: "d", status: "pending" }]), echo("e1")]),
    calls([plan("p2", [{ id: "a", status: "completed", outcome: "A read" }, { id: "b", status: "in_progress", outcome: "Reading B" }, { id: "c", status: "pending" }, { id: "d", status: "pending" }]), echo("e2")]),
    answer("Xong."),
  ]);
  assert.equal(result.outcome, "completed");
  const row = terminal(result.events);
  assert.deepEqual(statuses(row), { a: "completed", b: "completed", c: "completed", d: "completed" }, "b had a result; c and d had no call: the answer is their work");
  assert.equal(row?.steps?.find((step) => step.id === "b")?.outcome, undefined, "an in-progress outcome says what it starts, never a result");
  assert.equal(row?.steps?.find((step) => step.id === "a")?.outcome, "A read", "the model's own result line stays");
  assert.equal(row?.state, "completed", "no step is left open");
});

test("a step whose latest write failed is not closed by the answer", async () => {
  const failing: ToolDefinition = { ...writeTool(), id: "test_write_fails", requiredPermissions: [], execute: async () => { throw new Error("rejected"); } };
  const result = await run("close-failed-write", [
    calls([plan("p1", [{ id: "a", status: "in_progress" }, { id: "b", status: "pending" }]), echo("e1"), { id: "w1", name: "test_write_fails", args: { value: "x" } }]),
    answer("Chưa ghi được."),
  ], { tools: [failing], allowWrites: true });
  assert.equal(result.outcome, "completed");
  const write = result.events.find((event) => event.type === "tool/result" && (event.payload as { callId?: string }).callId === "w1");
  assert.equal((write?.payload as { state?: string } | undefined)?.state, "failed", "the write ran and failed");
  const row = terminal(result.events);
  assert.deepEqual(statuses(row), { a: "in_progress", b: "completed" }, "a's read succeeded but the write after it failed; b had no call");
  assert.equal(row?.state, "active", "the step whose write failed keeps the plan open");

  const alone = await run("close-failed-write-last", [
    calls([plan("p1", [{ id: "a", status: "in_progress" }]), { id: "w1", name: "test_write_fails", args: { value: "x" } }]),
    answer("Chưa ghi được."),
  ], { tools: [failing], allowWrites: true });
  assert.equal(terminal(alone.events), undefined, "the last step's write failed: nothing pending behind it does not close it");
});

test("a partial answer closes the steps a call shows done and stops the plan; a pause for the user closes none", async () => {
  const policy: TurnControlPolicy = {
    id: "test.partial", revision: "v1", beforeModelStep: async () => ({}),
    reviewTerminal: async () => ({ decision: "accept", outcome: "partial", reason: "blocked-upstream" }),
  };
  const partial = await run("close-partial", [
    calls([plan("p1", [{ id: "a", status: "in_progress" }, { id: "b", status: "pending" }]), echo("e1")]),
    answer("Một phần."),
  ], { policy });
  assert.equal(partial.outcome, "partial");
  const stopped = terminal(partial.events);
  assert.deepEqual(statuses(stopped), { a: "completed", b: "pending" }, "only the step with a result closes");
  assert.equal(stopped?.state, "stopped");

  const paused = await run("close-paused", [
    calls([plan("p1", [{ id: "a", status: "in_progress" }, { id: "b", status: "pending" }]), echo("e1"), { id: "w1", name: "test_write", args: { value: "x" } }]),
  ], { tools: [writeTool()] });
  assert.ok(paused.approval, "the write waits for its card");
  const waiting = terminal(paused.events);
  assert.deepEqual(statuses(waiting), { a: "in_progress", b: "pending" }, "the user has not answered yet: nothing is closed");
  assert.equal(waiting?.state, "awaiting_user");
});

test("the answer closes the step in progress with no call, and a pending step behind it with no call", async () => {
  const result = await run("close-last-is-answer", [
    calls([plan("p1", [{ id: "read", status: "completed", outcome: "Read" }, { id: "report", status: "in_progress" }])]),
    answer("Kết quả: …"),
  ]);
  const row = terminal(result.events);
  assert.deepEqual(statuses(row), { read: "completed", report: "completed" }, "the answer is the last step's work");
  assert.equal(row?.state, "completed");

  const behind = await run("close-last-has-pending", [
    calls([plan("p1", [{ id: "read", status: "in_progress" }, { id: "report", status: "pending" }]), echo("e1")]),
    answer("Kết quả: …"),
  ]);
  const left = terminal(behind.events);
  assert.deepEqual(statuses(left), { read: "completed", report: "completed" }, "the report step had no call: the answer accepted as completed is its work");
  assert.equal(left?.state, "completed");
});

test("the review reads the plan after the evidence close: a step left behind that a call shows done is completed; the step in progress is not", async () => {
  const seen: Record<string, string>[] = [];
  const policy: TurnControlPolicy = {
    id: "test.open-steps", revision: "v1", beforeModelStep: async () => ({}),
    reviewTerminal: async (state) => {
      const shown = Object.fromEntries((state.workPlan?.steps ?? []).map((step) => [step.id, step.status]));
      seen.push(shown);
      return Object.values(shown).some((status) => status === "pending")
        ? { decision: "continue", feedback: "A step of the plan is still open.", fallback: "Not done.", workRemains: true }
        : { decision: "accept" };
    },
  };
  const result = await run("close-before-review", [
    calls([plan("p1", [{ id: "a", status: "in_progress" }, { id: "b", status: "pending" }]), echo("e1")]),
    calls([plan("p2", [{ id: "a", status: "pending" }, { id: "b", status: "in_progress" }]), echo("e2")]),
    answer("Xong."),
  ], { policy });
  assert.deepEqual(seen, [{ a: "completed", b: "in_progress" }], "one review, on the closed plan: no objection, no second lap");
  assert.equal(result.outcome, "completed");
  assert.deepEqual(statuses(terminal(result.events)), { a: "completed", b: "completed" }, "the accepted answer closes the step in progress");
  const evidenceRow = result.events.find((event) => event.type === "work/plan-updated" && (event.payload as { cause?: string }).cause === "terminal");
  const answerRow = result.events.find((event) => event.type === "turn/control-decision");
  assert.ok(evidenceRow && answerRow && evidenceRow.seq < answerRow.seq, "the close is journaled before the review's decision");
});

test("only the task's own plan closes: a later task's answer leaves an earlier task's open plan as it was", async () => {
  const failing: ToolDefinition = { ...writeTool(), id: "test_write_fails", requiredPermissions: [], execute: async () => { throw new Error("rejected"); } };
  const { adapter } = scriptedModel([
    calls([plan("p1", [{ id: "a", status: "in_progress" }]), { id: "w1", name: "test_write_fails", args: { value: "x" } }]),
    answer("Chưa ghi được."), answer("Dạ."),
  ]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), planningPlugin(), toolPlugin("extra", [failing])]);
  try {
    const loop = new DefaultAgentLoop(router, new InMemorySessionStore(), {}, { toolExecutionPolicy: allowAll });
    const first = await loop.runTurn({ sessionId: "earlier-plan", content: "work", security: security() });
    const left = first.events.filter((event) => event.type === "work/plan-updated").at(-1)?.payload as Parameters<typeof statuses>[0];
    assert.deepEqual([statuses(left), left?.state], [{ a: "in_progress" }, "active"], "the failed write left the task's plan open");
    const next = await loop.runTurn({ sessionId: "earlier-plan", content: "thanks", security: security() });
    assert.equal(next.outcome, "completed");
    assert.equal(next.events.some((event) => event.type === "work/plan-updated"), false, "the next task neither closes nor restates it");
  } finally { await host.shutdown(); }
});
