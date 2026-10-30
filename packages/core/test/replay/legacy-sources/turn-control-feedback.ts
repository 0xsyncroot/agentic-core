import type { ChatMessage, TurnControlPolicy } from "@0xsyncroot/contracts";

const WITHHELD_ANSWER_DELIMITER = "\n\nThe answer this concerns was withheld from the user and is not in the conversation. It read:\n";
const GUIDANCE_DELIMITER = "\n\nThis objection has now been raised twice. If it asks for a tool call, make that call now instead of"
  + " answering. Only if it cannot be satisfied with the tools and evidence available, do not repeat yourself: answer along"
  + " these lines, in your own words and in the language of the conversation:\n";
const KEPT_DRAFT_DELIMITER = "\n\nThe text you just wrote was shown to the user as progress; it will be folded away once the turn ends and is not in the conversation. It read:\n";
const MAX_WITHHELD_ANSWER_CHARS = 4_000;

export interface TurnControlFeedbackOptions {
  readonly withheldAnswer?: string | null;
  readonly keptAsNarration?: boolean;
  readonly guidance?: string;
}

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

export function withoutKeptDraft(message: ChatMessage): ChatMessage {
  const content = message.content ?? "";
  const start = content.indexOf(KEPT_DRAFT_DELIMITER);
  if (start < 0) return message;
  const guidance = content.indexOf(GUIDANCE_DELIMITER, start);
  return { ...message, content: `${content.slice(0, start)}${guidance < 0 ? "" : content.slice(guidance)}` };
}

export function turnControlObjection(message: ChatMessage): string {
  const content = message.content ?? "";
  const cuts = [WITHHELD_ANSWER_DELIMITER, KEPT_DRAFT_DELIMITER, GUIDANCE_DELIMITER].map((delimiter) => content.indexOf(delimiter)).filter((index) => index >= 0);
  return cuts.length === 0 ? content : content.slice(0, Math.min(...cuts));
}
