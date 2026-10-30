/** Public browser API declarations emitted with agentic-chat-widget.d.ts. */
interface AgentChatMessage {
  readonly role: "user" | "assistant" | "error";
  /** Present for assistant output so host applications can distinguish narration from the final answer. */
  readonly kind?: "narration" | "final";
  readonly content: string;
  readonly at: string;
  readonly turnId?: string;
  readonly ui?: unknown;
  readonly attachments?: readonly AgentChatAttachment[];
  readonly replyTo?: AgentChatReply;
}

interface AgentChatReply {
  readonly author: string;
  readonly content: string;
  readonly turnId?: string;
}

type AgentChatAttachmentSource = "picker" | "paste" | "drop" | "capture-chat" | "capture-screen";

interface AgentChatAttachment {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly source: AgentChatAttachmentSource;
  readonly file: File;
}

interface AgentChatAttachmentUploadContext {
  readonly id: string;
  readonly source: AgentChatAttachmentSource;
  readonly sessionId: string;
}

interface AgentChatFeedback {
  readonly value: "up" | "down";
  readonly content: string;
  readonly turnId?: string;
}

type AgentChatActionType = "open" | "close" | "destroy" | "new-session" | "send" | "interject" | "cancel" | "interaction" | "quote" | "copy" | "feedback" | "attachment" | "resize" | "mode-change" | "ui-action" | "link";

interface AgentChatAction {
  readonly type: AgentChatActionType;
  readonly sessionId: string;
  readonly at: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

interface AgentChatResizeEvent {
  readonly width: number;
  readonly previousWidth: number;
}

interface AgentChatUiButton {
  readonly id: string;
  readonly label: string;
  readonly behavior?: "event" | "submit" | "link";
  readonly value?: string;
  readonly href?: string;
  readonly variant?: "primary" | "secondary" | "ghost";
  readonly disabled?: boolean;
}

interface AgentChatUiStep {
  readonly id: string;
  readonly label: string;
  readonly status?: "pending" | "active" | "completed" | "failed";
  readonly href?: string;
  readonly expanded?: boolean;
  readonly children?: readonly AgentChatUiStep[];
}

interface AgentChatUiStepToggleEvent {
  readonly blockId?: string;
  readonly stepId?: string;
  readonly label: string;
  readonly open: boolean;
  readonly sessionId: string;
}

interface AgentChatUiActionEvent {
  readonly action: AgentChatUiButton;
  readonly blockId?: string;
  readonly message: string;
  readonly sessionId: string;
}

interface AgentChatLinkEvent {
  readonly href: string;
  readonly label: string;
  readonly sessionId: string;
}

interface AgentChatRenderContext {
  readonly index: number;
  readonly message: string;
  readonly sessionId: string;
}

type AgentChatResolveReason = "initial" | "open" | "new-session" | "refresh";

interface AgentChatResolveSeed {
  readonly reason: AgentChatResolveReason;
  readonly sessionId: string;
  readonly mode: "floating" | "docked";
  readonly opened: boolean;
  readonly agent: Readonly<{ id?: string; name: string }>;
  readonly location: Readonly<{ href: string; title: string; referrer: string }>;
  readonly signal: AbortSignal;
}

interface AgentChatResolveContext extends AgentChatResolveSeed {
  /** Browser-only integration data. It is never sent to the transport implicitly. */
  readonly hostContext: unknown;
  readonly runtime?: unknown;
}

type AgentChatResolvable<T> = T | ((context: AgentChatResolveContext) => AgentChatAwaitable<T>);
type AgentChatContextProvider = unknown | ((context: AgentChatResolveSeed) => AgentChatAwaitable<unknown>);

interface AgentChatOptions {
  /** How the widget looks for a backend that stopped answering; see ConnectionRecoveryOptions. */
  readonly connectionRecovery?: ConnectionRecoveryOptions;
  /** @deprecated Use connection.baseUrl. This is the Agentic web harness base URL, not a model/agent URL. */
  readonly apiBaseUrl?: string;
  /** Built-in HTTP/SSE connection to the Agentic web harness or gateway. */
  readonly connection?: AgentChatConnectionOptions;
  /** Replaces HTTP/SSE completely (for WebSocket, GraphQL, native bridges, custom gateways, etc.). */
  readonly transport?: AgentChatTransport;
  readonly agent?: AgentChatAgentProfile;
  /** Stable server-side routing key. agentName remains display-only. */
  readonly agentProfileId?: string;
  readonly agentName?: string;
  readonly logoUrl?: string;
  /** Optional large illustration for the empty/welcome state; falls back to the agent logo. */
  readonly welcomeImageUrl?: string;
  readonly subtitle?: string;
  readonly badge?: string;
  readonly userName?: string;
  readonly welcomeTitle?: AgentChatResolvable<string>;
  readonly welcomeMessage?: AgentChatResolvable<string>;
  /** Supplies browser-only data to dynamic presentation resolvers. */
  readonly contextProvider?: AgentChatContextProvider;
  /** Explicit opt-in data sent with each agent request; validate it again on the server. */
  readonly agentContextProvider?: (context: AgentChatResolveContext) => AgentChatAwaitable<Readonly<Record<string, unknown>> | undefined>;
  readonly placeholder?: string;
  readonly suggestedPrompts?: readonly string[];
  /** Neutral by default; see AgentChatLabels and apps/widget/HOST-INTEGRATION.md. */
  readonly labels?: AgentChatLabels;
  /**
   * Conversation aggregate ID, not an identity or authentication value. When omitted,
   * the widget creates a random ID and optionally persists it under storageKey.
   */
  readonly sessionId?: string;
  readonly storageKey?: string;
  readonly persistSession?: boolean;
  readonly startOpen?: boolean;
  /** Hides the built-in round launcher so the host application can open the widget from its own controls. */
  readonly showLauncher?: boolean;
  readonly position?: "left" | "right";
  readonly mode?: "floating" | "docked";
  /** Show the optional dock/float button in the header. Default false; the menu stays conversation-only. */
  readonly showModeToggle?: boolean;
  readonly width?: number;
  readonly minWidth?: number;
  readonly maxWidth?: number;
  readonly resizable?: boolean;
  readonly persistSize?: boolean;
  /** The round launcher can be dragged (mouse or touch) anywhere on screen; a plain tap still opens the panel. */
  readonly draggableLauncher?: boolean;
  /** Remembers where the launcher was dragged to, under storageKey, and restores it on the next page. */
  readonly persistLauncherPosition?: boolean;
  /**
   * The host's brand colour, any CSS colour. Every brand-coloured surface — launcher, user
   * bubbles, links, buttons, focus rings, tinted borders and backgrounds — is derived from it.
   */
  readonly primaryColor?: string;
  /**
   * Second stop of the launcher, send-button and composer-border gradients. Defaults to
   * primaryColor when that is set (one flat colour), otherwise to the widget's own purple.
   */
  readonly accentColor?: string;
  /** CSP nonce used only by the legacy <style> fallback when constructable stylesheets are unavailable. */
  readonly styleNonce?: string;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly credentials?: RequestCredentials;
  readonly attachments?: boolean;
  readonly attachmentAccept?: string;
  readonly maxAttachments?: number;
  readonly maxAttachmentBytes?: number;
  readonly attachmentShortcuts?: boolean;
  /** Uploads a file and returns JSON-safe data (normally a URL) included in the chat request. */
  readonly uploadAttachment?: (file: File, context: AgentChatAttachmentUploadContext) => Promise<unknown>;
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
  /** Presentation only: compact mode keeps the turn and conversation alive. */
  readonly onCompactChange?: (compact: boolean) => void;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly onDestroy?: () => void;
  readonly onReady?: () => void;
  readonly onBeforeAction?: (action: AgentChatAction) => boolean | void;
  readonly onBeforeOpen?: (action: AgentChatAction) => boolean | void;
  readonly onBeforeClose?: (action: AgentChatAction) => boolean | void;
  readonly onBeforeDestroy?: (action: AgentChatAction) => boolean | void;
  readonly onAction?: (action: AgentChatAction) => void;
  readonly onResize?: (event: AgentChatResizeEvent) => void;
  readonly onModeChange?: (mode: "floating" | "docked") => void;
  readonly onSessionChange?: (sessionId: string) => void;
  readonly onProgress?: (progress: unknown) => void;
  /** Presentation only, never the text: a narration's characters so far, and an accepted answer's length once, just before it paints (e.g. to leave compact mode). */
  readonly onTextProgress?: (text: { readonly kind: "answer" | "narration"; readonly id: string; readonly chars: number }) => void;
  readonly onUiAction?: (event: AgentChatUiActionEvent) => boolean | void;
  readonly onUiStepToggle?: (event: AgentChatUiStepToggleEvent) => void;
  readonly onLinkClick?: (event: AgentChatLinkEvent) => boolean | void;
  readonly renderUiBlock?: (block: unknown, context: AgentChatRenderContext) => HTMLElement | null;
  readonly onMessage?: (message: AgentChatMessage) => void;
  /** Called only for explicitly user-addressed narration, never reasoning/progress/tool output. */
  readonly onNarration?: (message: AgentChatMessage) => void;
  readonly onFeedback?: (feedback: AgentChatFeedback) => void;
  readonly onQuote?: (message: AgentChatMessage) => void;
  readonly onAttachmentClick?: () => void;
  readonly onAttachmentsChange?: (attachments: readonly AgentChatAttachment[]) => void;
  readonly onError?: (error: Error) => void;
}

interface AgentChatController {
  open(): void;
  close(): void;
  toggle(): void;
  destroy(): void;
  newSession(): void;
  send(content: string): Promise<void>;
  interject(content: string): Promise<boolean>;
  /** Show the existing avatar and live status in place of the open panel. */
  setCompactMode(compact: boolean): void;
  addAttachments(files: FileList | readonly File[]): Promise<void>;
  clearAttachments(): void;
  getAttachments(): readonly AgentChatAttachment[];
  cancel(): void;
  getSessionId(): string;
  /** True while a turn is streaming: `send` and `newSession` do nothing until it ends. */
  isPending(): boolean;
  /** Puts text in the composer without sending it, for a host that prepares a request for the user. */
  setDraft(content: string): void;
  isOpen(): boolean;
  getElement(): HTMLElement;
  setMode(mode: "floating" | "docked"): void;
  getMode(): "floating" | "docked";
  refreshContext(): Promise<void>;
}

interface AgentChatGlobalApi {
  readonly version: string;
  create(options: AgentChatOptions): AgentChatController;
  init(options: AgentChatOptions): AgentChatController;
  createHarnessTransport(options: AgentChatConnectionOptions): AgentChatTransport;
}

/** Global API installed by agentic-chat-widget.js. */
declare const AgentChat: AgentChatGlobalApi;
