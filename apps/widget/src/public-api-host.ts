/**
 * A host that answers some question cards itself — a page that sees the person finish the task a card waits on
 * (apps/widget/HOST-INTEGRATION.md "Cards a host answers"). These merge into the declarations of public-api.ts.
 */

/** A form card still waiting for its answer, as the host sees it: what it asks and until when. */
interface AgentChatPendingInteraction {
  readonly interactionId: string;
  /** The tool that asked; "runtime" for the runtime's own question. */
  readonly toolId: string;
  readonly requesterId: string;
  /** The card's form schema as the tool sent it, including any keyword of the tool's own. */
  readonly requestedSchema: Readonly<Record<string, unknown>>;
  readonly expiresAt: string;
}

interface AgentChatOptions {
  /**
   * The newest form card still waiting for an answer, live or loaded from history; `null` once none is (answered,
   * skipped, replaced by a new message, expired, or the conversation changed).
   */
  readonly onInteractionChange?: (pending: AgentChatPendingInteraction | null) => void;
}

interface AgentChatController {
  /**
   * Answers a pending form card as if the person had sent `content` on it — values the card itself may not show
   * (a `readOnly` choice) included; the server validates them as any answer. False, and nothing sent, when the card
   * is not pending in this conversation, has expired, or a turn is running.
   */
  answerInteraction(interactionId: string, content: Readonly<Record<string, unknown>>): Promise<boolean>;
}
