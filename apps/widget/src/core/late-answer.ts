/**
 * @internal A card the server can no longer resume — past its time, or answered by the server as expired, superseded or
 * out of date — still takes the person's answer: it goes into the conversation as their next message, which the agent reads
 * with the whole history; locking it would mean the agent never hears what was chosen. A card of another
 * conversation still locks: its answer has no place in this one.
 */
const LATE_CARD_SENTENCE = "Đã quá thời gian chờ — câu trả lời sẽ được gửi như một tin nhắn mới.";
/** @internal Said once the late answer has gone as a message. */
const LATE_SENT_SENTENCE = "Câu trả lời đã được gửi như một tin nhắn mới.";

/** @internal The answer as the message the person would have typed: the choice itself, or what was declined or allowed. */
function lateAnswerText(kind: "interaction" | "approval", accepted: boolean, title: string, echo?: readonly AgentChatInteractionEcho[]): string {
  const subject = title.trim() ? `: ${title.trim().slice(0, 160)}` : "";
  if (kind === "approval") return `${accepted ? "Cho phép" : "Từ chối"}${subject}`;
  if (!accepted) return `Bỏ qua câu hỏi${subject}`;
  const answers = (echo ?? []).filter((item) => item.value.trim());
  if (answers.length === 1) return answers[0]!.value;
  return answers.length ? answers.map((item) => `${item.label}: ${item.value}`).join("; ") : `Đã trả lời câu hỏi${subject}`;
}

/** @internal The server's own word that this card can no longer be resumed in place. */
function resumeGone(error: unknown): boolean {
  return error instanceof AgentChatTransportError && ["expired", "superseded", "stale-binding"].includes(String(error.reason));
}

/** @internal A card past its time, or recorded as expired: answerable late, as a message. */
function cardLate(card: { readonly expiresAt: string; readonly state?: string }): boolean {
  return card.state === "expired" || Date.parse(card.expiresAt) <= Date.now();
}

/** @internal What a settled approval card says, by the state history recorded. */
const SETTLED_APPROVAL_SENTENCE: Readonly<Record<string, string>> = Object.freeze({
  approved: "Đã cho phép thao tác này.", denied: "Đã từ chối thao tác này.",
  superseded: "Yêu cầu này không còn khớp với nội dung trao đổi mới nhất. Hãy yêu cầu lại nếu vẫn cần.",
});
