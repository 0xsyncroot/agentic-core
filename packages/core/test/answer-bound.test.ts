import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AgenticError, MODEL_LIMIT_REASON, type EventDraft, type LlmAdapter, type LlmStreamEvent } from "@0xsyncroot/contracts";
import { AnswerBound } from "../src/agent/answer-bound.js";
import { LlmStepExecutor } from "../src/agent/llm-step-executor.js";
import { ExponentialRetryPolicy } from "../src/agent/retry-policy.js";

/**
 * A degenerate generation (a finished report, then one short unit repeated until the provider's own token limit) is cut
 * once it loops or runs past the bound, and the step is generated again.
 */

const LOOP = "** l**\n\n---\n";

function feed(bound: AnswerBound, text: string, piece = 10): { readonly at: number; readonly reason?: string } {
  for (let at = 0; at < text.length; at += piece) {
    const reason = bound.push(text.slice(at, at + piece));
    if (reason) return { at: at + piece, reason };
  }
  return { at: text.length };
}

/** A table written for a person: rows share their shape and separators, never their values. */
function table(rows: number): string {
  const lines = ["| # | Employee | Allowance | Before | After | Difference |", "|---|---|---|---|---|---|"];
  for (let i = 1; i <= rows; i += 1) lines.push(`| ${i} | Employee ${String.fromCharCode(65 + (i % 26))}${i} | 0.${(i * 7) % 10} | ${(i * 104_729) % 9_000_000} | ${(i * 130_363) % 9_000_000} | ${(i * 7_919) % 1_000_000} |`);
  return lines.join("\n");
}

test("a looping answer is cut a little past the point it starts repeating one unit", () => {
  const report = "The reconciliation is complete.\n\n" + table(40);
  const { at, reason } = feed(new AnswerBound(32_000), report + LOOP.repeat(5_000));
  assert.match(reason ?? "", /looped on a 12-character unit/u);
  assert.ok(at > report.length && at < report.length + 4_096 + 512 + LOOP.length, `cut at ${at}`);
});

test("a looping pair of lines is a loop too; an answer that only shares a shape is not", () => {
  assert.match(feed(new AnswerBound(32_000), "start\n" + "**Wait**, calling it.\n\n**(Tool call)**.\n\n".repeat(800)).reason ?? "", /looped/u);
  assert.equal(feed(new AnswerBound(32_000), table(400)).reason, undefined);
  // A long rule between two parts, and a list whose items differ by one character, stay within the bound.
  assert.equal(feed(new AnswerBound(32_000), `Part one.\n${"-".repeat(3_000)}\nPart two.\n${table(30)}`).reason, undefined);
  assert.equal(feed(new AnswerBound(32_000), Array.from({ length: 600 }, (_, i) => `- item ${i % 10}${Math.floor(i / 10)}`).join("\n")).reason, undefined);
  // A blank template (a month's attendance sheet before anything is entered) repeats rows without a letter in them.
  const blankSheet = `| Day |${Array.from({ length: 31 }, (_, i) => ` ${i + 1} |`).join("")}\n${`|  |${"  |".repeat(31)}\n`.repeat(80)}`;
  assert.equal(feed(new AnswerBound(32_000), blankSheet).reason, undefined);
  assert.equal(feed(new AnswerBound(32_000), Array.from({ length: 400 }, (_, i) => `| ${i + 1} | 0 | 0 | 0 | 0 |`).join("\n")).reason, undefined);
});

test("the captured runaways are cut where the loop has filled the window", () => {
  // The two recorded runaway units: a line and separator after a report, and an 84-character unit.
  assert.match(feed(new AnswerBound(32_000), table(30) + LOOP.repeat(2_000)).reason ?? "", /12-character unit/u);
  const unit = "**Wait**, I'll just call it.\n\n**(Actually, I'll just call it)**.\n\n**(Tool call)**.\n\n";
  assert.equal(unit.length, 84);
  assert.match(feed(new AnswerBound(32_000), table(30) + unit.repeat(300)).reason ?? "", /84-character unit/u);
});

test("text past the bound is cut even when it never repeats", () => {
  const { at, reason } = feed(new AnswerBound(5_000), table(400), 100);
  assert.match(reason ?? "", /exceeded 5000 characters/u);
  assert.equal(at, 5_100);
});

interface Call { readonly signal: AbortSignal }

/** Loops for the first `looping` calls (until the call is aborted) in its answer or its reasoning, then answers. */
function adapter(looping: number, channel: "text-delta" | "reasoning-delta" = "text-delta"): { readonly llm: LlmAdapter; readonly calls: Call[] } {
  const calls: Call[] = [];
  const llm: LlmAdapter = {
    id: "fake", model: "fake-model", features: { progressStreaming: true },
    async *stream(_request, signal): AsyncIterable<LlmStreamEvent> {
      calls.push({ signal });
      if (calls.length <= looping) {
        yield { type: "text-delta", delta: "The report is ready.\n\n" };
        for (;;) { await delay(0, undefined, { signal }); yield { type: channel, delta: "Wait, I will call the tool now.\n" }; }
      }
      yield { type: "text-delta", delta: "The report is ready." };
      yield { type: "final", content: "The report is ready.", toolCalls: [], finishReason: "stop" };
    },
  };
  return { llm, calls };
}

function execute(looping: number, maxAttempts: number, channel?: "text-delta" | "reasoning-delta") {
  const { llm, calls } = adapter(looping, channel);
  const events: EventDraft[] = [], discarded: { attemptId: string; code: string; willRetry: boolean; itemId?: string }[] = [];
  const executor = new LlmStepExecutor(100_000, new ExponentialRetryPolicy(maxAttempts, 0), 1_000, undefined, 0, 32_000);
  const result = executor.execute({
    turnId: "turn", stepId: "step", runtimeSnapshotId: "rt", tools: [], messages: [{ role: "user", content: "reconcile" }],
    signal: new AbortController().signal, llm, resolvedModel: { modelId: llm.model } as never,
    writer: { append: async (drafts: EventDraft[]) => { events.push(...drafts); } } as never,
    onAttemptDiscarded: (attemptId, code, willRetry, itemId) => discarded.push({ attemptId, code, willRetry, ...(itemId ? { itemId } : {}) }),
  });
  return { result, calls, events, discarded };
}

test("a looping attempt is aborted, its streamed text discarded, and the step generated again", async () => {
  const { result, calls, events, discarded } = execute(1, 3);
  const final = await result;
  assert.equal(final.final.content, "The report is ready.");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.signal.aborted, true, "the looping call is cut at the provider, not left running");
  const failed = events.find((event) => event.type === "llm/attempt-failed")?.payload as Record<string, unknown>;
  assert.equal(failed.reason, MODEL_LIMIT_REASON.OUTPUT);
  assert.equal(failed.willRetry, true);
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0]?.willRetry, true);
  assert.ok(discarded[0]?.itemId, "the public text the attempt streamed is discarded with it");
  assert.equal(events.filter((event) => event.type === "llm/attempt-committed").length, 1);
});

test("a step whose every attempt loops fails with the output limit after the attempt budget", async () => {
  const { result, calls } = execute(3, 3);
  await assert.rejects(result, (error: unknown) => error instanceof AgenticError && error.reason === MODEL_LIMIT_REASON.OUTPUT && error.retryable);
  assert.equal(calls.length, 3);
});

test("reasoning that loops is cut the same way; an executor given no bound cuts nothing", async () => {
  const { result, calls, events } = execute(1, 3, "reasoning-delta");
  assert.equal((await result).final.content, "The report is ready.");
  assert.equal(calls.length, 2);
  assert.match(String((events.find((event) => event.type === "llm/attempt-failed")?.payload as Record<string, unknown>).message), /reasoning looped/u);
  const unbounded = new LlmStepExecutor(100_000, new ExponentialRetryPolicy(1, 0), 1_000);
  const answer = Array.from({ length: 3 }, () => "same line repeated\n").join("").repeat(200);
  const llm: LlmAdapter = { id: "fake", model: "fake-model", async *stream(): AsyncIterable<LlmStreamEvent> {
    yield { type: "text-delta", delta: answer }; yield { type: "final", content: answer, toolCalls: [], finishReason: "stop" }; } };
  const done = await unbounded.execute({ turnId: "t", stepId: "s", runtimeSnapshotId: "rt", tools: [], messages: [{ role: "user", content: "x" }],
    signal: new AbortController().signal, llm, resolvedModel: { modelId: llm.model } as never, writer: { append: async () => undefined } as never });
  assert.equal(done.final.content, answer);
});
