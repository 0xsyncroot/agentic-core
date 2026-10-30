/**
 * @internal Domain shapes carried over the transport contract: attachments, cards (approval/
 * interaction), history and the turn result — split out of transport/contracts.ts to keep both
 * files under the source line limit (builder rule 6). Same global script scope as contracts.ts.
 */

interface AgentChatTransportAttachment {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly source: AgentChatAttachmentSource;
  readonly data?: unknown;
}

interface AgentChatTurnRequest {
  readonly content: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly attachments: readonly AgentChatTransportAttachment[];
  readonly replyTo?: AgentChatReply;
  readonly agentProfileId?: string;
  /** Opt-in context intended for the server. hostContext is never copied here. */
  readonly agentContext?: Readonly<Record<string, unknown>>;
}

type AgentChatInteractionKind = "approval" | "form" | "external";
type AgentChatApprovalDecision = "approve" | "deny";
type AgentChatInteractionAction = "accept" | "decline" | "cancel";

interface AgentChatApprovalPresentation {
  readonly summary: string;
  readonly action: string;
  readonly target: string;
  readonly impact: string;
  readonly fields?: readonly { readonly label: string; readonly value: string | number | boolean }[];
}

interface AgentChatApprovalChallenge {
  readonly kind: "approval";
  readonly approvalId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolId: string;
  readonly sideEffect: "none" | "idempotent" | "nonIdempotent";
  readonly expiresAt: string;
  /** The conversation moved on after this was raised, so it no longer reflects the request. */
  readonly superseded?: boolean;
  readonly agentProfileId?: string;
  readonly presentation?: AgentChatApprovalPresentation;
  /** Only ever set from history; a live card's state is what the widget itself just resolved. */
  readonly state?: "pending" | "approved" | "denied" | "superseded" | "expired";
}

/** What the user picked, read back with the schema's own titles — never the raw submitted value. */
interface AgentChatInteractionEcho {
  readonly label: string;
  readonly value: string;
}

interface AgentChatInteractionBinding {
  readonly interactionId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolId: string;
  readonly requesterId: string;
  readonly message: string;
  readonly title?: string;
  readonly expiresAt: string;
  readonly agentProfileId?: string;
  /** Only ever set from history; a live card's state is what the widget itself just resolved. */
  readonly state?: "pending" | "answered" | "declined" | "superseded" | "expired";
  readonly echo?: readonly AgentChatInteractionEcho[];
}

interface AgentChatFormInteractionChallenge extends AgentChatInteractionBinding {
  readonly kind: "form";
  readonly requestedSchema: Readonly<Record<string, unknown>>;
}

interface AgentChatExternalInteractionChallenge extends AgentChatInteractionBinding {
  readonly kind: "external";
  readonly url: string;
  readonly externalId: string;
}

type AgentChatHumanInteractionChallenge = AgentChatFormInteractionChallenge | AgentChatExternalInteractionChallenge;

type AgentChatInteractionRequest = {
  readonly kind: "approval";
  readonly interactionId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly decision: AgentChatApprovalDecision;
  readonly agentProfileId?: string;
} | {
  readonly kind: "form" | "external";
  readonly interactionId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly action: AgentChatInteractionAction;
  readonly content?: unknown;
  readonly agentProfileId?: string;
};

interface AgentChatTurnResult {
  readonly content: string;
  readonly turnId?: string;
  readonly ui?: unknown;
  readonly outcome?: string;
  readonly approval?: AgentChatApprovalChallenge;
  readonly interaction?: AgentChatHumanInteractionChallenge;
  /**
   * Sentences sent with `interjectTurn` that this turn accepted but ended before reading (one that
   * arrived while the final answer was being written). The widget sends them on as the next turn.
   */
  readonly unreadInterjections?: readonly string[];
  readonly [key: string]: unknown;
}

type AgentChatHistoryStatus = "completed" | "partial" | "awaiting_approval" | "awaiting_interaction" | "failed" | "in_progress";

interface AgentChatHistoryMessage {
  readonly timeline?: readonly HistoryTimelineItem[];
  readonly attachments?: readonly Omit<AgentChatAttachment, "file">[];
  readonly role: "user" | "assistant" | "error";
  readonly content: string;
  readonly at?: string;
  readonly turnId?: string;
  /** Absent only for a legacy payload; a well-formed transport always states how the turn ended. */
  readonly status?: AgentChatHistoryStatus;
  /** How a `failed` turn failed, as the server classified it; `cancelled` is the person's own stop. */
  readonly failure?: { readonly code: string };
  /** Explicitly user-addressed narration emitted before the final answer. */
  readonly narrations?: readonly AgentChatNarration[];
  readonly work?: AgentChatHistoryWork;
  /** The prior turn this one resumed after an approval or interaction; its checklist is shared, not repeated. */
  readonly continuesTurnId?: string;
  readonly ui?: unknown;
  readonly approval?: AgentChatApprovalChallenge;
  readonly interaction?: AgentChatHumanInteractionChallenge;
}

interface AgentChatNarration {
  readonly id: string;
  readonly audience: "user";
  readonly content: string;
  readonly at?: string;
  /** An answer the review sent back, kept on screen while the work continued. */
  readonly draft?: true;
}

interface AgentChatTransportEventSink {
  readonly onEvent: (event: AgentChatStreamEvent) => void;
}

/**
 * The files of a turn's attachments the host did not upload itself, by attachment id.
 *
 * Beside the request rather than in it: the request is what a transport serializes, and a file is
 * not JSON. A transport that can carry files sends them with the turn (the built-in one does, as
 * `multipart/form-data`); one that cannot ignores this, and the turn carries names and sizes only.
 */
interface AgentChatTurnFiles {
  readonly attachmentFiles?: ReadonlyMap<string, File>;
}

interface AgentChatTransport {
  loadSessions?(context: AgentChatOperationContext, cursor?: string, query?: string): AgentChatAwaitable<AgentChatSessionPage>;
  checkConnection?(context: AgentChatOperationContext): AgentChatAwaitable<unknown>;
  loadHistory?(context: AgentChatOperationContext): AgentChatAwaitable<readonly AgentChatHistoryMessage[]>;
  send(request: AgentChatTurnRequest, context: AgentChatOperationContext & AgentChatTransportEventSink & AgentChatTurnFiles): Promise<AgentChatTurnResult>;
  resolveInteraction?(
    request: AgentChatInteractionRequest,
    context: AgentChatOperationContext & AgentChatTransportEventSink,
  ): Promise<AgentChatTurnResult>;
  cancelTurn?(context: AgentChatOperationContext): AgentChatAwaitable<void>;
  /**
   * Hands `content` to the turn named by `context.requestId`, which is still running.
   *
   * Resolves `false` when that turn did not take it — it had already finished, or it is holding
   * as many unread as it will. The widget shows that difference, because a sentence the user
   * typed to correct the agent that quietly went nowhere is the worst of the three outcomes.
   * Absent on a transport whose gateway cannot do this, and the widget then behaves as before.
   */
  interjectTurn?(
    request: { readonly content: string },
    context: AgentChatOperationContext,
  ): AgentChatAwaitable<boolean>;
  destroy?(): AgentChatAwaitable<void>;
}

/** @internal */
interface AgentChatComposition {
  readonly transport: AgentChatTransport;
  readonly connectionKey: string;
}

/** @internal */
class AgentChatTransportError extends Error {
  readonly code: string | undefined;
  readonly status: number | undefined;
  readonly retryable: boolean | undefined;
  readonly details: unknown;
  /** Why a resume was refused (expired | superseded | already-resolved | stale-binding), verbatim from the server. */
  readonly reason: string | undefined;
  /**
   * True only for a failure this transport diagnosed itself — a network error, a malformed
   * frame, a missing result — as opposed to a sentence the server (or a host callback such as
   * the headers provider) composed for the user. Only this kind is replaced by `labels.transportError`
   * in the chat; its own `message` still reaches `onError`/the console for diagnosis.
   */
  readonly transportFailure: boolean | undefined;

  constructor(message: string, options: { code?: string; status?: number; retryable?: boolean; details?: unknown; cause?: unknown; reason?: string; transportFailure?: boolean } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgentChatTransportError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
    this.details = options.details;
    this.reason = options.reason;
    this.transportFailure = options.transportFailure;
  }
}
