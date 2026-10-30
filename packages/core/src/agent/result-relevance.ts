import type { JsonValue, JudgmentQuestion, SessionEvent, TurnJudge } from "@0xsyncroot/contracts";
import type { JudgmentSeamMode } from "./observation-review.js";
import { JudgmentMemo } from "./judgment-memo.js";

const MAX_RESULTS = 32;
const EXCERPT_CHARS = 1_500;
/** A retained result is read as a pointer only when the judge is this sure it is no longer needed. */
const NOT_NEEDED = 0.1;

const CONCURRENCY = 8;
/**
 * One question per result, never one call for all of them: asked about many results in one state, the judge keeps the
 * newest and drops pages the request still needs (docs/incidents/2026-10-10-core-result-relevance.md).
 */
const NEEDED: JudgmentQuestion = Object.freeze({ type: "noul", instructions: "Is the earlier tool result in the state still needed to complete the request (its figures or rows will be used, compared or checked again)?",
  criteria: { true: "It holds data the request is about, or the answer may quote or check it.", false: "It was a step on the way (a lookup, a list already narrowed, another period or object) and the request no longer depends on it." } }) as JudgmentQuestion;

function restoredId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try { const parsed = JSON.parse(raw) as { resultId?: unknown }; return typeof parsed.resultId === "string" ? parsed.resultId : undefined; } catch { return undefined; }
}

/** The retained results of a task that the model may now read as a pointer to `read_result`, by event id. */
export type ResultRelevance = (events: readonly SessionEvent[], askNew?: boolean) => Promise<ReadonlySet<string>>;

/**
 * Earlier results the request no longer needs, read short.
 *
 * A long task keeps every large result it read in the prompt of every later step. Results the
 * runtime retained (they carry a `resultId`, so `read_result` restores them) and that the model has
 * already read are offered to the turn's judge before a model step: is each still needed to complete
 * the request? One it is sure is not needed is projected as a pointer (journal untouched); the
 * newest results — anything after the model's last message — are never touched, and neither is a
 * result that cannot be restored. Journaled as `result-relevance`; in `shadow` nothing is shortened.
 *
 * A verdict holds while the request does (`memo`, kept across the task's turns): asked again a few messages on, or on
 * every resume, a result judged needed puts a judgment on the path to the next model call and rarely changes the answer.
 * Its key is the result and the request it was judged for.
 */
export function createResultRelevance(judge: TurnJudge | undefined, mode: JudgmentSeamMode | undefined, request: string, signal: AbortSignal,
  pinned: ReadonlySet<string> = new Set(), restoring: ReadonlySet<string> = new Set(), memo = new JudgmentMemo()): ResultRelevance | undefined {
  if (!judge || !mode || mode === "off") return undefined;
  let key = "", last: ReadonlySet<string> = new Set();
  // A result judged not needed stays a pointer (unless read back); one judged needed stays whole for this request.
  const verdictKey = (event: SessionEvent) => ({ seam: "result-relevance", eventId: event.eventId, request });
  return async (events, askNew = true) => {
    const lastAssistant = [...events].reverse().find((event) => event.type === "assistant/message")?.seq ?? -1;
    // A result the model read back is one it needs. Judged unneeded again, it would be read back again, a model step each.
    const restored = new Set(events.flatMap((event) => {
      const payload = event.payload as Record<string, unknown>;
      return event.type === "tool/intent" && restoring.has(String(payload.toolId)) ? [restoredId(payload.arguments)] : [];
    }));
    const candidates = events.filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return event.type === "tool/result" && event.seq < lastAssistant && typeof payload.resultId === "string"
        && !restoring.has(String(payload.toolId)) && !pinned.has(String(payload.toolId)) && !restored.has(payload.resultId);
    }).slice(-MAX_RESULTS);
    if (candidates.length === 0) return new Set();
    // One judgment per new state of the conversation: a context retry in the same step reuses it.
    const now = `${candidates.map((event) => event.eventId).join(",")}|${lastAssistant}`;
    if (now === key) return last;
    // Verdicts already given keep applying whatever the pressure: applied only above it, the context would go short, then
    // whole again once under it, step after step. Pressure decides only whether to ask anew.
    const notNeeded = (event: SessionEvent) => memo.get(verdictKey(event)) === true;
    if (!askNew) return mode !== "on" ? new Set() : new Set(candidates.filter(notNeeded).map((event) => event.eventId));
    const due = candidates.filter((event) => memo.get(verdictKey(event)) === undefined);
    for (let start = 0; start < due.length; start += CONCURRENCY) {
      await Promise.all(due.slice(start, start + CONCURRENCY).map(async (event) => {
        const payload = event.payload as Record<string, unknown>;
        const result = { tool: String(payload.toolId ?? ""), excerpt: JSON.stringify(payload.result ?? null).slice(0, EXCERPT_CHARS) };
        const judged = await judge("result-relevance", { state: { request, result } as JsonValue, questions: { needed: NEEDED } }, signal);
        const answer = judged?.answers.needed;
        if (answer?.type === "noul") memo.set(verdictKey(event), answer.noul <= NOT_NEEDED);
      }));
    }
    key = now;
    last = mode !== "on" ? new Set() : new Set(candidates.filter(notNeeded).map((event) => event.eventId));
    return last;
  };
}
