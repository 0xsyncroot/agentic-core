import type { DataClassification, EventDraft } from "@0xsyncroot/contracts";
import type { AgentOutputChannel } from "./agent-output-channel.js";

/**
 * A policy's notice, added to the answer it accepted.
 *
 * Some facts an answer owes its reader are established by evidence, not by the model: a write the
 * system refused, a list the runtime had to cut. Checking that the model's prose admits them meant
 * reading it for words — a false claim got through with the right word in it, and an honest answer
 * without one was sent back until the turn ended on a canned reply. The policy states the fact in
 * the product's words; the runtime puts it after the answer, streamed into the same output and
 * journaled with it, so what the reader saw live is what history and replay show.
 */
export function withNotice<T extends { readonly content: string | null }>(answer: T, notice: string | undefined, draft: AgentOutputChannel): T {
  if (!notice) return answer;
  const separator = answer.content?.trim() ? "\n\n" : "";
  draft.appendCommitted(`${separator}${notice}`);
  return { ...answer, content: `${answer.content?.trimEnd() ?? ""}${separator}${notice}` };
}

/**
 * The journal entry for a noticed answer that was already journaled beside its plan update.
 *
 * That message was written before the plan ran and the answer was reviewed; the last message of a
 * turn is what history and replay read, so the answer with its notice is journaled after it.
 */
export function noticedAnswerDraft(
  answer: { readonly content: string | null }, notice: string | undefined,
  at: { readonly turnId: string; readonly stepId: string; readonly requestId: string; readonly attemptId: string; readonly classification?: DataClassification | undefined },
): readonly EventDraft[] {
  if (!notice) return [];
  return [{
    type: "assistant/message", turnId: at.turnId, stepId: at.stepId, requestId: at.requestId, attemptId: at.attemptId,
    ...(at.classification ? { classification: at.classification } : {}),
    payload: { content: answer.content, toolCalls: [], finishReason: "turn-control-notice" },
  }];
}

/**
 * The journal entry for an answer sent beside its plan update, once accepted.
 *
 * Such an answer is journaled after its review, not with the plan call it came with: written first, an answer the review
 * then sent back would stay in the transcript the next step reads, while the objection says it "is not in the
 * conversation". Carries the notice when the policy added one; it is the turn's last message either way.
 */
export function acceptedAnswerDraft(
  answer: { readonly content: string | null; readonly finishReason: string }, notice: string | undefined,
  at: { readonly turnId: string; readonly stepId: string; readonly requestId: string; readonly attemptId: string; readonly classification?: DataClassification | undefined },
): EventDraft {
  return {
    type: "assistant/message", turnId: at.turnId, stepId: at.stepId, requestId: at.requestId, attemptId: at.attemptId,
    ...(at.classification ? { classification: at.classification } : {}),
    payload: { content: answer.content, toolCalls: [], finishReason: notice ? "turn-control-notice" : answer.finishReason },
  };
}
