import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOL_EXECUTION_RESPONSE_PROTOCOL, type AgentProgressEvent, type JsonValue, type SessionEvent, type ToolDefinition } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { createWorkPlanningPlugin } from "@0xsyncroot/plugins-base";
import { activeHost, answer, calls, scriptedModel, security, SpyStore, toolPlugin, writeTool } from "./turn-harness.js";

/**
 * A planning call that settles a step (completed or blocked), sent beside work calls, runs after them and is applied only when
 * every work call of the step went through: the user never reads a step's result before the work sent with it ran, whether
 * or not earlier results already showed that step. Work is attributed as before, to the step the planning calls move into
 * progress. A plan, a revision or an in-progress mark still runs first, and a step of planning calls alone is applied as it was.
 */
const read: ToolDefinition = {
  id: "test_read", version: "1.0.0", description: "read a page", inputSchema: {}, outputSchema: {}, requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  execute: async (invocation) => {
    const page = (invocation.arguments as { page?: number }).page ?? 1;
    if (page === 0) throw new Error("page 0 does not exist");
    return { page } as JsonValue;
  },
};
const open: ToolDefinition = {
  id: "test_open", version: "1.0.0", description: "opens a dialog", inputSchema: {}, outputSchema: {}, requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  execute: async () => ({ protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "completed", result: { status: "succeeded", layer: "dialog" }, halt: "state-changed" }),
};
const PLAN = { goal: "Đọc rồi đối chiếu", steps: [{ id: "read", description: "Đọc màn", status: "in_progress" }, { id: "check", description: "Đối chiếu", status: "pending" }] };
/** The plan beside the first step's read: that read already shows "read" done, the live shape of a step with earlier evidence. */
const opening = calls([{ id: "plan", name: "plan_update", args: PLAN }, { id: "read-1", name: "test_read", args: { page: 1 } }]);
/** The plan alone: no result shows "read" done yet. */
const planOnly = calls([{ id: "plan", name: "plan_update", args: PLAN }]);
const markRead = { id: "mark", name: "plan_mark", args: { id: "read", status: "completed", outcome: "Đã đọc trang 1." } };
const payloadOf = (event: SessionEvent) => event.payload as Record<string, unknown>;
const ofCall = (events: readonly SessionEvent[], type: string, callId: string) => events.filter((event) => event.type === type && payloadOf(event).callId === callId).map(payloadOf);
const ofCallId = (events: readonly SessionEvent[], type: string, callId: string) => events.filter((event) => event.type === type && event.callId === callId).map(payloadOf);

async function run(sessionId: string, script: Parameters<typeof scriptedModel>[0]) {
  const { adapter, requests } = scriptedModel(script);
  const progress: AgentProgressEvent[] = [];
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read, open, writeTool()]), createWorkPlanningPlugin()]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 8 })
      .runTurn({ sessionId, content: "đọc rồi đối chiếu", security: security(), onProgress: (event) => progress.push(event) });
    return { result, requests, progress };
  } finally { await host.shutdown(); }
}

const toolMessage = (request: { readonly messages: readonly { readonly role: string; readonly toolCallId?: string; readonly content: string | null }[] } | undefined, callId: string) =>
  request?.messages.find((message) => message.role === "tool" && message.toolCallId === callId)?.content ?? "";
const notApplied = (tool: string, order: number, cause: string) => JSON.stringify({ type: "tool_error", code: "not-started", retryable: true,
  message: `Not applied: the plan kept its statuses, because a step is completed or blocked only after the work sent beside the mark, and ${tool} (call ${order} of this step, in your order) ${cause}; mark it once a result shows its outcome.` });

test("a mark completing a step beside its failed work is not applied: the step stays in progress, nothing is streamed, and the model reads why", async () => {
  const { result, requests, progress } = await run("gate-failed", [planOnly, calls([markRead, { id: "read-0", name: "test_read", args: { page: 0 } }]), answer("Chưa đọc được trang 0.")]);
  assert.equal(ofCall(result.events, "tool/result", "read-0")[0]!.workStepId, "check", "attributed as before, to the step the mark moves into progress");
  assert.deepEqual(ofCall(result.events, "tool/result", "mark").map((row) => [row.state, row.dispatched]), [["not_started", false]]);
  assert.deepEqual(ofCallId(result.events, "work/plan-updated", "mark"), [], "no plan change is journaled for the mark");
  assert.deepEqual(progress.filter((event) => event.type === "plan-updated" && event.callId === "mark"), [], "no outcome line reaches the client");
  assert.deepEqual(progress.filter((event) => event.type === "tool-started" && event.toolId === "plan_mark"), [], "the mark never started");
  assert.equal(toolMessage(requests[2], "mark"), notApplied("test_read", 2, "did not succeed"));
  const proposals = result.events.filter((event) => event.type === "work/plan-updated" && payloadOf(event).cause === "proposal").map(payloadOf);
  assert.deepEqual((proposals.at(-1)!.steps as { status: string }[]).map((step) => step.status), ["in_progress", "pending"]);
});

test("a mark completing a step beside work that went through is applied after that work: its result streams before the plan change", async () => {
  const { result, progress } = await run("gate-succeeded", [planOnly, calls([markRead, { id: "read-2", name: "test_read", args: { page: 2 } }]), answer("Đã đọc 2 trang.")]);
  assert.equal(ofCall(result.events, "tool/result", "mark")[0]!.state, "succeeded");
  assert.equal(ofCall(result.events, "tool/result", "read-2")[0]!.workStepId, "check", "attributed as before, to the step the mark moves into progress");
  const seen = progress.flatMap((event) => event.type === "tool-completed" && event.callId === "read-2" ? ["read-2 done"]
    : event.type === "plan-updated" && event.callId === "mark" ? ["mark shown"] : []);
  assert.deepEqual(seen, ["read-2 done", "mark shown"]);
  const shown = progress.find((event) => event.type === "plan-updated" && event.callId === "mark");
  assert.deepEqual(shown?.type === "plan-updated" && shown.plan.steps.map((step) => [step.id, step.status, step.outcome]),
    [["read", "completed", "Đã đọc trang 1."], ["check", "in_progress", undefined]]);
});

test("a call that changed the scope it was chosen for holds back the completion of its step, as a failure does", async () => {
  const { result, requests } = await run("gate-halt", [planOnly, calls([markRead, { id: "open", name: "test_open", args: {} }]), answer("Hộp thoại đã mở.")]);
  assert.equal(ofCall(result.events, "tool/result", "mark")[0]!.state, "not_started");
  assert.equal(toolMessage(requests[2], "mark"), notApplied("test_open", 2, "changed the scope it was chosen for"));
});

test("a completion behind a call that pauses for approval waits with it: not started, no plan change", async () => {
  const { result } = await run("gate-paused", [planOnly, calls([markRead, { id: "write-1", name: "test_write", args: { value: "v" } }])]);
  assert.equal(result.outcome, "awaiting_approval");
  assert.equal(ofCall(result.events, "tool/result", "mark")[0]!.state, "not_started");
  assert.deepEqual(ofCallId(result.events, "work/plan-updated", "mark"), []);
});

test("a step earlier results already show done is held back the same way: a failed or halted call beside the mark leaves no outcome line", async () => {
  for (const [sessionId, work, tool, cause] of [
    ["gate-shown-failed", { id: "read-0", name: "test_read", args: { page: 0 } }, "test_read", "did not succeed"],
    ["gate-shown-halted", { id: "open", name: "test_open", args: {} }, "test_open", "changed the scope it was chosen for"],
  ] as const) {
    const { result, requests, progress } = await run(sessionId, [opening, calls([markRead, work]), answer("Chưa xong.")]);
    assert.equal(ofCall(result.events, "tool/result", "mark")[0]!.state, "not_started", sessionId);
    assert.deepEqual(progress.filter((event) => event.type === "plan-updated" && event.callId === "mark"), [], sessionId);
    assert.equal(toolMessage(requests[2], "mark"), notApplied(tool, 2, cause));
  }
  const next = await run("gate-shown-next", [opening, calls([markRead, { id: "read-2", name: "test_read", args: { page: 2 } }]), answer("Đã đọc 2 trang.")]);
  assert.equal(ofCall(next.result.events, "tool/result", "read-2")[0]!.workStepId, "check", "the finished step marked beside the next step's first call");
  const seen = next.progress.flatMap((event) => event.type === "tool-completed" && event.callId === "read-2" ? ["read-2 done"]
    : event.type === "plan-updated" && event.callId === "mark" ? ["mark shown"] : []);
  assert.deepEqual(seen, ["read-2 done", "mark shown"]);
});

test("a plan, and an in-progress mark, still run before the step's work, which is attributed to the step they set", async () => {
  const { result } = await run("gate-first", [opening,
    calls([{ id: "jump", name: "plan_mark", args: { id: "check", status: "in_progress", outcome: "Bắt đầu đối chiếu." } }, { id: "read-2", name: "test_read", args: { page: 2 } }]),
    answer("Đã đọc và đối chiếu.")]);
  assert.equal(ofCall(result.events, "tool/result", "read-1")[0]!.workStepId, "read", "the plan sent beside the first read applied before it");
  assert.equal(ofCall(result.events, "tool/result", "read-2")[0]!.workStepId, "check", "the in-progress mark applied before the read");
});

test("a step of planning calls alone is applied as before, and marks beside the final answer still close the plan", async () => {
  const alone = await run("gate-plan-only", [opening, calls([markRead]), answer("Đã đọc.")]);
  assert.equal(ofCall(alone.result.events, "tool/result", "mark")[0]!.state, "succeeded");
  assert.equal(alone.progress.filter((event) => event.type === "plan-updated" && event.callId === "mark").length, 1);
  const closing = await run("gate-closing", [opening, calls([markRead,
    { id: "mark-2", name: "plan_mark", args: { id: "check", status: "completed", outcome: "Khớp 2 trang." } }], "Đã đọc và đối chiếu: khớp 2 trang.")]);
  assert.equal(closing.result.outcome, "completed");
  assert.equal(closing.result.content, "Đã đọc và đối chiếu: khớp 2 trang.");
  assert.deepEqual(["mark", "mark-2"].map((id) => ofCall(closing.result.events, "tool/result", id)[0]!.state), ["succeeded", "succeeded"]);
  const last = closing.result.events.filter((event) => event.type === "work/plan-updated").map(payloadOf).at(-1)!;
  assert.equal(last.state, "completed", "the plan closes with the answer");
});
