import assert from "node:assert/strict";
import test from "node:test";
import { assertValidCoreEventDraft, type JsonValue, type SessionEvent, type ToolDefinition, type ToolExecutionPolicy } from "@0xsyncroot/contracts";
import { DefaultAgentLoop, PermissionToolExecutionPolicy } from "@0xsyncroot/core";
import { SubGoalLedger } from "../src/agent/sub-goal-ledger.js";
import type { ToolBatchContext } from "../src/agent/tool-call-drafts.js";
import { activeHost, answer, calls, planningPlugin, PLAN_TOOL_ID, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/**
 * The sub-goal ledger keeps, per step of the work plan, what the model claims beside what the results attributed to the step
 * show. It is journaled after each model step as `work/step-progress`, ids, statuses and flags only, and decides nothing.
 */
const executed: string[] = [];
const click: ToolDefinition = {
  id: "test_click", version: "1", description: "click", requiredPermissions: [], sideEffect: "idempotent", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {},
  execute: async (invocation) => {
    const label = (invocation.arguments as { label?: string }).label ?? "";
    executed.push(`click ${label}`);
    return label === "Open detail" ? { status: "rejected", reasonCode: "label-mismatch" } : { status: "succeeded", screen: label };
  },
};
const read: ToolDefinition = {
  id: "test_read", version: "1", description: "read", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {},
  execute: async (invocation) => {
    const page = (invocation.arguments as { page?: number }).page ?? 0;
    executed.push(`read ${page}`);
    if (page === 0) throw new Error("page 0 does not exist");
    return { page } as JsonValue;
  },
};
/** Clicks run without a card, the way a product allows screen actions. */
const policy: ToolExecutionPolicy = (() => {
  const baseline = new PermissionToolExecutionPolicy();
  return {
    discover: (tools, context) => baseline.discover(tools, context),
    authorize: async (input) => ({ ...(await baseline.authorize(input)), outcome: "allow", reason: "test" }),
  };
})();
let plans = 0;
const plan = (steps: readonly (readonly [string, string])[]) => ({ id: `p${plans += 1}`, name: PLAN_TOOL_ID,
  args: { goal: "Open the sheet", steps: steps.map(([id, status]) => ({ id, description: `Step ${id}`, status })) } });

async function run(script: Parameters<typeof scriptedModel>[0], sessionId: string, planning = true) {
  executed.length = 0;
  const { adapter, requests } = scriptedModel(script);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [click, read]), ...(planning ? [planningPlugin()] : [])]);
  const store = new SpyStore();
  try {
    const result = await new DefaultAgentLoop(router, store, {}, { toolExecutionPolicy: policy })
      .runTurn({ sessionId, content: "mở bảng", security: security() });
    return { result, requests, events: await store.inner.load(sessionId, security()) };
  } finally { await host.shutdown(); }
}

type Progress = { readonly planId: string; readonly revision: number; readonly subGoals: readonly {
  readonly id: string; readonly claimed: string; readonly shown: boolean; readonly wrote: boolean;
  readonly calls: readonly { readonly callId: string; readonly toolId: string; readonly state: string; readonly sideEffect: string; readonly failed?: true; readonly halted?: true }[] }[] };
const progressOf = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "work/step-progress");
/** Each sub-goal as [id, claimed, shown, wrote, its calls as "callId tool state [failed]"]. */
const summary = (payload: JsonValue) => (payload as unknown as Progress).subGoals.map((goal) => [goal.id, goal.claimed, goal.shown, goal.wrote,
  goal.calls.map((entry) => [entry.callId, entry.toolId, entry.state, ...(entry.failed ? ["failed"] : []), ...(entry.halted ? ["halted"] : [])].join(" "))]);

test("each model step journals every sub-goal, claimed beside shown, from the results attributed to it", async () => {
  const { result, events } = await run([
    calls([plan([["s1", "in_progress"], ["s2", "pending"], ["s3", "pending"]]), { id: "r0", name: "test_read", args: { page: 0 } }]),
    calls([plan([["s1", "completed"], ["s2", "in_progress"], ["s3", "pending"]]), { id: "c1", name: "test_click", args: { label: "Open detail" } },
      { id: "c2", name: "test_click", args: { label: "row 2" } }]),
    calls([{ id: "c3", name: "test_click", args: { label: "icon-eye" } }]),
    calls([plan([["s1", "completed"], ["s2", "completed"], ["s3", "completed"]])]),
    answer("Đã mở bảng."),
  ], "ledger-steps");
  assert.equal(result.outcome, "completed");
  const progress = progressOf(events);
  assert.equal(progress.length, 4, "one record per model step that ran calls under the plan");
  assert.deepEqual(progress.map((event) => summary(event.payload)), [
    [["s1", "in_progress", false, false, ["r0 test_read failed failed"]], ["s2", "pending", false, false, []], ["s3", "pending", false, false, []]],
    // The refusal counts toward s2, the step the update moves into progress, and holds the update completing s1 back: s1 stays
    // in progress. The click stopped behind the refusal never ran, so it is no call of any step.
    [["s1", "in_progress", false, false, []], ["s2", "pending", false, false, ["c1 test_click succeeded failed"]], ["s3", "pending", false, false, []]],
    [["s1", "in_progress", true, true, ["c3 test_click succeeded"]], ["s2", "pending", false, false, []], ["s3", "pending", false, false, []]],
    // s3 had no call: shown as the plan's close rule completes a step, once nothing is left pending; s2's one call failed.
    [["s1", "completed", true, true, []], ["s2", "completed", false, false, []], ["s3", "completed", true, false, []]],
  ]);
  const stepOfCall = (callId: string) => events.find((event) => event.type === "tool/result" && event.callId === callId)!.stepId;
  assert.deepEqual(progress.slice(0, 3).map((event) => event.stepId), [stepOfCall("r0"), stepOfCall("c1"), stepOfCall("c3")], "journaled in the step it records");
  assert.deepEqual(executed, ["read 0", "click Open detail", "click icon-eye"]);
});

test("the record holds ids, statuses and flags only, and the journal refuses one that carries text", async () => {
  const { events } = await run([
    calls([plan([["s1", "in_progress"]]), { id: "c1", name: "test_click", args: { label: "row 2" } }]), answer("Đã mở."),
  ], "ledger-shape");
  const [record] = progressOf(events);
  const payload = record!.payload as unknown as Progress;
  assert.deepEqual(Object.keys(payload).sort(), ["planId", "revision", "subGoals"]);
  assert.deepEqual(Object.keys(payload.subGoals[0]!).sort(), ["calls", "claimed", "id", "shown", "wrote"]);
  assert.deepEqual(payload.subGoals[0]!.calls, [{ callId: "c1", toolId: "test_click", state: "succeeded", sideEffect: "idempotent" }]);
  assert.equal(JSON.stringify(payload).includes("Step s1"), false, "no description");
  assert.equal(JSON.stringify(payload).includes("Open the sheet"), false, "no goal");
  const draft = { type: "work/step-progress", turnId: record!.turnId!, stepId: record!.stepId! };
  assert.doesNotThrow(() => assertValidCoreEventDraft({ ...draft, payload: record!.payload }));
  const withText = { ...payload, subGoals: [{ ...payload.subGoals[0]!, outcome: "Đã mở bảng lương" }] } as unknown as JsonValue;
  assert.throws(() => assertValidCoreEventDraft({ ...draft, payload: withText }), /ids, statuses and flags only/u);
  assert.throws(() => assertValidCoreEventDraft({ ...draft, payload: { ...payload, goal: "Open the sheet" } as unknown as JsonValue }), /ids, statuses and flags only/u);
});

test("a call named outside the tool-id grammar is recorded under a fixed token, and the journal refuses a tool id that is text", async () => {
  const { events } = await run([
    calls([plan([["s1", "in_progress"]]), { id: "c1", name: "Open the sheet now!", args: {} }]), answer("Xong."),
  ], "ledger-unrecognized");
  const [record] = progressOf(events);
  const payload = record!.payload as unknown as Progress;
  assert.deepEqual(payload.subGoals[0]!.calls.map((entry) => entry.toolId), ["unrecognized"]);
  const draft = { type: "work/step-progress", turnId: record!.turnId!, stepId: record!.stepId! };
  assert.doesNotThrow(() => assertValidCoreEventDraft({ ...draft, payload: record!.payload }));
  const text = { ...payload, subGoals: [{ ...payload.subGoals[0]!, calls: [{ ...payload.subGoals[0]!.calls[0]!, toolId: "Open the sheet now!" }] }] } as unknown as JsonValue;
  assert.throws(() => assertValidCoreEventDraft({ ...draft, payload: text }), /ids, statuses and flags only/u);
});

test("a turn without a plan journals no sub-goal record", async () => {
  const { events } = await run([calls([{ id: "c1", name: "test_click", args: { label: "row 2" } }]), answer("Đã mở.")], "ledger-no-plan", false);
  assert.equal(progressOf(events).length, 0);
});

test("a sub-goal shown done mid-batch never returns the batch to the model: its later calls still run", async () => {
  const { requests, events } = await run([
    calls([plan([["s1", "in_progress"], ["s2", "pending"]]), { id: "c1", name: "test_click", args: { label: "icon-eye" } },
      { id: "r1", name: "test_read", args: { page: 1 } }, { id: "c2", name: "test_click", args: { label: "row 2" } }]),
    answer("Đã mở."),
  ], "ledger-no-return");
  assert.deepEqual(executed, ["click icon-eye", "read 1", "click row 2"]);
  assert.equal(requests.length, 2, "one request for the batch, one for the answer");
  assert.deepEqual(summary(progressOf(events)[0]!.payload)[0], ["s1", "in_progress", true, true,
    ["c1 test_click succeeded", "r1 test_read succeeded", "c2 test_click succeeded"]]);
});

const context = { turnId: "t2", stepId: "step" } as ToolBatchContext;
const planOf = (planId: string, steps: readonly (readonly [string, "pending" | "in_progress" | "completed"])[]) => ({ planId, revision: 2, state: "active" as const,
  goal: "g", updatedAt: "2026-01-01T00:00:00.000Z", steps: steps.map(([id, status]) => ({ id, description: id, status })) });
const shownOf = (draft: ReturnType<SubGoalLedger["draft"]>) => summary(draft!.payload).map(([id, , shown, wrote]) => [id, shown, wrote]);
const settled = (state: "succeeded" | "failed", result?: JsonValue) => ({ executionId: "e", state, dispatched: true, ...(result ? { result } : {}) });

test("a new plan that reuses a step id starts with no evidence: a step id names one sub-goal only within its plan", () => {
  const ledger = new SubGoalLedger();
  ledger.observe(planOf("plan-a", [["1", "in_progress"]]), "1", { id: "c1", name: "test_click", arguments: "{}" }, click, settled("succeeded", { status: "succeeded" }));
  ledger.draft(planOf("plan-a", [["1", "in_progress"]]), context);
  assert.deepEqual(shownOf(ledger.draft(planOf("plan-b", [["1", "in_progress"], ["2", "pending"]]), context)), [["1", false, false], ["2", false, false]]);
  assert.deepEqual(shownOf(ledger.draft(planOf("plan-a", [["1", "completed"], ["2", "pending"]]), context)), [["1", true, true], ["2", false, false]],
    "the same plan, revised, keeps its evidence");
  ledger.observe(undefined, "1", { id: "c2", name: "test_click", arguments: "{}" }, click, settled("failed"));
  assert.deepEqual(shownOf(ledger.draft(planOf("plan-a", [["1", "completed"]]), context)), [["1", true, true]], "no plan, nothing attributed");
});

test("restored from the task's step records: each call under its own plan, the latest state-changing call decides", () => {
  const record = (seq: number, turnId: string, planId: string, subGoals: readonly { readonly id: string; readonly calls: readonly Record<string, JsonValue>[] }[]): SessionEvent =>
    ({ seq, sessionId: "s", turnId, stepId: `x${seq}`, type: "work/step-progress", schemaVersion: 1, createdAt: "2026-01-01T00:00:00.000Z",
      payload: { planId, revision: seq, subGoals: subGoals.map((goal) => ({ ...goal, claimed: "in_progress", shown: false, wrote: false })) } }) as unknown as SessionEvent;
  const write = { callId: "w", toolId: "test_click", state: "succeeded", sideEffect: "idempotent" };
  const read = { callId: "r", toolId: "test_read", state: "succeeded", sideEffect: "none" };
  const ledger = SubGoalLedger.restore([
    record(1, "t1", "plan-a", [{ id: "1", calls: [write] }, { id: "2", calls: [read] }]),
    record(2, "t1", "plan-a", [{ id: "1", calls: [{ ...write, failed: true }] }]),
    record(3, "t1", "plan-b", [{ id: "2", calls: [{ ...read, state: "failed", failed: true }] }]),
    record(4, "t0", "plan-a", [{ id: "3", calls: [read] }]),
  ], ["t1"]);
  assert.deepEqual(shownOf(ledger.draft(planOf("plan-a", [["1", "in_progress"], ["2", "completed"], ["3", "pending"]]), context)),
    [["1", false, true], ["2", true, false], ["3", false, false]],
    "1: wrote, then its latest write failed; 2: its read did what it was asked; 3: recorded in a turn of another task");
  assert.deepEqual(shownOf(ledger.draft(planOf("plan-c", [["1", "in_progress"], ["2", "pending"]]), context)), [["1", false, false], ["2", false, false]],
    "a plan of the same task that reuses the ids inherits nothing");
  assert.equal(ledger.draft(undefined, context), undefined, "no record without a plan");
});
