import type { ChatMessage, TurnControlPolicy } from "@0xsyncroot/contracts";

/** Opens the quoted answer inside a feedback message; everything before it is the objection. */
const WITHHELD_ANSWER_DELIMITER = "\n\nThe answer this concerns was withheld from the user and is not in the conversation. It read:\n";
/** Opens the guidance added to the second objection sent back (`objectionsHeard`). */
const GUIDANCE_DELIMITER = "\n\nYour output has been sent back again. If this objection asks for a tool call, make that call now instead of"
  + " answering. Only if it cannot be satisfied with the tools and evidence available, do not repeat yourself: answer along"
  + " these lines, in your own words and in the language of the conversation:\n";
/** Opens the quoted text instead when the user kept it on screen as progress (`keepDraftsAsNarration`). */
const KEPT_DRAFT_DELIMITER = "\n\nThe text you just wrote was shown to the user as progress; it will be folded away once the turn ends and is not in the conversation. It read:\n";
const MAX_WITHHELD_ANSWER_CHARS = 4_000;

export interface TurnControlFeedbackOptions {
  /** The text answer the policy rejected, quoted so the objection is about something concrete. */
  readonly withheldAnswer?: string | null;
  /** The user saw that text as progress: it is quoted as such, and the final answer is asked to stand on its own. */
  readonly keptAsNarration?: boolean;
  /** What to say instead, offered once an objection has already been sent back. */
  readonly guidance?: string;
}

/**
 * The objection as the next step will read it, carrying the answer it is about — and, on the
 * second objection sent back, what to say instead.
 *
 * A rejected answer is never journaled — it was not accepted — so on its own the objection
 * reached the model as a system message about a sentence it could no longer see. With nothing
 * to tell it which sentence, it wrote the same one again, the policy raised the identical
 * objection, and the turn ended on the fallback.
 *
 * The answer is quoted inside the objection rather than replayed as an assistant turn. System
 * messages are moved to the front of the transcript before the model sees them, so a replayed
 * turn would end up last, separated from the objection — and a transcript ending in an
 * assistant message is a prompt to continue that message, which is the one thing a withheld
 * answer must not become. One self-contained message keeps its meaning wherever it lands.
 * Only a text answer is quoted: a rejected tool call is already named by the feedback. A policy
 * that keeps drafts as narration gets the other reading of the same quote: the user saw it as
 * progress, and it folds away with the turn's account — so "do not repeat it" would leave a final
 * answer pointing at text nobody can see any more; the model is asked for one that stands alone.
 *
 * The guidance is the policy's own conservative answer, handed to the model as a way out
 * rather than substituted for its answer: written by the model, in context, it reads as part
 * of the conversation; pasted in by the runtime, it read as the assistant giving up.
 *
 * Neither block tells the model to write. An objection can ask for an action — read the data
 * back before concluding — and no rewrite satisfies that; told "write the corrected answer",
 * a model rewrote three times and the turn ended on the fallback under a plan that said the
 * write had succeeded. The trailer names both remedies and lets the objection pick.
 */
export function turnControlFeedback(policy: TurnControlPolicy, feedback: string, options: TurnControlFeedbackOptions = {}): ChatMessage {
  const answer = typeof options.withheldAnswer === "string" ? options.withheldAnswer.trim().slice(0, MAX_WITHHELD_ANSWER_CHARS) : "";
  const quoted = !answer ? "" : options.keptAsNarration
    ? `${KEPT_DRAFT_DELIMITER}"""\n${answer}\n"""\nContinue the work the objection names — with the tool call it asks for, if it asks for one. Your final answer must stand on its own and state the full result, in the language of the conversation.`
    : `${WITHHELD_ANSWER_DELIMITER}"""\n${answer}\n"""\nAddress the objection — with the tool call it asks for, if it asks for one; otherwise with a corrected answer — in the language of the conversation.`;
  const guidance = options.guidance?.trim() ? `${GUIDANCE_DELIMITER}"""\n${options.guidance.trim()}\n"""` : "";
  return {
    role: "system", content: `${feedback}${quoted}${guidance}`,
    context: { trust: "instruction", retention: "required", provenance: `turn-control:${policy.id}@${policy.revision}` },
  };
}

/**
 * A feedback message without the kept draft it quoted — what an earlier send-back becomes once a
 * later one quotes a newer draft. A policy that keeps drafts sends a turn back many times while
 * work remains, feedback is never compacted, and each quote is up to 4,000 characters of text the
 * model has since moved past; only its latest words are worth that room.
 */
export function withoutKeptDraft(message: ChatMessage): ChatMessage {
  const content = message.content ?? "";
  const start = content.indexOf(KEPT_DRAFT_DELIMITER);
  if (start < 0) return message;
  const guidance = content.indexOf(GUIDANCE_DELIMITER, start);
  return { ...message, content: `${content.slice(0, start)}${guidance < 0 ? "" : content.slice(guidance)}` };
}
