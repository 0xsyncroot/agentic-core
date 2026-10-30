/** Public browser API declarations emitted with agentic-chat-widget.d.ts: the words a host may supply. */
/**
 * Every persona/copy string the widget itself decides to show, with a neutral English default.
 *
 * The widget is a generic layer and writes no business-language sentence of its own; a host that
 * wants one (Sample App's "Em sẽ …" plan sentence, its Vietnamese transport-failure line, …) supplies
 * it here. Anything left out keeps its neutral default rather than falling back to Vietnamese.
 */
interface AgentChatLabels extends AgentChatConnectionLabels {
  /**
   * The plan told once as chat text, from the step descriptions the agent itself wrote. Returning
   * undefined (the default) renders no sentence at all — only the checklist.
   */
  readonly planSentence?: (descriptions: readonly string[]) => string | undefined;
  /** Shown when a turn ended with no answer and nothing else (a card, a UI block) carries the reply. */
  readonly emptyAnswer?: string;
  /** Shown in the chat for a connectivity/protocol failure the transport diagnosed itself; the technical detail still reaches onError/console. */
  readonly transportError?: string;
  /** The one faded line for a history turn with no terminal event yet. */
  readonly inProgress?: string;
  /** The live line's own wording while nothing more specific is known. */
  readonly thinking?: string;
  /**
   * The account's header while a turn has stopped for an approval or a question — never the
   * completion summary, which would claim the work finished while the user is still being asked.
   */
  readonly awaitingUser?: string;
  /**
   * Shown when something the user typed into a turn already running was not taken by it — the turn
   * had finished, or it is holding as many unread as it will. It needs its own sentence because the
   * message is already on screen as theirs: without one, the correction sits in the conversation
   * looking delivered and the agent never read it.
   */
  readonly interjectionRefused?: string;
  /** Shown under such a message once the running turn has read it (progress `interjection-received`). */
  readonly interjectionRead?: string;
}
