import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProgressEvent, ChatMessage, EventDraft, JsonValue, SessionEvent, ToolDefinition, ToolExecutionPolicy, TurnControlPolicy } from "@0xsyncroot/contracts";
import { DefaultAgentLoop, PermissionToolExecutionPolicy } from "@0xsyncroot/core";
import { createUserInputToolsPlugin } from "@0xsyncroot/plugins-base";
import { resolveAgentOptions } from "../src/agent/agent-options.js";
import { MISSING_TOOL_RESULT_TEXT } from "../src/agent/conversation-projector.js";
import { ToolBatchExecutor, type ToolBatchContext } from "../src/agent/tool-batch-executor.js";
import { ToolExecutionCoordinator } from "../src/agent/tool-execution-coordinator.js";
import type { TurnEventWriter } from "../src/agent/turn-event-writer.js";
import { WorkPlanLedger } from "../src/agent/work-plan-ledger.js";
import { WorkStateTracker } from "../src/agent/work-state-tracker.js";
import { activeHost, answer, calls, planningPlugin, PLAN_TOOL_ID, scriptedModel, security, SpyStore, toolPlugin, writeTool } from "./turn-harness.js";

/**
 * A step's state-changing calls stop at its first work call that does not succeed. The model sent them together because it
 * knew their arguments; each assumed the one before went through. A refused click on a list that had not
 * opened is the case: the click after it would land on a screen nobody planned for. Reads still run.
 */
const executed: string[] = [];
/** Cancelled from inside a call, the way a user's stop lands while a step runs. */
let stopping = new AbortController();
const click: ToolDefinition = {
  id: "test_click", version: "1", description: "click", requiredPermissions: [], sideEffect: "idempotent", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {},
  execute: async (invocation) => {
    const label = (invocation.arguments as { label?: string }).label ?? "";
    executed.push(`click ${label}`);
    if (label === "icon-eye") return { status: "succeeded", screen: "detail" };
    if (label.startsWith("row")) return { status: "succeeded", screen: "list" };
    if (label === "stop") stopping.abort(new Error("stopped by the user"));
    // A screen refusal is a result the tool returns, not an error it throws.
    return { status: "rejected", reasonCode: "label-mismatch", message: "Ref e80 is \"icon-eye\"." };
  },
  observationKey: (result) => ({ screen: (result as { screen?: string }).screen ?? "list" }),
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
const write = writeTool(() => executed.push("write"));
const REGION_QUESTION = { message: "Which region?", fields: [{ id: "region", label: "Region", type: "select", required: true,
  choices: [{ value: "north", label: "North" }, { value: "south", label: "South" }] }] };
const NOT_RUN_AFTER_FIRST = /^\{"type":"tool_error","code":"not-started","retryable":true,"message":"Not run: test_click \(call 1 of this step, in your order\) did not succeed before it\. Decide again from its result\."\}$/u;

/** Screen clicks run without a card, the way a product allows them; every other tool meets the baseline. `asked` logs each decision. */
function screenPolicy(asked: string[] = []): ToolExecutionPolicy {
  const baseline = new PermissionToolExecutionPolicy();
  return {
    discover: (tools, context) => baseline.discover(tools, context),
    authorize: async (input) => {
      asked.push(input.tool.id);
      const decision = await baseline.authorize(input);
      return input.tool.id === "test_click" ? { ...decision, outcome: "allow", reason: "screen action" } : decision;
    },
  };
}

const ofCall = (events: readonly SessionEvent[], type: string, callId: string) =>
  events.filter((event) => event.type === type && event.callId === callId).map((event) => event.payload as Record<string, JsonValue>);
const toolMessage = (request: { readonly messages: readonly { readonly role: string; readonly toolCallId?: string; readonly content: string | null }[] }, callId: string) =>
  request.messages.find((message) => message.role === "tool" && message.toolCallId === callId)?.content ?? "";

async function run(script: Parameters<typeof scriptedModel>[0], sessionId: string, options: { readonly plugins?: Parameters<typeof activeHost>[1];
  readonly asked?: string[]; readonly loop?: ConstructorParameters<typeof DefaultAgentLoop>[2]; readonly store?: SpyStore; readonly signal?: AbortSignal;
  readonly turnControlPolicy?: TurnControlPolicy } = {}) {
  executed.length = 0;
  const { adapter, requests } = scriptedModel(script);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [click, read, write]), ...(options.plugins ?? [])]);
  const store = options.store ?? new SpyStore();
  const progress: AgentProgressEvent[] = [];
  try {
    const result = await new DefaultAgentLoop(router, store, options.loop ?? {}, { toolExecutionPolicy: screenPolicy(options.asked),
      ...(options.turnControlPolicy ? { turnControlPolicy: options.turnControlPolicy } : {}) })
      .runTurn({ sessionId, content: "mở bảng", security: security(), onProgress: (event) => progress.push(event), ...(options.signal ? { signal: options.signal } : {}) })
      .catch((error: unknown) => ({ error }));
    return { result: result as Extract<typeof result, { outcome: unknown }>, failure: "error" in result ? result.error : undefined,
      requests, progress, events: await store.inner.load(sessionId, security()) };
  } finally { await host.shutdown(); }
}

test("a click whose result says rejected stops the click after it; the model reads why, in its own numbering", async () => {
  const { result, requests, events, progress } = await run([calls([
    { id: "c1", name: "test_click", args: { label: "Open detail" } }, { id: "c2", name: "test_click", args: { label: "row 2" } },
  ]), answer("Chưa mở được.")], "stop-rejected");
  assert.equal(result.outcome, "completed");
  assert.deepEqual(executed, ["click Open detail"], "the second click never ran");
  assert.match(toolMessage(requests[1]!, "c2"), NOT_RUN_AFTER_FIRST);
  assert.deepEqual(ofCall(events, "tool/result", "c2").map((payload) => [payload.state, payload.dispatched, (payload.error as Record<string, JsonValue>).code]),
    [["not_started", false, "not-started"]], "journaled once, as not started");
  assert.deepEqual(ofCall(events, "tool/policy-decision", "c2"), [], "never prepared");
  assert.equal(progress.some((event) => (event.type === "tool-started" || event.type === "tool-completed") && event.callId === "c2"), false);
});

test("the stopped call names the failed one by its place in the model's order, not the order the plan update ran in", async () => {
  const { requests } = await run([calls([
    { id: "c1", name: "test_click", args: { label: "Open detail" } },
    { id: "p1", name: PLAN_TOOL_ID, args: { goal: "Mở bảng", steps: [{ id: "s1", description: "Mở bảng", status: "in_progress" }] } },
    { id: "c2", name: "test_click", args: { label: "row 2" } },
  ]), answer("Chưa mở được.")], "stop-order", { plugins: [planningPlugin()] });
  assert.deepEqual(executed, ["click Open detail"]);
  assert.match(toolMessage(requests[1]!, "c2"), NOT_RUN_AFTER_FIRST);
});

test("a question after a failed click is not asked: the user is never shown a step that did not happen", async () => {
  const { result, events, progress } = await run([calls([
    { id: "c1", name: "test_click", args: { label: "Open detail" } }, { id: "q1", name: "request_user_input", args: REGION_QUESTION },
  ]), answer("Chưa mở được.")], "stop-ask", { plugins: [createUserInputToolsPlugin()] });
  assert.equal(result.outcome, "completed");
  assert.equal(events.some((event) => event.type === "interaction/requested"), false);
  assert.equal(progress.some((event) => event.type === "interaction-requested"), false);
  assert.equal((ofCall(events, "tool/result", "q1")[0]!.error as Record<string, JsonValue>).code, "not-started");
});

test("a write after a failed click raises no card, meets no policy, and is not charged to the tool-call ceiling", async () => {
  const asked: string[] = [];
  // Two calls allowed: the refused click and the next step's click. A charged write would spend the second. The two spend
  // the ceiling, so the answer comes on the closing step it orders.
  const { result, events } = await run([calls([
    { id: "c1", name: "test_click", args: { label: "Open detail" } }, { id: "w1", name: "test_write", args: { value: "a" } },
  ]), calls([{ id: "c2", name: "test_click", args: { label: "icon-eye" } }]), answer("Đã mở.")], "stop-write", { asked, loop: { maxToolCalls: 2 } });
  assert.deepEqual(ofCall(events, "tool/result", "c2").map((payload) => payload.state), ["succeeded"], "the second click was within the ceiling");
  assert.deepEqual([result.outcome, (events.at(-1)!.payload as { reason?: string }).reason], ["partial", "tool-call-limit"]);
  assert.equal(events.some((event) => event.type === "approval/requested"), false, "no card for a write that must not run");
  assert.deepEqual(asked, ["test_click", "test_click"], "the policy decided the two clicks only");
  assert.deepEqual(executed, ["click Open detail", "click icon-eye"], "the write never ran; the next step's click did");
});

test("a refused click with the click it stopped is refunded like the refusal alone", async () => {
  // As refused-step.test.ts: the list (new), a click that changes nothing (a stall), then the refused step, then the right click.
  const { result, requests } = await run([
    calls([{ id: "c1", name: "test_click", args: { label: "row (look)" } }]), calls([{ id: "c2", name: "test_click", args: { label: "row" } }]),
    calls([{ id: "c3", name: "test_click", args: { label: "Open detail" } }, { id: "c3b", name: "test_click", args: { label: "row" } }]),
    calls([{ id: "c4", name: "test_click", args: { label: "icon-eye" } }]), answer("Đã mở bảng chi tiết."),
  ], "stop-refund-progressive", { loop: { maxSteps: 48, initialStepBudget: 3, stepBudgetExtension: 1 } });
  assert.ok(requests[3]!.tools.length > 0, "the step after the refusal can still click");
  assert.deepEqual(executed, ["click row (look)", "click row", "click Open detail", "click icon-eye"]);
  assert.equal(result.content, "Đã mở bảng chi tiết.");
});

test("a failed read stops nothing that only reads, and still stops the click after it", async () => {
  const { requests } = await run([calls([
    { id: "r0", name: "test_read", args: { page: 0 } }, { id: "r1", name: "test_read", args: { page: 1 } },
    { id: "c1", name: "test_click", args: { label: "row 2" } },
  ]), answer("Trang 1.")], "stop-reads");
  assert.deepEqual(executed, ["read 0", "read 1"], "both reads ran, the click did not");
  assert.equal(toolMessage(requests[1]!, "r1"), "{\"page\":1}");
  assert.match(toolMessage(requests[1]!, "c1"), /^\{"type":"tool_error","code":"not-started",.*"message":"Not run: test_read \(call 1 of this step, in your order\)/u);
});

test("an approval pause mid-step is unchanged: calls behind it wait for the user's approval, not for a failure", async () => {
  const { result, events } = await run([calls([
    { id: "r1", name: "test_read", args: { page: 1 } }, { id: "w1", name: "test_write", args: { value: "a" } },
    { id: "c1", name: "test_click", args: { label: "row 2" } },
  ])], "stop-approval");
  assert.equal(result.outcome, "awaiting_approval");
  assert.deepEqual(executed, ["read 1"]);
  assert.equal((ofCall(events, "tool/result", "c1")[0]!.error as Record<string, JsonValue>).code, "approval-required");
});

test("a later turn replays the stopped call's result as journaled, never as a result nobody recorded", async () => {
  const store = new SpyStore();
  await run([calls([
    { id: "c1", name: "test_click", args: { label: "Open detail" } }, { id: "c2", name: "test_click", args: { label: "row 2" } },
  ]), answer("Chưa mở được.")], "stop-replay", { store });
  const { requests } = await run([answer("Vẫn chưa.")], "stop-replay", { store });
  const replayed = toolMessage(requests[0]!, "c2");
  assert.match(replayed, NOT_RUN_AFTER_FIRST);
  assert.notEqual(replayed, MISSING_TOOL_RESULT_TEXT);
});

test("a turn cancelled during the step closes the later call as cancelled, as before, not as stopped behind a failure", async () => {
  stopping = new AbortController();
  const { failure, events } = await run([calls([
    { id: "c1", name: "test_click", args: { label: "stop" } }, { id: "c2", name: "test_click", args: { label: "row 2" } },
  ])], "stop-cancelled", { signal: stopping.signal });
  assert.match(String(failure), /stopped by the user|cancel/iu);
  assert.deepEqual(executed, ["click stop"]);
  assert.deepEqual(ofCall(events, "tool/result", "c2").map((payload) => [payload.state, payload.dispatched]), [["cancelled", false]]);
});

test("a write the step was not offered keeps its own refusal after a failed click: it says why, not that a failure stopped it", async () => {
  // The policy offers clicks and reads only; the write is in the turn's catalogue but not in this step.
  const policy: TurnControlPolicy = {
    id: "test.clicks-only", revision: "v1", beforeModelStep: async () => ({ allowedToolIds: ["test_click", "test_read"] }),
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const { requests, events } = await run([calls([
    { id: "c1", name: "test_click", args: { label: "Open detail" } }, { id: "w1", name: "test_write", args: { value: "a" } },
  ]), answer("Chưa mở được.")], "stop-unoffered", { turnControlPolicy: policy });
  assert.deepEqual(executed, ["click Open detail"]);
  assert.deepEqual(ofCall(events, "tool/result", "w1").map((payload) => [payload.state, (payload.error as Record<string, JsonValue>).code]), [["not_started", "validation"]]);
  assert.match(toolMessage(requests[1]!, "w1"), /Tool test_write is not offered in this step, so it was not run\./u);
});

/** The batch executor on its own, for the batches the loop's step path never builds: a policy's reads, a context with no step offer. */
async function batch(calls: readonly { readonly id: string; readonly name: string; readonly args: Record<string, unknown> }[], extra: Partial<ToolBatchContext>) {
  executed.length = 0;
  const journal: EventDraft[] = [];
  const writer = { append: async (drafts: readonly EventDraft[]) => { journal.push(...drafts); } } as unknown as TurnEventWriter;
  const options = resolveAgentOptions({});
  const executor = new ToolBatchExecutor(new ToolExecutionCoordinator([click, read], options, screenPolicy()), new WorkStateTracker(),
    WorkPlanLedger.restore({ turnId: "t1", isUserTurn: true, workPlanning: undefined, events: [], taskTurnIds: ["t1"], report: () => undefined }),
    writer, () => undefined, options);
  const context: ToolBatchContext = { sessionId: "s", turnId: "t1", stepId: "step-1", stepIndex: 1, security: security(), runtime: { id: "rt" } as never,
    runtimeRouteRevision: "route-1", ...extra };
  const messages: ChatMessage[] = [];
  const result = await executor.execute(calls.map((entry) => ({ id: entry.id, name: entry.name, arguments: JSON.stringify(entry.args) })),
    context, messages, new AbortController().signal, "request-1");
  const errorOf = (callId: string) => journal.filter((draft) => draft.type === "tool/result" && draft.callId === callId)
    .map((draft) => (draft.payload as Record<string, JsonValue>).error as Record<string, JsonValue> | undefined);
  return { result, errorOf };
}

test("a tool the runtime does not know keeps its own refusal after a failure, even where no step offer narrows the calls", async () => {
  const { errorOf } = await batch([{ id: "c1", name: "test_click", args: { label: "Open detail" } }, { id: "u1", name: "test_unknown_tool", args: {} }], {});
  assert.deepEqual(executed, ["click Open detail"]);
  const [error] = errorOf("u1");
  assert.notEqual(error?.code, "not-started");
  assert.match(String(error?.message), /^Unknown tool: test_unknown_tool$/u);
});

test("a runtime policy's own batch is not stopped behind a failure: its later calls still run", async () => {
  const reads = [{ id: "r0", name: "test_read", args: { page: 0 } }, { id: "c1", name: "test_click", args: { label: "row 2" } }];
  const observed = await batch(reads, { initiator: { policyId: "test.observer", reason: "verify" } });
  assert.deepEqual(executed, ["read 0", "click row 2"], "the policy's click ran after its failed read");
  assert.deepEqual(observed.errorOf("c1"), [undefined]);
  await batch(reads, {});
  assert.deepEqual(executed, ["read 0"], "the same calls from the model stop at the click");
});
