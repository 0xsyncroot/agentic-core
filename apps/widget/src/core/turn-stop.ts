/**
 * @internal What a turn the person stopped leaves on screen, and what its decision card says afterwards.
 *
 * A stop is not a failure: what was shown stays, open, under one neutral line; nothing folds, because the work did not
 * finish. The card the turn resumed from is settled, since the server has already carried out its decision; left
 * clickable, a second press would open a new row with the server's refusal.
 */
const STOPPED_TURN_SENTENCE = "Đã dừng xử lý theo yêu cầu.";

/** @internal Said on a card whose resume the person stopped before the server acted on it: it can be answered again. */
const STOPPED_CARD_SENTENCE = "Đã dừng; có thể thử lại.";

/** @internal The person's own stop: the local abort of the stream, never a failure the server reported. */
function userStopped(error: Error): boolean {
  return error.name === "AbortError";
}

/** @internal The one neutral line a stopped turn ends with, below whatever it had already shown. */
function stoppedLine(sentence: string): HTMLElement {
  const line = document.createElement("div");
  line.className = "acw-stop-line";
  line.textContent = sentence;
  return line;
}

/**
 * @internal A frame the server sends only after it recorded the decision a resume carries.
 *
 * Neither the HTTP answer nor the turn's first frame is one: both come before the decision is written, and a stop
 * there leaves the card open on the server. The approved call is the resume's first dispatch, told by `tool-started`
 * right after the decision is journaled; a turn the server finished (even paused on a new card) recorded it as well.
 */
function decisionActedOn(event: AgentChatStreamEvent): boolean {
  return event.type === "tool-started" || (event.type === "activity" && event.activity.code === "completed");
}

/** @internal The server's word that this card was already answered: it settles the card, and no turn is shown for it. */
function resumeAlreadyResolved(error: Error): boolean {
  return error instanceof AgentChatTransportError && error.reason === "already-resolved";
}

/** @internal A history entry for a turn the person stopped: replayed as it looked live, open, with the neutral line. */
function historyTurnStopped(message: AgentChatHistoryMessage): boolean {
  return message.status === "failed" && message.failure?.code === "cancelled";
}
