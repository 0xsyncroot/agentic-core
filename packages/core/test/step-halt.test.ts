import assert from "node:assert/strict";
import test from "node:test";
import {
  TOOL_EXECUTION_RESPONSE_PROTOCOL, type ChatMessage, type EventDraft, type JsonValue, type SessionEvent, type ToolDefinition, type ToolExecutionPolicy,
} from "@0xsyncroot/contracts";
import { DefaultAgentLoop, PermissionToolExecutionPolicy } from "@0xsyncroot/core";
import { resolveAgentOptions } from "../src/agent/agent-options.js";
import { ToolBatchExecutor, type ToolBatchContext } from "../src/agent/tool-batch-executor.js";
import { ToolExecutionCoordinator } from "../src/agent/tool-execution-coordinator.js";
import type { TurnEventWriter } from "../src/agent/turn-event-writer.js";
import { WorkPlanLedger } from "../src/agent/work-plan-ledger.js";
import { WorkStateTracker } from "../src/agent/work-state-tracker.js";
import { activeHost, answer, calls, planningPlugin, PLAN_TOOL_ID, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/**
 * A call that succeeded but changed the scope the step's later calls were chosen against (`halt` "state-changed") stops the
 * later state-changing calls as a failure does; reads still run. A partial write reports itself failed, so the step's next
 * write does not start either.
 */
const executed: string[] = [];
const open: ToolDefinition = {
  id: "test_open", version: "1", description: "opens a dialog", requiredPermissions: [], sideEffect: "idempotent", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {},
  execute: async () => {
    executed.push("open");
    return { protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "completed", result: { status: "succeeded", layer: "dialog" }, halt: "state-changed" };
  },
};
const click: ToolDefinition = {
  id: "test_click", version: "1", description: "click", requiredPermissions: [], sideEffect: "idempotent", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {},
  execute: async (invocation) => { executed.push(`click ${(invocation.arguments as { label?: string }).label ?? ""}`); return { status: "succeeded" }; },
};
const read: ToolDefinition = {
  id: "test_read", version: "1", description: "read", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {},
  execute: async (invocation) => { const page = (invocation.arguments as { page?: number }).page ?? 1; executed.push(`read ${page}`); return { page }; },
};
/** Applies rows; rows past the first two are refused, and the result says which applied, as a product's partial write does. */
const apply: ToolDefinition = {
  id: "test_apply", version: "1", description: "applies rows", requiredPermissions: [], sideEffect: "nonIdempotent", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {},
  execute: async (invocation) => {
    const rows = (invocation.arguments as { rows: readonly string[] }).rows;
    executed.push(`apply ${rows.join(",")}`);
    if (rows.length <= 2) return { status: "succeeded", applied: [...rows] };
    return { status: "failed", reasonCode: "partial-write", applied: rows.slice(0, 2), notApplied: rows.slice(2) };
  },
  // What the write leaves behind, as the product projects it: the same refusal again shows nothing new.
  observationKey: (result) => ({ status: (result as { status?: string }).status ?? "" }),
};
const policy: ToolExecutionPolicy = (() => {
  const baseline = new PermissionToolExecutionPolicy();
  return {
    discover: (tools, context) => baseline.discover(tools, context),
    authorize: async (input) => ({ ...(await baseline.authorize(input)), outcome: "allow", reason: "test" }),
  };
})();
const NOT_RUN_AFTER_HALT = "Not run: test_open (call 2 of this step, in your order) succeeded and changed the scope this call was chosen for "
  + "(another page, or a dialog opened or closed) before it. Decide again from its result.";

async function run(script: Parameters<typeof scriptedModel>[0], sessionId: string) {
  executed.length = 0;
  const { adapter, requests } = scriptedModel(script);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [open, click, read, apply]), planningPlugin()]);
  const store = new SpyStore();
  try {
    const result = await new DefaultAgentLoop(router, store, {}, { toolExecutionPolicy: policy }).runTurn({ sessionId, content: "mở", security: security() });
    return { result, requests, events: await store.inner.load(sessionId, security()) };
  } finally { await host.shutdown(); }
}
const resultOf = (events: readonly SessionEvent[], callId: string) =>
  events.find((event) => event.type === "tool/result" && event.callId === callId)!.payload as Record<string, JsonValue>;
const toolMessage = (request: { readonly messages: readonly { readonly role: string; readonly toolCallId?: string; readonly content: string | null }[] }, callId: string) =>
  request.messages.find((message) => message.role === "tool" && message.toolCallId === callId)?.content ?? "";

test("a call that halts stops the step's later state-changing calls, runs its reads, and the journal says why", async () => {
  const { result, requests, events } = await run([calls([
    { id: "p1", name: PLAN_TOOL_ID, args: { goal: "g", steps: [{ id: "s1", description: "Open", status: "in_progress" }] } },
    { id: "o1", name: "test_open", args: {} }, { id: "c1", name: "test_click", args: { label: "row 2" } },
    { id: "r1", name: "test_read", args: { page: 1 } }, { id: "w1", name: "test_apply", args: { rows: ["a"] } },
  ]), answer("Hộp thoại đã mở.")], "halt-stops");
  assert.equal(result.outcome, "completed");
  assert.deepEqual(executed, ["open", "read 1"], "the click and the write never ran; the read did");
  assert.deepEqual([resultOf(events, "o1").state, resultOf(events, "o1").halt], ["succeeded", "state-changed"], "the halt is journaled on its result");
  for (const callId of ["c1", "w1"]) {
    const payload = resultOf(events, callId);
    assert.deepEqual([payload.state, payload.dispatched, (payload.error as Record<string, JsonValue>).code], ["not_started", false, "not-started"]);
    assert.equal(JSON.parse(toolMessage(requests[1]!, callId)).message, NOT_RUN_AFTER_HALT);
  }
  assert.equal(toolMessage(requests[1]!, "o1"), "{\"status\":\"succeeded\",\"layer\":\"dialog\"}", "the model reads the tool's own result");
  const progress = events.find((event) => event.type === "work/step-progress")!.payload as { subGoals: { calls: Record<string, JsonValue>[] }[] };
  assert.deepEqual(progress.subGoals[0]!.calls.map((entry) => [entry.callId, entry.halted ?? false]), [["o1", true], ["r1", false]]);
});

test("a halt that is not the protocol's own value stops nothing", async () => {
  const loose: ToolDefinition = { ...open, id: "test_loose", execute: async () => {
    executed.push("loose");
    return { protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "completed", result: { status: "succeeded" }, halt: "maybe" } as unknown as JsonValue;
  } };
  executed.length = 0;
  const { adapter } = scriptedModel([calls([{ id: "l1", name: "test_loose", args: {} }, { id: "c1", name: "test_click", args: { label: "row 2" } }]), answer("Xong.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [loose, click])]);
  const store = new SpyStore();
  try {
    await new DefaultAgentLoop(router, store, {}, { toolExecutionPolicy: policy }).runTurn({ sessionId: "halt-loose", content: "mở", security: security() });
    assert.deepEqual(executed, ["loose", "click row 2"]);
    assert.equal(resultOf(await store.inner.load("halt-loose", security()), "l1").halt, undefined);
  } finally { await host.shutdown(); }
});

test("a halt on a result that itself reports failure is dropped: a failed call changed nothing to stop for", async () => {
  const refused: ToolDefinition = { ...open, id: "test_refused", execute: async () => {
    executed.push("refused");
    return { protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "completed", result: { status: "failed", reasonCode: "refused" }, halt: "state-changed" };
  } };
  executed.length = 0;
  const { adapter } = scriptedModel([calls([{ id: "f1", name: "test_refused", args: {} }]), answer("Xong.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [refused])]);
  const store = new SpyStore();
  try {
    await new DefaultAgentLoop(router, store, {}, { toolExecutionPolicy: policy }).runTurn({ sessionId: "halt-failed", content: "mở", security: security() });
    assert.equal(resultOf(await store.inner.load("halt-failed", security()), "f1").halt, undefined);
  } finally { await host.shutdown(); }
});

test("a partial write is a failed attempt: the step's next write does not start, and the model reads which rows applied", async () => {
  const { requests, events } = await run([calls([
    { id: "w1", name: "test_apply", args: { rows: ["a", "b", "c"] } }, { id: "w2", name: "test_apply", args: { rows: ["d"] } },
  ]), answer("Đã áp dụng một phần.")], "partial-write");
  assert.deepEqual(executed, ["apply a,b,c"]);
  const first = resultOf(events, "w1");
  assert.equal(first.state, "succeeded", "the tool ran; its own result says it did not do all it was asked");
  const attempt = first.attempt as Record<string, JsonValue>;
  assert.deepEqual([attempt.failure, attempt.failures], ["partial-write", 1], "recorded against its target as a failure");
  assert.deepEqual(JSON.parse(toolMessage(requests[1]!, "w1")), { status: "failed", reasonCode: "partial-write", applied: ["a", "b"], notApplied: ["c"] });
  assert.match(JSON.parse(toolMessage(requests[1]!, "w2")).message, /^Not run: test_apply \(call 1 of this step, in your order\) did not succeed before it\./u);
  assert.equal((resultOf(events, "w2").error as Record<string, JsonValue>).code, "not-started");
});

test("a partial write that shows nothing new is a refused work call: the step is refused-only, its stopped write uncounted", async () => {
  executed.length = 0;
  const journal: EventDraft[] = [];
  const writer = { append: async (drafts: readonly EventDraft[]) => { journal.push(...drafts); } } as unknown as TurnEventWriter;
  const options = resolveAgentOptions({});
  const executor = new ToolBatchExecutor(new ToolExecutionCoordinator([apply], options, policy), new WorkStateTracker(),
    WorkPlanLedger.restore({ turnId: "t1", isUserTurn: true, workPlanning: undefined, events: [], taskTurnIds: ["t1"], report: () => undefined }),
    writer, () => undefined, options);
  const step = (index: number) => executor.execute([
    { id: `w${index}a`, name: "test_apply", arguments: JSON.stringify({ rows: ["a", "b", `c${index}`] }) },
    { id: `w${index}b`, name: "test_apply", arguments: JSON.stringify({ rows: [`d${index}`] }) },
  ], { sessionId: "s", turnId: "t1", stepId: `step-${index}`, stepIndex: index, security: security(), runtime: { id: "rt" } as never,
    runtimeRouteRevision: "route-1" } satisfies ToolBatchContext, [] as ChatMessage[], new AbortController().signal, `request-${index}`);
  const firstStep = await step(1);
  assert.deepEqual(firstStep.kind === "completed" && [firstStep.progressed, firstStep.refusedOnly], [true, false], "the first partial result is news");
  const secondStep = await step(2);
  assert.deepEqual(secondStep.kind === "completed" && [secondStep.progressed, secondStep.refusedOnly], [false, true]);
  assert.deepEqual(executed, ["apply a,b,c1", "apply a,b,c2"], "neither step's second write ran");
  assert.equal(journal.filter((draft) => draft.type === "tool/policy-decision").length, 2, "the stopped writes were never prepared");
});
