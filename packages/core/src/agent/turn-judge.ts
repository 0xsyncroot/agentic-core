import { randomUUID } from "node:crypto";
import { AgenticError, type JudgmentAnswer, type JudgmentClassifiedPayload, type JudgmentPort, type JudgmentResult, type TurnJudge } from "@0xsyncroot/contracts";
import { BREAKER_SEAM, breakerRow, JUDGMENT_ATTEMPT_TIMEOUT_MS, JudgmentLatency, retriesSeam, type BreakerTransition } from "./judgment-latency.js";
import type { TurnEventWriter } from "./turn-event-writer.js";

const MAX_REASON_CHARS = 300;

/**
 * Elapsed time on the monotonic clock, never negative. `Date.now()` follows the wall clock, which a
 * host may set back mid-call (WSL2 does on resume): the difference then came out negative, the
 * journal refused the event, and a judgment that had answered failed the user's whole turn.
 */
const elapsedSince = (started: number): number => Math.max(0, Math.round(performance.now() - started));

/** Four decimals: enough for any threshold, and a value MySQL's JSON re-print cannot shift. */
const rounded = (value: number): number => Math.round(value * 10_000) / 10_000;

function roundAnswer(answer: JudgmentAnswer): JudgmentAnswer {
  if (answer.type === "noul") return { type: "noul", noul: rounded(answer.noul) };
  const probabilities = Object.fromEntries(Object.entries(answer.probabilities).map(([label, p]) => [label, rounded(p)]));
  return answer.type === "choice"
    ? { type: "choice", choice: answer.choice, probabilities, confidence: rounded(answer.confidence) }
    : { type: "score", score: rounded(answer.score), legend: answer.legend, probabilities, confidence: rounded(answer.confidence) };
}

/** A call that got no answer: the deadline ran out, or the gateway could not be reached or said to try again. A refused request (HTTP 4xx), a malformed answer and a cancel are not that. */
const unanswered = (error: unknown): boolean => error instanceof AgenticError && (error.code === "timeout" || (error.code === "transient" && error.retryable));

/** One `judgment/classified` row, for the judge below and for a seam's own fallback that decides in its place. */
export function journalJudgment(writer: TurnEventWriter, turnId: string, payload: JudgmentClassifiedPayload): Promise<unknown> {
  return writer.append([{ type: "judgment/classified", turnId, classification: "confidential", payload }], `judgment:${turnId}:${randomUUID()}`);
}

function journaled(answer: JudgmentAnswer): { readonly type: string; readonly value: number; readonly choice?: string } {
  if (answer.type === "noul") return { type: "noul", value: answer.noul };
  return answer.type === "choice" ? { type: "choice", value: answer.confidence, choice: answer.choice } : { type: "score", value: answer.score };
}

/**
 * The judge a turn lends its policies and its own seams.
 *
 * Every judgment is journaled as `judgment/classified` — answered or failed — under the seam that
 * asked, so what a fast classifier decided inside a turn can be read, measured and replayed like
 * any other fact of it. The caller receives the rounded values the journal holds, never more
 * precise ones, so a threshold decides on exactly what is written; a seam's own reading of them (`TurnJudgeOptions.verdict`)
 * goes on the same row. A failure (provider error,
 * timeout, malformed answer) is journaled and returns undefined; a cancelled turn still throws.
 *
 * Each call is asked with the one attempt deadline (`JUDGMENT_ATTEMPT_TIMEOUT_MS`). A seam whose verdict decides is asked once
 * more when the attempt got no answer (`unanswered`), after the failed attempt is journaled and unless the call was cancelled, then
 * gives up like any failed call; every other seam makes the one attempt. What `latency` learns from the answer or the
 * timeout (a call counted once, by its final outcome) decides whether an advisory seam is asked at all: a call it skips
 * journals nothing and returns undefined, as a failed one does, and only the breaker's own transitions are written, under the seam
 * `judgment-breaker`.
 */
export function createTurnJudge(port: JudgmentPort | undefined, writer: TurnEventWriter, turnId: string, latency: JudgmentLatency = new JudgmentLatency()): TurnJudge | undefined {
  if (!port) return undefined;
  const journal = (payload: JudgmentClassifiedPayload) => journalJudgment(writer, turnId, payload);
  const journalTransition = (transition: BreakerTransition) =>
    journal({ seam: BREAKER_SEAM, providerId: port.providerId, modelId: port.model, elapsedMs: 0, ...breakerRow(transition) });
  return async (seam, request, signal, options) => {
    const admitted = latency.admit(port, seam);
    if (!admitted.ask) { signal.throwIfAborted(); return undefined; }
    const { slot } = admitted;
    // The slot is told how the call ended exactly once; a call that ended any other way (a cancel, a refused journal write) tells nothing.
    let reported = false;
    const report = <T>(outcome: () => T): T => { reported = true; return outcome(); };
    try {
      if (admitted.entered) await journalTransition("probe");
      const base = { seam, providerId: port.providerId, modelId: port.model };
      const attempts = retriesSeam(seam) && !latency.stalled(port) ? 2 : 1;
      for (let attempt = 1; ; attempt += 1) {
        const started = performance.now();
        let result: JudgmentResult;
        try {
          const answered = await port.judge(request, signal, { timeoutMs: JUDGMENT_ATTEMPT_TIMEOUT_MS });
          result = { ...answered, answers: Object.fromEntries(Object.entries(answered.answers).map(([id, answer]) => [id, roundAnswer(answer)])) };
        } catch (error) {
          if (signal.aborted) throw error;
          const again = attempt < attempts && unanswered(error);
          const transition = !again && error instanceof AgenticError && error.code === "timeout" ? report(() => slot.timedOut()) : undefined;
          await journal({ ...base, outcome: "failed", elapsedMs: elapsedSince(started),
            reason: (error instanceof Error ? error.message : String(error)).slice(0, MAX_REASON_CHARS) });
          if (again) { signal.throwIfAborted(); continue; }
          if (transition) await journalTransition(transition);
          return undefined;
        }
        const elapsedMs = elapsedSince(started);
        const transition = report(() => slot.answered());
        const verdict = await options?.verdict?.(result.answers);
        await journal({ ...base, modelId: result.modelId.slice(0, 128), outcome: "answered", elapsedMs,
          answers: Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [id, journaled(answer)])), ...(verdict ? { verdict } : {}) });
        if (transition) await journalTransition(transition);
        return result;
      }
    } finally {
      if (!reported) slot.inconclusive();
    }
  };
}
