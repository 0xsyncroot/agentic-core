/**
 * @internal What the user sends while the agent is still working, and the turn cannot take it.
 *
 * A running turn takes typed words itself (`interject`): it reads them at its next step boundary,
 * the moment a correction is worth the most. It cannot take files — the runtime's mid-turn input is
 * words only (contracts `TurnInterjections.take(): string[]`) — and a transport without
 * interjections takes nothing at all. Those messages are put on screen at once, as the user's own,
 * marked as waiting, and go out in the order they were written as the next turns, each after the
 * one before it has finished. A turn that stops on a card for the user (an approval, a form) holds
 * the queue until that card is answered and its continuation is over: sending then would withdraw a
 * confirmation the user has not even read yet.
 */
interface QueuedSend {
  readonly content: string;
  readonly attachments: readonly PendingAttachment[];
  readonly reply: AgentChatReply | null;
  readonly row: HTMLElement;
}

/** The waiting mark under a queued message; removed the moment it is sent. */
function markQueued(row: HTMLElement, label: string): void {
  row.dataset.queued = "true";
  const note = document.createElement("div");
  note.className = "acw-user-queued";
  note.textContent = label;
  row.append(note);
}

function unmarkQueued(row: HTMLElement): void {
  delete row.dataset.queued;
  row.querySelector(":scope > .acw-user-queued")?.remove();
}

/** The label of the waiting mark, merged into AgentChatLabels (public-api.ts). */
interface AgentChatLabels {
  /** Under a message sent while the agent works that the running turn cannot take: it goes out as the next turn. */
  readonly queued?: string;
}
