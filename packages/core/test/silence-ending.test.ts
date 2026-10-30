import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, LlmAdapter, LlmStreamEvent, SessionEvent, ToolDefinition, ToolExecutionPolicy, TurnControlPolicy, TurnFallbackTextInput } from "@0xsyncroot/contracts";
import { DefaultAgentLoop, PermissionToolExecutionPolicy, type ContinueQuestionWording } from "@0xsyncroot/core";
import { createSystemPromptPlugin } from "@0xsyncroot/plugins-base";
import { activeHost, answer, call, planningPlugin, planStep, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/**
 * A turn the silence watch stops — no step and no tool call for `turnTimeoutMs` — ends `partial` with reason `time-limit`, not
 * failed. Whatever hung (the model or a tool), the journal stays whole: every step that started has one end, every call has a
 * result, and the turn's own closing step comes after the last one. The content is the product's sentence for `time-limit`,
 * never a draft the model wrote beside its calls; and the next turn starts on a clean journal.
 */

// Above 30 s, so the step budget's own time rule (every step final for a limit of 15 s or less) stays out of the way. The
// silence watch runs on `setTimeout`, which the tests mock: the hang is reached, then the limit is ticked past at once.
const TURN_LIMIT_MS = 31_000;
const WORDING: ContinueQuestionWording = { question: "Go on with the rest?", continueLabel: "Go on", stopLabel: "Stop here", stopped: "Stopped here." };
const payload = (event: SessionEvent | undefined) => (event?.payload ?? {}) as Record<string, unknown>;

/** Resolves `promise` when the work reaches the point that never returns. */
function hangPoint() {
  let reached!: () => void;
  const promise = new Promise<void>((resolve) => { reached = resolve; });
  return { promise, hang: <T>() => { reached(); return new Promise<T>(() => undefined); } };
}

/** A model that plays `replies` in order, then never answers (and never notices an abort) from call `hangFrom` on. */
function hangingModel(replies: readonly ((request: Parameters<LlmAdapter["stream"]>[0]) => LlmStreamEvent)[], hangFrom: number) {
  const point = hangPoint();
  let calls = 0;
  const adapter: LlmAdapter = {
    id: "hanging", model: "hanging",
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      calls += 1;
      if (calls >= hangFrom) await point.hang<void>();
      yield replies[calls - 1]!(request);
    },
  };
  return { adapter, hung: point.promise };
}

const read: ToolDefinition = {
  id: "test_read", version: "1", description: "read", requiredPermissions: [], sideEffect: "none", timeoutMs: 60_000,
  inputSchema: { type: "object" }, outputSchema: {}, execute: async () => ({ rows: 3 }) as JsonValue,
};

/** A write that is sent and never answers; like a request in flight, it gives up only when its signal aborts. */
function hungWrite() {
  const point = hangPoint();
  const tool: ToolDefinition = {
    id: "test_hung_write", version: "1", description: "writes one value", requiredPermissions: [], sideEffect: "idempotent", timeoutMs: 60_000,
    inputSchema: { type: "object" }, outputSchema: {},
    execute: (_invocation, signal) => Promise.race([point.hang<JsonValue>(), new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })]),
  };
  return { tool, hung: point.promise };
}

/** Lets every call run without a card, so the hung write is dispatched. */
const baseline = new PermissionToolExecutionPolicy();
const allowAll: ToolExecutionPolicy = {
  discover: (tools, context) => baseline.discover(tools, context),
  authorize: async (input) => ({ ...await baseline.authorize(input), outcome: "allow" }),
};

function recordingPolicy(seen: TurnFallbackTextInput[]): TurnControlPolicy {
  return {
    id: "test", revision: "1", beforeModelStep: async () => ({}), reviewTerminal: async () => ({ decision: "accept", reason: "ok" }),
    fallbackText: (input) => {
      seen.push(input);
      return input.kind === "time-limit" ? `Hết thời gian (${input.completedSteps.length} xong, ${input.remainingSteps.length} còn lại).` : "khác";
    },
  };
}

/** The journal invariants any ending must keep, checked on one turn's own events. */
function assertWhole(events: readonly SessionEvent[], turnId: string): void {
  const own = events.filter((event) => event.turnId === turnId);
  const starts = own.filter((event) => event.type === "step/start");
  for (const start of starts) {
    assert.equal(own.filter((event) => event.type === "step/end" && event.stepId === start.stepId).length, 1, `step ${String(payload(start).index)} has exactly one end`);
  }
  for (const intent of own.filter((event) => event.type === "tool/intent")) {
    assert.equal(own.filter((event) => event.type === "tool/result" && event.callId === intent.callId).length, 1, `call ${intent.callId} has exactly one result`);
  }
  const indexes = starts.map((event) => Number(payload(event).index));
  const last = starts.at(-1)!;
  assert.equal(Number(payload(last).index), Math.max(0, ...indexes.slice(0, -1)) + 1, "the closing step comes right after the last one");
  const answer = own.filter((event) => event.type === "assistant/message").at(-1)!;
  assert.equal(answer.stepId, last.stepId, "the partial answer is on the closing step");
  assert.equal(payload(answer).finishReason, "time-limit");
  const end = own.at(-1)!;
  assert.equal(end.type, "turn/end");
  assert.deepEqual([payload(end).status, payload(end).reason, payload(end).steps], ["partial", "time-limit", payload(last).index]);
  assert.equal(own.some((event) => event.type === "turn/failed"), false);
}

async function silentAgent(adapter: LlmAdapter, tools: readonly ToolDefinition[], policy: TurnControlPolicy | undefined, toolExecutionPolicy?: ToolExecutionPolicy, continueQuestion: ContinueQuestionWording | null = WORDING) {
  const store = new SpyStore();
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), planningPlugin(), ...(tools.length ? [toolPlugin("silence", tools)] : [])]);
  const agent = new DefaultAgentLoop(router, store, { turnTimeoutMs: TURN_LIMIT_MS, llmAttemptTimeoutMs: 60_000, maxSteps: 8 }, {
    ...(policy ? { turnControlPolicy: policy } : {}), ...(toolExecutionPolicy ? { toolExecutionPolicy } : {}), ...(continueQuestion ? { continueQuestion } : {}),
  });
  return { store, host, agent };
}

test("a model call that hangs past the silence limit ends the turn partial on the product's time-limit sentence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seen: TurnFallbackTextInput[] = [];
  const model = hangingModel([
    planStep("plan-1", "Đọc dữ liệu", [{ id: "a", description: "Đọc trang 1", status: "completed" }, { id: "b", description: "Tổng hợp", status: "in_progress" }]),
    call("read-1", "test_read", {}, "Em đã ghi xong dữ liệu."),
  ], 3);
  const { store, host, agent } = await silentAgent(model.adapter, [read], recordingPolicy(seen));
  try {
    const turn = agent.runTurn({ sessionId: "silent-model", content: "đọc", security: security(), idempotencyKey: "silent-model-1" });
    await model.hung;
    t.mock.timers.tick(TURN_LIMIT_MS);
    const result = await turn;
    assert.equal(result.outcome, "partial");
    assert.equal(result.content, "Hết thời gian (1 xong, 1 còn lại).");
    assert.equal(result.interaction?.message, WORDING.question, "the silence limit is the runtime's own: the user is asked whether to go on");
    assert.doesNotMatch(result.content, /ghi xong/u, "the draft beside the call is never the answer");
    assert.deepEqual(seen, [{ kind: "time-limit", writesDispatched: false, completedSteps: ["Đọc trang 1"], remainingSteps: ["Tổng hợp"] }]);
    const events = await store.inner.load("silent-model", security());
    assertWhole(events, result.turnId);
    const hung = events.filter((event) => event.turnId === result.turnId && event.type === "step/start")[2]!;
    const hungEnd = events.find((event) => event.type === "step/end" && event.stepId === hung.stepId);
    assert.equal(payload(hungEnd).status, "failed", "the model step that hung is closed as failed, once");

    const replayed = await agent.runTurn({ sessionId: "silent-model", content: "đọc", security: security(), idempotencyKey: "silent-model-1" });
    assert.deepEqual([replayed.replayed, replayed.outcome, replayed.content, replayed.interaction?.interactionId], [true, "partial", result.content, result.interaction?.interactionId],
      "a retry of the request replays the partial and its question");
  } finally { await host.shutdown(); }
});

test("a tool that hangs past the silence limit closes its call as unknown, and the sentence knows a write was sent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seen: TurnFallbackTextInput[] = [];
  const write = hungWrite();
  const { adapter, requests } = scriptedModel([call("write-1", "test_hung_write", { value: "x" }), answer("Xong.")]);
  const { store, host, agent } = await silentAgent(adapter, [write.tool], recordingPolicy(seen), allowAll);
  try {
    const turn = agent.runTurn({ sessionId: "silent-tool", content: "ghi", security: security() });
    await write.hung;
    t.mock.timers.tick(TURN_LIMIT_MS);
    const result = await turn;
    assert.equal(result.outcome, "partial");
    assert.equal(seen.length, 1);
    assert.deepEqual([seen[0]!.kind, seen[0]!.writesDispatched], ["time-limit", true]);
    const events = await store.inner.load("silent-tool", security());
    assertWhole(events, result.turnId);
    const written = events.find((event) => event.type === "tool/result" && event.callId === "write-1");
    assert.deepEqual([payload(written).state, payload(written).dispatched], ["outcome_unknown", true], "the write may have landed: never reported as not started");

    // The next turn reads a journal with no open call, no open step and the question closed by the new message, and answers.
    const next = await agent.runTurn({ sessionId: "silent-tool", content: "tiếp", security: security() });
    assert.deepEqual([next.outcome, next.content], ["completed", "Xong."]);
    assert.equal(requests.length, 2);
  } finally { await host.shutdown(); }
});

test("without a product sentence or question wording the silence ending carries no content and asks nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const silent = hangingModel([], 1);
  const quiet = await silentAgent(silent.adapter, [], undefined, undefined, null);
  try {
    const turn = quiet.agent.runTurn({ sessionId: "silent-bare", content: "đọc", security: security() });
    await silent.hung;
    t.mock.timers.tick(TURN_LIMIT_MS);
    const result = await turn;
    assert.deepEqual([result.outcome, result.content, result.interaction], ["partial", "", undefined], "no words for the question, no question");
    assertWhole(await quiet.store.inner.load("silent-bare", security()), result.turnId);
  } finally { await quiet.host.shutdown(); }
});

test("a caller's cancel still fails the turn: a decision to stop is not a time limit", async () => {
  // The cancel is raised from inside the hanging model call, before the silence limit.
  const caller = new AbortController();
  const reason = new Error("Turn cancelled by the client");
  const cancelling: LlmAdapter = {
    id: "cancelling", model: "cancelling",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      caller.abort(reason);
      await new Promise<void>(() => undefined);
    },
  };
  const run = await silentAgent(cancelling, [], undefined);
  try {
    await assert.rejects(run.agent.runTurn({ sessionId: "cancelled", content: "đọc", security: security(), signal: caller.signal }),
      (error: unknown) => (error as Error).cause === reason);
    const events = await run.store.inner.load("cancelled", security());
    assert.equal(events.at(-1)!.type, "turn/failed");
  } finally { await run.host.shutdown(); }
});
