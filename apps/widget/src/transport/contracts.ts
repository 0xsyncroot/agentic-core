type AgentChatAwaitable<T> = T | Promise<T>;

interface AgentChatAgentProfile {
  /** Stable server-side routing key. The display name does not select an agent. */
  readonly id?: string;
  readonly name?: string;
  readonly logoUrl?: string;
}

interface AgentChatOperationContext {
  readonly operation: "runtime" | "history" | "sessions" | "turn" | "interaction" | "cancel" | "interject";
  readonly sessionId: string;
  readonly requestId: string;
  readonly agentProfileId?: string;
  readonly interactionId?: string;
  readonly interactionKind?: AgentChatInteractionKind;
  readonly signal: AbortSignal;
}

interface AgentChatEndpointContext extends AgentChatOperationContext {
  readonly baseUrl: string;
}

type AgentChatEndpoint = string | URL | ((context: AgentChatEndpointContext) => AgentChatAwaitable<string | URL>);

interface AgentChatHarnessEndpoints {
  /** Set to false when the service has no runtime/health endpoint. */
  readonly runtime?: AgentChatEndpoint | false;
  /** Set to false when the service has no conversation-history endpoint. */
  readonly history?: AgentChatEndpoint | false;
  readonly sessions?: AgentChatEndpoint | false;
  readonly turnStream?: AgentChatEndpoint;
  /** Set to false only when the gateway deliberately does not support human interaction resume. */
  readonly interactionStream?: AgentChatEndpoint | false;
  /** Set to false only when the gateway cannot cancel a detached turn explicitly. */
  readonly cancelTurn?: AgentChatEndpoint | false;
  /** Set to false when the gateway cannot take a message into a turn that is already running. */
  readonly interjectTurn?: AgentChatEndpoint | false;
}

interface AgentChatHttpRequestContext extends AgentChatOperationContext {
  readonly url: string;
}

type AgentChatHeaderProvider = HeadersInit | ((context: AgentChatHttpRequestContext) => AgentChatAwaitable<HeadersInit>);
type AgentChatRequestExecutor = (url: string, init: RequestInit, context: AgentChatHttpRequestContext) => Promise<Response>;

interface AgentChatSseFrame {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
}

type AgentChatStreamEvent =
  | { readonly type: "progress"; readonly progress: unknown }
  | { readonly type: "assistant-output-start"; readonly outputId: string; readonly audience: "user"; readonly turnId?: string }
  | { readonly type: "assistant-output-delta"; readonly outputId: string; readonly audience: "user"; readonly delta: string; readonly turnId?: string }
  | { readonly type: "assistant-output-end"; readonly outputId: string; readonly audience: "user"; readonly status: "completed" | "discarded"; readonly turnId?: string }
  | { readonly type: "assistant-narration-start"; readonly narrationId: string; readonly audience: "user"; readonly turnId?: string; readonly kind?: "draft" }
  | { readonly type: "assistant-narration-delta"; readonly narrationId: string; readonly audience: "user"; readonly delta: string; readonly turnId?: string }
  | { readonly type: "assistant-narration-end"; readonly narrationId: string; readonly audience: "user"; readonly status: "completed" | "discarded"; readonly turnId?: string }
  /** `narrationId`, told earlier in the turn, leaves the chat: the step that told `by` ran without progress. */
  | { readonly type: "assistant-narration-superseded"; readonly narrationId: string; readonly audience: "user"; readonly by: string; readonly turnId?: string }
  | { readonly type: "assistant-reasoning-start"; readonly reasoningId: string; readonly audience: "user"; readonly turnId?: string }
  | { readonly type: "assistant-reasoning-delta"; readonly reasoningId: string; readonly audience: "user"; readonly delta: string; readonly turnId?: string }
  | { readonly type: "assistant-reasoning-end"; readonly reasoningId: string; readonly audience: "user"; readonly status: "completed" | "discarded"; readonly turnId?: string }
  // `step` is the runtime's own numeric model-step ordinal (envelope/idempotency bookkeeping); the
  // widget never renders it, only `workStepId` (the plan step's own id) says where a call belongs.
  | { readonly type: "plan-updated"; readonly turnId: string; readonly step?: number; readonly cause: AgentChatPlanCause; readonly plan: AgentChatWorkPlan; readonly changedStepIds?: readonly string[] }
  | { readonly type: "tool-started"; readonly turnId: string; readonly step?: number; readonly callId: string; readonly label?: string; readonly workStepId?: string }
  | { readonly type: "tool-completed"; readonly turnId: string; readonly step?: number; readonly callId: string; readonly label?: string; readonly workStepId?: string; readonly status: AgentChatToolStatus }
  | { readonly type: "activity"; readonly activity: AgentChatActivity }
  | { readonly type: "metadata"; readonly data: unknown }
  /** The gateway replays this request from the start: whatever the turn drew so far is stale. */
  | { readonly type: "stream-reset" }
  | { readonly type: "result"; readonly result: AgentChatTurnResult }
  | { readonly type: "error"; readonly error: Error };

type AgentChatActivityCode =
  | "analyzing"
  | "working"
  | "composing"
  | "retrying"
  | "revising"
  | "safety-limit"
  | "completed"
  | "failed";

/** Agent-authored execution trace: the step wording comes from the agent, never from the widget. */
interface AgentChatWorkPlanStep {
  readonly id: string;
  readonly description: string;
  readonly status: "pending" | "in_progress" | "completed" | "blocked";
  readonly outcome?: string;
}

/** The runtime's own lifecycle for the plan; the widget renders it, it never infers it. */
type AgentChatWorkPlanState = "active" | "awaiting_user" | "completed" | "stopped" | "failed";

/** Why a `plan-updated` frame arrived: a fresh model proposal, a reopened plan, or the turn's closing state. */
type AgentChatPlanCause = "proposal" | "restore" | "terminal";

/** Terminal state of one tool call, published by the runtime — never guessed from a phrase. */
type AgentChatToolStatus = "succeeded" | "failed" | "cancelled" | "denied" | "not_started" | "outcome_unknown";

interface AgentChatWorkPlan {
  /** Identity the runtime assigns; absent only for a legacy payload the widget must still render. */
  readonly planId?: string;
  readonly revision?: number;
  readonly state?: AgentChatWorkPlanState;
  readonly goal?: string;
  readonly steps: readonly AgentChatWorkPlanStep[];
}

/** A history entry's account of one tool call the turn made — its own row in the folded checklist. */
interface AgentChatHistoryTool {
  readonly callId: string;
  readonly label?: string;
  readonly status: AgentChatToolStatus;
  readonly workStepId?: string;
}

/** What a past turn did, kept in history so a reload can rebuild the same folded checklist live had. */
interface AgentChatHistoryWork {
  readonly durationMs?: number;
  readonly decision?: string;
  readonly plan?: Readonly<Pick<AgentChatWorkPlan, "planId" | "state" | "steps">>;
  readonly tools: readonly AgentChatHistoryTool[];
}

interface AgentChatActivity {
  readonly id: string;
  readonly code: AgentChatActivityCode;
  /** `awaiting` only ever accompanies `code: "completed"`: the stream ended, but on a card, not an answer. */
  readonly state: "active" | "done" | "partial" | "awaiting";
  /**
   * What this activity is, in the user's words, when the server chose to say.
   *
   * The widget is never told which tool is running — tool identity stays server-side — so its
   * own copy for `working` can only be one generic sentence for every call. A product that
   * publishes a business phrase for a tool gets that phrase rendered instead.
   */
  readonly label?: string;
}

type AgentChatStreamProtocolResult = AgentChatStreamEvent | readonly AgentChatStreamEvent[] | null;
type AgentChatStreamProtocol = (frame: AgentChatSseFrame, context: AgentChatOperationContext) => AgentChatStreamProtocolResult;

interface AgentChatReconnectOptions {
  /** Reconnects after an interrupted response; does not count the initial request. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Wall-clock bound on all resumptions of one request, so a long outage ends in one failure. 0 (default) = attempts only. */
  readonly maxTotalMs?: number;
  /** Per-attempt wait for response headers before the attempt is aborted and resumed. Default 30000; 0 disables. */
  readonly headersTimeoutMs?: number;
  /** Silence (heartbeats count as data) on an open stream before the attempt is aborted and resumed. Default 45000; 0 disables. */
  readonly idleTimeoutMs?: number;
}

interface AgentChatConnectionOptions {
  readonly kind?: "gateway-harness";
  /** Base URL of the Agentic web harness/gateway, not an LLM or display-agent URL. */
  readonly baseUrl: string | URL;
  readonly endpoints?: AgentChatHarnessEndpoints;
  /** Static headers or a per-request async provider for token refresh/signing. */
  readonly headers?: AgentChatHeaderProvider;
  readonly credentials?: RequestCredentials;
  /** Injectable HTTP executor for signing, retry, tracing and deterministic tests. */
  readonly request?: AgentChatRequestExecutor;
  /** Maps an alternative SSE dialect into normalized widget events. */
  readonly protocol?: AgentChatStreamProtocol;
  /** Defaults to three bounded resumptions using the same requestId and Last-Event-ID. */
  readonly reconnect?: AgentChatReconnectOptions | false;
  /**
   * Response header the gateway sets, with this value, when it answered a resume as a brand-new run
   * (it lost the earlier one, e.g. after a restart). The transport then emits `stream-reset` so the
   * widget drops the partial output it already drew before the replay starts again from event 0.
   */
  readonly streamReset?: { readonly header: string; readonly value?: string };
}
