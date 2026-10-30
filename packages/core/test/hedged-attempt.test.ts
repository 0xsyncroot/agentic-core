import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AgenticError, MODEL_LIMIT_REASON, type ChatMessage, type EventDraft, type LlmAdapter, type LlmStreamEvent, type PreparedLlmRequest } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { createSystemPromptPlugin, createUserInputToolsPlugin } from "@0xsyncroot/plugins-base";
import { resolveAgentOptions } from "../src/agent/agent-options.js";
import { DECAY_WEIGHT, FirstEventModel, HEDGE_MIN_MS, HEDGE_MIN_SAMPLES, RAISE_WEIGHT } from "../src/agent/first-event-model.js";
import { LlmStepExecutor } from "../src/agent/llm-step-executor.js";
import { ExponentialRetryPolicy } from "../src/agent/retry-policy.js";
import { SpyStore, activeHost, answer, call, scriptedModel, security, toolPlugin, writeTool } from "./turn-harness.js";

/**
 * A provider gateway can leave a call open with no header until it cuts it minutes later. After a stretch of silence the
 * same request goes once more and the first call to speak is used; these pin what that may and may not do.
 */

type Script = "silent" | "empty" | { readonly answerAfterMs: number } | { readonly failAfterMs: number; readonly code?: "transient" | "permanent" }
  | { readonly reasoningLimitAfterMs: number };
interface Call { readonly request: PreparedLlmRequest; readonly signal: AbortSignal }

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/**
 * Each call follows the next script; the calls are recorded with the signal the adapter was handed. `live` declares a
 * stream that shows progress from its first token (`progressStreaming`), the only kind a second call is made for.
 */
function fakeAdapter(scripts: readonly Script[], live: boolean, plain: boolean): { readonly llm: LlmAdapter; readonly calls: Call[] } {
  const calls: Call[] = [];
  const llm: LlmAdapter = {
    id: "fake", model: "fake-model", ...(live ? { features: { progressStreaming: true } } : {}),
    ...(plain ? { plainParameters: { thinking: false } } : {}),
    async *stream(request, signal): AsyncIterable<LlmStreamEvent> {
      const script = scripts[calls.length] ?? "silent";
      calls.push({ request, signal });
      const label = `call ${calls.length}`;
      if (script === "silent") await untilAborted(signal);
      else if (script === "empty") await delay(1, undefined, { signal });
      else if ("reasoningLimitAfterMs" in script) {
        await delay(script.reasoningLimitAfterMs, undefined, { signal });
        throw new AgenticError("transient", "thinking ran out", false, { reason: MODEL_LIMIT_REASON.REASONING });
      } else if ("failAfterMs" in script) {
        await delay(script.failAfterMs, undefined, { signal });
        const code = script.code ?? "transient";
        throw new AgenticError(code, code === "permanent" ? "gateway answered 400" : "gateway answered 502", code === "transient");
      } else {
        await delay(script.answerAfterMs, undefined, { signal });
        yield { type: "text-delta", delta: label };
        yield { type: "final", content: label, toolCalls: [], finishReason: "stop" };
      }
    },
  };
  return { llm, calls };
}

interface RunOptions {
  readonly hedgeAfterMs?: number; readonly timeoutMs?: number; readonly maxAttempts?: number; readonly signal?: AbortSignal;
  readonly live?: boolean; readonly plain?: boolean; readonly content?: string; readonly failHedgeJournal?: boolean;
  /** An executor kept across calls, a writer (one turn) and the conversation sent: what the learned hedge needs. */
  readonly executor?: LlmStepExecutor; readonly writer?: object; readonly messages?: readonly ChatMessage[]; readonly charsPerToken?: number;
}

function run(scripts: readonly Script[], options: RunOptions = {}) {
  const { llm, calls } = fakeAdapter(scripts, options.live ?? true, options.plain ?? false);
  const events: EventDraft[] = [], deltas: string[] = [], started: string[] = [];
  const executor = options.executor ?? new LlmStepExecutor(100_000, new ExponentialRetryPolicy(options.maxAttempts ?? 1, 0), options.timeoutMs ?? 300,
    undefined, options.hedgeAfterMs ?? 30);
  const writer = options.writer ?? {};
  Object.assign(writer, { append: async (drafts: EventDraft[]) => {
    if (options.failHedgeJournal && drafts.some((draft) => (draft.payload as Record<string, unknown>).hedgeOf)) throw new Error("journal unavailable");
    events.push(...drafts);
  } });
  const result = executor.execute({
    turnId: "turn", stepId: "step", runtimeSnapshotId: "rt", tools: [], messages: options.messages ?? [{ role: "user", content: options.content ?? "hello" }],
    signal: options.signal ?? new AbortController().signal, llm,
    resolvedModel: { modelId: llm.model, ...(options.charsPerToken ? { estimatedCharsPerToken: options.charsPerToken } : {}) } as never,
    writer: writer as never,
    onAttemptStarted: (attemptId) => started.push(attemptId),
    onTextDelta: (delta, attemptId) => deltas.push(`${attemptId}:${delta}`),
  });
  return { result, calls, events, deltas, started };
}

const ofType = (events: readonly EventDraft[], type: string) => events.filter((event) => event.type === type);
const payload = (event: EventDraft | undefined) => event?.payload as Record<string, any>;

test("a silent first call is sent once more and the call that speaks first is the step's; the other is aborted", async () => {
  const { result, calls, events, deltas, started } = run(["silent", { answerAfterMs: 10 }]);
  const outcome = await result;
  assert.equal(outcome.final.content, "call 2");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.signal.aborted, true, "the silent call is aborted");
  assert.equal(calls[1]!.signal.aborted, false);
  const [primary, hedge] = calls.map((call) => call.request);
  assert.notEqual(primary!.attemptId, hedge!.attemptId);
  assert.deepEqual({ ...hedge, attemptId: "", contentHash: "" }, { ...primary, attemptId: "", contentHash: "" }, "the same request");
  assert.equal(outcome.attemptId, hedge!.attemptId, "usage and the message are journaled against the call that answered");
  const prepared = ofType(events, "request/prepared");
  assert.equal(prepared.length, 2);
  assert.equal(payload(prepared[1]).hedgeOf, primary!.attemptId);
  assert.equal(payload(prepared[1]).hedgeAfterMs, 30);
  const committed = ofType(events, "llm/attempt-committed");
  assert.equal(committed.length, 1);
  assert.equal(committed[0]!.attemptId, hedge!.attemptId);
  assert.deepEqual(payload(committed[0]).hedge, { primaryAttemptId: primary!.attemptId, hedgeAttemptId: hedge!.attemptId, afterMs: 30, winner: "hedge" });
  assert.ok(payload(committed[0]).firstEventMs >= 35, `first event at ${payload(committed[0]).firstEventMs} ms`);
  const discarded = ofType(events, "llm/attempt-discarded");
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0]!.attemptId, primary!.attemptId);
  assert.equal(payload(discarded[0]).code, "hedge-lost");
  assert.equal(payload(discarded[0]).willRetry, false);
  assert.equal(ofType(events, "llm/attempt-failed").length, 0);
  // Observers see one attempt; nothing of the silent call reaches the stream.
  assert.deepEqual(started, [primary!.attemptId]);
  assert.deepEqual(deltas, [`${primary!.attemptId}:call 2`]);
});

test("a call that speaks before the hedge time is the only call made", async () => {
  const { result, calls, events } = run([{ answerAfterMs: 5 }]);
  assert.equal((await result).final.content, "call 1");
  await delay(60);
  assert.equal(calls.length, 1, "no second call after the first one spoke");
  assert.equal(ofType(events, "request/prepared").length, 1);
  const committed = payload(ofType(events, "llm/attempt-committed")[0]);
  assert.equal(committed.hedge, undefined);
  assert.equal(typeof committed.firstEventMs, "number");
  assert.equal(ofType(events, "llm/attempt-discarded").length, 0);
});

test("both calls silent until the first-event bound fail the attempt as a timeout, counted from the first call", async () => {
  const started = performance.now();
  const { result, calls, events } = run(["silent", "silent"], { timeoutMs: 150 });
  await assert.rejects(result, (error: unknown) => error instanceof AgenticError && error.code === "timeout");
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 140 && elapsed < 400, `the bound is shared, not restarted by the second call: ${elapsed} ms`);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.signal.aborted));
  const failed = ofType(events, "llm/attempt-failed");
  assert.equal(failed.length, 1);
  assert.equal(payload(failed[0]).code, "timeout");
  const discarded = ofType(events, "llm/attempt-discarded");
  assert.deepEqual(discarded.map((event) => [event.attemptId, payload(event).code, payload(event).hedge.winner]),
    [[calls[0]!.request.attemptId, "timeout", "none"], [calls[1]!.request.attemptId, "timeout", "none"]]);
});

test("aborting the turn while both calls are open aborts both", async () => {
  const controller = new AbortController();
  const { result, calls } = run(["silent", "silent"], { signal: controller.signal });
  setTimeout(() => controller.abort(new AgenticError("cancelled", "user stopped the turn")), 60);
  await assert.rejects(result, (error: unknown) => error instanceof AgenticError && error.code === "cancelled");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.signal.aborted));
});

test("with the hedge off, a silent call waits for the bound and is retried as before", async () => {
  const { result, calls, events } = run(["silent", { answerAfterMs: 5 }], { hedgeAfterMs: 0, timeoutMs: 80, maxAttempts: 2 });
  assert.equal((await result).final.content, "call 2");
  assert.equal(calls.length, 2);
  assert.equal(payload(ofType(events, "llm/attempt-failed")[0]).code, "timeout");
  assert.equal(ofType(events, "request/prepared").filter((event) => payload(event).hedgeOf).length, 0);
  assert.equal(payload(ofType(events, "llm/attempt-committed")[0]).hedge, undefined);
});

test("an error is not an event: a first call that fails after the hedge started leaves the step to the second", async () => {
  const { result, calls, events } = run([{ failAfterMs: 50 }, { answerAfterMs: 40 }]);
  assert.equal((await result).final.content, "call 2");
  assert.equal(calls.length, 2);
  assert.equal(payload(ofType(events, "llm/attempt-committed")[0]).hedge.winner, "hedge");
  // A call that fails before the hedge time fails the attempt at once, as it did without one.
  const early = run([{ failAfterMs: 5 }, { answerAfterMs: 5 }]);
  await assert.rejects(early.result, (error: unknown) => error instanceof AgenticError && error.code === "transient");
  await delay(60);
  assert.equal(early.calls.length, 1);
});

test("the hedge is an agent option: 20 s by default, 0 turns it off, a negative value is refused", () => {
  assert.equal(resolveAgentOptions({}).llmHedgeAfterMs, 20_000);
  assert.equal(resolveAgentOptions({ llmHedgeAfterMs: 0 }).llmHedgeAfterMs, 0);
  assert.throws(() => resolveAgentOptions({ llmHedgeAfterMs: -1 }), /llmHedgeAfterMs must be a non-negative integer/u);
});

test("a stream that may be silent while it works gets no second call and keeps the wait for the prompt to be read", async () => {
  // A silent-until-final generation gets no second call per attempt. 1,800 characters add 150 ms to a 100 ms bound.
  const content = "x".repeat(1_800);
  const slow = run([{ answerAfterMs: 160 }], { live: false, timeoutMs: 100, content });
  assert.equal((await slow.result).final.content, "call 1", "an answer past the bound but within the prompt's wait arrives");
  assert.equal(slow.calls.length, 1);
  const started = performance.now();
  const hung = run(["silent"], { live: false, timeoutMs: 100, content });
  await assert.rejects(hung.result, (error: unknown) => error instanceof AgenticError && error.code === "timeout");
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 240 && elapsed < 320, `bound + chars/12 (at most 3x): ${elapsed} ms`);
  assert.equal(hung.calls.length, 1, "no second call");
  assert.equal(ofType(hung.events, "request/prepared").length, 1);
});

test("the plain regeneration after a reasoning limit has no progress to watch, so it gets no second call", async () => {
  const { result, calls } = run([{ reasoningLimitAfterMs: 5 }, { answerAfterMs: 60 }], { plain: true, maxAttempts: 2 });
  assert.equal((await result).final.content, "call 2");
  assert.equal(calls.length, 2, "the first call and its plain regeneration, nothing more");
  assert.deepEqual(calls[1]!.request.parameters, { thinking: false });
});

test("a second call that cannot be journaled is not made, and the first one still answers", async () => {
  const { result, calls, events } = run([{ answerAfterMs: 60 }], { failHedgeJournal: true });
  assert.equal((await result).final.content, "call 1");
  assert.equal(calls.length, 1);
  assert.equal(payload(ofType(events, "llm/attempt-committed")[0]).hedge, undefined);
});

test("a stream that ends before its first event has failed; it does not win the race", async () => {
  const { result, calls, events } = run([{ answerAfterMs: 60 }, "empty"]);
  assert.equal((await result).final.content, "call 1");
  assert.equal(calls.length, 2);
  const discarded = ofType(events, "llm/attempt-discarded")[0];
  assert.equal(discarded!.attemptId, calls[1]!.request.attemptId);
  assert.equal(payload(discarded).code, "permanent", "its own failure, not a lost race");
  assert.equal(payload(ofType(events, "llm/attempt-committed")[0]).hedge.winner, "primary");
  const alone = run(["empty"]);
  await assert.rejects(alone.result, /ended without a final event/u);
});

test("the second call's own error is journaled, not the attempt's timeout", async () => {
  const { result, calls, events } = run(["silent", { failAfterMs: 1, code: "permanent" }], { timeoutMs: 150 });
  await assert.rejects(result, (error: unknown) => error instanceof AgenticError && error.code === "timeout");
  const discarded = ofType(events, "llm/attempt-discarded");
  assert.deepEqual(discarded.map((event) => [event.attemptId, payload(event).code]),
    [[calls[0]!.request.attemptId, "timeout"], [calls[1]!.request.attemptId, "permanent"]]);
});

// ---- The learned first-event time (FirstEventModel) and what the executor does with it ----

const learned = (samples: readonly (readonly [tokens: number, ms: number])[], model = new FirstEventModel()) => {
  for (const [tokens, ms] of samples) model.learn("m", tokens, ms);
  return model;
};
const same = (count: number, tokens: number, ms: number) => Array.from({ length: count }, () => [tokens, ms] as const);

test("the hedge stays at the cap until a model has five samples, then follows what was learned, never below the floor", () => {
  const model = new FirstEventModel();
  assert.equal(model.hedgeAfterMs("m", 2_000, 20_000), 20_000, "no sample: today's constant");
  for (let sample = 1; sample < HEDGE_MIN_SAMPLES; sample += 1) {
    model.learn("m", 2_000, 1_000);
    assert.equal(model.hedgeAfterMs("m", 2_000, 20_000), 20_000, `${sample} samples: still the prior`);
  }
  model.learn("m", 2_000, 1_000);
  const hedge = model.hedgeAfterMs("m", 2_000, 20_000);
  assert.ok(hedge < 10_000, `five samples at ~1 s: ${hedge} ms`);
  assert.equal(hedge, HEDGE_MIN_MS, "a healthy gateway hedges at the floor, 6 s");
  assert.equal(model.hedgeAfterMs("other", 2_000, 20_000), 20_000, "another model has learned nothing");
});

test("a slow sample raises the estimate at once and fast samples lower it slowly", () => {
  const model = learned(same(HEDGE_MIN_SAMPLES, 2_000, 1_000));
  const before = model.expectedMs("m", 2_000)!;
  assert.ok(Math.abs(before - 1_000) < 1e-6);
  model.learn("m", 2_000, 15_000);
  const raised = model.expectedMs("m", 2_000)!;
  assert.ok(Math.abs(raised - (before + RAISE_WEIGHT * (15_000 - before))) < 1e-6, `moved by half the difference: ${raised}`);
  assert.equal(model.hedgeAfterMs("m", 2_000, 20_000), 20_000, "the spread makes the next hedge wait the cap");
  model.learn("m", 2_000, 1_000);
  const lowered = model.expectedMs("m", 2_000)!;
  assert.ok(Math.abs(lowered - (raised - DECAY_WEIGHT * (raised - 1_000))) < 1e-6, `moved by a tenth of the difference: ${lowered}`);
  assert.ok(lowered > (raised + 1_000) / 2, "one fast answer does not undo a slow one");
});

test("the learned time grows with the uncached tokens, and the hedge is clamped to the floor and the cap", () => {
  // A small prompt answers in ~1 s, a 50k-token uncached one in ~6 s.
  const model = learned(Array.from({ length: 40 }, (_, at) => (at % 2 === 0 ? [1_000, 1_000] : [50_000, 6_000]) as const));
  const [small, big, bigger] = [1_000, 50_000, 100_000].map((tokens) => model.expectedMs("m", tokens)!);
  assert.ok(small < big && big < bigger, `${small} < ${big} < ${bigger}`);
  assert.ok(Math.abs(big - 6_000) < 600 && Math.abs(small - 1_000) < 600, `fits what it saw: ${small}, ${big}`);
  assert.equal(model.hedgeAfterMs("m", 1_000, 200_000), HEDGE_MIN_MS, "never earlier than 6 s");
  assert.ok(model.hedgeAfterMs("m", 100_000, 200_000) > model.hedgeAfterMs("m", 1_000, 200_000), "a longer prompt waits longer");
  assert.equal(model.hedgeAfterMs("m", 100_000, 4_000), 4_000, "a cap below the floor wins");
  assert.equal(model.hedgeAfterMs("m", 100_000, 0), 0, "0 turns the hedge off");
  const slow = learned(same(8, 2_000, 30_000));
  assert.equal(slow.hedgeAfterMs("m", 2_000, 20_000), 20_000, "never above the cap");
  assert.ok(slow.hedgeAfterMs("m", 2_000, 600_000) < 45_000 * 2, "a large cap no longer means off once the gateway's time is known");
  assert.ok(learned(same(8, 2_000, 8_000)).hedgeAfterMs("m", 2_000, 600_000) < 30_000);
});

test("a hedge that answered teaches nothing; a primary that answered after the hedge was sent does", async () => {
  const model = new FirstEventModel(20);
  const executor = new LlmStepExecutor(100_000, new ExponentialRetryPolicy(1, 0), 300, undefined, 100, 0, model);
  for (let at = 0; at < HEDGE_MIN_SAMPLES; at += 1) {
    const { result, events } = run(["silent", { answerAfterMs: 5 }], { executor });
    await result;
    assert.equal(payload(ofType(events, "llm/attempt-committed")[0]).hedge.winner, "hedge");
  }
  assert.equal(model.hedgeAfterMs("fake-model", 0, 100), 100, "five hedge-won attempts: still the prior");
  assert.equal(model.expectedMs("fake-model", 0), undefined);
  const late = run([{ answerAfterMs: 130 }, "silent"], { executor });
  await late.result;
  assert.equal(payload(ofType(late.events, "llm/attempt-committed")[0]).hedge.winner, "primary");
  assert.ok(model.expectedMs("fake-model", 0)! >= 130, "the primary's slow first event is a sample: it is what raises the estimate");
});

test("the executor hedges at the learned time and journals it on the primary and on the hedge", async () => {
  const model = new FirstEventModel(20);
  const executor = new LlmStepExecutor(100_000, new ExponentialRetryPolicy(1, 0), 300, undefined, 100, 0, model);
  const first = run([{ answerAfterMs: 5 }], { executor });
  await first.result;
  assert.equal(payload(ofType(first.events, "request/prepared")[0]).hedgeAfterMs, 100, "before the evidence: the cap");
  for (let at = 1; at < HEDGE_MIN_SAMPLES; at += 1) await run([{ answerAfterMs: 5 }], { executor }).result;
  const { result, calls, events } = run(["silent", { answerAfterMs: 5 }], { executor });
  const outcome = await result;
  assert.equal(outcome.final.content, "call 2");
  const [primary, hedge] = ofType(events, "request/prepared").map(payload);
  assert.equal(primary!.hedgeAfterMs, 20, "the computed value is on the primary's request/prepared");
  assert.equal(primary!.hedgeOf, undefined);
  assert.equal(hedge!.hedgeAfterMs, 20);
  assert.equal(hedge!.hedgeOf, calls[0]!.request.attemptId);
  const committed = payload(ofType(events, "llm/attempt-committed")[0]);
  assert.equal(committed.hedge.afterMs, 20);
  assert.ok(committed.firstEventMs >= 20 && committed.firstEventMs < 90, `sent at ~20 ms, not at the cap: ${committed.firstEventMs} ms`);
  // Off stays off, whatever was learned; a stream without progress has no hedge to journal.
  const off = run([{ answerAfterMs: 5 }], { executor: new LlmStepExecutor(100_000, new ExponentialRetryPolicy(1, 0), 300, undefined, 0, 0, model) });
  await off.result;
  assert.equal(payload(ofType(off.events, "request/prepared")[0]).hedgeAfterMs, undefined);
  const plain = run([{ answerAfterMs: 5 }], { executor, live: false });
  await plain.result;
  assert.equal(payload(ofType(plain.events, "request/prepared")[0]).hedgeAfterMs, undefined);
});

test("each turn keeps its own previous request: the uncached estimate is what is new to the gateway in that turn", async () => {
  const executor = new LlmStepExecutor(100_000, new ExponentialRetryPolicy(1, 0), 300, undefined, 100);
  const piece = (message: ChatMessage) => JSON.stringify(message).length;
  const system: ChatMessage = { role: "system", content: "Quy tắc." };
  const turn = (marker: string) => {
    const opening: ChatMessage[] = [system, { role: "user", content: marker.repeat(400) }];
    const next: ChatMessage[] = [...opening, { role: "assistant", content: marker.repeat(100) }, { role: "user", content: marker.repeat(50) }];
    return { opening, next, newInFirst: piece(opening[1]!), newInSecond: piece(next[2]!) + piece(next[3]!) };
  };
  const [a, b] = [turn("a"), turn("b")], writers = [{}, {}];
  const estimate = (events: readonly EventDraft[]) => payload(ofType(events, "llm/attempt-committed")[0]).estimatedUncachedTokens;
  const options = (writer: object, messages: readonly ChatMessage[]) => ({ executor, writer, messages, charsPerToken: 1 });
  const firsts = [run([{ answerAfterMs: 5 }], options(writers[0]!, a.opening)), run([{ answerAfterMs: 5 }], options(writers[1]!, b.opening))];
  await Promise.all(firsts.map((first) => first.result));
  assert.deepEqual(firsts.map((first) => estimate(first.events)), [a.newInFirst, b.newInFirst], "a turn's first request: what follows the system message and the tools");
  const seconds = [run([{ answerAfterMs: 5 }], options(writers[0]!, a.next)), run([{ answerAfterMs: 5 }], options(writers[1]!, b.next))];
  await Promise.all(seconds.map((second) => second.result));
  assert.deepEqual(seconds.map((second) => estimate(second.events)), [a.newInSecond, b.newInSecond], "only what the turn's own previous request did not hold");
});

test("a retry after a hang keeps the estimate of the request that hung, and the hung request is not what the next step is measured against", async () => {
  const executor = new LlmStepExecutor(100_000, new ExponentialRetryPolicy(2, 0), 60, undefined, 0);
  const piece = (message: ChatMessage) => JSON.stringify(message).length;
  const writer = {};
  const opening: ChatMessage[] = [{ role: "system", content: "Quy tắc." }, { role: "user", content: "x".repeat(300) }];
  const second: ChatMessage[] = [...opening, { role: "assistant", content: "y".repeat(200) }];
  const third: ChatMessage[] = [...second, { role: "user", content: "z".repeat(80) }];
  const estimate = (events: readonly EventDraft[]) => payload(ofType(events, "llm/attempt-committed")[0]).estimatedUncachedTokens;
  await run([{ answerAfterMs: 5 }], { executor, writer, messages: opening, charsPerToken: 1 }).result;
  const hung = run(["silent", { answerAfterMs: 5 }], { executor, writer, messages: second, charsPerToken: 1 });
  await hung.result;
  assert.equal(hung.calls.length, 2, "the first attempt timed out and was retried");
  assert.equal(estimate(hung.events), piece(second[2]!), "not 0, which is what the request measured against itself would give");
  const next = run([{ answerAfterMs: 5 }], { executor, writer, messages: third, charsPerToken: 1 });
  await next.result;
  assert.equal(estimate(next.events), piece(third[3]!));
});

test("a step whose request never got an answer is not the baseline of the next one", async () => {
  const executor = new LlmStepExecutor(100_000, new ExponentialRetryPolicy(1, 0), 40, undefined, 0);
  const piece = (message: ChatMessage) => JSON.stringify(message).length;
  const writer = {};
  const opening: ChatMessage[] = [{ role: "system", content: "Quy tắc." }, { role: "user", content: "x".repeat(300) }];
  const hung: ChatMessage[] = [...opening, { role: "assistant", content: "y".repeat(200) }];
  const next: ChatMessage[] = [...hung, { role: "user", content: "z".repeat(80) }];
  await run([{ answerAfterMs: 5 }], { executor, writer, messages: opening, charsPerToken: 1 }).result;
  await assert.rejects(run(["silent"], { executor, writer, messages: hung, charsPerToken: 1 }).result,
    (error: unknown) => error instanceof AgenticError && error.code === "timeout");
  const after = run([{ answerAfterMs: 5 }], { executor, writer, messages: next, charsPerToken: 1 });
  await after.result;
  assert.equal(payload(ofType(after.events, "llm/attempt-committed")[0]).estimatedUncachedTokens, piece(hung[2]!) + piece(next[3]!),
    "the gateway never read the hung request; both new messages are still uncached");
});

test("request/prepared carries the digests that make a cache drop attributable: the system text and the tool schemas", async () => {
  const { sha256 } = await import("../src/hash.js");
  const { result, events } = run([{ answerAfterMs: 5 }], { messages: [{ role: "system", content: "Quy tắc A." }, { role: "user", content: "hi" }] });
  await result;
  const prepared = payload(ofType(events, "request/prepared")[0]);
  assert.equal(prepared.systemHash, sha256("Quy tắc A."));
  assert.equal(prepared.toolsHash, sha256([]));
  const other = run([{ answerAfterMs: 5 }], { messages: [{ role: "system", content: "Quy tắc B." }, { role: "user", content: "hi" }] });
  await other.result;
  assert.notEqual(payload(ofType(other.events, "request/prepared")[0]).systemHash, prepared.systemHash);
});

/** The silence the runtime allowed the model's first event in one turn's steps, from the `request/prepared` rows the journal holds. */
const hedgesOf = (events: readonly { readonly type: string; readonly turnId?: string; readonly payload: unknown }[], turnId: string): unknown[] =>
  events.filter((event) => event.type === "request/prepared" && event.turnId === turnId).map((event) => (event.payload as Record<string, unknown>).hedgeAfterMs);

const REGION_QUESTION = { message: "Which region?", fields: [{ id: "region", label: "Region", type: "select", required: true, choices: [{ value: "north", label: "North" }] }] };

test("A1: first events learned in run-turn set the hedge of an approval resume and of an interaction resume: one learner per runtime", async () => {
  // Five answered steps are the evidence the hedge waits for (HEDGE_MIN_SAMPLES). Learned per use case, a runtime whose
  // resumes saw none of them would keep the prior (20 s) on the resume's steps, and a hung one would wait it out.
  const quick = Array.from({ length: HEDGE_MIN_SAMPLES }, (_, index) => answer(`quick ${index}`));
  const { adapter } = scriptedModel([...quick, call("w1", "test_write", { value: "a" }), answer("Written."), call("ask-1", "request_user_input", REGION_QUESTION), answer("Looked up.")],
    { progressStreaming: true });
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), createUserInputToolsPlugin(), toolPlugin("write", [writeTool()])]);
  try {
    const agent = new DefaultAgentLoop(router, new SpyStore(), {}, {});
    const prior = resolveAgentOptions({}).llmHedgeAfterMs;
    const first = await agent.runTurn({ sessionId: "learn-0", content: "hello", security: security() });
    assert.deepEqual(hedgesOf(first.events, first.turnId), [prior], "no evidence yet: the prior");
    for (let at = 1; at < HEDGE_MIN_SAMPLES; at += 1) await agent.runTurn({ sessionId: `learn-${at}`, content: "hello", security: security() });

    const paused = await agent.runTurn({ sessionId: "approval", content: "write a", security: security() });
    assert.equal(paused.outcome, "awaiting_approval");
    const resumed = await agent.resumeTurn({ sessionId: "approval", approvalId: paused.approval!.approvalId, decision: "approve", security: security(), idempotencyKey: "approve-1" });
    assert.equal(resumed.content, "Written.");
    assert.deepEqual(hedgesOf(resumed.events, resumed.turnId), [HEDGE_MIN_MS], "the approval resume hedges at the floor the run-turn samples earned, not at the prior");

    const asked = await agent.runTurn({ sessionId: "interaction", content: "look it up", security: security() });
    assert.equal(asked.outcome, "awaiting_interaction");
    const answered = await agent.resumeInteraction({ sessionId: "interaction", interactionId: asked.interaction!.interactionId, action: "accept", content: { region: "north" },
      security: security(), idempotencyKey: "answer-1" });
    assert.equal(answered.content, "Looked up.");
    assert.deepEqual(hedgesOf(answered.events, answered.turnId), [HEDGE_MIN_MS], "the interaction resume too");
  } finally { await host.shutdown(); }
});
