import assert from "node:assert/strict";
import { test } from "node:test";
import { createEchoToolPlugin } from "@0xsyncroot/adapter-echo";
import { AgenticError, type LlmAdapter, type LlmStreamEvent, type SessionEvent, type ToolExecutionPolicy, type TurnControlPolicy, type TurnInterjections } from "@0xsyncroot/contracts";
import { DefaultAgentLoop, PermissionToolExecutionPolicy } from "@0xsyncroot/core";
import { SpyStore, activeHost, answer, call, security, toolPlugin, writeTool } from "./turn-harness.js";

/**
 * Input the user adds while the model is still working cuts the model call (step-interruption.ts): the step would throw that
 * output away, so the turn stops waiting for it and reads the words at once. A tool that already runs is never cut, and the
 * turn's own cancel always wins over the cut.
 */

/** A queue the way the delivery edge's is: input offered at any time, listeners told, read at boundaries. */
function queue(): TurnInterjections & { offer(content: string): void; readonly items: string[] } {
  const items: string[] = [], listeners = new Set<() => void>();
  return {
    items,
    offer(content) { items.push(content); for (const listener of [...listeners]) listener(); },
    take: () => items.splice(0),
    get pending() { return items.length; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

type Reply = (request: Parameters<LlmAdapter["stream"]>[0], signal: AbortSignal) => AsyncIterable<LlmStreamEvent>;

/** A model whose calls are scripted as streams; each sees the signal its call was given. */
function streamingModel(replies: readonly Reply[]) {
  const requests: Parameters<LlmAdapter["stream"]>[0][] = [];
  const aborted: number[] = [];
  const adapter: LlmAdapter = {
    id: "streaming", model: "streaming", features: { progressStreaming: true },
    async *stream(request, signal) {
      requests.push(request);
      const index = requests.length - 1;
      signal.addEventListener("abort", () => aborted.push(index), { once: true });
      yield* replies[Math.min(index, replies.length - 1)]!(request, signal);
    },
  };
  return { adapter, requests, aborted };
}

/** Thinks, then never answers until its call is aborted. */
function hangs(onStart?: () => void): Reply {
  return async function* (_request, signal) {
    yield { type: "reasoning-delta", delta: "đang nghĩ" } as LlmStreamEvent;
    onStart?.();
    await new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
}

const said = (reply: () => LlmStreamEvent): Reply => async function* () { yield reply(); };
const userWords = (request: Parameters<LlmAdapter["stream"]>[0]) => request.messages.filter((message) => message.role === "user").map((message) => message.content ?? "");
const discarded = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "llm/attempt-discarded").map((event) => event.payload as Record<string, unknown>);

test("input added while the model thinks cuts the call: discarded as interjection, not retried, read by the next step", async () => {
  const input = queue();
  const { adapter, requests, aborted } = streamingModel([hangs(() => setTimeout(() => input.offer("sửa lại: tháng 8"), 20)), said(answer("đã mở tháng 8"))]);
  const { host, router } = await activeHost(adapter, []);
  try {
    const started = Date.now();
    const result = await new DefaultAgentLoop(router, new SpyStore()).runTurn({ sessionId: "cut", content: "mở tháng 9", security: security(), interjections: input });
    assert.ok(Date.now() - started < 5_000, "the hanging call was not waited for");
    assert.equal(result.outcome, "completed");
    assert.equal(result.content, "đã mở tháng 8");
    assert.deepEqual(aborted, [0]);
    assert.equal(requests.length, 2, "cut once, never retried");
    assert.ok(userWords(requests[1]!).includes("sửa lại: tháng 8"));
    assert.equal(result.events.some((event) => event.type === "llm/attempt-failed"), false);
    assert.deepEqual(discarded(result.events).map((payload) => [payload.code, payload.willRetry]), [["interjection", false]]);
    const cutStep = result.events.find((event) => event.type === "step/end")!;
    assert.deepEqual([(cutStep.payload as Record<string, unknown>).status, (cutStep.payload as Record<string, unknown>).reason], ["completed", "interjection"]);
    assert.equal(result.events.some((event) => event.stepId === cutStep.stepId && (event.type === "assistant/message" || event.type === "usage/recorded")), false);
  } finally { await host.shutdown(); }
});

test("the turn's own cancel wins over a cut that comes with it", async () => {
  const input = queue(), controller = new AbortController();
  const { adapter } = streamingModel([hangs(() => setTimeout(() => { input.offer("thêm"); controller.abort(new Error("người dùng dừng")); }, 20))]);
  const { host, router } = await activeHost(adapter, []);
  try {
    await assert.rejects(new DefaultAgentLoop(router, new SpyStore()).runTurn({
      sessionId: "cancel-wins", content: "mở", security: security(), interjections: input, signal: controller.signal,
    }));
  } finally { await host.shutdown(); }
});

test("input added while a tool runs never cuts it: the tool finishes once and the words are read at the next step", async () => {
  const input = queue();
  let runs = 0;
  const { adapter, requests, aborted } = streamingModel([said(call("r", "test_slow_read", {})), said(answer("đã đọc, đã nhận ý anh/chị"))]);
  const slowRead = { ...writeTool(), id: "test_slow_read", requiredPermissions: [], sideEffect: "none" as const, inputSchema: { type: "object" },
    execute: async () => { input.offer("nhớ kiểm lại"); await new Promise((resolve) => setTimeout(resolve, 50)); runs += 1; return { read: true }; } };
  const { host, router } = await activeHost(adapter, [toolPlugin("read", [slowRead])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore()).runTurn({ sessionId: "tool-runs", content: "đọc", security: security(), interjections: input });
    assert.equal(runs, 1);
    assert.deepEqual(aborted, []);
    assert.ok(userWords(requests[1]!).includes("nhớ kiểm lại"));
    assert.equal(discarded(result.events).some((payload) => payload.code === "interjection"), false);
  } finally { await host.shutdown(); }
});

test("with no step left to give the input, the call is not cut and the words stay queued for the edge", async () => {
  const input = queue();
  const slow: Reply = async function* () { setTimeout(() => input.offer("đổi tháng"), 5); await new Promise((resolve) => setTimeout(resolve, 60)); yield answer("chưa xác minh")(); };
  const { adapter, aborted } = streamingModel([slow]);
  const { host, router } = await activeHost(adapter, []);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 1 }).runTurn({ sessionId: "no-room", content: "mở", security: security(), interjections: input });
    assert.deepEqual(aborted, []);
    assert.deepEqual(input.items, ["đổi tháng"]);
    assert.equal(result.outcome, "partial");
  } finally { await host.shutdown(); }
});

test("a user who keeps adding input while the model thinks cannot hold the turn past its step allowance", async () => {
  const input = queue();
  let said = 0;
  // Thinks for 100 ms unless cut; each call hears one more sentence from the user as it starts.
  const talkedOver: Reply = async function* (_request, signal) {
    yield { type: "reasoning-delta", delta: "đang nghĩ" } as LlmStreamEvent;
    setTimeout(() => input.offer(`thêm ${++said}`), 5);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 100);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    yield answer("xong")();
  };
  const { adapter, requests } = streamingModel([talkedOver]);
  const { host, router } = await activeHost(adapter, []);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 6 }).runTurn({
      sessionId: "keeps-talking", content: "mở", security: security(), interjections: input,
    });
    assert.ok(requests.length >= 2 && requests.length <= 12, `cut, and bounded: ${requests.length} calls`);
    assert.ok(["completed", "partial"].includes(result.outcome));
  } finally { await host.shutdown(); }
});

/** Writes run without a card, the way a product with standing approval allows them. */
const allowAll: ToolExecutionPolicy = (() => {
  const baseline = new PermissionToolExecutionPolicy();
  return { discover: (tools, context) => baseline.discover(tools, context), authorize: async (input) => ({ ...(await baseline.authorize(input)), outcome: "allow", reason: "test" }) };
})();

test("input that arrives while the review decides is read before the answer ends the turn or the write runs", async () => {
  const input = queue();
  let writes = 0, reviews = 0;
  const policy: TurnControlPolicy = {
    id: "slow-review", revision: "v1",
    beforeModelStep: async () => ({}),
    // The review is where the time goes; the user speaks during the first one of each kind.
    reviewToolCalls: async () => { if (reviews++ === 0) input.offer("đừng ghi, đổi sang tháng 8"); return { decision: "accept" }; },
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const { adapter, requests } = streamingModel([said(call("w", "test_write", { value: "tháng 9" })), said(answer("đã dừng, chưa ghi gì"))]);
  const { host, router } = await activeHost(adapter, [toolPlugin("write", [writeTool(() => { writes += 1; })])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { turnControlPolicy: policy, toolExecutionPolicy: allowAll }).runTurn({
      sessionId: "after-review", content: "ghi tháng 9", security: security(), interjections: input,
    });
    assert.equal(writes, 0, "the write the user stopped never ran");
    assert.equal(result.events.some((event) => event.type === "tool/intent"), false);
    assert.ok(userWords(requests[1]!).includes("đừng ghi, đổi sang tháng 8"));
    assert.equal(result.content, "đã dừng, chưa ghi gì");
  } finally { await host.shutdown(); }
});

test("an answer the review accepted while the user spoke is not the turn's end: the next step answers with their words", async () => {
  const input = queue();
  let reviews = 0;
  const policy: TurnControlPolicy = {
    id: "slow-review", revision: "v1",
    beforeModelStep: async () => ({}),
    reviewTerminal: async () => { if (reviews++ === 0) input.offer("thêm cả tháng 8"); return { decision: "accept" }; },
  };
  const { adapter, requests } = streamingModel([said(answer("tháng 9 xong")), said(answer("tháng 9 và tháng 8 xong"))]);
  const { host, router } = await activeHost(adapter, []);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { turnControlPolicy: policy }).runTurn({
      sessionId: "answer-after-review", content: "tháng 9", security: security(), interjections: input,
    });
    assert.equal(result.content, "tháng 9 và tháng 8 xong");
    assert.ok(userWords(requests[1]!).includes("thêm cả tháng 8"));
    assert.equal(result.events.some((event) => event.type === "assistant/message" && (event.payload as Record<string, unknown>).content === "tháng 9 xong"), false);
  } finally { await host.shutdown(); }
});

test("input that arrives while the step reads before its model ends the step without a model call", async () => {
  const input = queue();
  let steps = 0;
  const policy: TurnControlPolicy = {
    id: "reads-first", revision: "v1",
    beforeModelStep: async () => { if (steps++ === 0) input.offer("thôi, lấy tháng 8"); return {}; },
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const { adapter, requests } = streamingModel([said(answer("đã lấy tháng 8"))]);
  const { host, router } = await activeHost(adapter, []);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { turnControlPolicy: policy }).runTurn({
      sessionId: "before-model", content: "lấy tháng 9", security: security(), interjections: input,
    });
    assert.equal(requests.length, 1, "the first step made no call");
    assert.ok(userWords(requests[0]!).includes("thôi, lấy tháng 8"));
    assert.equal(result.events.filter((event) => event.type === "request/prepared").length, 1);
    assert.equal(result.content, "đã lấy tháng 8");
  } finally { await host.shutdown(); }
});

test("input that arrives during a retry's back-off cuts the retry as it starts, and its discard says so", async () => {
  const input = queue();
  const failing: Reply = async function* () {
    setTimeout(() => input.offer("đổi sang tháng 8"), 5);
    throw new AgenticError("transient", "gateway busy", true);
  };
  const { adapter, requests } = streamingModel([failing, said(answer("đã đổi sang tháng 8"))]);
  const { host, router } = await activeHost(adapter, []);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore()).runTurn({ sessionId: "back-off", content: "tháng 9", security: security(), interjections: input });
    assert.equal(result.content, "đã đổi sang tháng 8");
    assert.deepEqual(discarded(result.events).map((payload) => [payload.code, payload.willRetry]), [["transient", true], ["interjection", false]]);
    assert.ok(userWords(requests.at(-1)!).includes("đổi sang tháng 8"));
  } finally { await host.shutdown(); }
});

test("a read-only call accepted while the user spoke still runs; the words are read at the next step", async () => {
  const input = queue();
  let runs = 0;
  const policy: TurnControlPolicy = {
    id: "slow-review", revision: "v1",
    beforeModelStep: async () => ({}),
    reviewToolCalls: async () => { input.offer("nhớ đọc cả tháng 8"); return { decision: "accept" }; },
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const read = { ...writeTool(), id: "test_read", requiredPermissions: [], sideEffect: "none" as const, inputSchema: { type: "object" },
    execute: async () => { runs += 1; return { read: true }; } };
  const { adapter, requests } = streamingModel([said(call("r", "test_read", {})), said(answer("đã đọc"))]);
  const { host, router } = await activeHost(adapter, [toolPlugin("read", [read])]);
  try {
    await new DefaultAgentLoop(router, new SpyStore(), {}, { turnControlPolicy: policy }).runTurn({
      sessionId: "read-after-review", content: "đọc", security: security(), interjections: input,
    });
    assert.equal(runs, 1);
    assert.ok(userWords(requests[1]!).includes("nhớ đọc cả tháng 8"));
  } finally { await host.shutdown(); }
});

test("a turn nobody interrupts journals the same events whether or not its queue can be watched", async () => {
  const types = async (interjections: TurnInterjections) => {
    const { adapter } = streamingModel([said(call("r", "agentic_echo", { value: "x" })), said(answer("xong"))]);
    const { host, router } = await activeHost(adapter, [createEchoToolPlugin()]);
    try {
      const result = await new DefaultAgentLoop(router, new SpyStore()).runTurn({ sessionId: "same", content: "đọc", security: security(), interjections });
      return result.events.map((event) => event.type);
    } finally { await host.shutdown(); }
  };
  assert.deepEqual(await types(queue()), await types({ take: () => [] }));
});
