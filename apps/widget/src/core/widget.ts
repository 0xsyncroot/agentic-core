/// <reference path="../ui/connection-banner.ts" />
/// <reference path="./connection-monitor.ts" />
/// <reference path="../ui/conversation-browser.ts" />
/// <reference path="../ui/table-viewer.ts" />
/// <reference path="../ui/escape-before-host.ts" />
/// <reference path="../shared/stream-markdown.ts" />
/// <reference path="../ui/dock-layout.ts" />
/// <reference path="../ui/callout.ts" />
/// <reference path="../ui/header-menu-toggles.ts" />
/// <reference path="../ui/welcome-typing.ts" />
/// <reference path="../ui/send-queue.ts" />
/** @internal */
/** How many times one operation is resumed after a reconnection before its failure is final. */
const MAX_AUTO_RESUMES = 5;

interface WidgetSettings {
  readonly transport: AgentChatTransport;
  readonly connectionKey: string;
  readonly labels: ResolvedLabels;
  readonly agentProfileId?: string;
  readonly agentName: string;
  readonly logoUrl: string;
  readonly welcomeImageUrl: string;
  readonly subtitle: string;
  readonly badge: string;
  readonly userName: string;
  readonly welcomeTitle: AgentChatResolvable<string>;
  readonly welcomeMessage: AgentChatResolvable<string>;
  readonly placeholder: string;
  readonly suggestedPrompts: readonly string[];
  readonly storageKey: string;
  readonly persistSession: boolean;
  readonly startOpen: boolean;
  readonly showLauncher: boolean;
  readonly position: "left" | "right";
  readonly mode: "floating" | "docked";
  readonly showModeToggle: boolean;
  readonly dockLayout: "push" | "overlay";
  readonly dockedZIndex?: number;
  readonly persistMode: boolean;
  readonly dockedEdgeInset: number;
  readonly dockedPageMinWidth: number;
  readonly dockedCovers: readonly string[];
  readonly dockedMoves: readonly string[];
  readonly width: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly resizable: boolean;
  readonly persistSize: boolean;
  readonly draggableLauncher: boolean;
  readonly persistLauncherPosition: boolean;
  readonly attachments: boolean;
  readonly attachmentAccept: string;
  readonly maxAttachments: number;
  readonly maxAttachmentBytes: number;
  readonly attachmentShortcuts: boolean;
}

/** @internal */
interface PendingAttachment extends AgentChatAttachment {
  readonly previewUrl?: string;
}

/** @internal */
type TransportAttachment = AgentChatTransportAttachment;

/** @internal */
interface AssistantShell {
  readonly row: HTMLElement;
  readonly bubble: HTMLElement;
  readonly rich: HTMLElement;
  readonly actions: HTMLElement;
}

/** @internal A notice line (a retry, a safety stop) in a turn's folded account. */
interface TimelineRow {
  readonly key: string;
  readonly kind: "notice";
  readonly element: HTMLElement;
  readonly icon: HTMLElement;
  readonly label: HTMLElement;
}

/** @internal One tool call's own line — its mark comes straight from the status the runtime published. */
interface ToolRow {
  readonly element: HTMLElement;
  readonly label: HTMLElement;
}

/**
 * @internal A step of the agent's plan in the folded account's checklist: its words, its state on the
 * connecting line, and the tool work done inside it.
 */
interface StepItem {
  readonly id: string;
  readonly element: HTMLElement;
  readonly label: HTMLElement;
  readonly work: HTMLElement;
  /** The step's short title, which the live line shows while the step is being carried out. */
  title: string;
}

/** @internal */
interface TurnUi extends AssistantShell {
  readonly thinking: HTMLDetailsElement;
  readonly summaryLabel: HTMLElement;
  /** Everything the turn told and did before its answer, in the order it happened. */
  readonly timeline: HTMLElement;
  /**
   * The one line under what the turn has said so far, saying where it is: the plan step being
   * carried out — or, with no plan, the call being made, or just that it is thinking — its words
   * replaced in place. Its chevron opens the checklist while the turn still runs.
   */
  readonly liveLine: HTMLElement;
  /** The chevron on the live line; shown once there is a checklist to open onto. */
  readonly detailToggle: HTMLButtonElement;
  /** Under the live line: the latest call made for the step it names, replaced in place. */
  readonly callLine: HTMLElement;
  /** The call the call line speaks for, and the step it was made in: it stays until the step moves on. */
  lastCallId: string;
  lastCallStep: string;
  /** What each finished step found, told as chat text where the step ended — by step id. */
  readonly stepNotes: Map<string, HTMLElement>;
  /**
   * Whether the reader opened the checklist while the turn was still running. It starts closed:
   * the turn tells what it is doing as chat and on its two lines, and the checklist is the detail
   * behind them for whoever wants it.
   */
  detailOpen: boolean;
  /** The plan told as a sentence of chat text at the top of the turn, when the host supplies one. */
  planSentence: HTMLElement | null;
  /** Identity of the plan this turn is showing, so a later frame for the same plan updates in place. */
  planId: string;
  /** Whether the account shows its checklist yet: only once the turn has folded. */
  revealed: boolean;
  /** Notice lines (a retry, a safety stop) by key. */
  readonly rows: Map<string, TimelineRow>;
  readonly committedNarrations: Array<{ readonly content: string; readonly element: HTMLElement }>;
  readonly discardedOutputIds: Set<string>;
  narrationDraft: HTMLElement | null;
  streamedNarration: string;
  /** The live narration reached its cap and ends in "…"; later words of it are not kept. */
  narrationClipped: boolean;
  narrationRenderFrame: number | null;
  activeNarrationId: string;
  activeNarrationTurnId: string;
  /** What the open output has written so far: gathered, never painted until the runtime accepts it. */
  streamedOutput: string;
  activeOutputId: string;
  /** What stands in the answer bubble while an output is written or reviewed: the answer itself lands whole. */
  draftNote: HTMLElement | null;
  /** A policy sent the last draft back, so the note says the answer is being reviewed. */
  revisionRequested: boolean;
  /** Id of the reasoning block currently open; its text is never rendered. */
  activeReasoningId: string;
  /** What the model is thinking right now, as far as it has been sent; gone when the thought ends. */
  thought: string;
  thoughtFrame: number | null;

  /** Each plan step's checklist entry, by step id, once the agent reached it. */
  readonly steps: Map<string, StepItem>;
  /** The step being carried out, whose tool work is told under its line. */
  activeStep: string;
  /** Turns this one resumed after a decision: they fold only when this one's work is done. */
  readonly resumes: TurnUi[];
  /** When this turn started, so its summary can say how long it has been running. */
  readonly startedAt: number;
  /** Every tool call's own line, by callId — kept after it ends so its status can still be updated. */
  readonly toolRows: Map<string, ToolRow>;
  /** callIds with no `tool-completed` yet, in the order they started; the live line follows the latest. */
  readonly activeToolCallIds: Set<string>;
  completed: boolean;
  /** What the summary says once this turn is folded after pausing: how long it ran itself, measured when it stopped. */
  ranSummary: string;
  /** The server has acted on the decision this turn resumes with (turn-stop.ts `decisionActedOn`). */
  acted: boolean;
}

/** @internal */
type UnknownRecord = Record<string, unknown>;

/** @internal */
const WIDGET_VERSION = "0.1.0";
/** @internal */
const SESSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
/** Timeline entries that are the turn speaking — in view whether or not the checklist is open. */
const THOUGHT_KEPT_CHARS = 600;
const THOUGHT_LINE_CHARS = 150;
const THOUGHT_MIN_CHARS = 24;
const SPOKEN_KINDS: ReadonlySet<string> = new Set(["narration", "step-note"]);
/** @internal */
/** @internal */
/**
 * What the trace says about a tool call when the server publishes no phrase for that tool.
 *
 * Tool identity stays server-side, so this one sentence has to cover every call the widget is
 * told about. That is exactly why rows are keyed by their text: without it, a turn that reads
 * two business sources renders this line twice and claims two different things happened.
 */
const TOOL_TRACE_FALLBACK = "Đang truy xuất dữ liệu nghiệp vụ…";
/** @internal How long a finished turn's account takes to fold away under its summary line. */
const FOLD_DURATION_MS = 320;
/** @internal How long the composer says why a file did not join the tray: long enough to read twice. */
const ATTACHMENT_NOTICE_MS = 8_000;
/** @internal What the live line is saying: a tool call, a notice, the step being carried out, or nothing known yet. */
type LiveSource = "thinking" | "step" | "work" | "notice";
/** @internal The glyph beside a line: work running, a notice, a step not yet done, or work that finished. */
type Glyph = "work" | "notice" | "waiting" | "done";
/**
 * @internal Trace entry states. "skipped" marks a planned step the agent never reached; "muted"
 * marks a tool call the runtime says never really ran (cancelled or not started).
 */
type TraceState = "pending" | "active" | "paused" | "done" | "partial" | "skipped" | "error" | "muted";

/** @internal Distance from the bottom that still counts as "following the stream". */
const STICK_TO_BOTTOM_SLACK_PX = 56;
/** @internal How long a smooth jump to the bottom may take before its scroll events count as the user's. */
const SMOOTH_SCROLL_SETTLE_MS = 800;
const OUTPUT_MAX_CHARS = 256_000;
/** @internal Where the user put the launcher, in viewport pixels. Clamped only when painted. */
interface LauncherPosition { readonly left: number; readonly top: number }
/**
 * @internal A press that travels less than this is a click. Fingers and mice both wobble a few
 * pixels on a plain tap, and a zero threshold turns every tap into a drag that never opens the panel.
 */
const LAUNCHER_DRAG_THRESHOLD_PX = 6;
/** @internal Size to clamp against while the launcher is hidden — `display: none` measures as 0. */
const LAUNCHER_SIZE_PX = 58;

/** @internal Application facade coordinating view, context and transport ports. */
class EmbeddedAgentChat implements AgentChatController {
  readonly #options: AgentChatOptions;
  readonly #settings: WidgetSettings;
  readonly #host: HTMLElement;
  readonly #shadow: ShadowRoot;
  readonly #root: HTMLElement;
  /** Full-size view of an answer's table; closed whenever the chat steps aside or closes. */
  readonly #tables: TableViewer;
  readonly #launcher: HTMLButtonElement;
  readonly #compactStatus: HTMLElement;
  readonly #compactLabel: HTMLElement;
  readonly #compactMessage: HTMLElement;
  /** The card a host asked for (showCallout), placed against the launcher or the panel. */
  readonly #callout: CalloutView;
  readonly #panel: HTMLElement;
  readonly #conversation: HTMLElement;
  /** The way back down once the user has scrolled up; visible only while they are away. */
  readonly #jump: HTMLButtonElement;
  readonly #liveTurns = new Set<TurnUi>();
  /** Turns stopped on a decision, by the approval or interaction they are waiting on. */
  readonly #pausedTurns = new Map<string, TurnUi>();
  /** Form cards still waiting, for a host that answers some itself (`onInteractionChange`, `answerInteraction`). */
  readonly #pendingInteractions = new PendingInteractionLedger({
    report: (pending) => { try { this.#options.onInteractionChange?.(pending); } catch { /* Host callback. */ } },
    expire: ({ status }) => { status.textContent = LATE_CARD_SENTENCE; },
  });
  /** Every history turn built so far this load, by turnId, so a `continuesTurnId` chain can find its earlier turn. */
  readonly #historyTurns = new Map<string, TurnUi>();
  /** Ticks only while a turn is running; one for the widget, not one per turn. */

  #scrollFrame: number | null = null;
  #stickToBottom = true;
  /** Until when scroll events belong to a smooth jump the widget started, not to the user. */
  #settleUntil = 0;
  /** Folds in progress: the widget moving the view itself, which is not the user leaving the bottom. */
  #reflowing = 0;
  readonly #form: HTMLFormElement;
  readonly #input: HTMLTextAreaElement;
  readonly #sendButton: HTMLButtonElement;
  readonly #attachButton: HTMLButtonElement;
  readonly #fileInput: HTMLInputElement;
  readonly #attachmentMenu: HTMLElement;
  readonly #attachmentTray: HTMLElement;
  /** Why the last file did not join the tray, said where the user is looking. */
  readonly #attachmentNotice: HTMLElement;
  #attachmentNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #replyPreview: HTMLElement;
  readonly #connection: HTMLElement;
  /** Whether the backend answers; every action that needs it waits here instead of failing alone. */
  readonly #link: ConnectionMonitor;
  readonly #linkBanner: ConnectionBanner;
  readonly #resizeHandle: HTMLElement;
  readonly #moreButton: HTMLButtonElement;
  readonly #headerMenu: HTMLElement;
  readonly #menuToggles: HeaderMenuToggles;
  #conversationBrowser: ConversationBrowser | undefined;
  readonly #modeButton: HTMLButtonElement;
  readonly #contextResolver: AgentChatContextResolver;
  readonly #abortControllers = new Set<AbortController>();
  readonly #lifecycleController: AbortController;
  readonly #objectUrls = new Set<string>();
  readonly #attachments: PendingAttachment[] = [];
  #attachmentWork: Promise<void> | undefined;
  #turnAbortController: AbortController | null = null;
  #turnRequestId = "";
  /** Mid-turn sentences the running turn took, marked read as it reads them; one it returned unread is found again. */
  readonly #interjected = new InterjectionReceipts();
  /** Sentences the turn took but ended before reading; sent on as the next turn once it is over. */
  #unread: { readonly sentences: readonly string[]; readonly paused: boolean } | undefined;
  /** Messages the running turn could not take, sent in order as the next turns (ui/send-queue.ts). */
  readonly #queued: QueuedSend[] = [];
  /** The last turn stopped on a card for the user; the queue waits for its answer. */
  #awaitingUser = false;
  #sessionId: string;
  #mode: "floating" | "docked";
  #width: number;
  #pending = false;
  #destroyed = false;
  #opened = false;
  #compact = false;
  #dayDividerShown = false;
  #startPromise: Promise<void> | null = null;
  #resizePointerId: number | null = null;
  #resizeStartX = 0;
  #resizeStartWidth = 0;
  #launcherPointerId: number | null = null;
  #launcherDragStart = { x: 0, y: 0, left: 0, top: 0 };
  /** Position before the current drag, so a cancelled gesture can put the launcher back. */
  #launcherDragOrigin: LauncherPosition | null = null;
  /** Set by a drag, spent by the click that follows it — the same click a tap produces. */
  #launcherDragged = false;
  #launcherPosition: LauncherPosition | null = null;
  #reply: AgentChatReply | null = null;
  #runtimeInfo: unknown;
  #resolveContextSnapshot: AgentChatResolveContext | null = null;
  #welcomeAbortController: AbortController | null = null;
  #welcomeGeneration = 0;
  #welcomeTyping: AbortController | null = null;
  /** The page's strip given to the docked panel (ui/dock-layout.ts). */
  readonly #dock = new DockLayout();
  /** Present only while a history request is in flight; it owns the conversation until then. */
  #historySkeleton: HTMLElement | null = null;
  #historyController: AbortController | undefined;
  #lastDay = "";

  constructor(options: AgentChatOptions, composition: AgentChatComposition) {
    this.#options = options;
    this.#settings = normalizeSettings(options, composition);
    this.#lifecycleController = new AbortController();
    this.#mode = this.#storedMode() ?? this.#settings.mode;
    this.#contextResolver = new AgentChatContextResolver(
      options.contextProvider,
      () => ({
        sessionId: this.#sessionId,
        mode: this.#mode,
        opened: this.#opened,
        agent: { ...(this.#settings.agentProfileId ? { id: this.#settings.agentProfileId } : {}), name: this.#settings.agentName },
      }),
      () => this.#runtimeInfo,
    );
    this.#width = this.#storedWidth() ?? this.#settings.width;
    const requestedSession = options.sessionId?.trim();
    if (requestedSession && !SESSION_PATTERN.test(requestedSession)) throw new TypeError("sessionId is invalid");
    this.#sessionId = requestedSession || this.#storedSession() || this.#freshSession();
    this.#persistSession();

    this.#host = document.createElement("div");
    this.#host.dataset.agenticChat = WIDGET_VERSION;
    this.#host.style.position = "fixed";
    this.#host.style.inset = "0";
    this.#host.style.zIndex = "2147483000";
    this.#host.style.pointerEvents = "none";
    this.#shadow = attachGuestShadow(this.#host, this.#lifecycleController.signal);
    // `typeof` on purpose: it is the one form that does not itself throw for an identifier that
    // was never declared, which is exactly the state this is looking for. The published bundle
    // is already minified, and a host pipeline that minifies or re-bundles it a second time can
    // drop these top-level constants — the page then fails with a bare "X is not defined" from
    // inside minified code, which says nothing about what to do. This names the cause instead.
    if (typeof WIDGET_TEMPLATE === "undefined" || typeof WIDGET_STYLES === "undefined") {
      throw new Error(
        "agentic-chat-widget.js is missing its own constants: the published bundle was altered after"
        + " build. Serve the file exactly as shipped — it is already minified, and re-bundling or"
        + " re-minifying it drops parts of it.");
    }
    this.#shadow.innerHTML = WIDGET_TEMPLATE;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(WIDGET_STYLES);
      this.#shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement("style");
      if (options.styleNonce?.trim()) style.nonce = options.styleNonce.trim();
      style.textContent = WIDGET_STYLES;
      this.#shadow.prepend(style);
    }
    this.#root = this.#required<HTMLElement>(".acw-root");
    this.#tables = new TableViewer(this.#root, () => [this.#input, this.#sendButton], () => this.#syncDock());
    this.#launcher = this.#required<HTMLButtonElement>(".acw-launcher");
    this.#compactStatus = this.#required<HTMLElement>(".acw-compact-status");
    this.#compactLabel = this.#required<HTMLElement>(".acw-compact-label");
    this.#compactMessage = this.#required<HTMLElement>(".acw-compact-message");
    this.#panel = this.#required<HTMLElement>(".acw-panel");
    this.#panel.setAttribute("data-agent-overlay", "");
    this.#conversation = this.#required<HTMLElement>(".acw-conversation");
    this.#jump = this.#required<HTMLButtonElement>(".acw-jump");
    this.#trackConversationScroll();
    this.#form = this.#required<HTMLFormElement>(".acw-composer");
    this.#input = this.#required<HTMLTextAreaElement>(".acw-composer textarea");
    this.#sendButton = this.#required<HTMLButtonElement>(".acw-send");
    this.#attachButton = this.#required<HTMLButtonElement>(".acw-attach");
    this.#fileInput = this.#required<HTMLInputElement>(".acw-file-input");
    this.#attachmentMenu = this.#required<HTMLElement>(".acw-attachment-menu");
    this.#attachmentTray = this.#required<HTMLElement>(".acw-attachment-tray");
    this.#attachmentNotice = this.#required<HTMLElement>(".acw-attachment-notice");
    this.#replyPreview = this.#required<HTMLElement>(".acw-reply-preview");
    this.#connection = this.#required<HTMLElement>(".acw-connection");
    const labels = this.#settings.labels;
    this.#callout = new CalloutView(this.#root, {
      closeLabel: labels.calloutClose,
      geometry: () => this.#calloutGeometry(),
      action: (event) => {
        try { this.#options.onCalloutAction?.(event); } catch { /* Consumer callbacks cannot break the widget. */ }
        this.#emit("callout-action", event);
      },
      dismiss: (event) => {
        try { this.#options.onCalloutDismiss?.(event); } catch { /* Consumer callbacks cannot break the widget. */ }
        this.#emit("callout-dismiss", event);
      },
    }, this.#settings.dockedMoves);
    this.#linkBanner = new ConnectionBanner(
      { lost: labels.connectionLost, gaveUp: labels.connectionGaveUp, retry: labels.connectionRetry }, () => this.#link.retryNow(),
    );
    this.#form.parentNode?.insertBefore(this.#linkBanner.element, this.#form);
    this.#link = new ConnectionMonitor((signal) => this.#probeBackend(signal), (state) => this.#showLink(state), options.connectionRecovery);
    this.#resizeHandle = this.#required<HTMLElement>(".acw-resize-handle");
    this.#moreButton = this.#required<HTMLButtonElement>(".acw-more");
    this.#headerMenu = this.#required<HTMLElement>(".acw-header-menu");
    this.#menuToggles = new HeaderMenuToggles(this.#required<HTMLElement>(".acw-header"), this.#headerMenu, this.#required<HTMLElement>(".acw-badge"), options.menuToggles ?? [],
      { sessionId: () => this.#sessionId, closeMenu: () => this.#setHeaderMenu(false), decide: (event) => this.#options.onMenuToggle?.(event) ?? true });
    this.#modeButton = this.#required<HTMLButtonElement>(".acw-menu-mode");
    this.#configureAppearance();
    this.#bind();
    (document.body ?? document.documentElement).append(this.#host);
    void this.#renderWelcome("initial");
    if (this.#settings.startOpen) this.open();
  }

  open(): void {
    if (this.#compact) { this.setCompactMode(false); return; }
    if (this.#destroyed || this.#opened) return;
    const action = this.#actionDetail("open");
    if (!this.#beforeAction(action)) return;
    this.#opened = true;
    this.#panel.hidden = false;
    this.#launcher.hidden = true;
    this.#launcher.setAttribute("aria-expanded", "true");
    this.#syncDock();
    try { this.#options.onOpen?.(); } catch { /* Consumer callbacks cannot break the widget. */ }
    this.#commitAction(action);
    if (this.#conversation.querySelector(":scope > .acw-welcome")) void this.#renderWelcome("open");
    void this.#ensureStarted().then(() => this.#input.focus());
  }

  close(): void {
    if (this.#destroyed || !this.#opened) return;
    const action = this.#actionDetail("close");
    if (!this.#beforeAction(action)) return;
    this.#opened = false;
    this.#tables.close();
    this.setCompactMode(false);
    this.#setHeaderMenu(false);
    this.#setAttachmentMenu(false);
    this.#panel.hidden = true;
    this.#launcher.hidden = !this.#settings.showLauncher;
    this.#launcher.setAttribute("aria-expanded", "false");
    this.#syncDock();
    try { this.#options.onClose?.(); } catch { /* Consumer callbacks cannot break the widget. */ }
    this.#commitAction(action);
  }

  toggle(): void { if (this.#compact) this.setCompactMode(false); else if (this.#opened) this.close(); else this.open(); }

  setCompactMode(compact: boolean): void {
    if (this.#destroyed) return;
    // Pushed beside the page, the panel covers nothing the agent could need to see.
    compact = compact && this.#opened && !this.#pushesPage();
    if (compact === this.#compact) return;
    // The agent is about to act on the page: the table view goes with the panel, not over the page.
    if (compact) this.#tables.close();
    this.#compact = compact;
    this.#root.dataset.compact = String(compact);
    this.#panel.hidden = compact || !this.#opened;
    this.#launcher.hidden = !compact && (this.#opened || !this.#settings.showLauncher);
    this.#launcher.setAttribute("aria-expanded", String(this.#opened && !compact));
    this.#compactStatus.hidden = !compact;
    if (compact && !this.#compactLabel.textContent) this.#compactLabel.textContent = this.#settings.labels.inProgress;
    this.#paintLauncher();
    this.#syncDock();
    try { this.#options.onCompactChange?.(compact); } catch { /* Consumer callbacks cannot break the widget. */ }
    this.#emit("compact-change", { compact });
  }

  showCallout(callout: AgentChatCallout): void {
    if (!this.#destroyed) this.#callout.show(callout);
  }

  hideCallout(id?: string): void { this.#callout.hide(id); }

  getCalloutId(): string | undefined { return this.#callout.id; }

  cancel(): void {
    if (this.#destroyed || !this.#pending || !this.#turnAbortController) return;
    const action = this.#actionDetail("cancel");
    if (!this.#beforeAction(action)) return;
    this.#requestTurnCancellation(this.#turnRequestId);
    this.#turnAbortController.abort();
    this.#commitAction(action);
  }

  destroy(): void {
    if (this.#destroyed) return;
    const action = this.#actionDetail("destroy");
    if (!this.#beforeAction(action)) return;
    if (this.#pending) this.#requestTurnCancellation(this.#turnRequestId);
    this.setCompactMode(false);
    this.#destroyed = true;
    this.#lifecycleController.abort();
    // A frame that survives teardown would render into a detached conversation.
    if (this.#scrollFrame !== null) window.cancelAnimationFrame(this.#scrollFrame);
    this.#scrollFrame = null;
    for (const turn of this.#liveTurns) this.#cancelNarrationRender(turn);
    this.#liveTurns.clear();
    this.#pausedTurns.clear();
    this.#pendingInteractions.clear();
    this.#queued.splice(0);
    this.#historyTurns.clear();
    this.#link.destroy();
    for (const controller of this.#abortControllers) controller.abort();
    this.#conversationBrowser?.close();
    this.#abortControllers.clear();
    clearTimeout(this.#attachmentNoticeTimer);
    for (const url of this.#objectUrls) URL.revokeObjectURL(url);
    this.#objectUrls.clear();
    try { void this.#settings.transport.destroy?.(); } catch { /* Transport cleanup cannot break destroy. */ }
    try { this.#options.onDestroy?.(); } catch { /* Consumer callbacks cannot break the widget. */ }
    this.#commitAction(action);
    this.#welcomeTyping?.abort();
    this.#dock.release();
    this.#callout.destroy();
    this.#host.remove();
  }

  async #openSession(sessionId: string): Promise<void> {
    if (this.#destroyed || this.#pending || !SESSION_PATTERN.test(sessionId)) return;
    this.#sessionId = sessionId;
    this.#historyTurns.clear();
    this.#pausedTurns.clear();
    this.#pendingInteractions.clear();
    this.#queued.splice(0);
    this.#persistSession();
    this.#input.value = "";
    this.clearAttachments();
    this.#setReply(null);
    this.#conversation.replaceChildren();
    this.#dayDividerShown = false;
    this.#stickToBottom = true;
    try { await this.#loadHistory(); }
    catch (cause) { this.#error(cause instanceof Error ? cause : new Error("Không tải được cuộc trò chuyện.")); }
    try { this.#options.onSessionChange?.(this.#sessionId); } catch { /* Host callback. */ }
  }

  newSession(): void {
    if (this.#destroyed || this.#pending) return;
    this.#conversationBrowser?.close();
    this.#historyController?.abort();
    this.#pausedTurns.clear();
    this.#pendingInteractions.clear();
    this.#queued.splice(0);
    const previousSessionId = this.#sessionId;
    const action = this.#actionDetail("new-session", { previousSessionId });
    if (!this.#beforeAction(action)) return;
    this.#sessionId = this.#freshSession();
    this.#historyTurns.clear();
    this.#reflowing = 0;
    this.#persistSession();
    void this.#renderWelcome("new-session");
    this.#input.value = "";
    this.clearAttachments();
    this.#setReply(null);
    this.#resizeInput();
    this.#input.focus();
    try { this.#options.onSessionChange?.(this.#sessionId); } catch { /* Consumer callbacks cannot break the widget. */ }
    this.#commitAction(this.#actionDetail("new-session", { previousSessionId, sessionId: this.#sessionId }));
  }

  async send(content: string): Promise<void> {
    while (this.#attachmentWork) await this.#attachmentWork;
    await this.#dispatch(content.trim(), [...this.#attachments], this.#reply);
  }

  /** Sends a message: the composer's (no row yet), or one that waited in the queue on screen (`queuedRow`). */
  async #dispatch(normalized: string, attached: readonly PendingAttachment[], reply: AgentChatReply | null, queuedRow?: HTMLElement): Promise<void> {
    if (this.#destroyed || this.#pending || (!normalized && attached.length === 0)) return;
    const attachmentData = attached.map((attachment) => this.#attachmentMetadata(attachment));
    const action = this.#actionDetail("send", { content: normalized, attachments: attachmentData, ...(reply ? { replyTo: reply } : {}) });
    if (!this.#beforeAction(action)) return;
    await this.#ensureStarted();
    let transportAttachments: readonly TransportAttachment[];
    try {
      transportAttachments = await this.#transportAttachments(attached);
    } catch (cause) {
      // Silence here is the worst outcome: an upload that throws (e.g. a file whose non-ASCII name
      // cannot go in an HTTP header) must not leave send doing nothing, the typed text still in the
      // box and nothing on screen to say why. The words go up as the user's own message and are
      // marked undelivered, which is what every other failed send does.
      const error = cause instanceof Error ? cause : new Error(this.#settings.labels.transportError);
      if (queuedRow) unmarkQueued(queuedRow);
      const failedRow = queuedRow ?? this.#appendUserMessage(normalized, new Date().toISOString(), false, attached, reply ?? undefined);
      this.#markUndelivered(failedRow, error.message || this.#settings.labels.transportError);
      this.#error(error);
      return;
    }
    const baseRequestContent = normalized || `Hãy xử lý ${attached.length} tệp đính kèm đã gửi.`;
    // A new request is the moment an earlier pending confirmation stops describing what was
    // asked for. The server still considers it valid, so it must not stay one click away.
    this.#withdrawPendingApprovals();
    if (queuedRow) unmarkQueued(queuedRow);
    else {
      this.#appendUserMessage(normalized, new Date().toISOString(), true, attached, reply ?? undefined);
      this.#attachments.splice(0);
      this.#showAttachmentNotice(undefined);
      this.#renderAttachmentTray();
      this.#notifyAttachmentsChange();
      this.#setReply(null);
      this.#input.value = "";
      this.#resizeInput();
    }
    const turn = this.#createLiveAssistantTurn();
    this.#commitAction(action);
    this.#setPending(true);
    try {
      const result = await this.#streamTurn(baseRequestContent, turn, transportAttachments, reply ?? undefined, this.#turnFiles(attached));
      this.#completeAssistantTurn(turn, result);
    } catch (cause) {
      this.#failTurn(turn, cause);
    } finally {
      this.#setPending(false);
      this.#input.focus();
      this.#scrollToLatest();
    }
  }

  #failTurn(turn: TurnUi, cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(this.#settings.labels.transportError);
    if (error instanceof AgentChatTransportError && error.details && typeof error.details === "object") {
      const unread = (error.details as { unreadInterjections?: unknown }).unreadInterjections;
      if (Array.isArray(unread)) {
        const sentences = unread.filter((item): item is string => typeof item === "string" && item.trim() !== "");
        if (sentences.length > 0) this.#input.value = [this.#input.value, ...sentences].filter(Boolean).join("\n");
      }
    }
    if (userStopped(error)) { this.#stopTurn(turn); return; }
    // Only a failure this transport diagnosed itself (network, malformed frame, missing
    // result) is replaced by the host's business sentence; a server- or host-composed message
    // (an HTTP error body, a headers-provider rejection) is shown exactly as given — that is
    // already product copy, and it is not this generic layer's place to write another one.
    this.#settleRetries(turn);
    // A lost connection is said once, by the banner; the turn it cut short only says that it was cut.
    const interrupted = isConnectivityFailure(error);
    const sentence = interrupted ? this.#settings.labels.turnInterrupted
      : error instanceof AgentChatTransportError && error.transportFailure ? this.#settings.labels.transportError : error.message;
    this.#showFailure(turn, sentence);
    if (!interrupted) this.#message({ role: "error", content: sentence, at: new Date().toISOString() });
    this.#error(error);
  }

  /**
   * What happens to sentences a turn took but ended before reading.
   *
   * A turn reads mid-turn sentences at its step boundaries; one that arrives while the agent is
   * writing its final answer finds no boundary left, and the gateway hands it back with the
   * result. It was accepted, so it is not shown as refused: it becomes the next turn, already on
   * screen as the user's message, so it is not echoed twice. A turn that stopped to wait for the
   * user (an approval, a form) cannot be continued by text, so there the words are marked as not
   * delivered instead, in the host's own sentence.
   */
  #followUnread(): void {
    const unread = this.#unread, rows = this.#interjected.unread();
    this.#unread = undefined;
    if (!unread || this.#destroyed) return;
    if (unread.paused) {
      for (const row of unread.sentences.map((sentence) => rows.get(sentence))) if (row) this.#markUndelivered(row, this.#settings.labels.interjectionRefused);
      return;
    }
    void this.#continueWith(unread.sentences.join("\n"));
  }

  async #continueWith(content: string): Promise<void> {
    if (this.#destroyed || this.#pending || !content.trim()) return;
    const action = this.#actionDetail("send", { content, attachments: [] });
    if (!this.#beforeAction(action)) return;
    const turn = this.#createLiveAssistantTurn();
    this.#commitAction(action);
    this.#setPending(true);
    try {
      this.#completeAssistantTurn(turn, await this.#streamTurn(content, turn));
    } catch (cause) {
      this.#failTurn(turn, cause);
    } finally {
      this.#setPending(false);
      this.#scrollToLatest();
    }
  }

  /** The composer's message while a turn runs that the turn cannot take: on screen now, sent after it (ui/send-queue.ts). */
  async #queueDraft(): Promise<void> {
    while (this.#attachmentWork) await this.#attachmentWork;
    const content = this.#input.value.trim();
    const attachments = [...this.#attachments];
    const reply = this.#reply;
    if (this.#destroyed || (!content && attachments.length === 0)) return;
    if (!this.#pending) { await this.#dispatch(content, attachments, reply); return; }
    const row = this.#appendUserMessage(content, new Date().toISOString(), false, attachments, reply ?? undefined);
    markQueued(row, this.#settings.labels.queued);
    this.#queued.push({ content, attachments, reply, row });
    this.#attachments.splice(0);
    this.#showAttachmentNotice(undefined);
    this.#renderAttachmentTray();
    this.#notifyAttachmentsChange();
    this.#setReply(null);
    this.#input.value = "";
    this.#resizeInput();
    this.#syncSendButton();
    this.#scrollToLatest(true);
  }

  #drainQueued(): void {
    if (this.#destroyed || this.#pending || this.#awaitingUser) return;
    const next = this.#queued.shift();
    if (next) void this.#dispatch(next.content, next.attachments, next.reply, next.row);
  }

  /**
   * Adds something to the turn that is already running, instead of waiting for it to finish.
   *
   * Deliberately not folded into `send()`: `send()` while a turn runs has always been a no-op and
   * a host calling it does not expect its words to land in someone else's turn. This is the
   * explicit act, and it answers whether the turn took them.
   *
   * Attachments staged in the tray are left where they are — an interjection carries text only,
   * and they stay visible for the next turn rather than being silently dropped into this one.
   */
  async interject(content: string): Promise<boolean> {
    const normalized = content.trim();
    const deliver = this.#settings.transport.interjectTurn;
    if (this.#destroyed || !this.#pending || !normalized || !deliver || !this.#turnRequestId) return false;
    const action = this.#actionDetail("interject", { content: normalized });
    if (!this.#beforeAction(action)) return false;
    const row = this.#appendUserMessage(normalized, new Date().toISOString(), true);
    // The running answer is updated in place. Keep added user messages before that answer,
    // rather than leaving them below a reply that already incorporates their request.
    const running = [...this.#liveTurns].at(-1);
    if (running) this.#conversation.insertBefore(row, running.row);
    this.#input.value = "";
    this.#resizeInput();
    this.#commitAction(action);
    this.#scrollToLatest();
    this.#interjected.add(normalized, row);
    try {
      // Called on the transport, like every other transport method here: the built-in HTTP
      // transport reads its endpoints from private fields, and a detached call threw before any
      // request left the browser — every interjection then read as refused.
      const accepted = await deliver.call(this.#settings.transport, { content: normalized }, {
        operation: "interject",
        sessionId: this.#sessionId,
        requestId: this.#turnRequestId,
        ...(this.#settings.agentProfileId ? { agentProfileId: this.#settings.agentProfileId } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!accepted) { this.#interjected.remove(row); this.#markUndelivered(row, this.#settings.labels.interjectionRefused); }
      return accepted;
    } catch (cause) {
      // A failure to hand them over reads to the user exactly like a refusal, and is shown the
      // same way; the technical cause goes to onError, where the rest of them go.
      this.#interjected.remove(row);
      this.#markUndelivered(row, this.#settings.labels.interjectionRefused);
      this.#error(cause instanceof Error ? cause : new Error(this.#settings.labels.transportError));
      return false;
    }
  }

  #canInterject(): boolean {
    return typeof this.#settings.transport.interjectTurn === "function";
  }

  async addAttachments(files: FileList | readonly File[]): Promise<void> {
    await this.#addFiles(Array.from(files), "picker");
  }

  clearAttachments(): void {
    if (this.#attachments.length === 0) return;
    const removed = this.#attachments.splice(0);
    for (const attachment of removed) this.#revokeAttachmentPreview(attachment);
    this.#renderAttachmentTray();
    this.#notifyAttachmentsChange();
    this.#commitAction(this.#actionDetail("attachment", { operation: "clear", count: removed.length }));
  }

  getAttachments(): readonly AgentChatAttachment[] { return [...this.#attachments]; }

  async refreshContext(): Promise<void> {
    if (this.#destroyed) return;
    if (this.#conversation.querySelector(":scope > .acw-welcome")) await this.#renderWelcome("refresh");
    else this.#resolveContextSnapshot = await this.#contextResolver.resolve("refresh", this.#lifecycleController.signal);
  }

  getSessionId(): string { return this.#sessionId; }
  isPending(): boolean { return this.#pending; }
  setDraft(content: string): void {
    if (this.#destroyed || typeof content !== "string") return;
    this.#input.value = this.#input.maxLength > 0 ? content.slice(0, this.#input.maxLength) : content;
    this.#resizeInput();
    this.#input.focus();
  }
  isOpen(): boolean { return this.#opened; }
  getElement(): HTMLElement { return this.#host; }
  setMode(mode: "floating" | "docked"): void {
    if (this.#destroyed || (mode !== "floating" && mode !== "docked") || mode === this.#mode) return;
    const previousMode = this.#mode;
    const action = this.#actionDetail("mode-change", { mode, previousMode });
    if (!this.#beforeAction(action)) return;
    this.#mode = mode;
    this.#root.dataset.mode = mode;
    if (this.#pushesPage()) this.setCompactMode(false);
    this.#setWidth(this.#width);
    this.#updateModeButton();
    try { this.#options.onModeChange?.(mode); } catch { /* Consumer callbacks cannot break the widget. */ }
    this.#commitAction(action);
  }
  getMode(): "floating" | "docked" { return this.#mode; }
  setMenuToggle(id: string, state: Parameters<HeaderMenuToggles["set"]>[1]): void { if (!this.#destroyed) this.#menuToggles.set(id, state); }
  setBadge(label: string | null, title?: string): void { if (!this.#destroyed) this.#menuToggles.setBadge(label, title); }

  #required<T extends Element>(selector: string): T {
    const element = this.#shadow.querySelector<T>(selector);
    if (!element) throw new Error(`Widget template is missing ${selector}`);
    return element;
  }

  #configureAppearance(): void {
    this.#root.dataset.position = this.#settings.position;
    this.#root.dataset.mode = this.#mode;
    this.#launcher.hidden = !this.#settings.showLauncher;
    this.#modeButton.hidden = !this.#settings.showModeToggle;
    this.#updateModeButton();
    this.#setWidth(this.#width);
    if (!this.#settings.resizable) {
      this.#resizeHandle.hidden = true;
      this.#resizeHandle.tabIndex = -1;
    }
    if (this.#settings.draggableLauncher) {
      this.#launcher.dataset.draggable = "true";
      const stored = this.#storedLauncherPosition();
      if (stored) this.#placeLauncher(stored);
    }
    const color = (value: string | undefined) => value?.trim() && CSS.supports("color", value.trim()) ? value.trim() : undefined;
    const primary = color(this.#options.primaryColor);
    // A host that names only its own colour gets that colour throughout: the default accent is
    // the widget's purple, and a gradient into it would put a second brand on the host's page.
    const accent = color(this.#options.accentColor) ?? primary;
    if (primary) this.#host.style.setProperty("--acw-primary", primary);
    if (accent) this.#host.style.setProperty("--acw-accent", accent);
    this.#required<HTMLElement>(".acw-agent-name").textContent = this.#settings.agentName;
    this.#required<HTMLElement>(".acw-subtitle").textContent = this.#settings.subtitle;
    this.#input.placeholder = this.#settings.placeholder;
    const badge = this.#required<HTMLElement>(".acw-badge");
    if (this.#settings.badge) { badge.textContent = this.#settings.badge; badge.hidden = false; }
    this.#avatar(this.#required<HTMLElement>(".acw-header-avatar"));
    this.#avatar(this.#required<HTMLElement>(".acw-launcher-avatar"));
    this.#launcher.setAttribute("aria-label", `Mở ${this.#settings.agentName}`);
    this.#panel.setAttribute("aria-label", this.#settings.agentName);
    this.#attachButton.hidden = !this.#settings.attachments;
    this.#fileInput.accept = this.#settings.attachmentAccept;
  }

  #updateModeButton(): void {
    const docked = this.#mode === "docked";
    const label = docked ? "Chuyển sang cửa sổ nổi" : "Gắn thành panel bên cạnh";
    this.#modeButton.title = label;
    this.#modeButton.setAttribute("aria-label", label);
    this.#required<HTMLElement>(".acw-menu-mode-label").textContent = label;
  }

  #setHeaderMenu(open: boolean): void {
    if (open) this.#setAttachmentMenu(false);
    this.#headerMenu.hidden = !open;
    this.#moreButton.setAttribute("aria-expanded", String(open));
  }

  #setAttachmentMenu(open: boolean): void {
    if (!this.#settings.attachments) open = false;
    this.#attachmentMenu.hidden = !open;
    this.#attachButton.setAttribute("aria-expanded", String(open));
  }

  #bind(): void {
    this.#launcher.addEventListener("click", () => {
      // A drag ends with the same click a tap does; only the flag tells them apart.
      if (this.#launcherDragged) { this.#launcherDragged = false; return; }
      this.toggle();
    });
    this.#required<HTMLButtonElement>(".acw-compact-stop").addEventListener("click", () => this.cancel());
    this.#required<HTMLButtonElement>(".acw-close").addEventListener("click", () => this.close());
    this.#conversationBrowser = new ConversationBrowser(this.#panel, this.#conversation, this.#settings.transport,
      (signal) => ({ operation: "history", sessionId: this.#sessionId, requestId: `widget-history-${randomId()}`,
        ...(this.#settings.agentProfileId ? { agentProfileId: this.#settings.agentProfileId } : {}), signal }),
      (sessionId) => this.#openSession(sessionId), () => this.#pending, () => { this.#stickToBottom = false; this.#settleUntil = 0; });
    bindHeaderMenuEntries(this.#shadow, { history: () => this.#conversationBrowser?.openHistory(), search: () => this.#conversationBrowser?.openSearch(), new: () => this.newSession() }, () => this.#setHeaderMenu(false));
    this.#moreButton.addEventListener("click", () => this.#setHeaderMenu(this.#headerMenu.hidden));
    this.#modeButton.addEventListener("click", () => {
      this.#setHeaderMenu(false);
      this.setMode(this.#mode === "floating" ? "docked" : "floating");
      this.#persistMode();
    });
    this.#attachButton.addEventListener("click", () => {
      const action = this.#actionDetail("attachment", { operation: "menu", open: this.#attachmentMenu.hidden });
      if (!this.#beforeAction(action)) return;
      try { this.#options.onAttachmentClick?.(); } catch { /* Consumer callbacks cannot break the widget. */ }
      this.#setHeaderMenu(false);
      this.#setAttachmentMenu(this.#attachmentMenu.hidden);
      this.#commitAction(action);
    });
    this.#required<HTMLButtonElement>(".acw-capture-chat").addEventListener("click", () => void this.#captureScreen(true));
    this.#required<HTMLButtonElement>(".acw-capture-screen").addEventListener("click", () => void this.#captureScreen(false));
    this.#required<HTMLButtonElement>(".acw-pick-file").addEventListener("click", () => {
      this.#setAttachmentMenu(false);
      this.#fileInput.click();
    });
    this.#fileInput.addEventListener("change", () => {
      const files = this.#fileInput.files ? Array.from(this.#fileInput.files) : [];
      this.#fileInput.value = "";
      void this.#addFiles(files, "picker");
    });
    this.#required<HTMLButtonElement>(".acw-reply-close").addEventListener("click", () => {
      if (!this.#reply) return;
      const action = this.#actionDetail("quote", { operation: "cancel", ...(this.#reply.turnId ? { turnId: this.#reply.turnId } : {}) });
      if (!this.#beforeAction(action)) return;
      this.#setReply(null);
      this.#commitAction(action);
      this.#input.focus();
    });
    this.#resizeHandle.addEventListener("pointerdown", (event) => this.#beginResize(event));
    this.#resizeHandle.addEventListener("pointermove", (event) => this.#moveResize(event));
    this.#resizeHandle.addEventListener("pointerup", (event) => this.#endResize(event));
    this.#resizeHandle.addEventListener("pointercancel", () => this.#cancelResize());
    this.#resizeHandle.addEventListener("keydown", (event) => this.#resizeWithKeyboard(event));
    // The panel enters with a short slide; its box is final only when that ends.
    this.#panel.addEventListener("animationend", () => this.#callout.place(), { signal: this.#lifecycleController.signal });
    this.#launcher.addEventListener("pointerdown", (event) => this.#beginLauncherDrag(event));
    this.#launcher.addEventListener("pointermove", (event) => this.#moveLauncherDrag(event));
    this.#launcher.addEventListener("pointerup", (event) => this.#endLauncherDrag(event));
    this.#launcher.addEventListener("pointercancel", () => this.#cancelLauncherDrag());
    // A spot that was on screen in one window is off screen in a smaller one.
    window.addEventListener("resize", () => {
      this.#paintLauncher();
      // The strip the docked panel keeps must still leave the page room in a narrower window. The
      // widget's own resize event (ui/dock-layout.ts) arrives here too and changes nothing.
      if (this.#mode === "docked") this.#setWidth(this.#width);
    }, { passive: true, signal: this.#lifecycleController.signal });
    this.#shadow.addEventListener("click", (event) => {
      const path = event.composedPath();
      if (!path.includes(this.#moreButton) && !path.includes(this.#headerMenu)) this.#setHeaderMenu(false);
      if (!path.includes(this.#attachButton) && !path.includes(this.#attachmentMenu)) this.#setAttachmentMenu(false);
      const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (target) this.#openLink(target.href, target.textContent?.trim() || target.href, event as MouseEvent);
    });
    // Before the host page, which may stop Escape on its way down (ui/escape-before-host.ts): the table over everything, then a menu, then search and history.
    listenEscapeBeforeHost(this.#lifecycleController.signal, [this.#tables.escapeSurface, { element: this.#shadow, isOpen: () => !this.#headerMenu.hidden || !this.#attachmentMenu.hidden,
      close: () => { const back = this.#attachmentMenu.hidden ? this.#moreButton : this.#attachButton; this.#setHeaderMenu(false); this.#setAttachmentMenu(false); back.focus(); } },
    ...this.#conversationBrowser.escapeSurfaces]);
    this.#form.addEventListener("submit", (event) => {
      event.preventDefault();
      // While the agent works the button means Stop — but words in the box mean the user is adding
      // to this turn, not ending it. Throwing away a ten-minute read because someone typed a
      // correction and pressed Enter is the worse of the two readings.
      if (this.#pending) {
        // Files never ride on an interjection, and a transport without them takes no words either: both wait their turn.
        if (this.#attachments.length > 0 || (!this.#canInterject() && this.#input.value.trim())) { void this.#queueDraft(); return; }
        if (this.#canInterject() && this.#input.value.trim()) { void this.interject(this.#input.value); return; }
        this.cancel();
        return;
      }
      void this.send(this.#input.value);
    });
    this.#input.addEventListener("input", () => { this.#resizeInput(); this.#syncSendButton(); });
    this.#input.addEventListener("paste", (event) => {
      if (!this.#settings.attachments) return;
      const clipboard = event.clipboardData;
      const fromItems = Array.from(clipboard?.items ?? [])
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      // Some browsers list a pasted file only under `files`.
      const files = fromItems.length > 0 ? fromItems : Array.from(clipboard?.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        void this.#addFiles(files, "paste");
        return;
      }
      // A paste that brings neither a file nor any text is a clipboard the browser could not read:
      // typically a screenshot held in a format this browser is not given (a Linux browser under a
      // remote or WSL desktop sees only an empty text). Doing nothing looked like a broken button.
      const carriesText = Array.from(clipboard?.types ?? []).some((type) => type !== "Files" && Boolean(clipboard?.getData(type)));
      if (!carriesText) {
        this.#attachmentError("Không nhận được ảnh hay tệp nào từ bộ nhớ tạm: trình duyệt này không đọc được thứ vừa sao chép. Hãy lưu ảnh thành tệp rồi bấm + để đính kèm.");
      }
    });
    this.#form.addEventListener("dragover", (event) => {
      if (!this.#settings.attachments || !event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      this.#form.dataset.dragging = "true";
    });
    this.#form.addEventListener("dragleave", (event) => {
      if (event.relatedTarget instanceof Node && this.#form.contains(event.relatedTarget)) return;
      delete this.#form.dataset.dragging;
    });
    this.#form.addEventListener("drop", (event) => {
      delete this.#form.dataset.dragging;
      if (!this.#settings.attachments || !event.dataTransfer?.files.length) return;
      event.preventDefault();
      void this.#addFiles(Array.from(event.dataTransfer.files), "drop");
    });
    this.#input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.#form.requestSubmit();
      }
    });
    window.addEventListener("keydown", (event) => {
      if (!this.#opened || !this.#settings.attachments || !this.#settings.attachmentShortcuts || event.defaultPrevented || !event.ctrlKey || !event.altKey) return;
      const cropToChat = event.code === "KeyS";
      if (!cropToChat && event.code !== "KeyA") return;
      event.preventDefault();
      void this.#captureScreen(cropToChat);
    }, { signal: this.#lifecycleController.signal });
  }

  #setReply(reply: AgentChatReply | null): void {
    this.#reply = reply;
    this.#replyPreview.hidden = reply === null;
    this.#required<HTMLElement>(".acw-reply-author").textContent = reply?.author ?? "";
    this.#emit("reply-change", { reply, sessionId: this.#sessionId });
  }

  /** One add after another, each image made lighter before it joins the tray (attachment-images.ts); a send waits for them. */
  #addFiles(files: readonly File[], source: AgentChatAttachmentSource): Promise<void> {
    const work = (this.#attachmentWork ?? Promise.resolve()).then(() => this.#attachFiles(files, source));
    const settled: Promise<void> = work.catch(() => undefined).finally(() => { if (this.#attachmentWork === settled) this.#attachmentWork = undefined; });
    this.#attachmentWork = settled;
    return work;
  }

  async #attachFiles(files: readonly File[], source: AgentChatAttachmentSource): Promise<void> {
    if (this.#destroyed || !this.#settings.attachments || files.length === 0) return;
    const available = this.#settings.maxAttachments - this.#attachments.length;
    if (available <= 0) {
      this.#attachmentError(`Chỉ được đính kèm tối đa ${this.#settings.maxAttachments} tệp.`);
      return;
    }
    const selected = files.slice(0, available);
    const action = this.#actionDetail("attachment", { operation: "add", source, count: selected.length });
    if (!this.#beforeAction(action)) return;
    this.#showAttachmentNotice(undefined);
    let added = 0;
    for (const picked of selected) {
      // A pasted image may come without a name; it is named the way browsers name one ("image.png").
      const pickedName = picked.name || (/^image\/[a-z0-9.-]+/iu.test(picked.type) ? `image.${picked.type.slice(6).split(/[+;]/u)[0]}` : "Tệp đính kèm");
      if (!this.#acceptsAttachment(picked)) {
        this.#attachmentError(`Định dạng tệp không được hỗ trợ: ${pickedName}${picked.type ? ` (${picked.type})` : ""}`);
        continue;
      }
      // Before the size check: a photo over the limit is usually well under it once scaled down.
      const { file, name } = await compactImageFile(picked, pickedName);
      if (this.#destroyed) return;
      if (file.size > this.#settings.maxAttachmentBytes) {
        this.#attachmentError(`${name} vượt quá giới hạn ${this.#formatBytes(this.#settings.maxAttachmentBytes)}.`);
        continue;
      }
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      if (previewUrl) this.#objectUrls.add(previewUrl);
      this.#attachments.push({ id: `attachment-${randomId()}`, name, type: file.type || "application/octet-stream", size: file.size, source, file, ...(previewUrl ? { previewUrl } : {}) });
      added += 1;
    }
    if (files.length > available) this.#attachmentError(`Chỉ thêm ${available} tệp do giới hạn ${this.#settings.maxAttachments} tệp mỗi tin nhắn.`);
    if (added === 0) return;
    this.#renderAttachmentTray();
    this.#notifyAttachmentsChange();
    this.#commitAction(this.#actionDetail("attachment", { operation: "add", source, count: added }));
    this.#emit("attachment-add", { source, attachments: this.getAttachments(), sessionId: this.#sessionId });
    this.#input.focus();
  }

  #acceptsAttachment(file: File): boolean {
    const extension = file.name.includes(".") ? `.${file.name.split(".").pop()?.toLowerCase() ?? ""}` : "";
    return this.#settings.attachmentAccept.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean).some((rule) => {
      if (rule === "*/*") return true;
      if (rule.startsWith(".")) return extension === rule;
      if (rule.endsWith("/*")) return file.type.toLowerCase().startsWith(rule.slice(0, -1));
      return file.type.toLowerCase() === rule;
    });
  }

  #attachmentMetadata(attachment: AgentChatAttachment): Omit<TransportAttachment, "data"> {
    return { id: attachment.id, name: attachment.name, type: attachment.type, size: attachment.size, source: attachment.source };
  }

  async #transportAttachments(attachments: readonly PendingAttachment[]): Promise<readonly TransportAttachment[]> {
    return Promise.all(attachments.map(async (attachment) => {
      const metadata = this.#attachmentMetadata(attachment);
      if (!this.#options.uploadAttachment) return metadata;
      const data = await this.#options.uploadAttachment(attachment.file, { id: attachment.id, source: attachment.source, sessionId: this.#sessionId });
      return { ...metadata, data };
    }));
  }

  /**
   * The files that go with the turn itself: every attachment the host did not upload on its own.
   * A turn that only names a file nobody stored sends an id this browser made up, no tool can open
   * it, and the assistant asks for a file it was just given.
   */
  #turnFiles(attachments: readonly PendingAttachment[]): ReadonlyMap<string, File> {
    return new Map(this.#options.uploadAttachment ? [] : attachments.map((attachment) => [attachment.id, attachment.file]));
  }

  #notifyAttachmentsChange(): void {
    const attachments = this.getAttachments();
    try { this.#options.onAttachmentsChange?.(attachments); } catch { /* Consumer callbacks cannot break the widget. */ }
    this.#emit("attachments-change", { attachments, sessionId: this.#sessionId });
  }

  #removeAttachment(id: string): void {
    const index = this.#attachments.findIndex((attachment) => attachment.id === id);
    const attachment = this.#attachments[index];
    if (!attachment) return;
    const action = this.#actionDetail("attachment", { operation: "remove", attachment: this.#attachmentMetadata(attachment) });
    if (!this.#beforeAction(action)) return;
    this.#attachments.splice(index, 1);
    this.#revokeAttachmentPreview(attachment);
    this.#renderAttachmentTray();
    this.#notifyAttachmentsChange();
    this.#commitAction(action);
    this.#emit("attachment-remove", { attachment: this.#attachmentMetadata(attachment), sessionId: this.#sessionId });
  }

  #revokeAttachmentPreview(attachment: PendingAttachment): void {
    if (!attachment.previewUrl) return;
    URL.revokeObjectURL(attachment.previewUrl);
    this.#objectUrls.delete(attachment.previewUrl);
  }

  #renderAttachmentTray(): void {
    this.#syncSendButton();
    this.#attachmentTray.replaceChildren();
    this.#attachmentTray.hidden = this.#attachments.length === 0;
    for (const attachment of this.#attachments) {
      const chip = document.createElement("div");
      chip.className = "acw-attachment-chip";
      chip.dataset.kind = attachment.previewUrl ? "image" : "file";
      const thumb = document.createElement("span");
      thumb.className = "acw-attachment-thumb";
      if (attachment.previewUrl) {
        const image = document.createElement("img");
        image.src = attachment.previewUrl;
        image.alt = "";
        thumb.append(image);
      } else {
        thumb.textContent = this.#fileExtension(attachment.name);
      }
      const meta = document.createElement("span");
      meta.className = "acw-attachment-meta";
      const name = document.createElement("span");
      name.className = "acw-attachment-name";
      name.textContent = attachment.name;
      name.title = attachment.name;
      const size = document.createElement("span");
      size.className = "acw-attachment-size";
      size.textContent = this.#formatBytes(attachment.size);
      meta.append(name, size);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "acw-attachment-remove";
      remove.textContent = "×";
      remove.title = `Xóa ${attachment.name}`;
      remove.setAttribute("aria-label", `Xóa ${attachment.name}`);
      remove.addEventListener("click", () => this.#removeAttachment(attachment.id));
      chip.append(thumb, meta, remove);
      this.#attachmentTray.append(chip);
    }
  }

  #fileExtension(name: string): string {
    const extension = name.includes(".") ? name.split(".").pop() ?? "file" : "file";
    return extension.slice(0, 4).toUpperCase();
  }

  #formatBytes(value: number): string {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  /**
   * A file that did not join the tray, and why.
   *
   * The reason used to go only to `onError` and an event, and nothing in the widget showed it: a
   * refused or unreadable file simply did not appear, and a host that reports `onError` as a lost
   * connection (the demo panel did) told the user the assistant was unreachable. It is shown in the
   * composer now; the error is named so a host can tell it from a transport failure.
   */
  #attachmentError(message: string): void {
    // Several files refused in one go are all named; the same reason is not repeated.
    const shown = this.#attachmentNotice.hidden ? "" : this.#attachmentNotice.textContent ?? "";
    this.#showAttachmentNotice(shown && !shown.split("\n").includes(message) ? `${shown}\n${message}` : message);
    const error = new Error(message);
    error.name = "AgentChatAttachmentError";
    this.#error(error);
    this.#emit("attachment-error", { message, sessionId: this.#sessionId });
  }

  /** Shows the notice for a while, or clears it (`undefined`): a new attempt or a send replaces it. */
  #showAttachmentNotice(message: string | undefined): void {
    clearTimeout(this.#attachmentNoticeTimer);
    this.#attachmentNoticeTimer = undefined;
    this.#attachmentNotice.textContent = message ?? "";
    this.#attachmentNotice.hidden = !message;
    if (message) this.#attachmentNoticeTimer = setTimeout(() => this.#showAttachmentNotice(undefined), ATTACHMENT_NOTICE_MS);
  }

  async #captureScreen(cropToChat: boolean): Promise<void> {
    this.#setAttachmentMenu(false);
    const operation = cropToChat ? "capture-chat" : "capture-screen";
    const action = this.#actionDetail("attachment", { operation });
    if (!this.#beforeAction(action)) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.#attachmentError("Trình duyệt không hỗ trợ chụp màn hình.");
      return;
    }
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false, preferCurrentTab: cropToChat } as DisplayMediaStreamOptions);
      const blob = await captureStreamFrame(stream, cropToChat
        ? { rect: this.#panel.getBoundingClientRect(), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight } : undefined);
      const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
      const source: AgentChatAttachmentSource = cropToChat ? "capture-chat" : "capture-screen";
      await this.#addFiles([new File([blob], `${cropToChat ? "chat" : "man-hinh"}-${stamp}.png`, { type: "image/png" })], source);
      this.#commitAction(action);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error("Không thể chụp màn hình.");
      if (error.name !== "NotAllowedError" && error.name !== "AbortError") this.#attachmentError(error.message);
    } finally {
      for (const track of stream?.getTracks() ?? []) track.stop();
    }
  }

  async #renderWelcome(reason: AgentChatResolveReason): Promise<void> {
    this.#welcomeAbortController?.abort();
    const controller = new AbortController();
    const generation = ++this.#welcomeGeneration;
    this.#welcomeAbortController = controller;
    this.#abortControllers.add(controller);
    this.#dayDividerShown = false;
    // A refresh keeps the words already typed (ui/welcome-typing.ts); every other showing types them afresh.
    const shownMessage = reason === "refresh" ? this.#conversation.querySelector(":scope > .acw-welcome > .acw-welcome-message")?.textContent ?? "" : "";
    const welcome = document.createElement("section");
    welcome.className = "acw-welcome";
    const avatar = document.createElement("div");
    avatar.className = "acw-welcome-avatar";
    this.#avatar(avatar, this.#settings.welcomeImageUrl);
    const title = document.createElement("h2");
    const fallbackTitle = `Xin chào ${this.#settings.userName}!`;
    title.textContent = typeof this.#settings.welcomeTitle === "string" ? this.#settings.welcomeTitle : fallbackTitle;
    const message = document.createElement("p");
    message.className = "acw-welcome-message";
    message.textContent = shownMessage;
    const fallbackMessage = "Tôi có thể giúp gì cho bạn?";
    this.#typeWelcome(message, typeof this.#settings.welcomeMessage === "string" ? this.#settings.welcomeMessage : fallbackMessage);
    welcome.append(avatar, title, message);
    if (this.#settings.suggestedPrompts.length > 0) {
      const suggestions = document.createElement("div");
      suggestions.className = "acw-suggestions";
      scrollSideways(suggestions);
      for (const prompt of this.#settings.suggestedPrompts) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "acw-suggestion";
        button.textContent = prompt;
        button.title = prompt;
        button.addEventListener("click", () => void this.send(prompt));
        suggestions.append(button);
      }
      welcome.append(suggestions);
    }
    this.#conversation.replaceChildren(welcome);
    // The runtime check usually answers before the history request does, and its success path
    // refreshes the greeting. Without this, that refresh wipes the placeholder and flashes a
    // greeting that is about to be replaced — the exact stutter the placeholder exists to stop.
    if (this.#historySkeleton) {
      welcome.hidden = true;
      this.#conversation.append(this.#historySkeleton);
    }
    try {
      const context = await this.#contextResolver.resolve(reason, controller.signal);
      const [resolvedTitle, resolvedMessage] = await Promise.all([
        this.#contextResolver.text(this.#settings.welcomeTitle, fallbackTitle, context),
        this.#contextResolver.text(this.#settings.welcomeMessage, fallbackMessage, context),
      ]);
      if (this.#destroyed || controller.signal.aborted || generation !== this.#welcomeGeneration || !welcome.isConnected) return;
      this.#resolveContextSnapshot = context;
      title.textContent = resolvedTitle;
      this.#typeWelcome(message, resolvedMessage);
      this.#emit("context-refresh", { reason, sessionId: this.#sessionId });
    } catch (cause) {
      if (!controller.signal.aborted) this.#error(cause instanceof Error ? cause : new Error("Không thể tạo nội dung chào mừng."));
    } finally {
      this.#abortControllers.delete(controller);
      if (this.#welcomeAbortController === controller) this.#welcomeAbortController = null;
    }
  }

  #typeWelcome(message: HTMLElement, text: string): void {
    this.#welcomeTyping?.abort();
    this.#welcomeTyping = new AbortController();
    message.dataset.text = text;
    typeWelcomeText(message, text, this.#welcomeTyping.signal);
  }

  #avatar(container: HTMLElement, imageUrl = this.#settings.logoUrl): void {
    container.replaceChildren();
    const fallback = () => {
      container.replaceChildren();
      container.textContent = initials(this.#settings.agentName);
    };
    if (!imageUrl) { fallback(); return; }
    const image = document.createElement("img");
    image.alt = "";
    image.src = imageUrl;
    image.addEventListener("error", fallback, { once: true });
    container.append(image);
  }

  #removeWelcome(): void {
    this.#conversation.querySelector(".acw-welcome")?.remove();
    this.#conversation.querySelector(".acw-history-empty")?.remove();
  }

  #ensureDayDivider(at?: string): void {
    const parsed = at ? new Date(at) : new Date();
    const date = Number.isNaN(parsed.valueOf()) ? new Date() : parsed;
    const day = date.toLocaleDateString("vi-VN");
    if (this.#dayDividerShown && this.#lastDay === day) return;
    this.#dayDividerShown = true;
    this.#lastDay = day;
    const divider = document.createElement("div");
    divider.className = "acw-day";
    divider.textContent = day === new Date().toLocaleDateString("vi-VN") ? "Hôm nay" : day;
    this.#conversation.append(divider);
  }

  #clock(at?: string): string {
    const date = at ? new Date(at) : new Date();
    return new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" }).format(Number.isNaN(date.valueOf()) ? new Date() : date);
  }

  #appendUserMessage(content: string, at: string, notify: boolean, attachments: readonly Omit<PendingAttachment, "file">[] = [], replyTo?: AgentChatReply): HTMLElement {
    this.#removeWelcome();
    this.#ensureDayDivider(at);
    const row = document.createElement("article");
    row.className = "acw-message acw-user";
    const time = document.createElement("time");
    time.className = "acw-user-time";
    time.textContent = this.#clock(at);
    row.append(time);
    if (attachments.length > 0) {
      const gallery = document.createElement("div");
      gallery.className = "acw-user-attachments";
      for (const attachment of attachments) {
        const card = document.createElement("div");
        card.className = "acw-user-attachment";
        if (attachment.previewUrl) {
          const image = document.createElement("img");
          image.src = attachment.previewUrl;
          image.alt = attachment.name;
          card.append(image);
        } else {
          const icon = document.createElement("span");
          icon.className = "acw-user-attachment-icon";
          icon.textContent = this.#fileExtension(attachment.name);
          card.append(icon);
        }
        const copy = document.createElement("span");
        copy.className = "acw-user-attachment-copy";
        const name = document.createElement("span");
        name.className = "acw-user-attachment-name";
        name.textContent = attachment.name;
        name.title = attachment.name;
        const size = document.createElement("span");
        size.className = "acw-user-attachment-size";
        size.textContent = this.#formatBytes(attachment.size);
        copy.append(name, size);
        card.append(copy);
        gallery.append(card);
      }
      row.append(gallery);
    }
    if (content) {
      const bubble = document.createElement("div");
      bubble.className = "acw-bubble";
      bubble.textContent = content;
      row.append(bubble);
    }
    this.#conversation.append(row);
    if (notify) this.#message({ role: "user", content, at, ...(attachments.length > 0 ? { attachments: attachments.filter((item): item is PendingAttachment => "file" in item) } : {}), ...(replyTo ? { replyTo } : {}) });
    this.#scrollToLatest(true);
    return row;
  }

  /**
   * Marks a message of the user's own as one that never reached the agent.
   *
   * The words stay — they did type them — and the note goes beside them, because the failure
   * this exists for is the quiet one: a correction sitting in the conversation looking delivered
   * while the agent it was meant for never read a word of it.
   */
  #markUndelivered(row: HTMLElement, sentence: string): void {
    row.classList.add("acw-error");
    const note = document.createElement("div");
    note.className = "acw-user-undelivered";
    note.textContent = sentence;
    row.append(note);
    this.#message({ role: "error", content: sentence, at: new Date().toISOString() });
    this.#scrollToLatest(true);
  }

  #assistantShell(at?: string): AssistantShell {
    this.#removeWelcome();
    this.#ensureDayDivider(at);
    const row = document.createElement("article");
    row.className = "acw-message acw-assistant";
    const meta = document.createElement("div");
    meta.className = "acw-assistant-meta";
    const avatar = document.createElement("div");
    avatar.className = "acw-message-avatar";
    this.#avatar(avatar);
    const name = document.createElement("span");
    name.className = "acw-assistant-name";
    name.textContent = this.#settings.agentName;
    const time = document.createElement("time");
    time.textContent = this.#clock(at);
    meta.append(avatar, name, time);
    const bubble = document.createElement("div");
    bubble.className = "acw-bubble acw-markdown";
    const rich = document.createElement("div");
    rich.className = "acw-rich";
    const actions = document.createElement("div");
    actions.className = "acw-message-actions";
    row.append(meta, bubble, rich, actions);
    this.#conversation.append(row);
    return { row, bubble, rich, actions };
  }

  #createLiveAssistantTurn(): TurnUi {
    const shell = this.#assistantShell();
    const turn = this.#turnUi(shell, true);
    shell.bubble.hidden = true;
    shell.bubble.setAttribute("aria-live", "polite");
    shell.bubble.setAttribute("aria-atomic", "false");
    this.#liveTurns.add(turn);
    this.#scrollToLatest(true);
    return turn;
  }

  /**
   * The account of a turn's work, and the one line it folds into once the work is done.
   *
   * While the turn runs, the account is simply part of the reply: a line saying which step it is in,
   * everything the agent says as it goes — the plan, then what it is doing — as ordinary chat text,
   * one after the other and never one in place of another, and a line for the call being made. The
   * checklist of steps and the calls under them is kept as it happens, behind the live line's
   * chevron. Once the answer is in it all folds under the summary line, which opens onto the whole
   * of it. A turn loaded from history is built already folded.
   */
  #turnUi(shell: AssistantShell, live: boolean): TurnUi {
    const thinking = document.createElement("details");
    thinking.className = "acw-thinking";
    thinking.open = live;
    const summary = document.createElement("summary");
    const summaryLabel = document.createElement("span");
    summaryLabel.className = "acw-thinking-label";
    summaryLabel.textContent = "Quy trình xử lý";
    summary.append(summaryLabel, this.#chevronIcon());
    // A turn with nothing worth recounting still says how long it took, but opens onto nothing.
    summary.addEventListener("click", (event) => {
      if (thinking.dataset.complete !== "true" || thinking.dataset.empty === "true") event.preventDefault();
    });
    const body = document.createElement("div");
    body.className = "acw-thinking-body";
    const timeline = document.createElement("div");
    timeline.className = "acw-timeline";
    const liveLine = document.createElement("div");
    liveLine.className = "acw-live-line";
    liveLine.setAttribute("role", "status");
    liveLine.dataset.source = "thinking";
    liveLine.dataset.state = "active";
    liveLine.dataset.icon = "none";
    const liveIcon = document.createElement("span");
    liveIcon.className = "acw-work-icon";
    liveIcon.setAttribute("aria-hidden", "true");
    const liveLabel = document.createElement("span");
    liveLabel.className = "acw-live-label";
    liveLabel.textContent = this.#settings.labels.thinking;
    const detailToggle = document.createElement("button");
    detailToggle.type = "button";
    detailToggle.className = "acw-live-toggle";
    detailToggle.setAttribute("aria-label", "Quy trình xử lý");
    detailToggle.setAttribute("aria-expanded", "false");
    detailToggle.append(this.#chevronIcon());
    detailToggle.hidden = true;
    liveLine.append(liveIcon, liveLabel, detailToggle);
    liveLine.hidden = !live;
    liveLine.dataset.detail = "closed";
    const callLine = document.createElement("div");
    callLine.className = "acw-call-line";
    const callIcon = document.createElement("span");
    callIcon.className = "acw-work-icon";
    callIcon.setAttribute("aria-hidden", "true");
    callIcon.append(this.#rowIcon("work"));
    const callLabel = document.createElement("span");
    callLabel.className = "acw-live-label";
    callLine.append(callIcon, callLabel);
    callLine.hidden = true;
    // What the turn has said so far leads and only ever grows; where it is now comes under it, at
    // the edge the reader is following, and what it is calling for that step under that. The line
    // used to lead instead: a model that says nothing beside its calls then left a turn that was
    // one line for a minute, and nothing on screen said what had been done so far.
    body.append(timeline, liveLine, callLine);
    thinking.append(summary, body);
    shell.row.insertBefore(thinking, shell.bubble);
    this.#trackThinkingToggle(thinking);
    const turn: TurnUi = {
      ...shell, thinking, summaryLabel, timeline, liveLine, detailToggle, callLine, detailOpen: false,
      planSentence: null, planId: "", revealed: !live, rows: new Map(), lastCallId: "", lastCallStep: "", stepNotes: new Map(),
      committedNarrations: [], discardedOutputIds: new Set(), narrationDraft: null,
      streamedNarration: "", narrationClipped: false, narrationRenderFrame: null, activeNarrationId: "", activeNarrationTurnId: "",
      streamedOutput: "", activeOutputId: "", draftNote: null, revisionRequested: false, activeReasoningId: "", thought: "", thoughtFrame: null,
      steps: new Map(), activeStep: "", resumes: [], toolRows: new Map(), activeToolCallIds: new Set(), startedAt: Date.now(), completed: false, ranSummary: "", acted: false,
    };
    // The whole line opens the checklist, not only its chevron: the chevron is a 14px target.
    liveLine.addEventListener("click", () => { if (!detailToggle.hidden) this.#setDetailOpen(turn, !turn.detailOpen); });
    return turn;
  }

  /** Whether a checklist entry is out of view: until the turn folds, only a reader who opened the checklist sees it. */
  #detailHidden(turn: TurnUi): boolean {
    return !turn.revealed && !turn.detailOpen;
  }

  /**
   * Opens or closes the checklist under a turn that is still running.
   *
   * What the agent said stays in view either way — it is the reply. Only the checklist moves: the
   * plan's steps, each with the calls made under it. Folded, the turn's own summary line does this.
   */
  #setDetailOpen(turn: TurnUi, open: boolean): void {
    if (turn.revealed || turn.detailOpen === open) return;
    turn.detailOpen = open;
    turn.liveLine.dataset.detail = open ? "open" : "closed";
    turn.thinking.dataset.detail = open ? "open" : "closed";
    turn.detailToggle.setAttribute("aria-expanded", String(open));
    for (const child of [...turn.timeline.children] as HTMLElement[]) {
      if (!SPOKEN_KINDS.has(child.dataset.messageKind ?? "")) child.hidden = !open;
    }
    this.#placeCallLine(turn);
    this.#emit("thinking-toggle", { sessionId: this.#sessionId, open, complete: false });
    this.#scrollToLatest();
  }

  /** The chevron is offered once the turn has a checklist entry to open onto. */
  #offerDetail(turn: TurnUi): void {
    if (turn.detailToggle.hidden) turn.detailToggle.hidden = false;
  }

  /** Appends a plain notice line: under the step being carried out, or on the account's own timeline. */
  #addRow(turn: TurnUi, key: string, container: HTMLElement = turn.timeline): TimelineRow {
    const element = document.createElement("div");
    element.className = "acw-work";
    element.dataset.kind = "notice";
    element.dataset.rowKey = key;
    const icon = document.createElement("span");
    icon.className = "acw-work-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.append(this.#rowIcon("notice"));
    const label = document.createElement("span");
    label.className = "acw-work-label";
    element.append(icon, label);
    // The checklist lists notices; while the turn runs and it is closed, the live line speaks for them.
    element.hidden = container === turn.timeline && this.#detailHidden(turn);
    container.append(element);
    this.#offerDetail(turn);
    const row: TimelineRow = { key, kind: "notice", element, icon, label };
    turn.rows.set(key, row);
    this.#scrollToLatest();
    return row;
  }

  /**
   * One tool call's own checklist-style line — the same shape a plan step's entry uses, so its
   * mark comes straight from the `.acw-thinking-item[data-state=...]` rules already drawing ✓/✕/–.
   * Nested under the plan step it ran inside when the runtime says which one that was, else on the
   * account's own timeline (spec §3.7 rendering table).
   */
  #addToolRow(turn: TurnUi, callId: string, label: string, workStepId: string | undefined): ToolRow {
    const step = workStepId ? this.#ownStep(turn, workStepId) : turn.activeStep ? this.#stepItem(turn, turn.activeStep) : undefined;
    const container = step ? step.work : turn.timeline;
    const element = document.createElement("div");
    element.className = "acw-thinking-item";
    element.dataset.state = "active";
    const dot = document.createElement("span");
    dot.className = "acw-thinking-dot";
    dot.setAttribute("aria-hidden", "true");
    const words = document.createElement("span");
    words.textContent = label;
    element.append(dot, words);
    element.hidden = container === turn.timeline && this.#detailHidden(turn);
    container.append(element);
    this.#offerDetail(turn);
    const row: ToolRow = { element, label: words };
    turn.toolRows.set(callId, row);
    this.#scrollToLatest();
    return row;
  }

  /** A small monochrome glyph saying what kind of line this is, in the ink of the words beside it. */
  #rowIcon(glyph: Glyph): SVGSVGElement {
    const paths: Record<Glyph, string> = {
      // Only work that really finished gets a check. A step still being carried out, or waiting on the
      // user's decision, gets an empty circle: the same promise the checklist's ○ makes.
      done: "M7 10.2l2.1 2.1 4-4.3M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14",
      waiting: "M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14",
      work: "M4 5.5c0-1.1 2.7-2 6-2s6 .9 6 2-2.7 2-6 2-6-.9-6-2m0 0v9c0 1.1 2.7 2 6 2s6-.9 6-2v-9M4 10c0 1.1 2.7 2 6 2s6-.9 6-2",
      notice: "M16 10a6 6 0 1 1-1.76-4.24M16 4.5v3h-3",
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "15");
    svg.setAttribute("height", "15");
    svg.setAttribute("fill", "none");
    svg.setAttribute("viewBox", "0 0 20 20");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", paths[glyph]);
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-width", "1.5");
    svg.append(path);
    return svg;
  }

  /**
   * Gives every line still saying it is running the ending the turn actually had.
   *
   * Tool phrases are the widget's to settle: the server says when a call starts and when it ends,
   * and a turn that ends first leaves the line mid-sentence. A plan step is the agent's own
   * sentence, and only the agent may call one finished — see `#settlePlanTrace`.
   */
  #settleWork(turn: TurnUi, ending: "completed" | "partial" | "failed"): void {
    this.#settleRetries(turn, ending === "failed" ? "error" : "done");
    for (const callId of turn.activeToolCallIds) {
      const row = turn.toolRows.get(callId);
      // The runtime never sent this call's ending — the turn stopped while it was still running,
      // so its outcome is genuinely unknown, which is exactly what the "stopped" mark says. Only
      // a `tool-completed{status:"succeeded"}` may ever put a ✓ here.
      if (row) row.element.dataset.state = ending === "failed" ? "error" : "partial";
    }
    turn.activeToolCallIds.clear();
  }

  /** Tool work done while a step is being carried out belongs under that step in the checklist. */
  #workContainer(turn: TurnUi): HTMLElement {
    const step = turn.activeStep ? this.#stepItem(turn, turn.activeStep) : undefined;
    return step ? step.work : turn.timeline;
  }

  /**
   * The two lines that say where the turn is, each replaced in place.
   *
   * The live line is the plan step being carried out; the call line, under it, is the latest call
   * made for that step. With no plan the live line carries the call itself, and with nothing known
   * it says "Đang suy nghĩ". They used to be one line showing whichever was more specific, so a
   * running call hid the step it belonged to and a reader who looked up mid-call could not tell how
   * far along the plan was. A list growing while the turn runs is still not what the reader should
   * have to follow: the checklist is behind the live line's chevron.
   *
   * While the model thinks between calls, what it is thinking takes the same place: the live line
   * when there is no step, the call line when there is one.
   *
   * The call line keeps the last call's own ending — "Đã đọc biểu «24-SNGD»: 32 dòng" — until the
   * next call or the next step. It used to show only a call still running and vanish between
   * calls: against a document server that answers in milliseconds it was on screen for one frame
   * at a time, ten times in a row, which read as the reply twitching and told nobody what was read.
   */
  #refreshLiveLine(turn: TurnUi): void {
    if (turn.completed) return;
    const activeCallId = [...turn.activeToolCallIds].at(-1);
    const call = activeCallId ? turn.toolRows.get(activeCallId)?.label.textContent ?? "" : "";
    const retrying = [...turn.rows.values()].some((row) => row.element.dataset.code === "retrying" && row.element.dataset.state === "active");
    const step = turn.activeStep ? this.#stepItem(turn, turn.activeStep) : undefined;
    const lastRow = turn.lastCallId && turn.lastCallStep === turn.activeStep ? turn.toolRows.get(turn.lastCallId) : undefined;
    const last = lastRow?.label.textContent ?? "";
    const doing = call || (retrying ? "Đang thử lại…" : "");
    // Between calls the model is thinking, and what it thinks is what is happening.
    const thought = doing ? "" : this.#thoughtLine(turn);
    const [source, words]: [LiveSource, string] = step ? ["step", step.title]
      : call ? ["work", call]
      : retrying ? ["notice", doing]
      : ["thinking", thought || this.#settings.labels.thinking];
    this.#setLiveLine(turn, source, words, "active", source === "thinking" ? null : source === "step" ? "waiting" : source);
    this.#setCallLine(turn, step ? doing || thought || last : "", doing ? "active" : thought ? "thinking" : lastRow?.element.dataset.state ?? "active");
    // The line stays for as long as the turn runs, text streaming under it or not. It used to stand
    // down whenever the answer bubble was writing — and what the agent says mid-turn is written
    // there first, before the runtime calls it narration — so the line vanished for a second and
    // came back, and the answer below shifted by a line when the summary finally took its place.
    if (!turn.liveLine.hidden) return;
    turn.liveLine.hidden = false;
    this.#scrollToLatest();
  }

  /** The latest call for the step on the live line; nothing until the step has made one. */
  #setCallLine(turn: TurnUi, words: string, state = "active"): void {
    const label = turn.callLine.querySelector(".acw-live-label");
    if (label && label.textContent !== words) label.textContent = words;
    // The line outlives its call, so it has to say whether the call is still running: a product
    // that writes one phrase per tool sends "Đang lấy dữ liệu…" for the ending too, and kept on
    // the line unmarked that reads as a call that never finished.
    if (turn.callLine.dataset.state !== state) {
      turn.callLine.dataset.state = state;
      turn.callLine.firstElementChild?.replaceChildren(...(state === "thinking" ? [] : [this.#rowIcon(state === "done" ? "done" : "work")]));
    }
    this.#placeCallLine(turn);
  }

  /** In view only while it adds something: the open checklist already lists the call under its step. */
  #placeCallLine(turn: TurnUi): void {
    const words = turn.callLine.querySelector(".acw-live-label")?.textContent ?? "";
    turn.callLine.hidden = !words || turn.revealed || turn.detailOpen;
  }

  #setLiveLine(turn: TurnUi, source: LiveSource, words: string, state: "active" | "settled", glyph: Glyph | null): void {
    const line = turn.liveLine;
    const icon = glyph ?? "none";
    if (line.dataset.icon !== icon) {
      line.firstElementChild?.replaceChildren(...(glyph ? [this.#rowIcon(glyph)] : []));
      line.dataset.icon = icon;
    }
    line.dataset.source = source;
    line.dataset.state = state;
    const label = line.querySelector(".acw-live-label");
    if (label && label.textContent !== words) label.textContent = words;
    if (words) this.#compactLabel.textContent = source === "thinking" ? this.#settings.labels.thinking : words;
  }

  /**
   * A settled turn's live line says where the work stopped — the step it paused in, or else the last
   * work done — without shimmer. A turn waiting on a decision keeps showing it above its card, so its
   * glyph must not claim more than happened: a paused step is still waiting, and only work that
   * finished carries a check.
   */
  #settleLiveLine(turn: TurnUi, step: StepItem | undefined): void {
    const lastToolCallId = [...turn.toolRows.keys()].at(-1);
    const lastTool = lastToolCallId ? turn.toolRows.get(lastToolCallId) : undefined;
    const words = step ? step.title : lastTool?.label.textContent ?? "";
    const glyph: Glyph = step ? "waiting" : lastTool?.element.dataset.state === "done" ? "done" : "work";
    this.#setLiveLine(turn, step ? "step" : "work", words, "settled", glyph);
    turn.liveLine.hidden = !words;
    this.#setCallLine(turn, "");
  }

  /**
   * A retry is news while it waits and a record once it has happened.
   *
   * Nothing on the wire says a retry is over: the next attempt simply starts. Left as announced, the
   * line spun until the turn ended and then kept a ✓ beside a sentence still saying it was retrying.
   */
  #settleRetries(turn: TurnUi, state: TraceState = "done"): void {
    for (const row of turn.rows.values()) {
      if (row.element.dataset.code !== "retrying" || row.element.dataset.state !== "active") continue;
      row.element.dataset.state = state;
      row.label.textContent = "Đã thử lại";
    }
  }

  #commitNarration(turn: TurnUi): void {
    this.#cancelNarrationRender(turn);
    const content = turn.streamedNarration.trim();
    if (!content) {
      turn.narrationDraft?.remove();
      turn.narrationDraft = null;
      this.#refreshLiveLine(turn);
      return;
    }
    const narration = narrationBubble(content, turn.narrationDraft ?? undefined);
    if (!turn.narrationDraft) turn.timeline.append(narration);
    turn.committedNarrations.push({ content, element: narration });
    turn.narrationDraft = null;
    turn.streamedNarration = "";
    this.#refreshLiveLine(turn);
    // The chat's own sanitised markup, so what the narration bolds (the figures) stays bold here.
    if (narration.textContent) this.#compactMessage.innerHTML = narration.innerHTML;
    else this.#compactMessage.textContent = content;
    this.#compactMessage.hidden = false;
    this.#message({ role: "assistant", kind: "narration", content, at: new Date().toISOString(), ...(turn.activeNarrationTurnId ? { turnId: turn.activeNarrationTurnId } : {}) });
  }

  #sameMessage(left: string, right: string): boolean {
    const normalize = (value: string) => value.replaceAll(/\s+/g, " ").trim();
    return normalize(left) === normalize(right);
  }

  #removeDuplicateNarrations(turn: TurnUi, finalContent: string): void {
    for (let index = turn.committedNarrations.length - 1; index >= 0; index -= 1) {
      const narration = turn.committedNarrations[index];
      if (!narration || !this.#sameMessage(narration.content, finalContent)) continue;
      narration.element.remove();
      turn.committedNarrations.splice(index, 1);
    }
    // A folded account emptied this way has nothing left to open onto.
    if (turn.completed) turn.thinking.dataset.empty = String(turn.timeline.children.length === 0);
  }

  #observeProgress(progress: unknown): void {
    this.#interjected.read(progress, this.#settings.labels.interjectionRead);
    try { this.#options.onProgress?.(progress); } catch { /* Consumer callbacks cannot break the widget. */ }
    this.#emit("progress", { sessionId: this.#sessionId, progress });
  }

  /** How much user-addressed text a block has streamed so far, for the host's layout; never the text itself. */
  #observeText(kind: "answer" | "narration", id: string, chars: number): void {
    try { this.#options.onTextProgress?.({ kind, id, chars }); } catch { /* Consumer callbacks cannot break the widget. */ }
  }

  #resetOutputDraft(turn: TurnUi, clearBubble: boolean): void {
    turn.discardedOutputIds.clear();
    turn.activeOutputId = "";
    turn.streamedOutput = "";
    turn.bubble.removeAttribute("aria-busy");
    if (clearBubble) {
      turn.bubble.replaceChildren();
      turn.bubble.hidden = true;
      this.#removeDraftNote(turn);
      this.#refreshLiveLine(turn);
    }
  }

  /**
   * Stands a note in the answer bubble while an output is written, and while a review decides on it.
   *
   * Nothing a model writes is painted before the runtime accepts it: painted as it streamed, a draft
   * the review sends back would appear and vanish, and the reviewing note take its place.
   * The note says which of the two is going on; the live line above it says what the turn is doing.
   */
  #showDraftNote(turn: TurnUi): void {
    let note = turn.draftNote;
    if (!note || note.parentNode !== turn.bubble) {
      if (!note) {
        note = document.createElement("div");
        note.className = "acw-draft-note";
        note.setAttribute("role", "status");
        const dots = document.createElement("span");
        dots.className = "acw-typing";
        dots.setAttribute("aria-hidden", "true");
        dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
        const label = document.createElement("span");
        label.className = "acw-draft-note-label";
        note.append(dots, label);
        turn.draftNote = note;
      }
      turn.bubble.replaceChildren(note);
    }
    note.dataset.kind = turn.revisionRequested ? "revising" : "composing";
    const label = note.lastElementChild;
    if (label) label.textContent = turn.revisionRequested ? "Đang rà soát lại câu trả lời…" : "Đang soạn câu trả lời…";
    turn.bubble.setAttribute("aria-busy", "true");
    turn.bubble.hidden = false;
    this.#refreshLiveLine(turn);
    this.#scrollToLatest();
  }

  /** The note has nothing left to stand in for: an answer took its place, or the bubble starts from nothing. */
  #removeDraftNote(turn: TurnUi): void {
    turn.draftNote?.remove();
    turn.draftNote = null;
    turn.revisionRequested = false;
  }

  #startOutput(turn: TurnUi, outputId: string): void {
    if (typeof outputId !== "string" || !/^[a-zA-Z0-9._:-]{1,256}$/.test(outputId) || outputId === turn.activeOutputId) return;
    // Writing is work resuming, so a retry announced before it has happened.
    this.#settleRetries(turn);
    // Whatever the bubble already shows is replaced where it stands, never hidden first.
    this.#resetOutputDraft(turn, false);
    turn.activeOutputId = outputId;
    turn.bubble.dataset.messageKind = "output-draft";
    this.#showDraftNote(turn);
  }

  #appendOutputDelta(turn: TurnUi, outputId: string, delta: string): void {
    if (typeof delta !== "string" || !delta || outputId !== turn.activeOutputId || turn.discardedOutputIds.has(outputId)) return;
    if (turn.streamedOutput.length + delta.length > OUTPUT_MAX_CHARS) {
      turn.discardedOutputIds.add(outputId);
      turn.streamedOutput = "";
      return;
    }
    // Gathered, not painted: the end of this output says whether it is the answer.
    turn.streamedOutput += delta;
  }

  #endOutput(turn: TurnUi, outputId: string, status: "completed" | "discarded"): void {
    if (outputId !== turn.activeOutputId) return;
    if (status === "discarded" || turn.discardedOutputIds.has(outputId)) {
      // Nothing of it was shown. Under review, the note goes on saying why the answer is not there yet.
      this.#resetOutputDraft(turn, !turn.revisionRequested);
      if (turn.revisionRequested) this.#showDraftNote(turn);
      return;
    }
    const answer = turn.streamedOutput;
    // A draft that completed empty has nothing to replace the note with; the result still will.
    if (answer) {
      // Told once, before it paints: the host lays itself out for the whole answer in the frame it appears.
      this.#observeText("answer", outputId, answer.length);
      this.#removeDraftNote(turn);
      turn.bubble.innerHTML = renderMarkdown(answer);
    }
    this.#refreshLiveLine(turn);
    turn.bubble.dataset.messageKind = "output";
    turn.bubble.setAttribute("aria-busy", "false");
    turn.discardedOutputIds.delete(outputId);
    turn.activeOutputId = "";
    turn.streamedOutput = "";
    this.#stickToBottomNow();
  }

  #startNarration(turn: TurnUi, narrationId: string, turnId?: string, kind?: "draft"): void {
    if (typeof narrationId !== "string" || !/^[a-zA-Z0-9._:-]{1,256}$/.test(narrationId) || narrationId === turn.activeNarrationId) return;
    if (turn.activeNarrationId) {
      this.#cancelNarrationRender(turn);
      turn.streamedNarration = "";
      turn.narrationClipped = false;
      turn.narrationDraft?.remove();
    }
    // This narration is the draft currently streaming into the answer bubble, recognized as
    // narration after the fact (§10.9): its `narrationId` is the same output the bubble was
    // building. The narration slot below carries the words from here — the bubble is withdrawn
    // outright, with no "reviewing" note and nothing retyped; the matching
    // assistant-output-end(discarded) that follows only confirms what already happened here.
    if (narrationId === turn.activeOutputId && !turn.discardedOutputIds.has(narrationId)) {
      turn.discardedOutputIds.add(narrationId);
      if (kind === "draft") {
        // Sent back: the note says why the answer is not there yet, until the next draft is accepted.
        turn.revisionRequested = true;
        this.#resetOutputDraft(turn, false);
        this.#showDraftNote(turn);
      } else this.#resetOutputDraft(turn, true);
    }
    turn.activeNarrationId = narrationId;
    turn.activeNarrationTurnId = typeof turnId === "string" ? turnId : "";
    turn.streamedNarration = "";
    turn.narrationClipped = false;
    // Speaking is work resuming too, so a retry announced before it has happened.
    this.#settleRetries(turn);
    this.#dropThought(turn);
    // Told after everything so far, so it goes at the end of the timeline — and the work that
    // follows it is told under it rather than folded into a line above.
    const draft = narrationBubble("", undefined, kind === "draft");
    tagNarration(draft, narrationId);
    turn.narrationDraft = draft;
    // After everything done so far, and ahead of the steps still to come: the checklist lists the
    // whole plan from the start, and what the agent says belongs where it said it, not under
    // steps it had not reached.
    const upcoming = ([...turn.timeline.children] as HTMLElement[]).find((child) => child.classList.contains("acw-check-step") && child.dataset.state === "pending");
    turn.timeline.insertBefore(draft, upcoming ?? null);
    this.#refreshLiveLine(turn);
    this.#scrollToLatest();
  }

  #appendNarrationDelta(turn: TurnUi, narrationId: string, delta: string): void {
    if (typeof narrationId !== "string" || typeof delta !== "string" || !delta || narrationId !== turn.activeNarrationId || turn.narrationClipped) return;
    // A long narration (a draft the runtime kept as progress) is cut, never withdrawn: the user has read it.
    const joined = turn.streamedNarration + delta;
    turn.narrationClipped = joined.length > NARRATION_MAX_CHARS;
    turn.streamedNarration = clipNarration(joined);
    this.#scheduleNarrationRender(turn);
    this.#observeText("narration", narrationId, turn.streamedNarration.length);
  }

  #cancelNarrationRender(turn: TurnUi): void {
    if (turn.narrationRenderFrame === null) return;
    window.cancelAnimationFrame(turn.narrationRenderFrame);
    turn.narrationRenderFrame = null;
  }

  #scheduleNarrationRender(turn: TurnUi): void {
    if (turn.narrationRenderFrame !== null) return;
    const narrationId = turn.activeNarrationId;
    turn.narrationRenderFrame = window.requestAnimationFrame(() => {
      turn.narrationRenderFrame = null;
      // A kept draft is hidden, and renders only once, when it ends.
      if (turn.activeNarrationId !== narrationId || !turn.narrationDraft || turn.narrationDraft.hidden) return;
      // As Markdown from the first frame: shown raw, its marks snapped into format only when it ended.
      turn.narrationDraft.innerHTML = renderMarkdown(healStreamedMarkdown(turn.streamedNarration));
      this.#stickToBottomNow();
    });
  }

  #endNarration(turn: TurnUi, narrationId: string, status: "completed" | "discarded"): void {
    if (typeof narrationId !== "string" || narrationId !== turn.activeNarrationId) return;
    this.#cancelNarrationRender(turn);
    const discarded = status === "discarded";
    if (!discarded) this.#commitNarration(turn);
    turn.activeNarrationId = "";
    turn.activeNarrationTurnId = "";
    turn.streamedNarration = "";
    turn.narrationClipped = false;
    if (discarded) {
      turn.narrationDraft?.remove();
      turn.narrationDraft = null;
      this.#refreshLiveLine(turn);
    }
  }

  /**
   * What the model is thinking, shown while it thinks — on the line that shimmers, replaced as it
   * goes, and gone when the thought ends: it is the turn being alive, not part of its account.
   *
   * It was hidden outright before: the thinking is written for nobody, once showed an English
   * sentence in a Vietnamese payroll trace, and names the tools it is about to call. A product now
   * chooses whether to send the text at all, and the server takes the identifiers out before it
   * does. A product that sends none still shows only that it is thinking.
   */
  #startReasoning(turn: TurnUi, reasoningId: string): void {
    if (typeof reasoningId !== "string" || !/^[a-zA-Z0-9._:-]{1,256}$/.test(reasoningId) || reasoningId === turn.activeReasoningId) return;
    turn.activeReasoningId = reasoningId;
    turn.thought = "";
    this.#settleRetries(turn);
    this.#refreshLiveLine(turn);
  }

  #appendReasoning(turn: TurnUi, reasoningId: string, delta: string): void {
    if (turn.completed || reasoningId !== turn.activeReasoningId || typeof delta !== "string" || !delta) return;
    // Only the tail is ever shown, so only the tail is kept.
    turn.thought = (turn.thought + delta).slice(-THOUGHT_KEPT_CHARS);
    if (turn.thoughtFrame !== null) return;
    turn.thoughtFrame = window.requestAnimationFrame(() => {
      turn.thoughtFrame = null;
      this.#refreshLiveLine(turn);
    });
  }

  /**
   * Private reasoning is ephemeral by contract, so its end leaves nothing behind in the timeline.
   *
   * The line keeps the last thought until the next thing happens, though. A server that passes
   * only whole sentences releases the last one as the thought ends; cleared here, it was never on
   * screen at all, and the seconds the model then spends writing out its calls went back to a
   * bare "thinking".
   */
  #endReasoning(turn: TurnUi, reasoningId: string): void {
    if (reasoningId !== turn.activeReasoningId) return;
    turn.activeReasoningId = "";
    this.#refreshLiveLine(turn);
  }

  /** Something else is happening now — a call, a plan update, the agent speaking: what was thought before it is over. */
  #dropThought(turn: TurnUi): void {
    turn.thought = "";
  }

  /**
   * The thought as one line: the sentence being written now, with the one before it while the new
   * one is only a few words long, so the line never drops to a single word mid-thought.
   */
  #thoughtLine(turn: TurnUi): string {
    const text = turn.thought.replace(/[*#`>|]+/gu, " ").replace(/\s+/gu, " ").trim();
    if (!text) return "";
    const sentences = text.split(/(?<=[.!?…:;])\s+/u);
    let line = sentences.at(-1) ?? "";
    if (line.length < THOUGHT_MIN_CHARS && sentences.length > 1) line = `${sentences.at(-2)} ${line}`;
    return line.length > THOUGHT_LINE_CHARS ? `…${line.slice(-THOUGHT_LINE_CHARS)}` : line;
  }

  /**
   * The runtime's plan: kept as a checklist for the folded account, straight from `plan.state` and
   * each step's own `status` — see `planStepMark` (core/plan-marks.ts). Nothing here reads a
   * phrase or guesses an ending; identity, scope and closure are the runtime's, never the widget's.
   */
  #handlePlan(turn: TurnUi, event: { readonly cause: AgentChatPlanCause; readonly plan: AgentChatWorkPlan; readonly changedStepIds?: readonly string[] }): void {
    if (turn.completed) return;
    const { plan, changedStepIds } = event;
    // A `terminal` frame closing a plan this turn never proposed (the retired dormant plan from
    // the previous task, whichever order core reports it in) is not this turn's account to repaint
    // — only a `proposal`/`restore` frame ever establishes which plan this turn owns.
    if (event.cause === "terminal" && plan.planId !== turn.planId) return;
    if (plan.planId) turn.planId = plan.planId;
    this.#dropThought(turn);
    const changed = changedStepIds ? new Set(changedStepIds) : undefined;
    let active = "";
    for (const [index, step] of plan.steps.entries()) {
      if (step.status === "in_progress") active = step.id;
      // A step not reached yet is on the checklist too, in the quiet ink of something still to
      // come: the plan is what the reader is following, and a list that only ever shows what is
      // already done cannot say how much is left.
      const mark = planStepMark(step.status, plan.state, true) ?? "pending";
      let item = this.#stepItem(turn, step.id);
      // A step already on this turn's checklist always updates in place. A step only a turn this one
      // resumed holds is entered here once this turn carries it on (or finishes it): the work it
      // runs is told in its own fold. One it has not reached stays a forecast on the paused turn.
      // A finished step new to this turn is only entered when the runtime says it changed here —
      // a step finished before this turn began is history, however many times the whole plan is resent.
      if (!item) {
        const earlier = this.#earlierStep(turn, step.id);
        if (earlier) {
          const continues = step.status === "in_progress" || earlier.item.element.dataset.state === "paused" || changed?.has(step.id) === true;
          if (step.status === "pending" || !continues) continue;
          item = this.#ownStep(turn, step.id);
        } else {
          if (step.status === "completed" && changed && !changed.has(step.id)) continue;
          item = this.#addStep(turn, step.id, plan.steps.slice(index + 1).map((later) => later.id));
        }
      }
      if (!item) continue;
      item.element.dataset.state = mark;
      item.label.textContent = step.description;
      item.title = step.description;
      if (step.status === "completed" && step.outcome) this.#noteStep(turn, item, step.outcome);
    }
    // A dropped forecast leaves the checklist. A step that started stays as history,
    // but removing it from the plan also ends its running indicator without claiming success.
    const planned = new Set(plan.steps.map((step) => step.id));
    for (const owner of [turn, ...turn.resumes]) {
      for (const [id, item] of [...owner.steps]) {
        if (planned.has(id)) continue;
        if (item.element.dataset.state === "active") item.element.dataset.state = "partial";
        if (item.element.dataset.state !== "pending") continue;
        item.element.remove();
        owner.steps.delete(id);
      }
    }
    turn.activeStep = active;
    if (event.cause === "proposal" && plan.revision === 1) this.#tellPlan(turn, plan);
    this.#refreshLiveLine(turn);
    this.#scrollToLatest();
  }

  /** A step's checklist entry in this turn's own account. A turn it resumed keeps its own entry of the step. */
  #stepItem(turn: TurnUi, id: string): StepItem | undefined {
    return turn.steps.get(id);
  }

  /** The entry a turn this one resumed holds for the step, with that turn. */
  #earlierStep(turn: TurnUi, id: string): { readonly owner: TurnUi; readonly item: StepItem } | undefined {
    for (const owner of [...turn.resumes].reverse()) {
      const item = owner.steps.get(id);
      if (item) return { owner, item };
    }
    return undefined;
  }

  /**
   * The step's entry in this turn's own account; a step the paused turn holds gets a new entry of
   * its own here, so the work this turn runs for it is told in this turn's fold. The paused turn's
   * entry keeps what it said when it stopped — except a forecast it never reached, which moves.
   */
  #ownStep(turn: TurnUi, id: string): StepItem | undefined {
    const own = turn.steps.get(id);
    if (own) return own;
    const earlier = this.#earlierStep(turn, id);
    if (!earlier) return undefined;
    const item = this.#addStep(turn, id);
    item.label.textContent = earlier.item.label.textContent;
    item.title = earlier.item.title;
    item.element.dataset.state = "active";
    if (earlier.item.element.dataset.state === "pending") {
      earlier.item.element.remove();
      earlier.owner.steps.delete(id);
    }
    return item;
  }

  /**
   * A plan step on this turn's checklist: out of view until the turn folds or the reader opens it.
   * `laterIds` are the steps the plan puts after this one; it goes in ahead of the first of them
   * already listed, so a step added by a later revision lands where the plan has it.
   */
  #addStep(turn: TurnUi, id: string, laterIds: readonly string[] = []): StepItem {
    const element = document.createElement("div");
    element.className = "acw-thinking-item acw-check-step";
    element.dataset.stepId = id;
    element.hidden = this.#detailHidden(turn);
    const dot = document.createElement("span");
    dot.className = "acw-thinking-dot";
    dot.setAttribute("aria-hidden", "true");
    const body = document.createElement("div");
    body.className = "acw-check-body";
    const label = document.createElement("span");
    label.className = "acw-check-label";
    const work = document.createElement("div");
    work.className = "acw-check-work";
    body.append(label, work);
    element.append(dot, body);
    const next = laterIds.map((later) => turn.steps.get(later)?.element).find((later) => later?.parentNode === turn.timeline);
    turn.timeline.insertBefore(element, next ?? null);
    this.#offerDetail(turn);
    const item: StepItem = { id, element, label, work, title: "" };
    turn.steps.set(id, item);
    return item;
  }

  /**
   * What a finished step found, told as chat text at the point the step ended.
   *
   * The agent writes it on the plan when it closes a step ("Đã đọc file Excel, nhận diện 46 sheet…")
   * and it is the one account of the work a model that says nothing beside its calls ever gives.
   * It used to be parsed and dropped: such a turn showed one line for its whole length and then
   * the answer, with the plan's own record of what each step had found never reaching the screen.
   * It goes after everything said during the step and ahead of the next step, so both the running
   * turn and the folded checklist read in the order things happened.
   */
  #noteStep(turn: TurnUi, item: StepItem, outcome: string): void {
    const owner = [turn, ...turn.resumes].find((each) => each.steps.get(item.id) === item) ?? turn;
    let note = owner.stepNotes.get(item.id);
    if (!note) {
      note = document.createElement("div");
      note.className = "acw-markdown acw-step-note";
      note.dataset.messageKind = "step-note";
      let next = item.element.nextSibling as HTMLElement | null;
      while (next && !next.classList.contains("acw-check-step")) next = next.nextSibling as HTMLElement | null;
      owner.timeline.insertBefore(note, next);
      owner.stepNotes.set(item.id, note);
      this.#scrollToLatest();
    }
    if (note.textContent !== outcome) note.textContent = outcome;
  }

  /**
   * The plan told once as chat text, in the host's own words — never the widget's (spec §3.7:
   * generic layers write no business-language copy). Only the first `cause:"proposal"`
   * frame of a brand-new plan reaches here (see the caller), and only when the agent's own
   * narration is not already saying it.
   *
   * With no host sentence nothing is told here, and deliberately: the plan's steps as a numbered list
   * would put twenty lines of chat in front of the reader before any work is done, for a plan with a
   * step per form. The plan is behind the live line's chevron; the
   * chat is for what the agent says and what each step found.
   */
  #tellPlan(turn: TurnUi, plan: AgentChatWorkPlan): void {
    if (turn.committedNarrations.length > 0 || turn.narrationDraft) return;
    const planSentence = this.#settings.labels.planSentence;
    const descriptions = plan.steps.filter((step) => step.status !== "completed").map((step) => step.description);
    const sentence = planSentence?.(descriptions);
    if (!sentence) return;
    let element = turn.planSentence;
    if (!element) {
      // Chat text in look only: the widget wrote it, so it is not a message, and nothing that reads
      // `.acw-bubble` as the agent's words — a host, the answer's own streaming — should find it.
      element = document.createElement("div");
      element.className = "acw-markdown acw-plan-sentence";
      turn.timeline.parentNode?.insertBefore(element, turn.timeline);
      turn.planSentence = element;
    }
    element.textContent = sentence;
    this.#scrollToLatest();
  }

  /**
   * A tool call starting: its own checklist-style line, exactly like a plan step's entry (spec
   * §3.7/§10.6). `workStepId`, when the runtime sends one, nests it under that step's own work.
   */
  #handleToolStarted(turn: TurnUi, callId: string, label: string | undefined, workStepId: string | undefined): void {
    if (turn.completed || typeof callId !== "string" || !callId) return;
    this.#settleRetries(turn);
    this.#dropThought(turn);
    const row = turn.toolRows.get(callId) ?? this.#addToolRow(turn, callId, label ?? TOOL_TRACE_FALLBACK, workStepId);
    row.element.dataset.state = "active";
    if (label) row.label.textContent = label;
    turn.activeToolCallIds.add(callId);
    turn.lastCallId = callId;
    turn.lastCallStep = turn.activeStep;
    this.#refreshLiveLine(turn);
  }

  /** A tool call's ending, marked straight from the status the runtime published — see `toolStatusMark`. */
  #handleToolCompleted(turn: TurnUi, callId: string, label: string | undefined, status: AgentChatToolStatus): void {
    turn.activeToolCallIds.delete(callId);
    if (turn.completed) return;
    const row = turn.toolRows.get(callId);
    if (!row) return;
    row.element.dataset.state = toolStatusMark(status);
    if (label) row.label.textContent = label;
    // Of calls made together, the one that ended last is the latest thing that happened.
    if (turn.activeToolCallIds.size === 0) turn.lastCallId = callId;
    this.#refreshLiveLine(turn);
  }

  /** Backward-compatible path for a host's own custom protocol still publishing generic `activity` frames. */
  #handleToolActivity(turn: TurnUi, activity: AgentChatActivity): void {
    if (activity.state === "active") this.#handleToolStarted(turn, activity.id, activity.label, undefined);
    else this.#handleToolCompleted(turn, activity.id, activity.label, activity.state === "done" ? "succeeded" : "outcome_unknown");
  }

  #handleActivity(turn: TurnUi, activity: AgentChatActivity): void {
    if (!activity || typeof activity.id !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(activity.id) ||
        (activity.state !== "active" && activity.state !== "done" && activity.state !== "partial" && activity.state !== "awaiting")) return;
    // `#handlePlan` has always had this guard and this did not. A reconnect after the turn ends
    // appended a warning below the closing line, and nothing settled it afterwards: the account
    // sat folded and finished with a spinner running inside it.
    if (turn.completed) return;
    const code = activity.code;
    if (code === "completed") {
      // A turn paused on an approval or a question is not a turn that finished: the header must
      // say so, never the completion summary — the account itself already stays open, unfolded,
      // for exactly this reason.
      const awaiting = activity.state === "awaiting";
      this.#completeThinking(turn, false, activity.state === "partial", awaiting ? this.#settings.labels.awaitingUser : undefined);
      return;
    }
    if (code === "failed") {
      this.#completeThinking(turn, true);
      return;
    }
    if (code === "working") { this.#handleToolActivity(turn, activity); return; }
    // The review is said in the answer's own bubble, where the withdrawn text was.
    if (code === "revising") {
      if (activity.state === "active") this.#reviseDraft(turn);
      return;
    }
    // Generic placeholders are not lines of their own: "Đang suy nghĩ" already says the agent is at
    // it, and a line repeating that under every narration is noise. A new attempt, or writing
    // starting, is still work resuming — so the retry announced before it has happened.
    if (code === "analyzing" || code === "composing") {
      this.#settleRetries(turn);
      this.#refreshLiveLine(turn);
      return;
    }
    const labels: Record<Exclude<AgentChatActivityCode, "completed" | "failed" | "working" | "revising" | "analyzing" | "composing">, string> = {
      retrying: "Đang thử lại…",
      "safety-limit": "Đã dừng ở giới hạn xử lý an toàn",
    };
    const label = labels[code];
    if (typeof label !== "string") return;
    this.#noticeRow(turn, activity, label);
  }

  /** Something the turn says about itself — a retry, a safety stop — as its own line where it happened. */
  #noticeRow(turn: TurnUi, activity: AgentChatActivity, label: string): void {
    const key = `notice:${activity.id}`;
    const container = this.#workContainer(turn);
    let row = turn.rows.get(key);
    // Repeated after other work was told, it is a new event and belongs where it happened. The
    // earlier line keeps its place under another key, so it still settles with the turn.
    if (row && container.lastElementChild !== row.element) {
      turn.rows.delete(key);
      turn.rows.set(`${key}:${turn.rows.size}`, row);
      row = undefined;
    }
    row ??= this.#addRow(turn, key, container);
    row.element.dataset.code = activity.code;
    row.element.dataset.state = activity.state;
    row.label.textContent = label;
    this.#refreshLiveLine(turn);
  }

  /**
   * A policy sent the answer back, and the answer's own bubble says so.
   *
   * It used to be a row appended under the trace in the same frame the bubble emptied, which is
   * what made the trace look as if it had slid over the answer; and nothing afterwards could say
   * the review was over, so the row spun on and finished as a ticked "đang rà soát…". The draft is
   * withdrawn here rather than when its end arrives: the review has already rejected it, and a
   * delta still in flight must not paint it back.
   */
  #reviseDraft(turn: TurnUi): void {
    turn.revisionRequested = true;
    if (turn.activeOutputId) turn.discardedOutputIds.add(turn.activeOutputId);
    this.#showDraftNote(turn);
  }

  /**
   * Settles a turn's account, so nothing on it goes on saying it is running.
   *
   * Folding is a separate decision, made once the turn's result is in (see `#foldChain`): a turn can
   * be over without its work being finished, and one that stopped on an approval is waiting.
   */
  #completeThinking(turn: TurnUi, failed = false, partial = false, summary?: string): void {
    if (turn.completed) return;
    turn.completed = true;
    this.#liveTurns.delete(turn);
    turn.activeReasoningId = "";
    turn.thought = "";
    const step = turn.activeStep ? this.#stepItem(turn, turn.activeStep) : undefined;
    turn.activeStep = "";
    if (turn.activeNarrationId) this.#endNarration(turn, turn.activeNarrationId, "discarded");
    this.#settleWork(turn, failed ? "failed" : partial ? "partial" : "completed");
    // A terminal plan may omit steps from older revisions, or its frame may never arrive.
    // Settle every active step owned by this turn; completed steps and tool results keep
    // their own recorded endings. Only the agent can mark a plan step successful.
    for (const item of turn.steps.values()) {
      if (item.element.dataset.state === "active") item.element.dataset.state = failed ? "error" : partial ? "partial" : "paused";
    }
    this.#settleLiveLine(turn, step);
    turn.callLine.dataset.state = "settled";
    // A turn that ran says how long it ran for, and nothing else.
    //
    // It used to announce that it was waiting for the user, which was wrong twice over: the
    // question is already in the chat directly underneath, so the line added nothing, and it
    // picked a form of address the product does not use. A summary is not a speaker and should
    // not be picking a form of address at all.
    //
    // Only an ending that went wrong still names itself, because there the outcome is the
    // information.
    const seconds = Math.max(1, Math.round((Date.now() - turn.startedAt) / 1_000));
    const settled = summary ?? (failed ? "Đã kết thúc xử lý"
      : partial ? "Đã dừng khi chưa hoàn tất"
      : `Đã xử lý trong ${seconds}s`);
    turn.ranSummary = failed || partial ? settled : `Đã xử lý trong ${seconds}s`;
    turn.thinking.dataset.failed = String(failed);
    turn.thinking.dataset.summary = settled;
    turn.summaryLabel.textContent = settled;
  }

  /**
   * Folds a turn whose work is really finished, together with every turn it resumed.
   *
   * A turn that stopped on an approval or a form has not finished, so it stays open above its card
   * until the decision is made and the turn it resumes ends — completed, cut short, failed or
   * stopped. Then both accounts fold at once; the answers, and the card with its decision, stay in
   * view. A card that expires, or that nobody acts on, leaves its turn open.
   */
  #foldChain(turn: TurnUi): void {
    for (const each of [...turn.resumes, turn]) {
      // A turn that paused said it was waiting; folded, it says how long it ran itself.
      if (each !== turn && each.ranSummary) {
        each.thinking.dataset.summary = each.ranSummary;
        each.summaryLabel.textContent = each.ranSummary;
      }
      each.thinking.dataset.complete = "true";
      each.thinking.dataset.empty = String(each.timeline.children.length === 0);
      this.#fold(each);
    }
  }

  /**
   * A decision resumes the turn that stopped for it, so the two fold together when the work is done.
   *
   * A decision that lets the work go on picks up the step the turn stopped in: the continuation's
   * line says that step from its first frame. It used to start from nothing — a new turn, no plan
   * yet — and read "Đang suy nghĩ" for however long the approved write took, which is exactly when
   * what is happening is best known. A refusal carries on nothing, so it starts from thinking.
   */
  #resume(turn: TurnUi, waitingOn: string, proceeds: boolean): void {
    const paused = this.#pausedTurns.get(waitingOn);
    if (!paused) return;
    this.#pausedTurns.delete(waitingOn);
    turn.resumes.push(...paused.resumes, paused);
    const stopped = [...paused.steps.values()].reverse().find((item) => item.element.dataset.state === "paused");
    if (!proceeds || !stopped) return;
    // The continuation owns an entry of the step from its first frame: its work is told here, not above the card.
    turn.activeStep = this.#ownStep(turn, stopped.id)?.id ?? stopped.id;
    this.#refreshLiveLine(turn);
  }

  /**
   * Folds everything above the answer under the one summary line, gradually where motion is welcome.
   *
   * Open while the work happens, one line once it is done — the shape every assistant the accountant
   * already uses has settled on. Snapped shut, the answer jumps up by the height of everything above
   * it in one frame; so the body's height runs down to nothing first, and only then is the element
   * closed and its checklist put in place of the live sentence and line. The summary says folded from
   * the first frame, and the words fade out well before the box closes, so nothing half-clipped lingers
   * under it. With reduced motion, or where nothing can animate, it closes at once.
   */
  #fold(turn: TurnUi): void {
    const { thinking } = turn;
    const summary = thinking.querySelector<HTMLElement>("summary");
    const body = thinking.querySelector<HTMLElement>(".acw-thinking-body");
    const height = thinking.open && body ? body.offsetHeight : 0;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    summary?.setAttribute("aria-expanded", "false");
    const release = this.#holdBottom();
    if (!body || height === 0 || still || typeof body.animate !== "function") {
      thinking.open = false;
      this.#reveal(turn);
      release();
      return;
    }
    thinking.dataset.folding = "true";
    const animation = body.animate(
      [{ height: `${height}px`, opacity: 1 }, { opacity: 0, offset: 0.35 }, { height: "0px", opacity: 0, paddingTop: "0px", paddingBottom: "0px" }],
      { duration: FOLD_DURATION_MS, easing: "cubic-bezier(.2, 0, 0, 1)", fill: "forwards" },
    );
    animation.addEventListener("finish", () => {
      thinking.open = false;
      this.#reveal(turn);
      delete thinking.dataset.folding;
      // The fill held the body at nothing. Closed, it has no height to hold, and a reopen must show
      // the whole account rather than an empty box.
      animation.cancel();
      release();
    }, { once: true });
    // An animation that never finishes — its turn removed with a new session — must not keep the hold.
    animation.addEventListener("cancel", release, { once: true });
  }

  /**
   * Folded, the account opens onto its checklist: the steps with their work, and the narration in order.
   * The plan sentence and the live line said what was happening while it happened; they are not repeated.
   */
  #reveal(turn: TurnUi): void {
    turn.revealed = true;
    // A step the turn never reached is part of the plan, not of what happened: it was on the
    // checklist while there was still a chance of reaching it, and listed under a finished turn
    // it reads as a process that stalled.
    for (const [id, item] of [...turn.steps]) {
      if (item.element.dataset.state !== "pending") continue;
      item.element.remove();
      turn.steps.delete(id);
    }
    // Unfolding must not bring back a draft the review sent back: it is never shown.
    for (const child of [...turn.timeline.children] as HTMLElement[]) child.hidden = child.dataset.kind === "draft";
    if (turn.planSentence) turn.planSentence.hidden = true;
    turn.liveLine.hidden = true;
    turn.callLine.hidden = true;
  }

  /**
   * Keeps a view that follows the bottom following it while the widget itself reshapes the conversation.
   *
   * A fold shrinks blocks above the answer for a few hundred milliseconds — two at once when a paused
   * turn folds with its continuation — often just as the answer below has grown. The browser keeps the
   * view steady by adjusting the scroll position, and the scroll events that raises read as far from
   * the bottom: the same reading as a user dragging the scrollbar up. So the view stopped following,
   * the jump button appeared, and the final answer ended out of view with nobody having scrolled.
   * While a fold runs only a gesture may take the view away from the bottom; once it is over, a view
   * that was following is put back at the end. The release is safe to call more than once.
   */
  #holdBottom(): () => void {
    const following = this.#stickToBottom;
    this.#reflowing += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // A frame later: the scroll events the last reflow raises are dispatched before frame callbacks.
      window.requestAnimationFrame(() => {
        this.#reflowing = Math.max(0, this.#reflowing - 1);
        if (following && this.#stickToBottom) this.#stickToBottomNow();
      });
    };
  }

  #trackThinkingToggle(thinking: HTMLDetailsElement): void {
    // The summary keeps its wording either way: open or folded it is the account of how the turn
    // went, and the chevron is what says which.
    thinking.addEventListener("toggle", () => {
      thinking.querySelector("summary")?.setAttribute("aria-expanded", String(thinking.open));
      this.#emit("thinking-toggle", { sessionId: this.#sessionId, open: thinking.open, complete: thinking.dataset.complete === "true" });
    });
  }

  /**
   * A past turn's account, rebuilt from its own history entry — the same checklist, tool marks and
   * narration a live turn ends up with (spec §3.7/§10.14). An awaiting turn is built OPEN, with a
   * settled live line on its in-progress step, and registered as paused so resolving its card folds
   * it exactly like a live one would. `continuesTurnId` merges into the earlier turn it resumes, so
   * a step already on screen there updates in place instead of listing again.
   */
  #appendAssistantMessage(message: AgentChatHistoryMessage & { readonly at: string }): void {
    const shell = this.#assistantShell(message.at);
    const safeApproval = harnessApprovalChallenge(message.approval, this.#sessionId);
    const visibleContent = safeApproval ? "" : message.content, stopped = historyTurnStopped(message);
    if (stopped) shell.bubble.replaceChildren(stoppedLine(visibleContent)); else shell.bubble.innerHTML = renderMarkdown(visibleContent);
    shell.bubble.hidden = !visibleContent;
    this.#renderRichUi(shell, message.ui, visibleContent);
    this.#renderApproval(shell, safeApproval);
    this.#renderHumanInteraction(shell, message.interaction);
    if (visibleContent && !stopped) this.#addMessageActions(shell, visibleContent, message.turnId);

    const narrations = (message.narrations ?? []).filter((narration) => narration?.audience === "user" &&
      typeof narration.content === "string" && narration.content.trim() && !this.#sameMessage(narration.content, visibleContent));
    const plan = message.work?.plan;
    const tools = message.work?.tools ?? [];
    const open = historyTurnOpen(message.status);
    if (narrations.length === 0 && !plan && tools.length === 0 && !open) { this.#scrollToLatest(); return; }

    const turn = this.#turnUi(shell, false);
    // `#turnUi(shell, false)` reveals the checklist immediately — right for a turn that is really
    // done. An awaiting one is not done: it stays exactly as live (checklist behind its chevron, one
    // settled line saying where it stopped) until it actually folds.
    turn.revealed = !open && !stopped;
    const continuesFrom = message.continuesTurnId ? this.#historyTurns.get(message.continuesTurnId) : undefined;
    if (continuesFrom) turn.resumes.push(...continuesFrom.resumes, continuesFrom);
    if (message.timeline?.length) {
      for (const item of message.timeline) {
        if (item.type === "plan-updated") this.#handlePlan(turn, item);
        else if (item.type === "tool-started") this.#handleToolStarted(turn, item.callId, item.label, item.workStepId);
        else if (item.type === "tool-completed") this.#handleToolCompleted(turn, item.callId, item.label, item.status ?? "outcome_unknown");
        else if (item.type === "narration" && !this.#sameMessage(item.content, visibleContent)) {
          const element = narrationBubble(item.content, undefined, item.draft === true);
          turn.timeline.append(element);
          turn.committedNarrations.push({ content: item.content.trim(), element });
        }
      }
    } else {
    if (plan) {
      for (const step of plan.steps) {
        const mark = planStepMark(step.status, plan.state, false);
        if (mark === undefined) continue;
        let item = this.#stepItem(turn, step.id);
        if (!item) {
          const earlier = this.#earlierStep(turn, step.id);
          // A step the paused turn holds is entered here only when this turn carried it on.
          if (earlier && step.status !== "in_progress" && earlier.item.element.dataset.state !== "paused" &&
            !tools.some((tool) => tool.workStepId === step.id)) continue;
          item = earlier ? this.#ownStep(turn, step.id) : this.#addStep(turn, step.id);
        }
        if (!item) continue;
        item.element.dataset.state = mark;
        item.label.textContent = step.description;
        item.title = step.description;
        if (step.outcome) this.#noteStep(turn, item, step.outcome);
      }
    }
    for (const tool of tools) {
      const row = this.#addToolRow(turn, tool.callId, tool.label ?? TOOL_TRACE_FALLBACK, tool.workStepId);
      row.element.dataset.state = toolStatusMark(tool.status);
    }
    for (const narration of narrations) {
      const element = narrationBubble(narration.content, undefined, narration.draft === true);
      turn.timeline.append(element);
      turn.committedNarrations.push({ content: narration.content.trim(), element });
    }

    }

    if (open) {
      const ran = typeof message.work?.durationMs === "number" ? Math.max(1, Math.round(message.work.durationMs / 1_000)) : undefined;
      if (ran !== undefined) turn.ranSummary = `Đã xử lý trong ${ran}s`;
      turn.thinking.open = true;
      if (message.status === "in_progress") {
        this.#setLiveLine(turn, "notice", this.#settings.labels.inProgress, "settled", "waiting");
        turn.liveLine.hidden = false;
      } else {
        const activeStepId = plan?.steps.find((step) => step.status === "in_progress")?.id;
        this.#settleLiveLine(turn, activeStepId ? this.#stepItem(turn, activeStepId) : undefined);
      }
      // A card the transport already reports settled (answered/declined/superseded/expired) needs
      // no resume — only a genuinely pending one is registered.
      const card = shell.rich.querySelector<HTMLElement>(".acw-approval");
      const waitingOn = card && card.dataset.resolved !== "true" ? card.dataset.interactionId : undefined;
      if (waitingOn) this.#pausedTurns.set(waitingOn, turn);
    } else if (stopped) { turn.thinking.open = true; this.#completeThinking(turn, false, true); }
    else {
      const seconds = typeof message.work?.durationMs === "number" ? Math.max(1, Math.round(message.work.durationMs / 1_000)) : undefined;
      this.#completeThinking(turn, message.status === "failed", message.status === "partial",
        message.status === "failed" || message.status === "partial" ? undefined : seconds !== undefined ? `Đã xử lý trong ${seconds}s` : "Quy trình xử lý");
      this.#foldChain(turn);
    }
    if (message.turnId) this.#historyTurns.set(message.turnId, turn);
    this.#scrollToLatest();
  }

  /**
   * What to show when the turn came back with no answer at all.
   *
   * `text(value, fallback)` returns the fallback only when the value is not a string, and an
   * empty string is a string — so the line written for exactly this case never ran. The bubble
   * was then hidden as empty, and a turn that produced nothing ended as a trace saying it had
   * finished with no message under it, which reads as the widget having lost the reply.
   *
   * It stays empty when something else is carrying the reply: an approval card, an interaction,
   * or a rich UI payload is the answer, and a sentence above it saying there was none is noise.
   * The runtime's question under a partial turn is not that answer: it asks only whether to go on.
   */
  #emptyAnswer(result: AgentChatTurnResult, hasApproval: boolean): string {
    if (hasApproval || (result.interaction !== undefined && result.outcome !== "partial") || result.ui !== undefined) return "";
    return this.#settings.labels.emptyAnswer;
  }

  #completeAssistantTurn(turn: TurnUi, result: AgentChatTurnResult): void {
    const safeApproval = harnessApprovalChallenge(result.approval, this.#sessionId);
    const unread = Array.isArray(result.unreadInterjections)
      ? result.unreadInterjections.filter((value): value is string => typeof value === "string" && value.trim() !== "") : [];
    this.#awaitingUser = safeApproval !== undefined || result.outcome === "awaiting_approval" || result.outcome === "awaiting_interaction";
    if (unread.length > 0) this.#unread = { sentences: unread, paused: this.#awaitingUser };
    const answer = text(result.content);
    const contentValue = safeApproval ? "" : answer.trim() ? answer : this.#emptyAnswer(result, safeApproval !== undefined);
    this.#resetOutputDraft(turn, false);
    this.#removeDuplicateNarrations(turn, contentValue);
    // Whatever answer the turn settled on — accepted from its output, or returned only with the result — takes the note's place.
    this.#removeDraftNote(turn);
    turn.bubble.innerHTML = renderMarkdown(contentValue);
    turn.bubble.dataset.messageKind = "final";
    turn.bubble.hidden = !contentValue;
    const turnId = text(result.turnId) || undefined;
    // A turn waiting on a decision has not finished: its account stays open above the card, and folds
    // together with the turn the decision resumes, once that one really ends. The header says so
    // too — never the completion summary — whether or not the `activity{completed}` progress
    // frame already said as much (it usually has by now, but a caller must not depend on that).
    const waitingOn = safeApproval?.approvalId ?? harnessHumanInteractionChallenge(result.interaction, this.#sessionId)?.interactionId;
    this.#completeThinking(turn, false, result.outcome === "partial", waitingOn ? this.#settings.labels.awaitingUser : undefined);
    this.#renderRichUi(turn, result.ui, contentValue);
    this.#renderApproval(turn, safeApproval);
    this.#renderHumanInteraction(turn, result.interaction);
    if (waitingOn) this.#pausedTurns.set(waitingOn, turn);
    else this.#foldChain(turn);
    if (contentValue) this.#addMessageActions(turn, contentValue, turnId);
    this.#message({
      role: "assistant", kind: "final", content: contentValue, at: new Date().toISOString(),
      ...(turnId ? { turnId } : {}), ...(result.ui !== undefined ? { ui: result.ui } : {}),
    });
  }

  /** Disables every control on a card — buttons, tabs, choices, free-text fields — so nothing on it can be acted on; `false` reopens it. */
  #lockCard(card: HTMLElement, locked = true): void {
    for (const control of card.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>("button, input, textarea")) control.disabled = locked;
  }

  /**
   * Puts an approval or interaction card in its final, permanently locked state.
   *
   * Used both for a card the widget itself just resolved and for one loaded from history already
   * settled: either way the sentence is final and nothing on the card is clickable again.
   */
  #settleCard(card: HTMLElement, status: HTMLElement, sentence: string, echo?: readonly AgentChatInteractionEcho[]): void {
    status.textContent = sentence;
    if (echo && echo.length > 0) {
      // The receipt takes the form's place, live and on reload alike: the locked tabs above it said the same twice.
      const form = card.querySelector<HTMLElement>(".acw-interaction-form");
      if (form) form.hidden = true;
      const list = document.createElement("dl");
      list.className = "acw-interaction-summary";
      for (const item of echo) {
        const term = document.createElement("dt");
        term.textContent = item.label;
        const value = document.createElement("dd");
        value.textContent = item.value;
        list.append(term, value);
      }
      card.append(list);
    }
    card.dataset.resolved = "true";
    this.#lockCard(card);
    this.#pendingInteractions.release(card);
  }

  /** Retires a confirmation the conversation has moved past, without resolving it server-side. */
  #withdrawApproval(card: HTMLElement, status: HTMLElement): void {
    card.dataset.superseded = "true";
    status.textContent = "Yêu cầu này không còn khớp với nội dung trao đổi mới nhất. Hãy yêu cầu lại nếu vẫn cần.";
    this.#lockCard(card);
    this.#pendingInteractions.release(card);
  }

  /**
   * Any confirmation still pending from an earlier turn no longer describes what was asked, and
   * the turn it belongs to has nothing left to wait for: it releases and folds along with it,
   * exactly as it would once the server's own pause-closure resolved the card (spec §3.2/§10.6).
   */
  #withdrawPendingApprovals(): void {
    for (const card of this.#conversation.querySelectorAll<HTMLElement>(".acw-approval:not([data-superseded])")) {
      if (card.dataset.resolved === "true") continue;
      const status = card.querySelector<HTMLElement>(".acw-approval-status");
      if (!status) continue;
      this.#withdrawApproval(card, status);
      const waitingOn = card.dataset.interactionId;
      const paused = waitingOn ? this.#pausedTurns.get(waitingOn) : undefined;
      if (paused && waitingOn) {
        this.#pausedTurns.delete(waitingOn);
        this.#foldChain(paused);
      }
    }
  }

  #renderApproval(shell: AssistantShell, value: unknown): void {
    const approval = harnessApprovalChallenge(value, this.#sessionId);
    if (!approval || shell.rich.querySelector(`[data-interaction-id="${approval.approvalId}"]`)) return;
    const card = document.createElement("section");
    card.className = "acw-approval";
    card.dataset.interactionId = approval.approvalId;
    card.setAttribute("aria-label", "Yêu cầu xác nhận thao tác");

    const title = document.createElement("strong");
    title.className = "acw-approval-title";
    // The presentation names the operation and its scope, and both are bound into the digest
    // the approval signs. Falling back to one constant title made every payroll card look
    // identical and dropped the only line saying who and which period is affected.
    title.textContent = approval.presentation?.action ?? "Cần xác nhận thao tác";
    const scope = document.createElement("p");
    scope.className = "acw-approval-target";
    scope.textContent = approval.presentation?.target ?? "";
    scope.hidden = !approval.presentation?.target;
    const description = document.createElement("p");
    description.className = "acw-approval-description";
    description.textContent = approval.presentation?.summary ?? "Vui lòng kiểm tra và xác nhận thao tác này.";
    const presentationNodes: HTMLElement[] = [];
    if (approval.presentation) {
      if (approval.presentation.fields?.length) {
        const fields = document.createElement("dl");
        fields.className = "acw-approval-fields";
        for (const field of approval.presentation.fields) {
          const label = document.createElement("dt");
          label.textContent = field.label;
          const value = document.createElement("dd");
          value.textContent = String(field.value);
          fields.append(label, value);
        }
        presentationNodes.push(fields);
      }
    }
    const risk = document.createElement("p");
    risk.className = "acw-approval-risk";
    risk.textContent = approval.presentation?.impact ?? (approval.sideEffect === "nonIdempotent"
      ? "Thao tác này có thể thay đổi dữ liệu và không được tự động thực hiện lại."
      : approval.sideEffect === "idempotent"
        ? "Thao tác này có thể thay đổi dữ liệu."
        : "Thao tác này cần xác nhận theo chính sách truy cập.");
    const status = document.createElement("span");
    status.className = "acw-approval-status";
    status.setAttribute("aria-live", "polite");
    const actions = document.createElement("div");
    actions.className = "acw-approval-actions";
    // A permission is asked, not a question: what it would do is on the card already (title, scope, the fields
    // it changes), and the answer is one press — "Cho phép" or "Từ chối". The form with a review tab is for
    // the agent's questions; dressed as one, a permission reads as something to fill in.
    // data-choice stays on each button, so a script that picks the choice and then presses send still works.
    const button = (decision: AgentChatApprovalDecision, label: string): HTMLButtonElement => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = decision === "approve" ? "acw-approval-approve" : "acw-approval-deny";
      element.dataset.choice = decision;
      element.textContent = label;
      element.addEventListener("click", () => void this.#resolveApproval(approval, decision, card, status));
      return element;
    };
    actions.append(button("deny", "Từ chối"), button("approve", "Cho phép"));
    const footer = document.createElement("div");
    footer.className = "acw-interaction-footer";
    footer.append(status, actions);
    card.append(title, scope, description, ...presentationNodes, risk, footer);
    shell.rich.append(card);

    card.dataset.approvalTurnId = approval.turnId;
    if (approval.state && approval.state !== "pending" && approval.state !== "expired") {
      // Loaded from history already settled: the card renders exactly the final state the
      // server recorded, never a fresh, clickable one.
      this.#settleCard(card, status, SETTLED_APPROVAL_SENTENCE[approval.state] ?? "");
    } else if (approval.superseded === true) {
      // Still inside its window and still valid to the server, but the accountant has since
      // asked for something else. Leaving it clickable invites confirming the old request.
      this.#withdrawApproval(card, status);
    } else if (cardLate(approval)) {
      status.textContent = LATE_CARD_SENTENCE;
    } else {
      const expiresAt = new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" }).format(new Date(approval.expiresAt));
      status.textContent = `Có hiệu lực đến ${expiresAt}.`;
    }
  }

  async #resolveApproval(
    approval: AgentChatApprovalChallenge,
    decision: AgentChatApprovalDecision,
    card: HTMLElement,
    status: HTMLElement,
  ): Promise<void> {
    if (this.#pending || card.dataset.resolved === "true") return;
    if (approval.sessionId !== this.#sessionId) { this.#settleCard(card, status, "Yêu cầu này không thuộc cuộc trò chuyện hiện tại."); return; }
    const late = (): string => lateAnswerText("approval", decision === "approve", approval.presentation?.summary ?? "");
    if (cardLate(approval)) { this.#answerLate(card, status, late()); return; }
    if (!this.#settings.transport.resolveInteraction) {
      const error = new Error(this.#settings.labels.transportError);
      status.textContent = error.message;
      this.#error(error);
      return;
    }
    const action = this.#actionDetail("interaction", { kind: approval.kind, interactionId: approval.approvalId, decision });
    if (!this.#beforeAction(action)) return;

    const turn = this.#createLiveAssistantTurn();
    this.#resume(turn, approval.approvalId, decision === "approve");
    this.#setPending(true);
    this.#lockCard(card);
    status.textContent = decision === "approve" ? "Đang cho phép và tiếp tục…" : "Đang từ chối và tiếp tục…";
    try {
      const result = await this.#streamInteraction(approval, decision, turn);
      this.#completeAssistantTurn(turn, result);
      this.#settleCard(card, status, decision === "approve" ? "Đã cho phép thao tác này." : "Đã từ chối thao tác này.");
      this.#commitAction(action);
    } catch (cause) {
      this.#failResume(turn, cause, card, status, late, cardLate(approval), decision === "approve" ? "Đã cho phép thao tác này." : undefined);
    } finally { this.#setPending(false); this.#input.focus(); this.#scrollToLatest(); }
  }

  /** A resume that ended without its result; `proceeded` is the card's sentence once the server acted on it (turn-stop.ts). */
  #failResume(turn: TurnUi, cause: unknown, card: HTMLElement, status: HTMLElement, late: () => string, isLate: boolean,
    proceeded?: string, echo?: readonly AgentChatInteractionEcho[]): void {
    const error = cause instanceof Error ? cause : new Error(this.#settings.labels.transportError);
    // The server already holds this card's answer: the row made for the resume goes, and the turns it took over fold.
    if (resumeAlreadyResolved(error)) {
      this.#completeThinking(turn);
      if (turn.resumes.length > 0) this.#foldChain(turn.resumes.at(-1)!);
      turn.row.remove();
      this.#settleCard(card, status, error.message);
      return;
    }
    const stopped = userStopped(error), gone = resumeGone(error);
    const sentence = gone ? LATE_SENT_SENTENCE
      : error instanceof AgentChatTransportError && error.transportFailure ? this.#settings.labels.transportError : error.message;
    if (stopped) this.#stopTurn(turn); else this.#showFailure(turn, sentence);
    // Sent once this resume's `finally` has cleared pending: sent at once, `#dispatch` refused it as a second turn and it was lost.
    if (gone) void Promise.resolve().then(() => this.send(late()));
    // A reasoned conflict is the server's own final word on this exact card — it stays locked,
    // unlike a transient failure the accountant might still retry (spec §3.2/§10.6, A1/A2).
    if (proceeded && turn.acted) this.#settleCard(card, status, proceeded, echo);
    else if ((error instanceof AgentChatTransportError && typeof error.reason === "string") || (isLate && !stopped)) {
      status.textContent = sentence;
      this.#pendingInteractions.release(card);
    } else {
      status.textContent = stopped ? STOPPED_CARD_SENTENCE : sentence;
      card.dataset.resolved = "";
      this.#lockCard(card, false);
    }
    if (!stopped && !gone) this.#error(error);
  }

  /** A turn that went wrong: one sentence on its row, and its account folds. */
  #showFailure(turn: TurnUi, sentence: string): void {
    this.#resetOutputDraft(turn, true);
    turn.row.classList.add("acw-error");
    turn.bubble.textContent = sentence;
    turn.bubble.hidden = false;
    this.#completeThinking(turn, true);
    this.#foldChain(turn);
  }

  /** The person's own stop (turn-stop.ts): what was shown stays, open, under one neutral line; an answer still gathered was never shown. */
  #stopTurn(turn: TurnUi): void {
    this.#resetOutputDraft(turn, false);
    this.#removeDraftNote(turn);
    turn.bubble.append(stoppedLine(STOPPED_TURN_SENTENCE));
    turn.bubble.hidden = false;
    this.#completeThinking(turn, false, true);
  }

  /** A card the server can no longer resume: its answer goes as the person's next message (late-answer.ts). */
  #answerLate(card: HTMLElement, status: HTMLElement, text: string, echo?: readonly AgentChatInteractionEcho[]): void { this.#settleCard(card, status, LATE_SENT_SENTENCE, echo); void this.send(text); }

  #renderHumanInteraction(shell: AssistantShell, value: unknown): void {
    const interaction = harnessHumanInteractionChallenge(value, this.#sessionId);
    if (!interaction || shell.rich.querySelector(`[data-interaction-id="${interaction.interactionId}"]`)) return;
    const { card, status, decline } = buildHumanInteractionCard(interaction,
      (content, echo) => void this.#resolveHumanInteraction(interaction, "accept", content, card, status, echo));
    shell.rich.append(card);
    if (interaction.state && interaction.state !== "pending" && interaction.state !== "expired") {
      this.#settleCard(card, status, SETTLED_INTERACTION_SENTENCE[interaction.state] ?? "", interaction.echo);
    } else if (cardLate(interaction)) {
      status.textContent = LATE_CARD_SENTENCE;
    } else {
      this.#pendingInteractions.track(interaction, card, status);
    }
    decline.addEventListener("click", () => void this.#resolveHumanInteraction(interaction, "decline", undefined, card, status));
  }

  async answerInteraction(interactionId: string, content: Readonly<Record<string, unknown>>): Promise<boolean> {
    const entry = this.#pendingInteractions.find(interactionId);
    if (this.#destroyed || this.#pending || !entry || !isRecord(content) || Date.parse(entry.interaction.expiresAt) <= Date.now()) return false;
    void this.#resolveHumanInteraction(entry.interaction, "accept", content, entry.card, entry.status, interactionAnswerEcho(entry.interaction.requestedSchema, content));
    return true;
  }

  async #resolveHumanInteraction(
    interaction: AgentChatHumanInteractionChallenge,
    actionValue: AgentChatInteractionAction,
    content: unknown,
    card: HTMLElement,
    status: HTMLElement,
    echo?: readonly AgentChatInteractionEcho[],
  ): Promise<void> {
    if (this.#pending || card.dataset.resolved === "true") return;
    if (interaction.sessionId !== this.#sessionId) { this.#settleCard(card, status, "Yêu cầu không còn hợp lệ cho cuộc trò chuyện này."); return; }
    const late = (): string => lateAnswerText("interaction", actionValue === "accept", interaction.title ?? interaction.message, echo);
    if (cardLate(interaction)) { this.#answerLate(card, status, late(), echo); return; }
    if (!this.#settings.transport.resolveInteraction) { status.textContent = this.#settings.labels.transportError; return; }
    const action = this.#actionDetail("interaction", { kind: interaction.kind, interactionId: interaction.interactionId, action: actionValue });
    if (!this.#beforeAction(action)) return;
    const turn = this.#createLiveAssistantTurn();
    this.#resume(turn, interaction.interactionId, actionValue === "accept");
    this.#setPending(true);
    this.#lockCard(card);
    status.textContent = "Đang tiếp tục…";
    try {
      const result = await this.#streamHumanInteraction(interaction, actionValue, content, turn);
      this.#completeAssistantTurn(turn, result);
      // With the answers read back as history shows them from the server's echo, so live and reload look alike.
      this.#settleCard(card, status, actionValue === "accept" ? "Thông tin đã được tiếp nhận." : "Đã bỏ qua yêu cầu.", actionValue === "accept" ? echo : undefined);
      this.#commitAction(action);
    } catch (cause) {
      this.#failResume(turn, cause, card, status, late, cardLate(interaction), actionValue === "accept" ? "Thông tin đã được tiếp nhận." : undefined, echo);
    } finally { this.#setPending(false); this.#input.focus(); this.#scrollToLatest(); }
  }

  #renderRichUi(shell: AssistantShell, ui: unknown, message: string): void {
    const blocks = Array.isArray(ui) ? ui : isRecord(ui) && Array.isArray(ui.blocks) ? ui.blocks : ui === undefined || ui === null ? [] : [ui];
    blocks.slice(0, 20).forEach((block, index) => {
      let custom: HTMLElement | null = null;
      try { custom = this.#options.renderUiBlock?.(block, { index, message, sessionId: this.#sessionId }) ?? null; }
      catch { /* A custom block failure falls back to the standard renderer. */ }
      if (custom) { shell.rich.append(custom); return; }
      if (!isRecord(block) || typeof block.type !== "string") return;
      if (block.type === "actions") {
        const actions = this.#renderUiActions(block.actions, message, text(block.id) || undefined);
        if (actions) shell.rich.append(actions);
      } else if (block.type === "task-card") {
        const card = this.#renderTaskCard(block, message);
        if (card) shell.rich.append(card);
      } else if (block.type === "details") {
        const details = this.#renderDetailsBlock(block);
        if (details) shell.rich.append(details);
      } else if (block.type === "markdown" && typeof block.content === "string") {
        const markdown = document.createElement("div");
        markdown.className = "acw-ui-markdown acw-markdown";
        markdown.innerHTML = renderMarkdown(block.content);
        shell.rich.append(markdown);
      }
    });
  }

  #renderUiActions(value: unknown, message: string, blockId?: string): HTMLElement | null {
    if (!Array.isArray(value)) return null;
    const container = document.createElement("div");
    container.className = "acw-ui-actions";
    for (const candidate of value.slice(0, 8)) {
      const action = this.#uiAction(candidate);
      if (action) container.append(this.#uiButton(action, message, blockId));
    }
    return container.childElementCount > 0 ? container : null;
  }

  #renderTaskCard(block: UnknownRecord, message: string): HTMLElement | null {
    if (typeof block.title !== "string" || !block.title.trim()) return null;
    const blockId = text(block.id) || undefined;
    const card = document.createElement("section");
    card.className = "acw-task-card";
    if (blockId) card.dataset.blockId = blockId;
    const header = document.createElement("div");
    header.className = "acw-card-header";
    const icon = document.createElement("span");
    icon.className = "acw-card-icon";
    icon.textContent = text(block.icon, "✓").slice(0, 2);
    const title = document.createElement("span");
    title.className = "acw-card-title";
    title.textContent = block.title;
    const count = document.createElement("span");
    count.className = "acw-card-count";
    const steps = Array.isArray(block.steps) ? block.steps.slice(0, 20) : [];
    const progress = isRecord(block.progress) ? block.progress : {};
    const total = typeof progress.total === "number" && progress.total > 0 ? Math.round(progress.total) : steps.length;
    const derivedCurrent = steps.filter((step) => isRecord(step) && step.status === "completed").length;
    const current = typeof progress.current === "number" ? Math.max(0, Math.min(total, Math.round(progress.current))) : derivedCurrent;
    if (total > 0) count.textContent = `${current}/${total}`;
    header.append(icon, title, count);
    card.append(header);
    if (total > 0) {
      const track = document.createElement("div");
      track.className = "acw-card-progress";
      const fill = document.createElement("span");
      fill.style.width = `${Math.round((current / total) * 100)}%`;
      track.append(fill);
      card.append(track);
    }
    if (steps.length > 0) {
      const list = document.createElement("ol");
      list.className = "acw-step-list";
      for (const step of steps) {
        const rendered = this.#renderTaskStep(step, 0, blockId);
        if (rendered) list.append(rendered);
      }
      card.append(list);
    }
    const actions = this.#renderUiActions(block.actions, message, blockId);
    if (actions) { actions.classList.add("acw-card-actions"); card.append(actions); }
    return card;
  }

  #renderTaskStep(value: unknown, depth: number, blockId?: string): HTMLLIElement | null {
    if (!isRecord(value) || typeof value.label !== "string" || !value.label.trim() || depth > 2) return null;
    const stepLabel = value.label;
    const stepId = typeof value.id === "string" && value.id ? value.id : undefined;
    const item = document.createElement("li");
    item.className = "acw-step";
    const status = value.status === "active" || value.status === "completed" || value.status === "failed" ? value.status : "pending";
    item.dataset.status = status;
    const row = document.createElement("div");
    row.className = "acw-step-row";
    const dot = document.createElement("span");
    dot.className = "acw-step-dot";
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "acw-step-label";
    label.textContent = stepLabel;
    row.append(dot, label);
    item.append(row);
    const childValues = Array.isArray(value.children) ? value.children.slice(0, 12) : [];
    const children = document.createElement("ol");
    children.className = "acw-step-children";
    for (const child of childValues) {
      const rendered = this.#renderTaskStep(child, depth + 1, blockId);
      if (rendered) children.append(rendered);
    }
    const hasChildren = children.childElementCount > 0;
    const href = this.#safeUrl(value.href);
    if (href) item.dataset.link = "true";
    if (hasChildren) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "acw-step-toggle";
      const expanded = value.expanded !== false;
      const updateToggle = (open: boolean): void => {
        children.hidden = !open;
        item.dataset.expanded = String(open);
        toggle.setAttribute("aria-expanded", String(open));
        toggle.setAttribute("aria-label", `${open ? "Thu gọn" : "Mở rộng"} ${stepLabel}`);
        toggle.title = open ? "Thu gọn" : "Mở rộng";
      };
      updateToggle(expanded);
      toggle.append(this.#chevronIcon());
      toggle.addEventListener("click", () => {
        const open = toggle.getAttribute("aria-expanded") !== "true";
        updateToggle(open);
        const event: AgentChatUiStepToggleEvent = {
          ...(blockId ? { blockId } : {}),
          ...(stepId ? { stepId } : {}),
          label: stepLabel,
          open,
          sessionId: this.#sessionId,
        };
        try { this.#options.onUiStepToggle?.(event); } catch { /* Consumer callbacks cannot break the widget. */ }
        this.#emit("ui-step-toggle", event);
      });
      row.append(toggle);
    } else if (href) {
      const link = document.createElement("a");
      link.className = "acw-step-link";
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", `Mở ${stepLabel}`);
      link.title = `Mở ${stepLabel}`;
      link.append(this.#externalLinkIcon());
      row.append(link);
    } else {
      const trailing = document.createElement("span");
      trailing.className = "acw-step-trailing";
      row.append(trailing);
    }
    if (hasChildren) item.append(children);
    return item;
  }

  #renderDetailsBlock(block: UnknownRecord): HTMLDetailsElement | null {
    if (typeof block.title !== "string" || typeof block.content !== "string") return null;
    const details = document.createElement("details");
    details.className = "acw-info-card";
    details.open = block.open === true;
    const summary = document.createElement("summary");
    const title = document.createElement("span");
    title.textContent = block.title;
    summary.append(title, this.#chevronIcon());
    const body = document.createElement("div");
    body.className = "acw-info-body acw-markdown";
    body.innerHTML = renderMarkdown(block.content);
    details.append(summary, body);
    details.addEventListener("toggle", () => this.#emit("ui-details-toggle", {
      sessionId: this.#sessionId, blockId: text(block.id) || undefined, open: details.open,
    }));
    return details;
  }

  #uiAction(value: unknown): AgentChatUiButton | null {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string" || !value.id.trim() || !value.label.trim()) return null;
    const behavior = value.behavior === "submit" || value.behavior === "link" ? value.behavior : "event";
    const variant = value.variant === "primary" || value.variant === "ghost" ? value.variant : "secondary";
    return {
      id: value.id, label: value.label, behavior, variant, disabled: value.disabled === true,
      ...(typeof value.value === "string" ? { value: value.value } : {}),
      ...(typeof value.href === "string" ? { href: value.href } : {}),
    };
  }

  #uiButton(action: AgentChatUiButton, message: string, blockId?: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "acw-ui-button";
    button.textContent = action.label;
    button.dataset.variant = action.variant ?? "secondary";
    button.dataset.behavior = action.behavior ?? "event";
    if (action.disabled) { button.disabled = true; button.dataset.permanentlyDisabled = "true"; }
    button.addEventListener("click", () => this.#handleUiAction(action, message, blockId));
    return button;
  }

  #handleUiAction(uiAction: AgentChatUiButton, message: string, blockId?: string): void {
    const event: AgentChatUiActionEvent = { action: uiAction, message, sessionId: this.#sessionId, ...(blockId ? { blockId } : {}) };
    const data = { uiActionId: uiAction.id, label: uiAction.label, behavior: uiAction.behavior ?? "event", ...(uiAction.value ? { value: uiAction.value } : {}), ...(blockId ? { blockId } : {}) };
    const action = this.#actionDetail("ui-action", data);
    if (!this.#beforeAction(action)) return;
    try { if (this.#options.onUiAction?.(event) === false) return; } catch { /* Consumer callbacks cannot break the widget. */ }
    this.#commitAction(action);
    if (uiAction.behavior === "submit") void this.send(uiAction.value?.trim() || uiAction.label);
    if (uiAction.behavior === "link" && uiAction.href) this.#openLink(uiAction.href, uiAction.label);
  }

  #safeUrl(value: unknown): string | null {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, document.baseURI);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch { return null; }
  }

  #openLink(value: string, label: string, nativeEvent?: MouseEvent): void {
    const href = this.#safeUrl(value);
    if (!href) { nativeEvent?.preventDefault(); return; }
    const link: AgentChatLinkEvent = { href, label, sessionId: this.#sessionId };
    const action = this.#actionDetail("link", { href, label });
    if (!this.#beforeAction(action)) { nativeEvent?.preventDefault(); return; }
    try {
      if (this.#options.onLinkClick?.(link) === false) { nativeEvent?.preventDefault(); return; }
    } catch { /* Consumer callbacks cannot break the widget. */ }
    this.#commitAction(action);
    if (!nativeEvent) followLink(href);
  }

  #addMessageActions(shell: AssistantShell, content: string, turnId?: string): void {
    if (shell.actions.childElementCount > 0) return;
    const message: AgentChatMessage = { role: "assistant", content, at: new Date().toISOString(), ...(turnId ? { turnId } : {}) };
    const quote = this.#actionButton("M9.102 7.814c.158 2.648-1.776 6.38-6.115 8.186L2 14.354A8.34 8.34 0 0 0 5.828 9.94c-2.566-.2-3.315-1.725-3.315-2.969 0-1.686 1.342-3.01 2.999-2.97 1.578-.04 3.393 1.124 3.59 3.813m8.889 0c.158 2.648-1.775 6.38-6.115 8.186l-.987-1.646a8.33 8.33 0 0 0 3.827-4.414c-2.565-.2-3.314-1.725-3.314-2.969 0-1.686 1.342-3.01 2.999-2.97 1.578-.04 3.393 1.124 3.59 3.813", "Trích dẫn câu trả lời");
    quote.addEventListener("click", () => {
      const action = this.#actionDetail("quote", { operation: "reply", content, ...(turnId ? { turnId } : {}) });
      if (!this.#beforeAction(action)) return;
      this.#setReply({ author: this.#settings.agentName, content, ...(turnId ? { turnId } : {}) });
      this.#input.focus();
      try { this.#options.onQuote?.(message); } catch { /* Consumer callbacks cannot break the widget. */ }
      this.#commitAction(action);
    });
    const copyPath = "M13.333 6.667V5a1.667 1.667 0 0 0-1.666-1.667H5A1.667 1.667 0 0 0 3.333 5v6.667A1.667 1.667 0 0 0 5 13.333h1.667m0-5a1.667 1.667 0 0 1 1.666-1.666H15a1.667 1.667 0 0 1 1.667 1.666V15A1.667 1.667 0 0 1 15 16.667H8.333A1.667 1.667 0 0 1 6.667 15z";
    const copy = this.#actionButton(copyPath, "Sao chép câu trả lời");
    copy.addEventListener("click", async () => {
      const action = this.#actionDetail("copy", { content, ...(turnId ? { turnId } : {}) });
      if (!this.#beforeAction(action)) return;
      this.#commitAction(action);
      const token = randomId();
      copy.dataset.copyToken = token;
      copy.dataset.copyState = "copying";
      copy.dataset.copyLabel = "Đang sao chép…";
      const success = await writeClipboardText(content);
      if (copy.dataset.copyToken !== token) return;
      copy.dataset.copyState = success ? "success" : "failed";
      copy.dataset.copyLabel = success ? "Đã sao chép" : "Không thể sao chép";
      copy.dataset.selected = String(success);
      copy.title = success ? "Đã sao chép" : "Không thể sao chép";
      copy.setAttribute("aria-label", copy.title);
      const path = copy.querySelector("path");
      if (path) path.setAttribute("d", success ? "m4.167 10 3.333 3.333L15.833 5" : "M5 5l10 10M15 5 5 15");
      this.#emit("copy-result", { success, content, sessionId: this.#sessionId, ...(turnId ? { turnId } : {}) });
      window.setTimeout(() => {
        if (copy.dataset.copyToken !== token) return;
        delete copy.dataset.copyToken;
        delete copy.dataset.copyState;
        delete copy.dataset.copyLabel;
        copy.dataset.selected = "false";
        copy.title = "Sao chép câu trả lời";
        copy.setAttribute("aria-label", copy.title);
        if (path) path.setAttribute("d", copyPath);
      }, 1600);
    });
    const up = this.#actionButton("M5.833 9.167v6.666a.833.833 0 0 1-.833.834H3.333a.833.833 0 0 1-.833-.834V10a.833.833 0 0 1 .833-.833zm0 0a3.333 3.333 0 0 0 3.334-3.334V5A1.667 1.667 0 1 1 12.5 5v4.167H15a1.667 1.667 0 0 1 1.667 1.666L15.833 15c-.12.511-.347.95-.648 1.25-.3.301-.658.447-1.018.417H8.333a2.5 2.5 0 0 1-2.5-2.5", "Câu trả lời hữu ích");
    const down = this.#actionButton("M5.833 10.833V4.167A.833.833 0 0 0 5 3.333H3.333a.833.833 0 0 0-.833.834V10a.833.833 0 0 0 .833.833zm0 0a3.333 3.333 0 0 1 3.334 3.334V15a1.666 1.666 0 1 0 3.333 0v-4.167H15a1.666 1.666 0 0 0 1.667-1.666L15.833 5c-.12-.511-.347-.95-.648-1.25-.3-.301-.658-.447-1.018-.417H8.333a2.5 2.5 0 0 0-2.5 2.5", "Câu trả lời chưa tốt");
    up.addEventListener("click", () => this.#feedback("up", content, turnId, up, down));
    down.addEventListener("click", () => this.#feedback("down", content, turnId, down, up));
    shell.actions.append(quote, copy, up, down);
  }

  #actionButton(pathData: string, title: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "acw-action";
    button.title = title;
    button.setAttribute("aria-label", title);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-width", "1.5");
    svg.append(path);
    button.append(svg);
    return button;
  }

  #chevronIcon(): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("acw-chevron");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m5 7.5 5 5 5-5");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-width", "1.5");
    svg.append(path);
    return svg;
  }

  #externalLinkIcon(): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M11.667 3.333h5v5m0-5-7.5 7.5m5.833.834V15a1.667 1.667 0 0 1-1.667 1.667H5A1.667 1.667 0 0 1 3.333 15V6.667A1.667 1.667 0 0 1 5 5h3.333");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-width", "1.5");
    svg.append(path);
    return svg;
  }

  #feedback(value: "up" | "down", content: string, turnId: string | undefined, selected: HTMLElement, other: HTMLElement): void {
    const feedback: AgentChatFeedback = { value, content, ...(turnId ? { turnId } : {}) };
    const action = this.#actionDetail("feedback", { value, content, ...(turnId ? { turnId } : {}) });
    if (!this.#beforeAction(action)) return;
    selected.dataset.selected = selected.dataset.selected === "true" ? "false" : "true";
    other.dataset.selected = "false";
    try { this.#options.onFeedback?.(feedback); } catch { /* Consumer callbacks cannot break the widget. */ }
    this.#commitAction(action);
  }

  #beginResize(event: PointerEvent): void {
    if (!this.#settings.resizable || event.button !== 0 || window.innerWidth <= 520) return;
    event.preventDefault();
    this.#resizePointerId = event.pointerId;
    this.#resizeStartX = event.clientX;
    this.#resizeStartWidth = this.#panel.getBoundingClientRect().width - (this.#root.dataset.dock === "push" ? this.#settings.dockedEdgeInset : 0);
    this.#panel.dataset.resizing = "true";
    try { this.#resizeHandle.setPointerCapture(event.pointerId); } catch { /* Pointer capture is an enhancement. */ }
  }

  #moveResize(event: PointerEvent): void {
    if (this.#resizePointerId !== event.pointerId) return;
    const movement = this.#settings.position === "right" ? this.#resizeStartX - event.clientX : event.clientX - this.#resizeStartX;
    this.#setWidth(this.#resizeStartWidth + movement);
  }

  #endResize(event: PointerEvent): void {
    if (this.#resizePointerId !== event.pointerId) return;
    try { this.#resizeHandle.releasePointerCapture(event.pointerId); } catch { /* The pointer may already be released. */ }
    this.#resizePointerId = null;
    delete this.#panel.dataset.resizing;
    this.#commitResize(this.#resizeStartWidth);
  }

  #cancelResize(): void {
    if (this.#resizePointerId === null) return;
    this.#resizePointerId = null;
    delete this.#panel.dataset.resizing;
    this.#setWidth(this.#resizeStartWidth);
  }

  #resizeWithKeyboard(event: KeyboardEvent): void {
    if (!this.#settings.resizable || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    const previousWidth = this.#width;
    const outward = this.#settings.position === "right" ? event.key === "ArrowLeft" : event.key === "ArrowRight";
    this.#setWidth(this.#width + (outward ? 1 : -1) * (event.shiftKey ? 32 : 16));
    this.#commitResize(previousWidth);
  }

  #setWidth(value: number): void {
    // Docked beside the page, the page keeps the width it still works at (dockedPageMinWidth, never under 320px).
    const reserved = this.#pushesPage() ? Math.max(320, this.#settings.dockedPageMinWidth) + this.#settings.dockedEdgeInset : 24;
    const viewportLimit = Math.max(this.#settings.minWidth, window.innerWidth - reserved);
    const maximum = Math.min(this.#settings.maxWidth, viewportLimit);
    this.#width = Math.round(Math.min(maximum, Math.max(this.#settings.minWidth, value)));
    this.#panel.style.width = `${this.#width}px`;
    this.#resizeHandle.setAttribute("aria-valuemin", String(this.#settings.minWidth));
    this.#resizeHandle.setAttribute("aria-valuemax", String(maximum));
    this.#resizeHandle.setAttribute("aria-valuenow", String(this.#width));
    this.#syncDock();
  }

  /**
   * Whether the open panel stands beside the page, which then gives up its width (ui/dock-layout.ts):
   * only while the window holds the page at its working width next to the panel at its narrowest.
   */
  #pushesPage(): boolean {
    const room = window.innerWidth - this.#settings.minWidth - this.#settings.dockedEdgeInset;
    return this.#mode === "docked" && this.#settings.dockLayout === "push" && window.innerWidth > 520 && room >= this.#settings.dockedPageMinWidth;
  }

  #syncDock(): void {
    const pushing = !this.#destroyed && this.#opened && !this.#compact && this.#pushesPage();
    if (pushing) this.#root.dataset.dock = "push"; else delete this.#root.dataset.dock;
    // "Lies over the page": the host moves such surfaces aside while the agent reads or acts. Beside the page it covers nothing.
    if (pushing) this.#panel.removeAttribute("data-agent-overlay"); else this.#panel.setAttribute("data-agent-overlay", "");
    // The table view is modal over the whole page: under the page's own popups it showed only beside them.
    this.#host.style.zIndex = pushing && this.#settings.dockedZIndex !== undefined && !this.#tables.isOpen ? String(this.#settings.dockedZIndex) : "2147483000";
    // Pushed, the panel runs to the screen edge; its conversation keeps the edge inset free for the host's own controls.
    const inset = pushing ? this.#settings.dockedEdgeInset : 0;
    this.#root.style.setProperty("--acw-dock-inset", `${inset}px`);
    this.#panel.style.width = `${this.#width + inset}px`;
    const covers = { covers: this.#settings.dockedCovers, ...(this.#settings.dockedZIndex !== undefined ? { zIndex: this.#settings.dockedZIndex } : {}) };
    if (pushing) this.#dock.reserve(this.#settings.position, this.#width + inset, this.#host, covers); else this.#dock.release();
    this.#callout.place();
  }

  #calloutGeometry(): CalloutGeometry {
    const box = (element: HTMLElement): CalloutBox => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { left, top, right, bottom };
    };
    return {
      side: this.#settings.position,
      compact: this.#compact,
      docked: this.#mode === "docked",
      panel: this.#opened && !this.#panel.hidden ? box(this.#panel) : null,
      launcher: this.#launcher.hidden ? null : box(this.#launcher),
    };
  }

  #commitResize(previousWidth: number): void {
    const roundedPrevious = Math.round(previousWidth);
    if (roundedPrevious === this.#width) return;
    const resize: AgentChatResizeEvent = { width: this.#width, previousWidth: roundedPrevious };
    const action = this.#actionDetail("resize", { width: resize.width, previousWidth: resize.previousWidth });
    if (!this.#beforeAction(action)) {
      this.#setWidth(roundedPrevious);
      return;
    }
    this.#persistWidth();
    try { this.#options.onResize?.(resize); } catch { /* Consumer callbacks cannot break the widget. */ }
    this.#commitAction(action);
  }

  #beginLauncherDrag(event: PointerEvent): void {
    // A second finger during a drag must not re-anchor it under the first one.
    if (!this.#settings.draggableLauncher || event.button !== 0 || this.#launcherPointerId !== null) return;
    // A new press starts clean: a touch drag ends with no click, so nothing spent the flag.
    this.#launcherDragged = false;
    this.#launcherPointerId = event.pointerId;
    this.#launcherDragOrigin = this.#launcherPosition;
    // offsetLeft/offsetTop rather than the bounding rect: the hover lift is a transform, and a
    // rect that includes it makes the button jump by that much on the first move.
    this.#launcherDragStart = { x: event.clientX, y: event.clientY, left: this.#launcher.offsetLeft, top: this.#launcher.offsetTop };
    try { this.#launcher.setPointerCapture(event.pointerId); } catch { /* Pointer capture is an enhancement. */ }
  }

  #moveLauncherDrag(event: PointerEvent): void {
    if (this.#launcherPointerId !== event.pointerId) return;
    const dx = event.clientX - this.#launcherDragStart.x;
    const dy = event.clientY - this.#launcherDragStart.y;
    if (!this.#launcherDragged) {
      if (Math.hypot(dx, dy) < LAUNCHER_DRAG_THRESHOLD_PX) return;
      this.#launcherDragged = true;
      this.#launcher.dataset.dragging = "true";
    }
    this.#placeLauncher({ left: this.#launcherDragStart.left + dx, top: this.#launcherDragStart.top + dy });
  }

  #endLauncherDrag(event: PointerEvent): void {
    if (this.#launcherPointerId !== event.pointerId) return;
    try { this.#launcher.releasePointerCapture(event.pointerId); } catch { /* The pointer may already be released. */ }
    this.#launcherPointerId = null;
    if (!this.#launcherDragged) return;
    delete this.#launcher.dataset.dragging;
    // Keep the spot that was painted, not where the pointer went: a drag past the edge would
    // otherwise remember a position nobody ever saw.
    if (this.#launcherPosition) this.#launcherPosition = this.#clampLauncherPosition(this.#launcherPosition);
    this.#persistLauncherPosition();
    // Touch ends a drag without any click, which would leave the flag to swallow the next real one.
    window.setTimeout(() => { this.#launcherDragged = false; }, 0);
  }

  #cancelLauncherDrag(): void {
    if (this.#launcherPointerId === null) return;
    this.#launcherPointerId = null;
    this.#launcherDragged = false;
    delete this.#launcher.dataset.dragging;
    this.#launcherPosition = this.#launcherDragOrigin;
    this.#paintLauncher();
  }

  #placeLauncher(position: LauncherPosition): void {
    this.#launcherPosition = position;
    this.#paintLauncher();
  }

  /** Paints `#launcherPosition` clamped to the viewport, or the stylesheet's corner when there is none. */
  #paintLauncher(): void {
    const style = this.#launcher.style;
    const status = this.#compactStatus.style;
    if (!this.#launcherPosition) {
      style.left = style.top = style.right = style.bottom = "";
      status.left = status.top = status.right = status.bottom = "";
      delete this.#launcher.dataset.moved;
      this.#callout.place();
      return;
    }
    const { left, top } = this.#clampLauncherPosition(this.#launcherPosition);
    style.left = `${left}px`;
    style.top = `${top}px`;
    // The stylesheet anchors the corner by right/bottom; both are released so left/top alone say where it is.
    style.right = "auto";
    style.bottom = "auto";
    this.#launcher.dataset.moved = "true";
    const statusWidth = this.#compactStatus.offsetWidth || 372, avatarSize = this.#launcher.offsetHeight || LAUNCHER_SIZE_PX;
    status.left = `${Math.max(8, Math.min(window.innerWidth - statusWidth - 8, left + avatarSize - statusWidth))}px`;
    const below = top < (this.#compactStatus.offsetHeight || 90) + 10;
    status.top = below ? `${top + avatarSize + 10}px` : "auto";
    status.right = "auto";
    status.bottom = below ? "auto" : `${Math.max(8, window.innerHeight - top + 10)}px`;
    this.#callout.place();
  }

  #clampLauncherPosition(position: LauncherPosition): LauncherPosition {
    const width = this.#launcher.offsetWidth || LAUNCHER_SIZE_PX;
    const height = this.#launcher.offsetHeight || LAUNCHER_SIZE_PX;
    return {
      left: Math.round(Math.min(Math.max(0, window.innerWidth - width), Math.max(0, position.left))),
      top: Math.round(Math.min(Math.max(0, window.innerHeight - height), Math.max(0, position.top))),
    };
  }

  async #streamTurn(
    content: string, turn: TurnUi, attachments: readonly TransportAttachment[] = [], replyTo?: AgentChatReply,
    attachmentFiles: ReadonlyMap<string, File> = new Map(),
  ): Promise<AgentChatTurnResult> {
    const requestId = `widget-${randomId()}`;
    return this.#streamOperation(turn, "turn", requestId, {}, async (context) => {
      let agentContext: Readonly<Record<string, unknown>> | undefined;
      if (this.#options.agentContextProvider) {
        const current = this.#resolveContextSnapshot;
        const resolveContext = current && current.sessionId === this.#sessionId
          ? { ...current, signal: context.signal }
          : await this.#contextResolver.resolve("refresh", context.signal);
        agentContext = await this.#options.agentContextProvider(resolveContext);
      }
      return await this.#settings.transport.send({
        content,
        sessionId: this.#sessionId,
        requestId,
        attachments,
        ...(replyTo ? { replyTo } : {}),
        ...(this.#settings.agentProfileId ? { agentProfileId: this.#settings.agentProfileId } : {}),
        ...(agentContext ? { agentContext } : {}),
      }, attachmentFiles.size > 0 ? { ...context, attachmentFiles } : context);
    });
  }

  async #streamInteraction(
    approval: AgentChatApprovalChallenge,
    decision: AgentChatApprovalDecision,
    turn: TurnUi,
  ): Promise<AgentChatTurnResult> {
    const resolve = this.#settings.transport.resolveInteraction;
    if (!resolve) throw new Error("Transport chưa hỗ trợ tiếp tục tương tác với người dùng.");
    const requestId = `widget-interaction-${randomId()}`;
    return this.#streamOperation(turn, "interaction", requestId, {
      interactionId: approval.approvalId,
      interactionKind: approval.kind,
    }, (context) => resolve.call(this.#settings.transport, {
      kind: approval.kind,
      interactionId: approval.approvalId,
      sessionId: approval.sessionId,
      requestId,
      decision,
      ...(this.#settings.agentProfileId ? { agentProfileId: this.#settings.agentProfileId } : {}),
    }, context));
  }

  async #streamHumanInteraction(
    interaction: AgentChatHumanInteractionChallenge,
    action: AgentChatInteractionAction,
    content: unknown,
    turn: TurnUi,
  ): Promise<AgentChatTurnResult> {
    const resolve = this.#settings.transport.resolveInteraction;
    if (!resolve) throw new Error("Transport chưa hỗ trợ tiếp tục tương tác với người dùng.");
    const requestId = `widget-interaction-${randomId()}`;
    return this.#streamOperation(turn, "interaction", requestId, {
      interactionId: interaction.interactionId, interactionKind: interaction.kind,
    }, (context) => resolve.call(this.#settings.transport, {
      kind: interaction.kind, interactionId: interaction.interactionId, sessionId: interaction.sessionId,
      requestId, action, ...(content === undefined ? {} : { content }),
      ...(this.#settings.agentProfileId ? { agentProfileId: this.#settings.agentProfileId } : {}),
    }, context));
  }

  async #streamOperation(
    turn: TurnUi,
    operation: "turn" | "interaction",
    requestId: string,
    interaction: Readonly<{ interactionId?: string; interactionKind?: AgentChatInteractionKind }>,
    execute: (context: AgentChatOperationContext & AgentChatTransportEventSink) => Promise<AgentChatTurnResult>,
  ): Promise<AgentChatTurnResult> {
    const controller = new AbortController();
    this.#turnAbortController = controller;
    this.#abortControllers.add(controller);
    this.#turnRequestId = requestId;
    const context = {
      operation,
      sessionId: this.#sessionId,
      requestId,
      ...(this.#settings.agentProfileId ? { agentProfileId: this.#settings.agentProfileId } : {}),
      ...interaction,
      signal: controller.signal,
      onEvent: (event: AgentChatStreamEvent) => this.#handleTransportEvent(turn, event),
    };
    try {
      // The same request id on every pass: the transport resumes it from the last event it saw and
      // the server recognises it, so a pass after an outage continues the work and never repeats a write.
      for (let resumed = 0; ; resumed += 1) {
        await this.#link.whenRestored(controller.signal, false);
        try { return await execute(context); }
        catch (cause) {
          if (controller.signal.aborted || !isConnectivityFailure(cause) || resumed >= MAX_AUTO_RESUMES) throw cause;
          this.#link.reportFailure();
          this.#settleRetries(turn);
          this.#refreshLiveLine(turn);
          if (await this.#link.whenRestored(controller.signal, true) === "gave-up") throw cause;
        }
      }
    } finally {
      // A "retrying" row must never outlive the attempt it announced (success, failure or give-up).
      this.#settleRetries(turn);
      this.#abortControllers.delete(controller);
      if (this.#turnAbortController === controller) this.#turnAbortController = null;
      if (this.#turnRequestId === requestId) this.#turnRequestId = "";
    }
  }

  async #probeBackend(signal: AbortSignal): Promise<boolean> {
    const check = this.#settings.transport.checkConnection;
    if (!check) return true;
    await check.call(this.#settings.transport, {
      operation: "runtime", sessionId: this.#sessionId, requestId: `widget-runtime-${randomId()}`,
      ...(this.#settings.agentProfileId ? { agentProfileId: this.#settings.agentProfileId } : {}), signal,
    });
    return true;
  }

  #showLink(state: ConnectionState): void {
    this.#linkBanner.show(state);
    this.#connection.dataset.state = state === "online" ? "online" : "offline";
    this.#input.placeholder = state !== "online" && this.#pending ? this.#settings.labels.connectionWaiting : this.#settings.placeholder;
    this.#emit("connection-change", { state: state === "online" ? "online" : "offline", sessionId: this.#sessionId });
    if (state !== "online") this.#scrollToLatest();
  }

  /** The gateway replays the request from its first event: what the turn drew so far is stale. */
  #discardReplayed(turn: TurnUi): void {
    this.#resetOutputDraft(turn, true);
    this.#cancelNarrationRender(turn);
    turn.narrationDraft?.remove();
    turn.narrationDraft = null;
    turn.streamedNarration = "";
    turn.activeNarrationId = "";
    for (const narration of turn.committedNarrations.splice(0)) narration.element.remove();
    this.#settleRetries(turn);
  }

  #handleTransportEvent(turn: TurnUi, event: AgentChatStreamEvent): void {
    if (decisionActedOn(event)) turn.acted = true;
    if (event.type === "progress") this.#observeProgress(event.progress);
    if (event.type === "assistant-output-start" && event.audience === "user") this.#startOutput(turn, event.outputId);
    if (event.type === "assistant-output-delta" && event.audience === "user") this.#appendOutputDelta(turn, event.outputId, event.delta);
    if (event.type === "assistant-output-end" && event.audience === "user") this.#endOutput(turn, event.outputId, event.status);
    if (event.type === "assistant-narration-start" && event.audience === "user") this.#startNarration(turn, event.narrationId, event.turnId, event.kind);
    if (event.type === "assistant-narration-delta" && event.audience === "user") this.#appendNarrationDelta(turn, event.narrationId, event.delta);
    if (event.type === "assistant-narration-end" && event.audience === "user") this.#endNarration(turn, event.narrationId, event.status);
    if (event.type === "assistant-narration-superseded" && event.audience === "user") dropSupersededNarration(turn.committedNarrations, event.narrationId);
    if (event.type === "assistant-reasoning-start" && event.audience === "user") this.#startReasoning(turn, event.reasoningId);
    // `status` is deliberately unread: a finished thought and an abandoned one both stop
    // being live, and neither belongs in the trace afterwards.
    if (event.type === "assistant-reasoning-delta" && event.audience === "user") this.#appendReasoning(turn, event.reasoningId, event.delta);
    if (event.type === "assistant-reasoning-end" && event.audience === "user") this.#endReasoning(turn, event.reasoningId);
    if (event.type === "plan-updated") this.#handlePlan(turn, event);
    if (event.type === "tool-started") this.#handleToolStarted(turn, event.callId, event.label, event.workStepId);
    if (event.type === "tool-completed") this.#handleToolCompleted(turn, event.callId, event.label, event.status);
    if (event.type === "activity") this.#handleActivity(turn, event.activity);
    if (event.type === "stream-reset") this.#discardReplayed(turn);
    if (event.type === "metadata") this.#emit("transport-metadata", { sessionId: this.#sessionId, data: event.data });
  }

  #requestTurnCancellation(requestId: string): void {
    if (!requestId || !this.#settings.transport.cancelTurn) return;
    try {
      void Promise.resolve(this.#settings.transport.cancelTurn({
        operation: "cancel",
        sessionId: this.#sessionId,
        requestId,
        ...(this.#settings.agentProfileId ? { agentProfileId: this.#settings.agentProfileId } : {}),
        signal: AbortSignal.timeout(5_000),
      })).catch(() => undefined);
    } catch { /* Cancellation delivery is best-effort; the local stream is still aborted. */ }
  }

  async #ensureStarted(): Promise<void> {
    if (!this.#startPromise) {
      this.#startPromise = Promise.allSettled([this.#loadRuntime(), this.#loadHistory()]).then(() => {
        this.#notify("ready");
      });
    }
    await this.#startPromise;
  }

  async #loadRuntime(): Promise<void> {
    const controller = new AbortController();
    this.#abortControllers.add(controller);
    try {
      this.#runtimeInfo = await this.#settings.transport.checkConnection?.({
        operation: "runtime",
        sessionId: this.#sessionId,
        requestId: `widget-runtime-${randomId()}`,
        ...(this.#settings.agentProfileId ? { agentProfileId: this.#settings.agentProfileId } : {}),
        signal: controller.signal,
      });
      applyGatewayLabels(this.#settings.labels, this.#options.labels, this.#runtimeInfo);
      this.#connection.dataset.state = "online";
      this.#connection.setAttribute("aria-label", "Runtime sẵn sàng");
      this.#connection.title = "Runtime sẵn sàng";
      this.#emit("connection-change", { state: "online", sessionId: this.#sessionId, runtime: this.#runtimeInfo });
      if (this.#conversation.querySelector(":scope > .acw-welcome")) await this.#renderWelcome("refresh");
    } catch (cause) {
      this.#connection.dataset.state = "offline";
      this.#connection.setAttribute("aria-label", "Mất kết nối runtime");
      this.#connection.title = "Mất kết nối runtime";
      const error = cause instanceof Error ? cause : new Error("Không kết nối được runtime");
      this.#error(error);
      this.#emit("connection-change", { state: "offline", sessionId: this.#sessionId, error: error.message });
    } finally {
      this.#abortControllers.delete(controller);
    }
  }

  /**
   * Placeholder shown while the history request is in flight.
   *
   * Opening a session that has history used to show the welcome block, hold it for as long as
   * the round trip took, and then replace the whole conversation in one frame. The greeting was
   * wrong for that session and the switch read as a stutter. The welcome is hidden rather than
   * removed, so a session that turns out to be empty gets it straight back without re-resolving
   * whatever the host computed for it.
   */
  #renderHistorySkeleton(): void {
    const skeleton = document.createElement("div");
    skeleton.className = "acw-skeleton";
    // It says nothing a screen reader should hear; the real messages announce themselves.
    skeleton.setAttribute("aria-hidden", "true");
    const bubble = document.createElement("div");
    bubble.className = "acw-skeleton-row";
    bubble.dataset.from = "user";
    const bubbleBody = document.createElement("span");
    bubbleBody.className = "acw-skeleton-bubble";
    bubble.append(bubbleBody);
    const reply = document.createElement("div");
    reply.className = "acw-skeleton-row";
    const avatar = document.createElement("span");
    avatar.className = "acw-skeleton-avatar";
    const block = document.createElement("span");
    block.className = "acw-skeleton-block";
    for (let line = 0; line < 3; line += 1) {
      const item = document.createElement("span");
      item.className = "acw-skeleton-line";
      block.append(item);
    }
    reply.append(avatar, block);
    skeleton.append(bubble, reply);
    this.#historySkeleton = skeleton;
    this.#conversation.append(skeleton);
  }

  async #loadHistory(): Promise<void> {
    if (!this.#settings.transport.loadHistory) return;
    this.#historyController?.abort();
    const controller = new AbortController();
    this.#historyController = controller;
    this.#abortControllers.add(controller);
    const opening = this.#conversation.querySelector<HTMLElement>(":scope > .acw-welcome");
    if (opening) opening.hidden = true;
    this.#renderHistorySkeleton();
    const sessionId = this.#sessionId;
    try {
      const messages = await this.#settings.transport.loadHistory({
        operation: "history",
        sessionId,
        requestId: `widget-history-${randomId()}`,
        ...(this.#settings.agentProfileId ? { agentProfileId: this.#settings.agentProfileId } : {}),
        signal: controller.signal,
      });
      // A host that opens the panel and starts a task on a fresh session in the same click
      // replaces the session while this request is still out; the old conversation must not
      // land above the new one's first message.
      if (controller.signal.aborted || sessionId !== this.#sessionId) return;
      if (messages.length === 0) {
        if (!this.#conversation.querySelector(":scope > .acw-welcome")) {
          const empty = document.createElement("p");
          empty.className = "acw-history-empty";
          empty.setAttribute("role", "status");
          empty.textContent = "Cuộc trò chuyện này chưa có tin nhắn.";
          this.#conversation.append(empty);
        }
        return;
      }
      this.#conversation.replaceChildren();
      this.#dayDividerShown = false;
      for (const value of messages) {
        const at = value.at ?? new Date().toISOString();
        if (value.role === "user") this.#appendUserMessage(value.content, at, false, value.attachments ?? []);
        if (value.role === "assistant") this.#appendAssistantMessage({ ...value, at });
      }
    } catch (cause) {
      if (sessionId === this.#sessionId && !controller.signal.aborted) {
        const notice = document.createElement("button");
        notice.type = "button";
        notice.className = "acw-history-retry";
        notice.textContent = "Chưa tải được cuộc trò chuyện. Bấm để thử lại.";
        notice.addEventListener("click", () => { notice.remove(); void this.#loadHistory(); });
        this.#conversation.append(notice);
      }
      this.#error(cause instanceof Error ? cause : new Error("Không tải được cuộc trò chuyện."));
    } finally {
      if (this.#historyController === controller) {
        this.#historySkeleton?.remove();
        this.#historySkeleton = null;
        this.#historyController = undefined;
      }
      // Queried again rather than captured: a welcome refresh during the load replaces the
      // element, and the one that has to come back is whichever is on screen now. On the path
      // that had messages there is none, because `replaceChildren` above removed it.
      const current = this.#conversation.querySelector<HTMLElement>(":scope > .acw-welcome");
      if (current?.hidden) {
        current.hidden = false;
        // Typed while it was hidden, the greeting would simply be there: type it again now it is seen.
        const message = current.querySelector<HTMLElement>(":scope > .acw-welcome-message");
        if (message?.dataset.text) { message.textContent = ""; this.#typeWelcome(message, message.dataset.text); }
      }
      this.#abortControllers.delete(controller);
    }
  }

  #storedSession(): string | null {
    if (!this.#settings.persistSession) return null;
    try {
      const stored = localStorage.getItem(this.#settings.storageKey);
      return stored && SESSION_PATTERN.test(stored) ? stored : null;
    } catch { return null; }
  }

  #persistSession(): void {
    if (!this.#settings.persistSession) return;
    try { localStorage.setItem(this.#settings.storageKey, this.#sessionId); } catch { /* Storage may be unavailable in privacy modes. */ }
  }

  #storedWidth(): number | null {
    if (!this.#settings.persistSize) return null;
    try {
      const stored = Number(localStorage.getItem(`${this.#settings.storageKey}:width`));
      return Number.isFinite(stored) && stored >= this.#settings.minWidth && stored <= this.#settings.maxWidth ? stored : null;
    } catch { return null; }
  }

  #persistWidth(): void {
    if (!this.#settings.persistSize) return;
    try { localStorage.setItem(`${this.#settings.storageKey}:width`, String(this.#width)); } catch { /* Storage may be unavailable in privacy modes. */ }
  }

  /** Only a choice the user can make (the header button is shown) is ever read back. */
  #storedMode(): "floating" | "docked" | null {
    if (!this.#settings.persistMode || !this.#settings.showModeToggle) return null;
    try {
      const stored = localStorage.getItem(`${this.#settings.storageKey}:mode`);
      return stored === "floating" || stored === "docked" ? stored : null;
    } catch { return null; }
  }

  #persistMode(): void {
    if (!this.#settings.persistMode) return;
    try { localStorage.setItem(`${this.#settings.storageKey}:mode`, this.#mode); } catch { /* Storage may be unavailable in privacy modes. */ }
  }

  #storedLauncherPosition(): LauncherPosition | null {
    if (!this.#settings.persistLauncherPosition) return null;
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(`${this.#settings.storageKey}:launcher`) ?? "null");
      if (!isRecord(stored)) return null;
      const { left, top } = stored;
      // Only the shape is trusted here; the numbers are clamped to the viewport when painted.
      return typeof left === "number" && Number.isFinite(left) && typeof top === "number" && Number.isFinite(top) ? { left, top } : null;
    } catch { return null; }
  }

  #persistLauncherPosition(): void {
    if (!this.#settings.persistLauncherPosition || !this.#launcherPosition) return;
    try { localStorage.setItem(`${this.#settings.storageKey}:launcher`, JSON.stringify(this.#launcherPosition)); } catch { /* Storage may be unavailable in privacy modes. */ }
  }

  #freshSession(): string { return randomId(); }

  #resizeInput(): void {
    this.#input.style.height = "auto";
    this.#input.style.height = `${Math.min(this.#input.scrollHeight, 130)}px`;
  }

  #setPending(value: boolean): void {
    this.#pending = value;
    if (value) {
      this.#compactLabel.textContent = this.#settings.labels.inProgress;
      this.#compactMessage.textContent = "";
      this.#compactMessage.hidden = true;
    }
    else this.setCompactMode(false);
    if (value) this.#awaitingUser = false;
    // Once a turn is over, what it took but never read goes on (see #followUnread), then what waited in the queue.
    if (!value) void Promise.resolve().then(() => { if (this.#pending) return; this.#followUnread(); this.#drainQueued(); });
    this.#sendButton.dataset.pending = String(value);
    this.#syncSendButton();
    // The composer stays open while a turn runs — words, files, a pasted screenshot: the running turn
    // takes the words (interject), and anything it cannot take waits its turn (ui/send-queue.ts).
    this.#input.disabled = false;
    if (value) this.#setAttachmentMenu(false);
    this.#shadow.querySelectorAll<HTMLButtonElement>('.acw-ui-button[data-behavior="submit"]').forEach((button) => {
      button.disabled = value || button.dataset.permanentlyDisabled === "true";
    });
    try { this.#options.onPendingChange?.(value); } catch { /* Consumer callbacks cannot break the widget. */ }
  }

  /** While a turn runs the button stops it — unless something is written or attached, which it then sends. */
  #syncSendButton(): void {
    const draft = this.#pending && (this.#attachments.length > 0 || this.#input.value.trim() !== "");
    this.#sendButton.dataset.draft = String(draft);
    const label = this.#pending && !draft ? "Dừng xử lý" : "Gửi yêu cầu";
    this.#sendButton.setAttribute("aria-label", label);
    this.#sendButton.title = label;
  }

  /**
   * Coalesced stick-to-bottom scrolling.
   *
   * Streaming emits hundreds of scroll requests per turn. Queuing one smooth scroll per
   * delta retargets an in-flight animation every frame, which is what reads as jank, and it
   * also drags the viewport back down while the user is reading earlier messages. One
   * pending frame at a time, instant while streaming, and only while the user is parked at
   * the bottom. `force` is for user-initiated moments that should always land at the end.
   * Content that lands while the user is away marks the jump button instead of moving them.
   */
  #scrollToLatest(force = false): void {
    if (force) this.#setStickToBottom(true);
    if (!this.#stickToBottom) { this.#jump.dataset.fresh = "true"; return; }
    if (this.#scrollFrame !== null) return;
    this.#scrollFrame = window.requestAnimationFrame(() => {
      this.#scrollFrame = null;
      this.#stickToBottomNow();
    });
  }

  /**
   * Scrolls within the caller's own animation frame.
   *
   * A streaming renderer already runs inside a frame: scheduling another one there leaves
   * the viewport a delta behind the text for the whole reply, which reads as stutter at the
   * bottom edge. Only callers outside a frame need `#scrollToLatest`.
   */
  #stickToBottomNow(): void {
    if (!this.#stickToBottom) return;
    this.#conversation.scrollTop = this.#conversation.scrollHeight;
  }

  #setStickToBottom(value: boolean): void {
    this.#stickToBottom = value;
    this.#jump.hidden = value;
    if (value) delete this.#jump.dataset.fresh;
  }

  #distanceFromBottom(): number {
    const { scrollHeight, scrollTop, clientHeight } = this.#conversation;
    return Math.max(0, scrollHeight - scrollTop - clientHeight);
  }

  /**
   * A gesture away from the bottom, honoured the moment it happens.
   *
   * The scroll event it produces arrives a frame later, and a reply being painted writes the
   * bottom position every frame — waiting for the event is what let the view snap back under
   * the user's fingers. A conversation too short to scroll has no "away" to go to.
   */
  #leaveBottom(): void {
    if (this.#conversation.scrollHeight - this.#conversation.clientHeight <= STICK_TO_BOTTOM_SLACK_PX) return;
    this.#settleUntil = 0;
    this.#setStickToBottom(false);
  }

  #jumpToLatest(): void {
    this.#setStickToBottom(true);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    // A smooth scroll passes through every position on its way down; those are not the user leaving.
    this.#settleUntil = reduced ? 0 : Date.now() + SMOOTH_SCROLL_SETTLE_MS;
    this.#conversation.scrollTo({ top: this.#conversation.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }

  /**
   * Stickiness is read off the geometry, never off a flag.
   *
   * The widget's own instant writes land at the bottom, so the scroll event they raise reads
   * as "still here" by itself. A flag marking them as programmatic leaked both ways: a write
   * that changed nothing raised no event and left the flag set to swallow the user's next
   * gesture, and a gesture coalesced into the same frame as a write was swallowed outright —
   * which is why scrolling up during a reply fought the viewport. The one write that passes
   * through other positions is the smooth jump, and that is bounded by `#settleUntil`.
   */
  #trackConversationScroll(): void {
    const conversation = this.#conversation;
    const signal = this.#lifecycleController.signal;
    conversation.addEventListener("scroll", () => {
      if (this.#distanceFromBottom() <= STICK_TO_BOTTOM_SLACK_PX) { this.#setStickToBottom(true); return; }
      // A fold moves the view without the user; while one runs, only a gesture may leave the bottom.
      if (Date.now() < this.#settleUntil || this.#reflowing > 0) return;
      this.#setStickToBottom(false);
    }, { passive: true, signal });
    conversation.addEventListener("scrollend", () => { this.#settleUntil = 0; }, { passive: true, signal });
    conversation.addEventListener("wheel", (event) => { if (event.deltaY < 0) this.#leaveBottom(); }, { passive: true, signal });
    let touchY = 0;
    conversation.addEventListener("touchstart", (event) => { touchY = event.touches[0]?.clientY ?? 0; }, { passive: true, signal });
    conversation.addEventListener("touchmove", (event) => {
      const y = event.touches[0]?.clientY ?? touchY;
      // Finger moving down drags earlier messages into view; that is the gesture, not a drag up.
      if (y > touchY + 4) this.#leaveBottom();
      touchY = y;
    }, { passive: true, signal });
    conversation.addEventListener("keydown", (event) => {
      if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") this.#leaveBottom();
    }, { signal });
    this.#jump.addEventListener("click", () => this.#jumpToLatest(), { signal });
  }

  #notify(type: "ready"): void {
    try { this.#options.onReady?.(); } catch { /* Consumer callbacks cannot break the widget. */ }
    this.#emit(type, { sessionId: this.#sessionId });
  }

  #actionDetail(type: AgentChatActionType, data?: Readonly<Record<string, unknown>>): AgentChatAction {
    return { type, sessionId: this.#sessionId, at: new Date().toISOString(), ...(data ? { data } : {}) };
  }

  #beforeAction(action: AgentChatAction): boolean {
    let allowed = true;
    try {
      if (this.#options.onBeforeAction?.(action) === false) allowed = false;
      if (action.type === "open" && this.#options.onBeforeOpen?.(action) === false) allowed = false;
      if (action.type === "close" && this.#options.onBeforeClose?.(action) === false) allowed = false;
      if (action.type === "destroy" && this.#options.onBeforeDestroy?.(action) === false) allowed = false;
    } catch { /* Consumer callbacks cannot break the widget. */ }
    const event = new CustomEvent<AgentChatAction>(`agentic-chat:before-${action.type}`, {
      bubbles: true, cancelable: true, composed: true, detail: action,
    });
    return this.#host.dispatchEvent(event) && allowed;
  }

  #commitAction(action: AgentChatAction): void {
    try { this.#options.onAction?.(action); } catch { /* Consumer callbacks cannot break the widget. */ }
    this.#emit(action.type, action);
    this.#emit("action", action);
  }

  #message(message: AgentChatMessage): void {
    if (message.kind === "narration") {
      try { this.#options.onNarration?.(message); } catch { /* Consumer callbacks cannot break the widget. */ }
    }
    try { this.#options.onMessage?.(message); } catch { /* Consumer callbacks cannot break the widget. */ }
    this.#emit("message", message);
  }

  #error(error: Error): void {
    try { this.#options.onError?.(error); } catch { /* Consumer callbacks cannot break the widget. */ }
    this.#emit("error", { message: error.message });
  }

  #emit(type: string, detail: unknown): void {
    this.#host.dispatchEvent(new CustomEvent(`agentic-chat:${type}`, { bubbles: true, composed: true, detail }));
  }
}
