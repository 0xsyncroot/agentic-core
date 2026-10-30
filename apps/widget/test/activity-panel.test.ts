import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { StubNode, createStubDom } from "./dom-stub.js";

/**
 * The activity panel, driven through the built bundle against a stub DOM.
 *
 * Every defect a user has reported in this panel was a state machine mistake — a ✓ on a step
 * nobody performed, a strikethrough on work that was merely waiting, one sentence repeated
 * three times — and none of them could be caught by asserting that a string survives
 * minification, which is all this suite could do before. These drive real events through the
 * real bundle and read the rows back.
 */

/**
 * Sample App's own `labels.planSentence` (spec §3.7 item 5): the "Em sẽ …" template it used to
 * hardcode into the generic widget, now supplied through the host contract instead. A step's
 * short title — its words before any ":" or dash, trailing punctuation dropped, no leading
 * "Đang", first letter lower-cased — is exactly what Sample App's product copy chose to say.
 */
function hostStepTitle(description: string): string {
  return (description.split(/:| – | - /u)[0] ?? description).trim().replace(/[\s.,;:!?…]+$/u, "");
}
function hostPlanItem(title: string): string {
  const words = title.replace(/^đang\s+/iu, "");
  return words.charAt(0).toLocaleLowerCase("vi") + words.slice(1);
}
function hostPlanSentence(descriptions: readonly string[]): string | undefined {
  const named = descriptions.map((description) => hostPlanItem(hostStepTitle(description))).filter(Boolean);
  if (named.length === 0) return undefined;
  if (named.length > 5) return `Em sẽ ${named.slice(0, 4).join(", ")}…`;
  if (named.length === 1) return `Em sẽ ${named[0]}.`;
  return `Em sẽ ${named.slice(0, -1).join(", ")} rồi ${named[named.length - 1]}.`;
}

interface StreamEvent { readonly type: string; readonly [key: string]: unknown }

interface Turn {
  /** The session the widget sent the turn under; approval and interaction cards are bound to it. */
  readonly sessionId: string;
  /** What the widget actually sent to start or resume this turn (e.g. an interaction's `content`). */
  readonly request: Record<string, unknown>;
  emit(...events: readonly StreamEvent[]): void;
  finish(result?: Record<string, unknown>): Promise<void>;
  /** Ends the turn the way a transport failure does: the send rejects. */
  fail(message: string): Promise<void>;
  /** The user presses stop. */
  cancel(): Promise<void>;
}

/** One piece of a turn's account: narration by its message kind, a checklist step with the work under it, or a tool row. */
interface Entry { readonly kind: string; readonly state: string; readonly text: string; readonly rows?: readonly Entry[] }

interface Panel {
  /** Entries inside expandable tool rows, in document order. */
  readonly rows: readonly { readonly state: string; readonly text: string }[];
  /** The account the folded summary opens onto, in order; tool rows done inside a step sit in its `rows`. */
  readonly timeline: readonly Entry[];
  readonly summary: string;
  readonly open: boolean;
  /** Whether the live line is showing "Đang suy nghĩ". */
  readonly thinking: boolean;
  /** Whether the summary line is shown at all. While the turn runs it is not. */
  readonly headed: boolean;
  /**
   * What the account shows above the answer while the turn runs: the plan told as chat, the live
   * line (the plan step being carried out, or what is happening when there is no plan), and the
   * call line (the latest call for that step). `call` is "" when the call line is not shown;
   * `detail` says whether the chevron is offered and which way it stands.
   */
  readonly live: {
    readonly sentence: string; readonly line: string; readonly source: string; readonly state: string; readonly icon: string; readonly lines: number;
    readonly call: string; readonly detail: "none" | "closed" | "open";
  };
  /** The kinds of what is not hidden inside the account, top to bottom: "plan", timeline entries, "live", "call-line". */
  readonly shown: readonly string[];
}

interface Harness {
  start(content: string): Promise<Turn>;
  panel(): Panel;
  /** Clicks the live line of the last reply, the way a reader opens or closes the checklist mid-turn. */
  toggleDetail(): void;
  /** Resolves a deferred history load, then lets the widget render it. */
  settleHistory(messages: readonly Record<string, unknown>[]): Promise<void>;
  has(selector: string): boolean;
  /** The controller a host holds, for flows the host drives directly. */
  readonly widget: { destroy(): void; newSession(): void; isPending(): boolean; setDraft(content: string): void; send(content: string): Promise<void>; cancel(): void };
  /** The scrolling conversation; the stub has no layout, so a test sets its height by hand. */
  readonly conversation: StubNode;
  /** The last reply's answer bubble — the row's own, not a narration's. */
  answer(): StubNode;
  /** What the composer currently holds. */
  draft(): string;
  /** One animation frame, so a test can watch what each frame paints. */
  frame(): void;
  /** Visible text of the last assistant bubble, or "" when nothing is rendered for the reply. */
  assistantText(): string;
  visible(selector: string): boolean;
  count(selector: string): number;
  /** The part of the last reply's account that folds; the stub has no layout, so a test sizes it. */
  foldBody(): StubNode;
  /** Every reply's folding account, oldest first. */
  folds(): readonly StubNode[];
  /** A line of the last reply's timeline, by kind. */
  row(kind: string): StubNode;
  /** Chooses "Cho phép" on the waiting approval card and sends it from its review tab, and hands back the turn it resumes. */
  approve(): Promise<Turn>;
  deny(): Promise<Turn>;
  /** The next resume is refused by the server the way the real transport reports it: a 409 with this reason and sentence. */
  refuseNextResume(reason: string, message: string): void;
  /** Presses a button on the last card, then waits until the widget is idle again — whether or not anything streams. */
  press(choice: "approve" | "deny"): Promise<void>;
  /** What the widget sent last to start or resume a turn, or undefined when nothing is waiting on the transport. */
  lastRequest(): Record<string, unknown> | undefined;
}

async function mount(options: {
  readonly deferHistory?: boolean; readonly reducedMotion?: boolean;
  /** `false` mounts a host that supplies no plan sentence, the way a product with no wrapper of its own does. */
  readonly planSentence?: false;
  /** Runs the built-in HTTP transport instead of the stub `deliver` sink, for a test that needs a real `AgentChatTransportError` (same realm, so `instanceof` holds). */
  readonly httpRequest?: (url: string, init: Record<string, unknown>) => Promise<Response>;
} = {}): Promise<Harness> {
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const dom = createStubDom();
  const context = createContext({
    ...dom.window,
    matchMedia: (query: string) => ({
      matches: options.reducedMotion === true && /reduced-motion/u.test(query), addEventListener: () => undefined, removeEventListener: () => undefined,
    }),
    document: dom.document, URL, Headers, Response, TextDecoder, DOMException,
    AbortController, setTimeout, clearTimeout, crypto,
    location: { origin: "https://sample-app.example", href: "https://sample-app.example/app/", assign: () => undefined },
    CustomEvent: class { readonly type: string; readonly detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
    Event: class { readonly type: string; constructor(type: string) { this.type = type; } },
  });
  const scope = context as unknown as Record<string, unknown>;
  scope.window = context;
  scope.globalThis = context;
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);

  // Errors are made inside the widget's realm: `instanceof Error` there does not recognise one of
  // ours, and a stop the widget cannot recognise as a stop is reported as a failure instead.
  const realmError = (message: string, name?: string): unknown =>
    new Script(`Object.assign(new Error(${JSON.stringify(message)}), ${JSON.stringify(name ? { name } : {})})`).runInContext(context);
  let pending: {
    readonly sink: { onEvent(event: StreamEvent): void };
    readonly sessionId: string;
    readonly request: Record<string, unknown>;
    settle(result: Record<string, unknown>): void;
    reject(error: unknown): void;
  } | undefined;
  let releaseHistory: ((messages: readonly Record<string, unknown>[]) => void) | undefined;
  let refusal: { readonly reason: string; readonly message: string } | undefined;
  const api = scope.AgentChat as {
    create(options: Record<string, unknown>): Harness["widget"];
    createHarnessTransport(options: Record<string, unknown>): unknown;
  };
  const deliver = (request: { readonly sessionId: string } & Record<string, unknown>, sink: { onEvent(event: StreamEvent): void; readonly signal: AbortSignal }) =>
    new Promise((resolve, reject) => {
      pending = { sink, sessionId: request.sessionId, request, settle: (result) => resolve(result), reject };
      sink.signal.addEventListener("abort", () => reject(realmError("Đã dừng.", "AbortError")), { once: true });
    });
  resetPlanHelper();
  // A test that needs a real `AgentChatTransportError` (same realm as the widget it feeds,
  // so `instanceof` holds — a plain `realmError` cannot stand in for one) runs the actual built-in
  // HTTP transport instead of the stub `deliver` sink above.
  const transport = options.httpRequest
    ? api.createHarnessTransport({
        baseUrl: "https://gateway.example", endpoints: { runtime: false, history: false },
        reconnect: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 }, request: options.httpRequest,
      })
    : {
        checkConnection: () => ({ status: "ok" }),
        loadHistory: () => options.deferHistory
          ? new Promise((resolve) => { releaseHistory = resolve as (messages: readonly Record<string, unknown>[]) => void; })
          : [],
        send: deliver,
        // A decision on an approval card resumes the turn through here, and it streams the same way.
        // A refusal goes through the built-in HTTP transport, so the widget gets a real `AgentChatTransportError`.
        resolveInteraction: (request: { readonly sessionId: string } & Record<string, unknown>, sink: { onEvent(event: StreamEvent): void; readonly signal: AbortSignal }) => {
          const refused = refusal;
          refusal = undefined;
          if (!refused) return deliver(request, sink);
          const refusing = api.createHarnessTransport({
            baseUrl: "https://gateway.example", endpoints: { runtime: false, history: false },
            reconnect: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
            request: async () => new Response(JSON.stringify({ error: { code: "conflict", message: refused.message, reason: refused.reason } }),
              { status: 409, headers: { "content-type": "application/json" } }),
          }) as { resolveInteraction(request: unknown, context: unknown): Promise<unknown> };
          return refusing.resolveInteraction(request, sink);
        },
      };
  const widget = api.create({
    persistSession: false,
    startOpen: true,
    transport,
    // A generic widget writes no business-language copy of its own; these are exactly the
    // sentences Sample App's own host page supplies, so the rest of this file can keep reading like
    // the product it exercises rather than the generic widget underneath it (spec §3.7 item 5).
    labels: {
      thinking: "Đang suy nghĩ",
      inProgress: "Đang xử lý…",
      emptyAnswer: "Agent đã hoàn tất nhưng không trả về nội dung.",
      transportError: "Không thể kết nối tới trợ lý. Anh/chị thử lại sau ít phút giúp em.",
      awaitingUser: "Đang chờ anh/chị phản hồi…",
      turnInterrupted: "Yêu cầu bị gián đoạn do mất kết nối. Anh/chị gửi lại giúp em.",
      ...(options.planSentence === false ? {} : { planSentence: hostPlanSentence }),
    },
  });
  const conversation = dom.body.querySelector(".acw-conversation");
  assert.ok(conversation, "the widget mounted its conversation");

  const decide = async (choice: "approve" | "deny"): Promise<Turn> => {
    pending = undefined;
    // A permission is answered by one press on its own button ("Cho phép" / "Từ chối"). A question card is
    // answered from its review tab: "Gửi thông tin", or "Bỏ qua".
    const card = dom.body.querySelectorAll(".acw-approval").at(-1);
    const question = card?.classList.contains("acw-interaction") === true;
    const option = question ? card?.querySelector(`[data-choice="${choice}"]`) : undefined;
    option?.click();
    const button = card?.querySelector(question ? (option || choice === "approve" ? ".acw-approval-approve" : ".acw-approval-deny")
      : `[data-choice="${choice}"]`);
    assert.ok(button, "an approval card is waiting for a decision");
    button.click();
    for (let attempt = 0; attempt < 50 && !pending; attempt += 1) {
      dom.flushFrames();
      await new Promise((resolve) => { setTimeout(resolve, 1); });
    }
    assert.ok(pending, "the decision never reached the transport");
    const turn = pending;
    // The card's click handler owns the resumed turn, so there is no promise to await: wait for
    // the widget to stop being busy instead.
    const settled = async () => {
      for (let attempt = 0; attempt < 50 && widget.isPending(); attempt += 1) await new Promise((resolve) => { setTimeout(resolve, 1); });
      dom.flushFrames();
    };
    return {
      sessionId: turn.sessionId,
      request: turn.request,
      emit(...events) {
        for (const event of events) turn.sink.onEvent(event);
        dom.stepFrame();
      },
      async finish(result = { content: "Xong." }) { turn.settle(result); await settled(); },
      async fail(message) { turn.reject(realmError(message)); await settled(); },
      async cancel() { widget.cancel(); await settled(); },
    };
  };
  return {
    conversation,
    answer(): StubNode {
      const row = dom.body.querySelectorAll(".acw-assistant").at(-1);
      const bubble = row?.children.find((node: StubNode) => node.classList.contains("acw-bubble"));
      assert.ok(bubble, "the reply has an answer bubble");
      return bubble;
    },
    async start(content: string): Promise<Turn> {
      // A second turn in the same test must wait for its own sink, not pick up the last one's.
      pending = undefined;
      const sent = widget.send(content);
      // The widget checks the connection and loads history before it sends, so the sink appears
      // several turns of the event loop later. Poll rather than guess a number of ticks.
      for (let attempt = 0; attempt < 50 && !pending; attempt += 1) {
        dom.flushFrames();
        await new Promise((resolve) => { setTimeout(resolve, 1); });
      }
      assert.ok(pending, "the transport never received the turn");
      const turn = pending;
      return {
        sessionId: turn.sessionId,
        request: turn.request,
        emit(...events) {
          for (const event of events) turn.sink.onEvent(event);
          // One generation, not a drain: rows render synchronously, and draining would
          // fast-forward anything that deliberately paces itself across frames.
          dom.stepFrame();
        },
        async finish(result = { content: "Xong." }) {
          turn.settle(result);
          await sent;
          dom.flushFrames();
        },
        async fail(message) {
          turn.reject(realmError(message));
          await sent;
          dom.flushFrames();
        },
        async cancel() {
          widget.cancel();
          await sent;
          dom.flushFrames();
        },
      };
    },
    async settleHistory(messages): Promise<void> {
      assert.ok(releaseHistory, "history was not deferred");
      releaseHistory(messages);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        dom.flushFrames();
        await new Promise((resolve) => { setTimeout(resolve, 1); });
      }
    },
    has(selector: string): boolean { return dom.body.querySelectorAll(selector).length > 0; },
    widget,
    draft(): string { return String(dom.body.querySelector("textarea")?.value ?? ""); },
    frame(): void { dom.stepFrame(); },
    assistantText(): string {
      const row = dom.body.querySelectorAll(".acw-assistant").at(-1);
      const bubble = row?.querySelectorAll(".acw-bubble").find((node: StubNode) => !node.hidden);
      return (bubble?.innerHTML ?? bubble?.textContent ?? "").trim();
    },
    visible(selector: string): boolean {
      return dom.body.querySelectorAll(selector).some((node: StubNode) => !node.hidden);
    },
    count(selector: string): number { return dom.body.querySelectorAll(selector).length; },
    foldBody(): StubNode {
      const body = dom.body.querySelectorAll(".acw-thinking-body").at(-1);
      assert.ok(body, "the reply has an account of its work");
      return body;
    },
    folds(): readonly StubNode[] { return dom.body.querySelectorAll(".acw-thinking"); },
    row(kind: string): StubNode {
      const line = dom.body.querySelectorAll(".acw-thinking").at(-1)?.querySelector(`.acw-work[data-kind="${kind}"]`);
      assert.ok(line, `the last reply has a ${kind} line`);
      return line;
    },
    toggleDetail(): void {
      const line = dom.body.querySelectorAll(".acw-thinking").at(-1)?.querySelector(".acw-live-line");
      assert.ok(line, "the last reply has a live line");
      line.click();
      dom.stepFrame();
    },
    approve(): Promise<Turn> { return decide("approve"); },
    deny(): Promise<Turn> { return decide("deny"); },
    refuseNextResume(reason, message): void { refusal = { reason, message }; },
    async press(choice): Promise<void> {
      pending = undefined;
      const button = dom.body.querySelectorAll(".acw-approval").at(-1)?.querySelector(`[data-choice="${choice}"]`);
      assert.ok(button, "the last card offers this choice");
      button.click();
      for (let attempt = 0; attempt < 10; attempt += 1) await new Promise((resolve) => { setTimeout(resolve, 1); });
      for (let attempt = 0; attempt < 50 && widget.isPending() && !pending; attempt += 1) await new Promise((resolve) => { setTimeout(resolve, 1); });
      dom.flushFrames();
    },
    lastRequest(): Record<string, unknown> | undefined { return pending?.request; },
    panel(): Panel {
      const thinking = dom.body.querySelectorAll(".acw-thinking").at(-1);
      if (!thinking) {
        return { rows: [], timeline: [], summary: "", open: false, thinking: false, headed: false,
          live: { sentence: "", line: "", source: "", state: "", icon: "", lines: 0, call: "", detail: "none" }, shown: [] };
      }
      const entry = (node: StubNode): Entry => {
        if (node.classList.contains("acw-check-step")) {
          const rows = (node.querySelector(".acw-check-work")?.children ?? []).map(entry);
          return { kind: "step", state: node.dataset.state ?? "", text: node.querySelector(".acw-check-label")?.textContent.trim() ?? "", ...(rows.length > 0 ? { rows } : {}) };
        }
        if (node.classList.contains("acw-work")) {
          return { kind: node.dataset.kind ?? "", state: node.dataset.state ?? "", text: node.querySelector(".acw-work-label")?.textContent.trim() ?? "" };
        }
        if (node.classList.contains("acw-thinking-item")) {
          // A tool call's own line: the same shape a plan step's entry uses, so its mark is a
          // real ✓/✕/– straight from the status the runtime published — never grouped or
          // deduped by its wording the way the old phrase-heuristic rows used to be.
          return { kind: "work", state: node.dataset.state ?? "", text: node.textContent.trim() };
        }
        return { kind: node.dataset.messageKind ?? "", state: "", text: node.textContent.trim() };
      };
      const children: StubNode[] = thinking.querySelector(".acw-timeline")?.children ?? [];
      const sentence = thinking.querySelector(".acw-plan-sentence");
      const lines = thinking.querySelectorAll(".acw-live-line");
      const line = lines[0];
      const lineShown = line !== undefined && !line.hidden;
      const callLine = thinking.querySelector(".acw-call-line");
      const callShown = callLine !== null && callLine !== undefined && !callLine.hidden;
      const toggle = line?.querySelector(".acw-live-toggle");
      return {
        // Every tool-call line anywhere in the account, flattened — nested under the step it ran
        // inside, or on the timeline directly when no step was active.
        rows: flat(children.map(entry)).filter((item) => item.kind === "work").map((item) => ({ state: item.state, text: item.text })),
        timeline: children.map(entry),
        summary: thinking.querySelector(".acw-thinking-label")?.textContent.trim() ?? "",
        open: thinking.open,
        thinking: lineShown && line?.dataset.source === "thinking",
        headed: thinking.dataset.complete === "true",
        live: {
          sentence: sentence && !sentence.hidden ? sentence.textContent.trim() : "",
          line: lineShown ? line?.querySelector(".acw-live-label")?.textContent.trim() ?? "" : "",
          source: line?.dataset.source ?? "", state: line?.dataset.state ?? "", icon: line?.dataset.icon ?? "", lines: lines.length,
          call: callShown ? callLine?.querySelector(".acw-live-label")?.textContent.trim() ?? "" : "",
          detail: !toggle || toggle.hidden ? "none" : line?.dataset.detail === "open" ? "open" : "closed",
        },
        // In the order the account's own body holds them — which is the order the reader sees.
        shown: (thinking.querySelector(".acw-thinking-body")?.children ?? []).flatMap((node: StubNode) =>
          node === sentence ? (sentence.hidden ? [] : ["plan"])
            : node === line ? (lineShown ? ["live"] : [])
            : node === callLine ? (callShown ? ["call-line"] : [])
            : node.children.filter((child: StubNode) => !child.hidden).map((child: StubNode) => entry(child).kind)),
      };
    },
  };
}

/**
 * A fake runtime's own `plan-updated` frame — the shape the real Agent API sends (spec §4.2):
 * `planId`/`revision`/`state`/`cause` plus `changedStepIds`, computed here the way the runtime
 * computes them, by comparing against the plan's own previous revision. One mount() is one
 * conversation, so revision keeps climbing across every `plan()` call in it, turn or no turn —
 * exactly what makes the widget tell its sentence once and never again for the same plan.
 */
let planRevision = 0;
let previousPlanSteps: Map<string, string> | undefined;
function resetPlanHelper(): void { planRevision = 0; previousPlanSteps = undefined; }
const plan = (...steps: readonly (readonly [string, string, string, string?])[]) => {
  planRevision += 1;
  const changedStepIds = steps.filter(([id, , status]) => previousPlanSteps?.get(id) !== status).map(([id]) => id);
  previousPlanSteps = new Map(steps.map(([id, , status]) => [id, status]));
  return {
    type: "plan-updated", turnId: "t1", cause: "proposal",
    plan: {
      planId: "plan-1", revision: planRevision, state: "active", goal: "Hỗ trợ tính lương",
      steps: steps.map(([id, description, status, outcome]) => ({ id, description, status, ...(outcome ? { outcome } : {}) })),
    },
    changedStepIds,
  };
};
const working = (id: string, state: "active" | "done", label?: string) =>
  ({ type: "activity", activity: { id, code: "working", state, ...(label ? { label } : {}) } });
/** Every entry of an account, with the tool rows under each step listed after it. */
const flat = (entries: readonly Entry[]): Entry[] => entries.flatMap((entry) => [entry, ...flat(entry.rows ?? [])]);

test("each tool call gets its own line, marked straight from the status the runtime publishes", async () => {
  const harness = await mount();
  const turn = await harness.start("Hỗ trợ tôi tính lương");

  // Three distinct calls, two of them phrased the same — each still gets its own line, because
  // identity here is the callId the runtime assigns, never the wording (spec §3.7 item 6).
  turn.emit(
    working("call-1", "active", "Đang xem các bảng lương gần đây…"),
    working("call-2", "active", "Đang kiểm tra kết nối dữ liệu…"),
    working("call-3", "active", "Đang xem các bảng lương gần đây…"),
  );
  assert.deepEqual(harness.panel().timeline, [
    { kind: "work", state: "active", text: "Đang xem các bảng lương gần đây…" },
    { kind: "work", state: "active", text: "Đang kiểm tra kết nối dữ liệu…" },
    { kind: "work", state: "active", text: "Đang xem các bảng lương gần đây…" },
  ], "three distinct calls, however similarly phrased, are three distinct lines");

  // Each settles on its own, independent of the other two — no shared entry to wait on.
  turn.emit(working("call-1", "done"));
  assert.deepEqual(harness.panel().timeline[0], { kind: "work", state: "done", text: "Đang xem các bảng lương gần đây…" },
    "the first call finishing does not touch the other two");
  assert.equal(harness.panel().timeline[1]?.state, "active");
  assert.equal(harness.panel().timeline[2]?.state, "active");
  turn.emit(working("call-2", "done"), working("call-3", "done"));
  assert.ok(harness.panel().timeline.every((item) => item.state === "done"), "every call that finished is marked done, on its own line");
  await turn.finish({ content: "Xong." });
});

test("a failed turn preserves successful reads under its unfinished plan step", async () => {
  const harness = await mount();
  const turn = await harness.start("Phân tích hồ sơ dự toán");
  turn.emit(plan(["read", "Đọc các biểu chi tiết", "in_progress"]));
  turn.emit(
    { type: "tool-started", callId: "read-26", workStepId: "read", label: "Đang đọc biểu 26" },
    { type: "tool-completed", callId: "read-26", status: "succeeded", label: "Đã đọc biểu 26: 8 dòng" },
    { type: "tool-started", callId: "read-27", workStepId: "read", label: "Đang đọc biểu 27" },
  );
  await turn.fail("Lượt phân tích đã dừng vì vượt giới hạn ngữ cảnh.");
  const rows = flat(harness.panel().timeline);
  assert.equal(rows.find((row) => row.text === "Đã đọc biểu 26: 8 dòng")?.state, "done");
  assert.equal(rows.find((row) => row.text === "Đang đọc biểu 27")?.state, "error");
  assert.equal(rows.find((row) => row.kind === "step")?.state, "error");
});

test("a turn that stops to ask something says so, and claims nothing it did not do", async () => {
  const harness = await mount();
  const turn = await harness.start("Hỗ trợ tôi tính lương");
  turn.emit(plan(
    ["confirm", "Xác nhận kỳ lương cần tính", "in_progress"],
    ["workdata", "Kiểm tra dữ liệu công nội bộ", "pending"],
    ["sheets", "Tạo bảng lương nháp cho kỳ mới", "pending"],
  ));
  // Mid-turn: the step being worked on is the one the spinner is attached to. If this ever
  // stopped being `active` the panel would look frozen while the agent was busy.
  assert.deepEqual(harness.panel().timeline, [
    { kind: "step", state: "active", text: "Xác nhận kỳ lương cần tính" },
    // The two behind it are on the checklist as still to come, so the reader can see how much is left.
    { kind: "step", state: "pending", text: "Kiểm tra dữ liệu công nội bộ" },
    { kind: "step", state: "pending", text: "Tạo bảng lương nháp cho kỳ mới" },
  ]);

  turn.emit({ type: "activity", activity: { id: "complete", code: "completed", state: "done" } });
  await turn.finish({ content: "Anh/chị xác nhận giúp em kỳ lương nhé." });

  const panel = harness.panel();
  // The panel records what happened. The step it stopped inside did start, so it stays; the two
  // behind it never did, and listing them under a finished turn reads as a stalled process.
  assert.deepEqual(panel.timeline, [{ kind: "step", state: "paused", text: "Xác nhận kỳ lương cần tính" }]);
  // Not "waiting for you": the question is in the chat right underneath, so the line would add
  // nothing — and it would have the panel addressing the reader, which is not its job.
  assert.match(panel.summary, /^Đã xử lý trong \d+s$/u);
  // The three specific misreports this replaced: a ✓ on the step being asked about, a
  // strikethrough on steps that are merely waiting, and "finished" over an open question.
  assert.equal(panel.timeline.some((entry) => entry.state === "skipped"), false);
  assert.equal(panel.timeline.some((entry) => entry.state === "done"), false);
});

test("a plan the agent finished reads as finished", async () => {
  const harness = await mount();
  const turn = await harness.start("Tạo bảng lương tháng 8");
  turn.emit(plan(["sheets", "Đã tạo 2 bảng lương nháp tháng 08/2026", "completed"]));
  turn.emit({ type: "activity", activity: { id: "complete", code: "completed", state: "done" } });
  await turn.finish();

  const panel = harness.panel();
  // Only what happened. The time is on the summary line; repeating it inside is noise.
  assert.deepEqual(panel.timeline, [{ kind: "step", state: "done", text: "Đã tạo 2 bảng lương nháp tháng 08/2026" }]);
  // The one fact worth keeping once the work is done is how long it took.
  assert.match(panel.summary, /^Đã xử lý trong \d+s$/u);
  assert.equal(panel.open, false, "a finished turn collapses to one line, and a click reopens it");
});

test("a turn the loop cut short says so, and is not reported as waiting for the user", async () => {
  const harness = await mount();
  const turn = await harness.start("Hỗ trợ tôi tính lương");
  turn.emit(plan(
    ["found", "Đã tìm thấy bảng lương tháng 8/2026", "completed"],
    ["confirm", "Xác nhận kỳ lương cần tính", "in_progress"],
    ["connect", "Kiểm tra trạng thái kết nối chấm công", "pending"],
  ));
  // `partial` is the loop saying the model's reply did not terminate cleanly. The turn is over
  // and nobody is being waited on, so neither "finished" nor "waiting for you" is true of it.
  turn.emit({ type: "activity", activity: { id: "complete", code: "completed", state: "partial" } });
  await turn.finish({ content: "Em mới kiểm tra được một phần." });

  const panel = harness.panel();
  // An ending that went wrong still names itself: there the outcome is the information.
  assert.equal(panel.summary, "Đã dừng khi chưa hoàn tất");
  assert.equal(panel.open, false, "collapsed like any other ending; the summary says it stopped early");
  assert.equal(panel.rows.some((row) => /kết quả một phần/u.test(row.text)), false,
    "no row claims a partial result: the summary is the whole account of how it ended");
  assert.equal(panel.timeline.some((entry) => entry.state === "skipped"), false, "unreached is not abandoned");
  assert.equal(panel.timeline.some((entry) => /Kiểm tra trạng thái kết nối/u.test(entry.text)), false, "and not shown either");
});

test("a partial result stays partial even without a completion activity frame", async () => {
  const harness = await mount();
  const turn = await harness.start("Đọc toàn bộ bảng");
  await turn.finish({ content: "Mới đọc được một phần bảng.", outcome: "partial" });
  assert.equal(harness.panel().summary, "Đã dừng khi chưa hoàn tất");
});

test("an active step removed by a later plan revision stops while its successful reads remain done", async () => {
  const harness = await mount();
  const turn = await harness.start("Phân tích tài liệu");
  turn.emit(plan(["survey", "Khảo sát hồ sơ", "completed"], ["scope", "Phân loại phạm vi từng biểu", "in_progress"], ["read", "Đọc các biểu nguồn", "pending"]));
  turn.emit(working("source-1", "active", "Đang xem biểu nguồn…"), working("source-1", "done", "Đã xem biểu nguồn: 33 dòng"));
  const revised = plan(["survey", "Khảo sát hồ sơ", "completed"], ["read", "Đọc các biểu nguồn", "in_progress"]);
  turn.emit(revised);
  const scope = harness.panel().timeline.find(entry => entry.kind === "step" && entry.text === "Phân loại phạm vi từng biểu");
  assert.equal(scope?.state, "partial", "a removed step is no longer running and cannot claim completion");
  assert.equal(scope?.rows?.[0]?.state, "done");
  turn.emit({ ...revised, cause: "terminal", plan: { ...revised.plan, state: "stopped", revision: revised.plan.revision + 1 } });
  await turn.finish({ content: "Chưa hoàn tất vì kết nối đọc tài liệu bị gián đoạn.", outcome: "partial" });
  assert.equal(harness.panel().summary, "Đã dừng khi chưa hoàn tất");
  assert.equal(flat(harness.panel().timeline).some(entry => entry.state === "active"), false);
  assert.equal(harness.panel().rows.find(row => row.text === "Đã xem biểu nguồn: 33 dòng")?.state, "done");
});

test("every active checklist step settles at turn end even without the terminal plan frame", async () => {
  for (const ending of ["partial", "failed", "completed"] as const) {
    const harness = await mount();
    const turn = await harness.start("Đọc và tự soát hồ sơ");
    turn.emit(plan(["opened", "Mở hồ sơ", "completed"], ["scope", "Phân loại phạm vi", "in_progress"], ["read", "Đọc nguồn", "in_progress"]));
    turn.emit(working("source-1", "active", "Đang đọc nguồn…"), working("source-1", "done", "Đã đọc nguồn: 50 dòng"));
    if (ending === "failed") await turn.fail("Kết nối bị gián đoạn.");
    else await turn.finish({ content: "Đã trả kết quả hiện có.", outcome: ending });
    const steps = harness.panel().timeline.filter(entry => entry.kind === "step");
    assert.deepEqual(steps.map(entry => entry.state), ["done", ending === "failed" ? "error" : ending === "partial" ? "partial" : "paused",
      ending === "failed" ? "error" : ending === "partial" ? "partial" : "paused"]);
    assert.equal(harness.panel().rows.find(row => row.text === "Đã đọc nguồn: 50 dòng")?.state, "done");
    assert.equal(flat(harness.panel().timeline).some(entry => entry.state === "active"), false);
  }
});

test("an errored stream restores accepted unread corrections to the composer without retrying the turn", async () => {
  let requests = 0;
  const harness = await mount({ httpRequest: async () => {
    requests += 1;
    return new Response('event: error\ndata: ' + JSON.stringify({
      message: "Kết nối đã gián đoạn.", unreadInterjections: ["đổi sang tháng 8"],
    }) + '\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  await harness.widget.send("Tính lương");
  assert.equal(harness.draft(), "đổi sang tháng 8");
  assert.equal(requests, 1, "a failed write is not retried automatically");
});

test("a turn with nothing to recount still says how long it took, and opens onto nothing", async () => {
  const harness = await mount();
  const turn = await harness.start("Tạo bảng lương tháng 8");
  turn.emit({ type: "activity", activity: { id: "analysis", code: "analyzing", state: "active" } });
  turn.emit({ type: "activity", activity: { id: "complete", code: "completed", state: "done" } });
  await turn.finish();
  assert.match(harness.panel().summary, /^Đã xử lý trong \d+s$/u);
  // No narration, no plan and no tool ran. A generic "analysing" line is not a record of anything.
  assert.deepEqual(harness.panel().timeline, []);
  assert.equal(harness.has('.acw-thinking[data-empty="true"]'), true, "so the summary has no chevron and no empty box behind it");
});

test("model reasoning is only ever the live line's words, and leaves nothing behind", async () => {
  const harness = await mount();
  const turn = await harness.start("Hỗ trợ tôi tính lương");
  // A server that publishes only the lifecycle — the default, and what Sample App's does — shows no word of it.
  turn.emit({ type: "assistant-reasoning-start", reasoningId: "reason-1", audience: "user" });
  assert.deepEqual([harness.panel().thinking, harness.panel().live.line], [true, "Đang suy nghĩ"], "the user is told thinking is happening");
  // Whether the text crosses at all is the product's choice, made on the server: it once put "So I
  // will respond politely…" into a Vietnamese payroll trace. What does cross is the live line's.
  turn.emit({ type: "assistant-reasoning-delta", reasoningId: "reason-1", audience: "user", delta: "Cần xem kỳ lương nào đang mở trước khi tính." });
  harness.frame();
  assert.equal(harness.panel().live.line, "Cần xem kỳ lương nào đang mở trước khi tính.");
  assert.deepEqual(harness.panel().timeline, [], "on the line, not in the account");

  turn.emit({ type: "assistant-reasoning-end", reasoningId: "reason-1", audience: "user", status: "completed" });
  assert.deepEqual(harness.panel().timeline, [], "a finished thought is not a step of the work and leaves no line behind");
  await turn.finish({ content: "Xong." });
  assert.equal(JSON.stringify(harness.panel()).includes("kỳ lương nào đang mở"), false, "nor its words anywhere on the page once the turn is over");
});

test("nothing lands in a panel that has already closed", async () => {
  const harness = await mount();
  const turn = await harness.start("Hỗ trợ tôi tính lương");
  turn.emit({ type: "activity", activity: { id: "complete", code: "completed", state: "done" } });
  await turn.finish();
  const before = harness.panel().rows.length;

  // A reconnect after the turn ended used to append a warning row below the closing line, where
  // nothing could ever settle it: a spinner running inside a finished, collapsed panel.
  turn.emit({ type: "activity", activity: { id: "transport-reconnect", code: "retrying", state: "active" } });
  assert.equal(harness.panel().rows.length, before);
});

test("a session with history shows a placeholder rather than a greeting it is about to replace", async () => {
  const harness = await mount({ deferHistory: true });
  // Opening used to show the welcome block for the length of the round trip and then swap the
  // whole conversation in one frame — the greeting was wrong for a session that has history,
  // and the switch read as a stutter.
  assert.equal(harness.has(".acw-skeleton"), true, "something stands in for the history being fetched");
  assert.equal(harness.visible(".acw-welcome"), false, "the greeting is not shown for a session that may have history");

  await harness.settleHistory([
    { role: "user", content: "Hỗ trợ tôi tính lương", at: "2026-09-11T09:00:00.000Z" },
    { role: "assistant", content: "Em đã kiểm tra kỳ lương.", at: "2026-09-11T09:00:04.000Z" },
  ]);
  assert.equal(harness.has(".acw-skeleton"), false, "the placeholder goes when the real thing arrives");
  assert.equal(harness.has(".acw-message"), true);
});

test("an empty session gets its greeting back, not a placeholder that never resolves", async () => {
  const harness = await mount({ deferHistory: true });
  assert.equal(harness.has(".acw-skeleton"), true);

  await harness.settleHistory([]);
  assert.equal(harness.has(".acw-skeleton"), false);
  // The welcome is hidden rather than removed precisely so this path costs no re-render.
  assert.equal(harness.visible(".acw-welcome"), true, "a session with no history is a session that should be greeted");
});

test("a transport failure it diagnosed itself shows labels.turnInterrupted in the bubble, never the technical detail (A14)", async () => {
  const harness = await mount({
    httpRequest: async () => { throw new TypeError("network down, deliberately, for this test"); },
  });
  await harness.widget.send("Hỗ trợ tôi tính lương");
  const answer = harness.answer();
  // A lost connection is said once by the connection banner; the turn it cut short only says it was
  // cut short, in the product's words, never one transportError bubble per action.
  assert.equal(answer.textContent, "Yêu cầu bị gián đoạn do mất kết nối. Anh/chị gửi lại giúp em.",
    "the product's own interruption label is shown, not the runtime's technical sentence");
  assert.doesNotMatch(answer.textContent, /network down/u, "the technical detail never reaches the chat");
  assert.equal(harness.has(".acw-assistant.acw-error"), true, "the reply row is marked as an error");
});

test("a turn that finishes with no text still says something", async () => {
  const harness = await mount();
  const turn = await harness.start("Hỗ trợ tôi tính lương");
  turn.emit({ type: "activity", activity: { id: "complete", code: "completed", state: "partial" } });
  // The loop returns empty content when the model produced only tool calls, or when its streamed
  // answer was discarded for being mixed with one. A panel that closes over nothing at all is
  // the worst outcome: the user cannot tell the turn from a hang.
  await turn.finish({ content: "", outcome: "partial" });
  // `.acw-bubble` alone proves nothing: the user's own message carries that class too.
  const answer = harness.assistantText();
  // `labels.emptyAnswer` is one neutral sentence for every empty turn (spec §3.7 item 5): the
  // widget no longer composes its own "partial" wording, only the host's single label.
  assert.equal(answer, "<p>Agent đã hoàn tất nhưng không trả về nội dung.</p>", "an empty answer must still render something the user can read");
});

test("a card carrying the reply is not captioned with a sentence saying there was none", async () => {
  const harness = await mount();
  const turn = await harness.start("Tạo bảng lương tháng 8");
  turn.emit({ type: "activity", activity: { id: "complete", code: "completed", state: "done" } });
  // A rich UI payload is the message. The turn has no prose and does not need any.
  await turn.finish({ content: "", ui: { kind: "task-card", title: "Tạo bảng lương nháp" } });
  assert.doesNotMatch(harness.assistantText(), /không trả về nội dung|dừng lại trước khi/u);
});

test("a running turn has no summary line over its work, and a finished one says how long it ran", async () => {
  const harness = await mount();
  const turn = await harness.start("Hỗ trợ tôi tính lương");
  turn.emit(plan(["s1", "Đang kiểm tra dữ liệu chấm công", "in_progress"]));
  // The timeline itself is the account while it is being written; a heading over it only repeats it.
  assert.equal(harness.panel().headed, false);
  assert.equal(harness.panel().open, true);
  assert.deepEqual(harness.panel().timeline, [{ kind: "step", state: "active", text: "Đang kiểm tra dữ liệu chấm công" }],
    "the step being worked on is one muted line, not a card");

  turn.emit(plan(["s1", "Đã kiểm tra dữ liệu chấm công tháng 08/2026", "completed"]));
  turn.emit({ type: "activity", activity: { id: "complete", code: "completed", state: "done" } });
  await turn.finish({ content: "Xong." });
  assert.equal(harness.panel().headed, true);
  assert.match(harness.panel().summary, /^Đã xử lý trong \d+s$/u, "the one fact worth a line once it is done is how long it took");
});

const draft = {
  start: (outputId: string): StreamEvent => ({ type: "assistant-output-start", outputId, audience: "user" }),
  delta: (outputId: string, delta: string): StreamEvent => ({ type: "assistant-output-delta", outputId, audience: "user", delta }),
  end: (outputId: string, status: "completed" | "discarded"): StreamEvent => ({ type: "assistant-output-end", outputId, audience: "user", status }),
};
const activity = (id: string, code: string, state = "active"): StreamEvent => ({ type: "activity", activity: { id, code, state } });
/** Runs every frame the stream has asked for. */
const reveal = (harness: Harness): void => { for (let frame = 0; frame < 40; frame += 1) harness.frame(); };
const inTenMinutes = (): string => new Date(Date.now() + 600_000).toISOString();

// Nothing a model writes is painted before the runtime accepts it: a long answer painted, then withdrawn for review, reads as
// the chat twitching.
test("an answer is never painted while it is written: the bubble says it is being written, and the answer lands whole once accepted", async () => {
  const harness = await mount();
  const turn = await harness.start("Hỗ trợ tôi tính lương");
  const answer = ["Em đã kiểm tra hệ thống.", "- Chưa có bảng lương nào được tạo.", "Kỳ gần nhất là **tháng 08/2026**."].join("\n\n");
  const painted = () => harness.conversation.querySelectorAll(".acw-bubble")
    .some((bubble: StubNode) => !bubble.hidden && /hệ thống|bảng lương nào|08\/2026/u.test(bubble.textContent ?? ""));
  turn.emit(draft.start("out-1"));
  const bubble = harness.answer();
  for (const piece of answer.match(/[\s\S]{1,7}/gu) ?? []) {
    turn.emit(draft.delta("out-1", piece));
    for (let frame = 0; frame < 3; frame += 1) {
      harness.frame();
      assert.equal(painted(), false, "no frame shows any of it before it is accepted");
      assert.equal(bubble.querySelector(".acw-draft-note")?.dataset.kind, "composing");
      assert.equal(bubble.textContent, "Đang soạn câu trả lời…", "the bubble says an answer is being written");
      assert.equal(harness.panel().live.line, "Đang suy nghĩ", "the live line stays in view while the output is open");
    }
  }
  turn.emit(draft.end("out-1", "completed"));
  assert.equal(harness.answer(), bubble, "the same bubble carries the answer");
  assert.equal(bubble.querySelector(".acw-draft-note"), null);
  assert.equal(bubble.innerHTML, "<p>Em đã kiểm tra hệ thống.</p><ul><li>Chưa có bảng lương nào được tạo.</li></ul><p>Kỳ gần nhất là <strong>tháng 08/2026</strong>.</p>",
    "whole, in the frame it was accepted, already formatted");
  await turn.finish({ content: answer });
});

test("a draft the review sends back never shows: the note says the answer is under review, and the accepted one lands in the same bubble", async () => {
  const harness = await mount();
  const turn = await harness.start("Hỗ trợ tôi tính lương");
  turn.emit(plan(["sheets", "Đã tìm thấy 4 bảng lương", "completed"], ["confirm", "Xác nhận kỳ lương", "in_progress"]));
  turn.emit(draft.start("draft-1"), draft.delta("draft-1", "Kỳ 11/2026 chưa có bảng lương."));
  reveal(harness);
  const bubble = harness.answer();
  assert.doesNotMatch(bubble.textContent, /11\/2026/u, "a draft may state facts the review will not accept, so it is not painted");
  assert.equal(bubble.textContent, "Đang soạn câu trả lời…");
  const place = bubble.parentNode?.children.indexOf(bubble);
  const rows = harness.panel().rows.length;

  // The order the backend emits them in: the review is announced, then the draft is withdrawn.
  turn.emit(activity("revision", "revising"), draft.end("draft-1", "discarded"));
  assert.equal(harness.answer(), bubble, "the same bubble carries on");
  assert.equal(bubble.hidden, false, "and it is not hidden");
  assert.equal(bubble.parentNode?.children.indexOf(bubble), place, "nor moved");
  assert.equal(bubble.querySelector(".acw-draft-note")?.dataset.kind, "revising");
  assert.equal(bubble.textContent, "Đang rà soát lại câu trả lời…", "the bubble itself says the answer is under review");
  assert.equal(harness.panel().rows.length, rows, "nothing is appended under the trace");

  // The next attempt starts. Under a plan its rows stand down — the early return that used to leave
  // a trace row for the review spinning until the turn ended.
  turn.emit(activity("analysis", "analyzing"), draft.start("draft-2"));
  assert.equal(bubble.textContent, "Đang rà soát lại câu trả lời…", "the note goes on saying the answer is under review");
  turn.emit(draft.delta("draft-2", "Đơn vị đã có bảng lương 07/2026 và 08/2026."));
  reveal(harness);
  assert.doesNotMatch(bubble.textContent, /08\/2026/u, "the next attempt is not painted while it may still be sent back");
  turn.emit(draft.end("draft-2", "completed"));
  assert.equal(harness.answer(), bubble, "the accepted answer lands in the same bubble");
  assert.equal(bubble.querySelector(".acw-draft-note"), null);
  assert.match(bubble.textContent, /08\/2026/u, "whole, once the runtime accepted it");

  turn.emit(activity("complete", "completed", "done"));
  await turn.finish({ content: "Đơn vị đã có bảng lương 07/2026 và 08/2026." });
  assert.match(bubble.innerHTML, /08\/2026/u);
  const panel = harness.panel();
  assert.equal(panel.rows.some((row) => /rà soát/u.test(row.text)), false, "no ticked row still saying the answer is being reviewed");
  assert.equal(panel.rows.some((row) => row.state === "active"), false, "and nothing left spinning");
  assert.match(panel.summary, /^Đã xử lý trong \d+s$/u, "a revised answer is still a finished turn");
  assert.equal(panel.open, false);
});

// Text written beside a tool call is an output until its step ends; only then does the runtime call it narration
// (spec ux-u2, second trade-off of the hold). So it appears whole at the step's end, never as it is typed.
test("text written beside a tool call is told whole when its step ends; until then the bubble only says an answer is being written", async () => {
  const harness = await mount();
  const turn = await harness.start("Tính lương tháng 8");
  // An output that ends as a bare tool call leaves nothing behind.
  turn.emit(draft.start("unseen"), draft.end("unseen", "discarded"));
  assert.equal(harness.answer().hidden, true);
  assert.equal(harness.answer().querySelector(".acw-draft-note"), null);

  const line = "Em sẽ kiểm tra dữ liệu chấm công trước.";
  const told = () => harness.conversation.querySelectorAll('.acw-timeline .acw-bubble[data-message-kind="narration"]')
    .filter((element: StubNode) => !element.hidden).map((element: StubNode) => element.textContent).join(" ");
  turn.emit(draft.start("beside-call"), draft.delta("beside-call", line));
  reveal(harness);
  const bubble = harness.answer();
  assert.doesNotMatch(`${told()} ${bubble.textContent}`, /kiểm tra dữ liệu/u, "not as it is typed");
  assert.equal(bubble.querySelector(".acw-draft-note")?.dataset.kind, "composing");
  assert.doesNotMatch(bubble.textContent, /rà soát/u, "nothing claims a review that never happened");

  // The step called a tool: the runtime tells the same words as narration under the same id.
  turn.emit(...sayText("beside-call", line), draft.end("beside-call", "discarded"), working("call-1", "active", "Đang đọc dữ liệu chấm công…"));
  reveal(harness);
  assert.equal(told(), line, "told whole, at the end of its step");
  assert.equal(harness.answer(), bubble);
  assert.equal(bubble.hidden, true, "while the tool works the bubble holds nothing; the live line says what runs");
  assert.equal(harness.panel().live.line, "Đang đọc dữ liệu chấm công…");

  turn.emit(working("call-1", "done", "Đang đọc dữ liệu chấm công…"));
  turn.emit(draft.start("answer"), draft.delta("answer", "Tháng 08/2026 có 152 nhân viên đủ công."));
  reveal(harness);
  assert.doesNotMatch(bubble.textContent, /152 nhân viên/u);
  turn.emit(draft.end("answer", "completed"), activity("complete", "completed", "done"));
  assert.equal(harness.answer(), bubble);
  assert.equal(bubble.querySelector(".acw-draft-note"), null);
  assert.match(bubble.textContent, /152 nhân viên/u);
  await turn.finish({ content: "Tháng 08/2026 có 152 nhân viên đủ công." });
  assert.equal(harness.panel().open, false);
});

test("an answer that arrives only with the result replaces the review note in the same bubble", async () => {
  const harness = await mount();
  const turn = await harness.start("Kỳ lương nào chưa có bảng lương?");
  turn.emit(draft.start("draft-1"), draft.delta("draft-1", "Kỳ 11/2026 chưa có bảng lương."));
  reveal(harness);
  const bubble = harness.answer();
  turn.emit(activity("revision", "revising"), draft.end("draft-1", "discarded"));
  // The policy's own safe answer ends the turn. It is never streamed, only returned.
  turn.emit(activity("complete", "completed", "partial"));
  await turn.finish({ content: "Dữ liệu chỉ ghi nhận kỳ 08/2026.", outcome: "partial" });
  assert.equal(harness.panel().open, false, "the account folds once the turn's answer is in");
  assert.equal(harness.answer(), bubble);
  assert.equal(bubble.hidden, false);
  assert.match(bubble.innerHTML, /08\/2026/u);
  assert.doesNotMatch(bubble.innerHTML, /11\/2026/u, "the draft never reached the screen");
  assert.equal(bubble.querySelector(".acw-draft-note"), null, "the note does not outlive the answer it stood in for");
  assert.equal(harness.panel().summary, "Đã dừng khi chưa hoàn tất");
});

test("a retry stops spinning once work resumes, and is kept in the past tense", async () => {
  const harness = await mount();
  const turn = await harness.start("Hỗ trợ tôi tính lương");
  turn.emit(plan(["confirm", "Xác nhận kỳ lương cần tính", "in_progress"]));
  turn.emit(activity("retry", "retrying"));
  assert.ok(flat(harness.panel().timeline).some((entry) => entry.kind === "notice" && entry.state === "active" && entry.text === "Đang thử lại…"),
    "a retry is recorded where it happened, under the step being carried out");
  assert.equal(harness.panel().live.call, "Đang thử lại…", "and while it waits, the line under the step says so");

  // Nothing on the wire says a retry is over; the next attempt just starts.
  turn.emit(activity("analysis", "analyzing"));
  assert.deepEqual(flat(harness.panel().timeline).find((entry) => entry.kind === "notice"), { kind: "notice", state: "done", text: "Đã thử lại" },
    "the retry is over once the next attempt starts, and the line says it happened rather than that it is happening");

  // A reconnect announces itself the same way, and nothing ever follows it either.
  turn.emit(activity("transport-reconnect", "retrying"));
  turn.emit(activity("complete", "completed", "done"));
  await turn.finish();
  const timeline = flat(harness.panel().timeline);
  assert.equal(timeline.some((entry) => /Đang thử lại/u.test(entry.text)), false, "a finished turn keeps no line saying it is retrying");
  assert.equal(timeline.some((entry) => entry.state === "active"), false);
});

test("the trace collapses however the turn ends, with what the turn produced below it", async () => {
  const answer = "Đơn vị đã có bảng lương 08/2026.";
  const answered = (harness: Harness) => !harness.answer().hidden && harness.answer().innerHTML.includes("08/2026");
  const endings: readonly { readonly name: string; end(turn: Turn): Promise<void>; readonly summary: RegExp; shows(harness: Harness): boolean; readonly waits?: boolean; readonly stops?: boolean }[] = [
    {
      name: "completed",
      async end(turn) { turn.emit(draft.end("o1", "completed"), activity("complete", "completed", "done")); await turn.finish({ content: answer }); },
      summary: /^Đã xử lý trong \d+s$/u, shows: answered,
    },
    {
      name: "completed with no closing progress event",
      async end(turn) { await turn.finish({ content: answer }); },
      summary: /^Đã xử lý trong \d+s$/u, shows: answered,
    },
    {
      name: "partial",
      async end(turn) { turn.emit(draft.end("o1", "completed"), activity("complete", "completed", "partial")); await turn.finish({ content: answer, outcome: "partial" }); },
      summary: /^Đã dừng khi chưa hoàn tất$/u, shows: answered,
    },
    {
      name: "failed",
      async end(turn) { turn.emit(activity("complete", "failed", "partial")); await turn.fail("Không thể hoàn tất yêu cầu lúc này."); },
      summary: /^Đã kết thúc xử lý$/u,
      shows: (harness) => !harness.answer().hidden && harness.answer().textContent.includes("Không thể hoàn tất"),
    },
    {
      name: "awaiting approval",
      async end(turn) {
        turn.emit(draft.end("o1", "discarded"), activity("complete", "completed", "done"));
        await turn.finish({ content: "", outcome: "awaiting_approval", approval: {
          sessionId: turn.sessionId, approvalId: "approval-1", turnId: "turn-1", toolId: "sample-app.payroll/create-draft",
          sideEffect: "nonIdempotent", expiresAt: inTenMinutes(),
        } });
      },
      summary: /^Đã xử lý trong \d+s$/u, shows: (harness) => harness.visible(".acw-approval"), waits: true,
    },
    {
      name: "awaiting an answer from the user",
      async end(turn) {
        turn.emit(draft.end("o1", "discarded"), activity("complete", "completed", "done"));
        await turn.finish({ content: "", outcome: "awaiting_interaction", interaction: {
          kind: "form", sessionId: turn.sessionId, interactionId: "interaction-1", turnId: "turn-1", toolId: "sample-app.payroll/ask",
          requesterId: "sample-app", message: "Anh/chị chọn giúp em kỳ lương cần tính.", expiresAt: inTenMinutes(),
          // A choice, not free text: the stub has no HTMLInputElement for a text field to be checked against.
          requestedSchema: { type: "object", properties: { period: { type: "string", title: "Kỳ lương", enum: ["07/2026", "08/2026"] } } },
        } });
      },
      summary: /^Đã xử lý trong \d+s$/u, shows: (harness) => harness.visible(".acw-interaction"), waits: true,
    },
    {
      // A stop is not a failure and not finished work: it stays
      // open with one neutral line, and the answer still being gathered, never shown, shows nothing.
      name: "stopped by the user",
      async end(turn) { await turn.cancel(); },
      summary: /^$/u, stops: true,
      shows: (harness) => !harness.answer().hidden && harness.answer().textContent.trim() === "Đã dừng xử lý theo yêu cầu.",
    },
  ];
  for (const ending of endings) {
    const harness = await mount();
    const turn = await harness.start("Tính lương tháng 8");
    turn.emit(plan(["confirm", "Xác nhận kỳ lương", "in_progress"]), draft.start("o1"), draft.delta("o1", answer));
    reveal(harness);
    assert.equal(harness.panel().open, true, `${ending.name}: the trace is open while the turn runs`);
    await ending.end(turn);
    const panel = harness.panel();
    if (ending.waits) {
      // Waiting on the user is not finished work: it folds with the turn the decision resumes.
      assert.equal(panel.open, true, `${ending.name}: a turn waiting on the user stays open above its card`);
      assert.equal(panel.headed, false, `${ending.name}: with no summary line to fold under`);
      assert.equal(panel.thinking, false, `${ending.name}: and nothing saying it is still thinking`);
    } else if (ending.stops) {
      assert.equal(panel.open, true, `${ending.name}: what the turn showed stays open`);
      assert.equal(panel.headed, false, `${ending.name}: with no summary line to fold under`);
      assert.equal(harness.has(".acw-error"), false, `${ending.name}: and nothing on it reads as a failure`);
    } else {
      assert.equal(panel.open, false, `${ending.name}: the trace collapses to its summary line`);
      assert.match(panel.summary, ending.summary, `${ending.name}: the summary says how the turn ended`);
    }
    assert.equal(panel.timeline.some((entry) => entry.state === "active"), false, `${ending.name}: no line is left running`);
    assert.ok(ending.shows(harness), `${ending.name}: what the turn produced is visible below the trace`);
    assert.equal(harness.answer().querySelector(".acw-draft-note"), null, `${ending.name}: no note outlives the turn`);
    assert.equal(panel.rows.some((row) => row.state === "active"), false, `${ending.name}: nothing is left spinning`);
  }
});

test("TeX arrows a model writes into a menu path render as the characters they mean", async () => {
  const harness = await mount();
  const turn = await harness.start("mở vào a xem đi");
  // A model writes TeX arrows into a menu path; the renderer is Markdown, and dollar signs in a
  // menu path are not something a reader should have to decode.
  await turn.finish({ content: "Anh/chị vào menu **Tiền lương** $\\rightarrow$ **Quản lý bảng lương**, rồi chọn bảng lương tháng 08/2026 ($\\times$ 2 bảng)." });
  const html = harness.assistantText();
  assert.match(html, /Tiền lương<\/strong> → <strong>Quản lý bảng lương/u);
  assert.match(html, /× 2 bảng/u);
  assert.doesNotMatch(html, /rightarrow|times|\$/u);
});

test("a math span a model writes into a report reads as text; a dollar amount and code keep what was written", async () => {
  const harness = await mount();
  const turn = await harness.start("đối soát");
  // A report's close-the-sum line written as a math span must not show as raw TeX.
  await turn.finish({ content: "**Kiểm khép** $\\text{Tổng chênh} \\approx \\text{Thiếu BHXH} + 38\\text{tr} - \\dots \\approx 35,7\\text{tr VNĐ}$\n\n"
    + "Tổng: $$\\frac{a}{b} = \\mathbf{19.390.140đ}$$\n\nGiá $5 và $7 giữ nguyên; mã `$\\alpha$` giữ nguyên." });
  const html = harness.assistantText();
  assert.match(html, /Tổng chênh ≈ Thiếu BHXH \+ 38tr - … ≈ 35,7tr VNĐ/u);
  assert.match(html, /a\/b = <strong>19\.390\.140đ<\/strong>/u);
  assert.match(html, /Giá \$5 và \$7 giữ nguyên/u, "an amount with no TeX command stays");
  assert.match(html, /<code>\$\\alpha\$<\/code>/u, "code keeps what the model wrote");
  assert.doesNotMatch(html, /\\text|\\approx|\\frac/u);
});

test("a list item indented under another is its child, and a numbered list keeps counting across what sits between", async () => {
  const harness = await mount();
  const turn = await harness.start("dựng danh mục");
  // Twelve groups and their tasks used to come out as one column of bullets, parents and children
  // at the same depth: the renderer took every marker for an item of one flat list.
  await turn.finish({ content: [
    "- **Sự nghiệp y tế**", "  - Khám chữa bệnh", "    - Chi lương", "  - Phòng bệnh", "- **Đảm bảo xã hội**", "  1. Trợ cấp hằng tháng",
    "", "1. Đọc biểu", "- ghi chú", "2. Ghi danh mục",
  ].join("\n") });
  const html = harness.assistantText();
  assert.match(html, /<ul><li><strong>Sự nghiệp y tế<\/strong><ul><li>Khám chữa bệnh<ul><li>Chi lương<\/li><\/ul><\/li><li>Phòng bệnh<\/li><\/ul><\/li><li><strong>Đảm bảo xã hội<\/strong><ol><li>Trợ cấp hằng tháng<\/li><\/ol><\/li><\/ul>/u,
    "children sit inside their parent's item, and coming back out lands on the right level");
  assert.match(html, /<ol><li>Đọc biểu<\/li><\/ol><ul><li>ghi chú<\/li><\/ul><ol start="2"><li>Ghi danh mục<\/li><\/ol>/u,
    "a numbered list that resumes says 2, not 1 again");
});

test("a pipe table renders as a table, figures on the right where the rule says so", async () => {
  const harness = await mount();
  const turn = await harness.start("tóm tắt danh mục");
  // A summary by lĩnh vực is what stands in for a list of 122 rows; as a paragraph of pipes it was unreadable.
  await turn.finish({ content: ["Em đã dựng xong:", "", "| Lĩnh vực | Số nhiệm vụ |", "|---|---:|", "| **Sự nghiệp y tế** | 7 |", "| Đảm bảo xã hội | 12 |", "", "Còn 2 chỗ cần xem."].join("\n") });
  const html = harness.assistantText();
  assert.match(html, /<table><thead><tr><th class="acw-cell-nowrap">Lĩnh vực<\/th><th class="acw-cell-figure">Số nhiệm vụ<\/th><\/tr><\/thead><tbody><tr><td class="acw-cell-phrase"><strong>Sự nghiệp y tế<\/strong><\/td><td class="acw-cell-figure">7<\/td><\/tr><tr><td class="acw-cell-phrase">Đảm bảo xã hội<\/td><td class="acw-cell-figure">12<\/td><\/tr><\/tbody><\/table>/u,
    "a row label several words long keeps a minimum width instead of one word a line");
  assert.match(html, /<p>Em đã dựng xong:<\/p>.*<p>Còn 2 chỗ cần xem\.<\/p>/su, "what stands around the table is still prose");
  assert.doesNotMatch(html, /\|/u, "no pipe reaches the screen");
});

test("a multiplication sign in a formula stays a multiplication sign, bold or not", async () => {
  const harness = await mount();
  const turn = await harness.start("công thức ô F24");
  // Seen on screen as "ROUND(D24F24+E24,0)*": the `*` inside the bold formula was taken for the
  // start of italics, so the multiplication sign vanished and a stray asterisk was left behind.
  await turn.finish({ content: [
    "Công thức: **ROUND(D24*F24+E24,0)**",
    "",
    "Trong câu: a*b*c, 2*3=6 và D24 * F24; **đậm có a*b** chứa *, rồi `=SUM(A1:A9)*2` và **`H24*0,08`**.",
    "",
    "Còn lại *nghiêng*, __đậm__ và =A1*(B1+C1)*2 hay (A1)*(B1)*(C1).",
  ].join("\n") });
  const html = harness.assistantText();
  assert.match(html, /Công thức: <strong>ROUND\(D24\*F24\+E24,0\)<\/strong>/u);
  assert.match(html, /a\*b\*c, 2\*3=6 và D24 \* F24; <strong>đậm có a\*b<\/strong> chứa \*, rồi <code>=SUM\(A1:A9\)\*2<\/code> và <strong><code>H24\*0,08<\/code><\/strong>\./u);
  assert.match(html, /<em>nghiêng<\/em>, <strong>đậm<\/strong> và =A1\*\(B1\+C1\)\*2 hay \(A1\)\*\(B1\)\*\(C1\)\./u);
  assert.equal(html.match(/<em>/gu)?.length, 1, "only the one word meant as italics is italic");
});

test("a host that starts a task on a fresh session never gets the old conversation above it, and can prefill and watch the composer", async () => {
  // The panel is open and the previous session's history is still on its way when the host's
  // button replaces the session — one click on "Tính tự động" right after opening the widget.
  const harness = await mount({ deferHistory: true });
  harness.widget.newSession();
  await harness.settleHistory([
    { role: "user", content: "câu của phiên cũ", at: "2026-09-01T00:00:00.000Z" },
    { role: "assistant", content: "trả lời của phiên cũ", at: "2026-09-01T00:00:01.000Z" },
  ]);
  assert.equal(harness.has(".acw-user"), false, "the old session's messages must not render into the new one");
  assert.equal(harness.has(".acw-welcome"), true, "the new session shows its greeting");

  harness.widget.setDraft("Tính lương tháng 09/2026");
  assert.equal(harness.draft(), "Tính lương tháng 09/2026", "a prefill lands in the composer and sends nothing");
  assert.equal(harness.has(".acw-user"), false);

  assert.equal(harness.widget.isPending(), false);
  const turn = await harness.start("Tính lương tháng 09/2026");
  assert.equal(harness.widget.isPending(), true, "a host can tell a running turn apart before starting another");
  await turn.finish();
  assert.equal(harness.widget.isPending(), false);
});

const narration = {
  start: (narrationId: string): StreamEvent => ({ type: "assistant-narration-start", narrationId, audience: "user" }),
  delta: (narrationId: string, delta: string): StreamEvent => ({ type: "assistant-narration-delta", narrationId, audience: "user", delta }),
  end: (narrationId: string, status: "completed" | "discarded" = "completed"): StreamEvent =>
    ({ type: "assistant-narration-end", narrationId, audience: "user", status }),
};

test("narration, the work it announced and the answer appear in the order they happened, then fold under one line", async () => {
  const harness = await mount();
  const turn = await harness.start("Tính lương tháng 8");
  assert.equal(harness.panel().thinking, true, "before anything else, the turn says it is thinking");
  assert.deepEqual(harness.panel().timeline, []);
  assert.equal(harness.panel().headed, false, "with no heading, card or border around it");

  turn.emit(narration.start("n1"), narration.delta("n1", "Mình sẽ kiểm tra bảng công trước."));
  assert.deepEqual(harness.panel().timeline.map((entry) => entry.kind), ["narration"], "the agent telling the user what it is doing is chat text in the turn");
  assert.match(harness.panel().timeline[0]?.text ?? "", /kiểm tra bảng công/u, "and it streams as it is written");
  assert.equal(harness.panel().thinking, true, "and the line above it goes on saying the turn is at work: the narration is under it, not instead of it");
  turn.emit(narration.end("n1"));

  turn.emit(working("call-1", "active", "Đang lấy dữ liệu bảng công…"));
  assert.deepEqual(harness.panel().timeline[1], { kind: "work", state: "active", text: "Đang lấy dữ liệu bảng công…" },
    "the work it announced goes directly below it");
  assert.equal(harness.panel().thinking, false, "a running line is its own sign of life");
  // The runtime's own `tool-completed` label is what the line shows once it is done — nothing
  // here transforms "Đang" into "Đã" any more; that is the runtime's wording to choose.
  turn.emit(working("call-1", "done", "Đã lấy dữ liệu bảng công"));
  assert.deepEqual(harness.panel().timeline[1], { kind: "work", state: "done", text: "Đã lấy dữ liệu bảng công" });
  assert.equal(harness.panel().thinking, true, "between steps the turn goes back to saying it is thinking");

  turn.emit(narration.start("n2"), narration.delta("n2", "Tiếp theo em đối chiếu thông tin nhân sự."), narration.end("n2"));
  turn.emit(working("call-2", "active", "Đang đối chiếu thông tin nhân sự…"));
  turn.emit(plan(["s1", "Đã lấy dữ liệu bảng công", "completed"], ["s2", "Đối chiếu thông tin nhân sự", "in_progress"]));
  // The call started before the plan was told and ends after it: it closes its own line, not a new one.
  turn.emit(working("call-2", "done", "Đã đối chiếu thông tin nhân sự"));
  assert.deepEqual(harness.panel().timeline.map(({ kind, state, text }) => kind === "narration" ? [kind] : [kind, state, text]), [
    ["narration"],
    ["work", "done", "Đã lấy dữ liệu bảng công"],
    ["narration"],
    ["work", "done", "Đã đối chiếu thông tin nhân sự"],
    ["step", "done", "Đã lấy dữ liệu bảng công"],
    ["step", "active", "Đối chiếu thông tin nhân sự"],
  ], "each stretch of work sits under the narration that announced it, and steps appear when the plan reaches them");

  turn.emit(draft.start("answer"), draft.delta("answer", "Tháng 08/2026 có 152 nhân viên đủ công."));
  reveal(harness);
  assert.equal(harness.answer().hidden, false, "the answer streams as normal text at the end");
  assert.equal(harness.panel().live.line, "Đối chiếu thông tin nhân sự", "under a line that stays where it is until the turn is over: it does not blink out and back");
  assert.equal(harness.panel().open, true, "and the timeline stays in view above it while the turn runs");

  turn.emit(draft.end("answer", "completed"), activity("complete", "completed", "done"));
  await turn.finish({ content: "Tháng 08/2026 có 152 nhân viên đủ công." });
  const panel = harness.panel();
  assert.equal(panel.open, false, "everything before the answer folds away");
  assert.equal(panel.headed, true);
  assert.match(panel.summary, /^Đã xử lý trong \d+s$/u);
  assert.equal(panel.thinking, false, "and nothing is left saying it is thinking");
  assert.deepEqual(panel.timeline.map((entry) => entry.kind), ["narration", "work", "narration", "work", "step", "step"],
    "opened again, it is the account exactly as it happened");
  assert.match(harness.answer().innerHTML, /152 nhân viên/u, "only the answer stays in view");
  const row = harness.answer().parentNode;
  assert.ok(row && row.children.indexOf(row.querySelector(".acw-thinking")!) < row.children.indexOf(harness.answer()),
    "the folded line sits above the answer, not inside or below it");
});

test("the fold runs the account's height down before closing it, unless motion is reduced", async () => {
  interface FakeAnimation { readonly keyframes: unknown; cancelled: boolean; finish(): void }
  const animations: FakeAnimation[] = [];
  const prototype = StubNode.prototype as unknown as { animate?: (keyframes: unknown) => unknown };
  // The stub has no animation engine. This one records what was asked for, and finishes on demand.
  prototype.animate = (keyframes: unknown) => {
    const listeners: (() => void)[] = [];
    const animation = {
      keyframes, cancelled: false,
      addEventListener: (_type: string, listener: () => void) => { listeners.push(listener); },
      cancel() { animation.cancelled = true; },
      finish() { for (const listener of listeners) listener(); },
    };
    animations.push(animation);
    return animation;
  };
  try {
    const harness = await mount();
    const turn = await harness.start("Tính lương tháng 8");
    turn.emit(working("call-1", "active", "Đang lấy dữ liệu bảng công…"), working("call-1", "done", "Đang lấy dữ liệu bảng công…"));
    harness.foldBody().offsetHeight = 120;
    turn.emit(activity("complete", "completed", "done"));
    await turn.finish({ content: "Xong." });
    assert.equal(animations.length, 1, "the fold is animated");
    assert.deepEqual(JSON.parse(JSON.stringify(animations[0]?.keyframes)), [
      { height: "120px", opacity: 1 }, { opacity: 0, offset: 0.35 }, { height: "0px", opacity: 0, paddingTop: "0px", paddingBottom: "0px" },
    ], "the words fade out well before the box closes, so nothing half-clipped lingers under the summary");
    assert.equal(harness.panel().open, true, "the account stays open while its height runs down, so the answer rises with it");
    const fold = harness.folds().at(-1);
    assert.equal(fold?.dataset.folding, "true", "the chevron turns to folded the moment folding starts, not when it ends");
    assert.equal(fold?.querySelector("summary")?.getAttribute("aria-expanded"), "false", "and so does what assistive technology is told");
    const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
    assert.match(source, /\[data-folding="true"\] > summary > \.acw-chevron \{ transform: rotate\(-90deg\)/u);
    animations[0]?.finish();
    assert.equal(harness.panel().open, false, "and closes once the fold has run");
    assert.equal(fold?.dataset.folding, undefined);
    assert.equal(animations[0]?.cancelled, true, "releasing the held height, so opening it again shows everything");

    const still = await mount({ reducedMotion: true });
    const other = await still.start("Tính lương tháng 8");
    other.emit(working("call-1", "active", "Đang lấy dữ liệu bảng công…"), working("call-1", "done", "Đang lấy dữ liệu bảng công…"));
    still.foldBody().offsetHeight = 120;
    other.emit(activity("complete", "completed", "done"));
    await other.finish({ content: "Xong." });
    assert.equal(animations.length, 1, "with reduced motion nothing animates");
    assert.equal(still.panel().open, false, "it simply closes");
  } finally {
    delete prototype.animate;
  }
});

test("a past turn whose history kept its narration comes back folded, with only the answer in view", async () => {
  const harness = await mount({ deferHistory: true });
  await harness.settleHistory([
    { role: "user", content: "Chào em", at: "2026-09-11T08:59:00.000Z" },
    { role: "assistant", content: "Dạ, em chào anh/chị.", at: "2026-09-11T08:59:02.000Z" },
    { role: "user", content: "Tính lương tháng 8", at: "2026-09-11T09:00:00.000Z" },
    { role: "assistant", content: "Em đã tạo bảng lương nháp tháng 08/2026.", at: "2026-09-11T09:00:21.000Z",
      narrations: [{ id: "n-1", audience: "user", content: "Mình sẽ kiểm tra bảng công trước." }] },
  ]);
  assert.equal(harness.count(".acw-thinking"), 1, "a turn with nothing but its answer keeps today's plain rendering");
  const panel = harness.panel();
  assert.equal(panel.open, false);
  assert.equal(panel.headed, true);
  // How long it took is not in history, and a duration made up at load time would be false.
  assert.equal(panel.summary, "Quy trình xử lý");
  assert.deepEqual(panel.timeline.map((entry) => [entry.kind, entry.text]), [["narration", "Mình sẽ kiểm tra bảng công trước."]]);
  assert.match(harness.answer().innerHTML, /bảng lương nháp/u);
  assert.equal(harness.answer().hidden, false);
});

test("a completed turn rebuilt from history shows how long it took, from work.durationMs, exactly like a live one would", async () => {
  const harness = await mount({ deferHistory: true });
  await harness.settleHistory([
    { role: "user", content: "Tính lương tháng 8", at: "2026-09-11T09:00:00.000Z" },
    { role: "assistant", content: "Đã tạo bảng lương nháp tháng 08/2026.", at: "2026-09-11T09:00:21.000Z", status: "completed",
      work: { durationMs: 21_400, tools: [], plan: { planId: "p1", state: "completed",
        steps: [{ id: "s1", description: "Đã tạo bảng lương nháp", status: "completed" }] } } },
  ]);
  assert.equal(harness.panel().summary, "Đã xử lý trong 21s", "reload reads the same duration a live turn would have folded into");
});

test("reload of a turn awaiting a question shows its in-progress step once — on the live line, not again as a checklist row", async () => {
  const harness = await mount({ deferHistory: true });
  await harness.settleHistory([
    { role: "user", content: "Tính lương tháng 8", at: "2026-09-11T09:00:00.000Z" },
    { role: "assistant", content: "", at: "2026-09-11T09:00:05.000Z", status: "awaiting_interaction",
      work: { tools: [], plan: { planId: "p1", state: "awaiting_user", steps: [
        { id: "s1", description: "Đã đọc tổng quan kỳ lương", status: "completed" },
        { id: "s2", description: "Xác định kỳ lương đang làm việc và hồ sơ nhân viên Huy", status: "in_progress" },
      ] } } },
  ]);
  const body = harness.foldBody();
  const checklistStep = body.querySelectorAll(".acw-check-step").find((node: StubNode) => node.dataset.stepId === "s2");
  assert.ok(checklistStep, "the in-progress step is on the checklist, ready to show once the turn actually folds");
  assert.equal(checklistStep!.hidden, true, "but not shown yet — the turn only paused to ask, it did not finish");
  const live = harness.panel().live;
  assert.equal(live.line, "Xác định kỳ lương đang làm việc và hồ sơ nhân viên Huy", "the live line is the one place it is told");
  assert.equal(live.lines, 1, "never a second line for the same step");
});

const approvalFor = (sessionId: string) => ({
  sessionId, approvalId: "approval-1", turnId: "turn-1", toolId: "sample-app.payroll/create-draft",
  sideEffect: "nonIdempotent", expiresAt: inTenMinutes(),
});
/** A folded account's checklist and tool-call lines, in document order: each step, then the work under it. */
const lines = (fold: StubNode | undefined) =>
  // The stub's selector matching has no `:not()`; a plan step is also `.acw-thinking-item`
  // (`#addStep`), so one query finds both kinds and the branch below tells them apart.
  fold?.querySelectorAll(".acw-thinking-item").map((line: StubNode) => line.classList.contains("acw-check-step")
    ? ["step", line.dataset.state, line.querySelector(".acw-check-label")?.textContent]
    : ["work", line.dataset.state, line.textContent]);

test("a folded account is collapsed by default, and the summary line is what opens it", async () => {
  const harness = await mount();
  const first = await harness.start("Hỗ trợ tôi tính lương");
  first.emit(working("call-1", "active", "Đang tổng hợp tình hình kỳ lương…"), working("call-2", "active", "Đang xem các bảng lương gần đây…"));
  first.emit(working("call-1", "done", "Đã tổng hợp tình hình kỳ lương"), working("call-2", "done", "Đã xem các bảng lương gần đây"));
  first.emit(activity("complete", "completed", "done"));
  await first.finish({ content: "", outcome: "awaiting_approval", approval: approvalFor(first.sessionId) });

  const resumed = await harness.approve();
  resumed.emit(working("call-3", "active", "Đang đối chiếu lại dữ liệu vừa ghi…"), working("call-4", "active", "Đang kiểm tra thiếu công…"));
  resumed.emit(working("call-3", "done", "Đã đối chiếu lại dữ liệu vừa ghi"), working("call-4", "done", "Đã kiểm tra thiếu công"));
  resumed.emit(narration.start("n1"), narration.delta("n1", "Em kiểm tra thêm dữ liệu công."), narration.end("n1"));
  resumed.emit(working("call-5", "active", "Đang lấy dữ liệu bảng công…"), working("call-6", "active", "Đang xem danh sách phòng ban…"));
  resumed.emit(working("call-5", "done", "Đã lấy dữ liệu bảng công"), working("call-6", "done", "Đã xem danh sách phòng ban"));
  resumed.emit(activity("complete", "completed", "done"));
  await resumed.finish({ content: "Dữ liệu công tháng 8/2026 đã sẵn sàng." });

  const [pausedFold, resumedFold] = harness.folds();
  assert.equal(harness.folds().length, 2, "the turn that stopped for the approval, and the turn it resumed into");
  assert.deepEqual([pausedFold?.open, resumedFold?.open], [false, false], "both fold once the resumed work is done");
  // Neither the user nor anything else opened these; the summary line — not a per-line
  // disclosure — is what a browser opens onto the checklist.
  assert.deepEqual(lines(pausedFold), [
    ["work", "done", "Đã tổng hợp tình hình kỳ lương"], ["work", "done", "Đã xem các bảng lương gần đây"],
  ], "the turn that stopped for the approval keeps its own tool calls");
  assert.deepEqual(lines(resumedFold), [
    ["work", "done", "Đã đối chiếu lại dữ liệu vừa ghi"], ["work", "done", "Đã kiểm tra thiếu công"],
    ["work", "done", "Đã lấy dữ liệu bảng công"], ["work", "done", "Đã xem danh sách phòng ban"],
  ], "the resumed turn's own tool calls, each its own line, in the order they ran");
});

test("a turn waiting on an approval stays open above its card, and folds with the turn the decision resumes", async () => {
  const harness = await mount();
  const first = await harness.start("Hỗ trợ tôi tính lương");
  first.emit(plan(["read", "Đang đọc tổng quan kỳ lương", "in_progress"], ["create", "Tạo bảng tổng hợp ngày công", "pending"]));
  first.emit(working("call-1", "active", "Đang tổng hợp tình hình kỳ lương…"), working("call-1", "done", "Đã tổng hợp tình hình kỳ lương"));
  first.emit(plan(["read", "Đã đọc tổng quan: 4 bảng lương tháng 7/2026 đã khóa", "completed"], ["create", "Tạo bảng tổng hợp ngày công", "in_progress"]));
  first.emit(activity("complete", "completed", "done"));
  await first.finish({ content: "", outcome: "awaiting_approval", approval: approvalFor(first.sessionId) });

  let panel = harness.panel();
  assert.equal(panel.open, true, "waiting on a decision is not finished work: the account stays in view");
  assert.equal(panel.headed, false, "with no summary line to fold it under");
  assert.equal(panel.thinking, false, "nothing says it is still thinking");
  assert.deepEqual(panel.timeline, [
    { kind: "step", state: "done", text: "Đã đọc tổng quan: 4 bảng lương tháng 7/2026 đã khóa", rows: [{ kind: "work", state: "done", text: "Đã tổng hợp tình hình kỳ lương" }] },
    { kind: "step", state: "paused", text: "Tạo bảng tổng hợp ngày công" },
  ], "and nothing is left running");
  // Paused, it keeps its live view: the line settled on the step it stopped in, and the plan sentence.
  assert.deepEqual(panel.shown, ["plan", "live"], "not the checklist: the turn has not folded");
  assert.equal(panel.live.sentence, "Em sẽ đọc tổng quan kỳ lương rồi tạo bảng tổng hợp ngày công.");
  assert.deepEqual([panel.live.line, panel.live.state, panel.live.call], ["Tạo bảng tổng hợp ngày công", "settled", ""],
    "the line rests on the step it stopped in, without shimmer, and nothing under it claims to be running");
  assert.equal(harness.visible(".acw-approval"), true, "the card sits under it");

  const resumed = await harness.approve();
  resumed.emit(plan(
    ["read", "Đã đọc tổng quan: 4 bảng lương tháng 7/2026 đã khóa", "completed"],
    ["create", "Đã tạo bảng tổng hợp ngày công tháng 8/2026", "completed"],
    ["report", "Báo hiện trạng dữ liệu công", "in_progress"],
  ));
  const [pausedFold, resumedFold] = harness.folds();
  assert.deepEqual(lines(pausedFold), [
    ["step", "done", "Đã đọc tổng quan: 4 bảng lương tháng 7/2026 đã khóa"],
    ["work", "done", "Đã tổng hợp tình hình kỳ lương"],
    ["step", "paused", "Tạo bảng tổng hợp ngày công"],
  ], "the paused turn keeps what it said when it stopped: the step it paused in stays paused");
  assert.deepEqual(lines(resumedFold), [
    ["step", "done", "Đã tạo bảng tổng hợp ngày công tháng 8/2026"],
    ["step", "active", "Báo hiện trạng dữ liệu công"],
  ], "the resumed turn tells the step it carried on and the one it reached, each its own entry");
  assert.equal(pausedFold?.open, true, "the paused account stays open while the resumed work runs");

  resumed.emit(draft.start("answer"), draft.delta("answer", "Dữ liệu công tháng 8/2026 đã sẵn sàng."), draft.end("answer", "completed"));
  resumed.emit(plan(
    ["read", "Đã đọc tổng quan: 4 bảng lương tháng 7/2026 đã khóa", "completed"],
    ["create", "Đã tạo bảng tổng hợp ngày công tháng 8/2026", "completed"],
    ["report", "Đã báo hiện trạng dữ liệu công", "completed"],
  ));
  resumed.emit(activity("complete", "completed", "done"));
  await resumed.finish({ content: "Dữ liệu công tháng 8/2026 đã sẵn sàng." });
  assert.deepEqual([pausedFold?.open, resumedFold?.open], [false, false], "when the resumed work really ends, both accounts fold");
  assert.deepEqual([pausedFold?.dataset.complete, resumedFold?.dataset.complete], ["true", "true"], "each under its own summary line");
  panel = harness.panel();
  assert.match(panel.summary, /^Đã xử lý trong \d+s$/u);
  assert.equal(harness.visible(".acw-approval"), true, "the card stays in view");
  assert.equal(harness.has(".acw-approval-status"), true);
  assert.match(harness.answer().innerHTML, /đã sẵn sàng/u, "and so does the answer");
});

const sayText = (id: string, text: string) => [narration.start(id), narration.delta(id, text), narration.end(id)];
const toolCall = (callId: string, label: string, workStepId?: string) => [
  { type: "tool-started", callId, label, ...(workStepId ? { workStepId } : {}) },
  { type: "tool-completed", callId, label, status: "succeeded" },
];

test("work stays in the turn that ran it: a continuation gets its own entry of the step, and the paused turn keeps its own", async () => {
  const harness = await mount();
  const first = await harness.start("Đối soát");
  first.emit(plan(["s1", "Đọc màn hình và tệp", "in_progress"], ["s2", "Đối chiếu", "pending"]));
  first.emit(...toolCall("c0", "Đã đọc màn hình hiện tại", "s1"));
  first.emit(activity("complete", "completed", "awaiting"));
  await first.finish({ content: "", outcome: "awaiting_approval", approval: approvalFor(first.sessionId) });

  const second = await harness.approve();
  assert.equal(harness.panel().live.line, "Đọc màn hình và tệp", "the continuation names the step from its first frame");
  second.emit(plan(["s1", "Đọc màn hình và tệp", "in_progress"], ["s2", "Đối chiếu", "pending"]));
  second.emit(...sayText("n1", "Em đọc các sheet."), ...toolCall("c1", "Đã đọc tệp", "s1"), ...toolCall("c2", "Đã đọc lại màn hình", "s1"));
  second.emit(activity("complete", "completed", "done"));
  await second.finish({ content: "Xong." });

  const [pausedFold, resumedFold] = harness.folds();
  assert.deepEqual(lines(pausedFold), [
    ["step", "paused", "Đọc màn hình và tệp"], ["work", "done", "Đã đọc màn hình hiện tại"],
  ], "the paused turn lists only the work it ran, and its step stays paused");
  assert.deepEqual(lines(resumedFold), [
    ["step", "paused", "Đọc màn hình và tệp"], ["work", "done", "Đã đọc tệp"], ["work", "done", "Đã đọc lại màn hình"],
  ], "the continuation lists its own entry of the step with the work it ran, in order");
  assert.equal(resumedFold?.querySelectorAll(".acw-bubble").length, 1, "and its narration");
});

test("the step a continuation carried on to its end is finished in the continuation, and the paused turn still says paused", async () => {
  const harness = await mount();
  const first = await harness.start("Đối soát");
  first.emit(plan(["s1", "Đọc tệp", "in_progress"], ["s2", "Đối chiếu", "pending"]));
  first.emit(activity("complete", "completed", "awaiting"));
  await first.finish({ content: "", outcome: "awaiting_approval", approval: approvalFor(first.sessionId) });
  const second = await harness.approve();
  second.emit(plan(["s1", "Đã đọc tệp", "completed"], ["s2", "Đối chiếu", "in_progress"]));
  second.emit(...toolCall("c1", "Đã đối chiếu", "s2"));
  second.emit(plan(["s1", "Đã đọc tệp", "completed"], ["s2", "Đã đối chiếu", "completed"]));
  second.emit(activity("complete", "completed", "done"));
  await second.finish({ content: "Xong." });
  const [pausedFold, resumedFold] = harness.folds();
  assert.deepEqual(lines(pausedFold), [["step", "paused", "Đọc tệp"]], "the forecast it never reached moved to the turn that reached it");
  assert.deepEqual(lines(resumedFold), [
    ["step", "done", "Đã đọc tệp"], ["step", "done", "Đã đối chiếu"], ["work", "done", "Đã đối chiếu"],
  ], "the continuation tells what it finished and the work it ran for it");
});

test("history rebuild gives a continuation its own entry of the step, the same as live", async () => {
  const harness = await mount({ deferHistory: true });
  const steps = (first: string, second: string) => [
    { id: "s1", description: "Đọc màn hình và tệp", status: first }, { id: "s2", description: "Đối chiếu", status: second },
  ];
  await harness.settleHistory([
    { role: "user", content: "Đối soát", at: "2026-09-11T09:00:00.000Z" },
    { role: "assistant", content: "", at: "2026-09-11T09:00:05.000Z", status: "awaiting_approval", turnId: "turn-1",
      work: { durationMs: 5_000, tools: [{ callId: "c0", label: "Đã đọc màn hình hiện tại", status: "succeeded", workStepId: "s1" }],
        plan: { planId: "p1", state: "awaiting_user", steps: steps("in_progress", "pending") } } },
    { role: "assistant", content: "Xong.", at: "2026-09-11T09:00:20.000Z", status: "completed", turnId: "turn-2", continuesTurnId: "turn-1",
      work: { durationMs: 15_000, tools: [{ callId: "c1", label: "Đã đọc tệp", status: "succeeded", workStepId: "s1" }],
        plan: { planId: "p1", state: "completed", steps: steps("in_progress", "pending") } } },
  ]);
  const [pausedFold, resumedFold] = harness.folds();
  assert.deepEqual(lines(pausedFold), [
    ["step", "paused", "Đọc màn hình và tệp"], ["work", "done", "Đã đọc màn hình hiện tại"],
  ], "the paused turn holds only its own work");
  assert.deepEqual(lines(resumedFold)?.map((line) => line[2]), ["Đọc màn hình và tệp", "Đã đọc tệp"], "the continuation holds its own entry and work");
  assert.deepEqual([pausedFold?.dataset.complete, resumedFold?.dataset.complete], ["true", "true"]);
});

test("a paused turn folded with its continuation says how long it ran itself, not that it is waiting", async () => {
  const harness = await mount();
  const first = await harness.start("Đối soát");
  first.emit(plan(["s1", "Đọc tệp", "in_progress"]));
  first.emit(activity("complete", "completed", "awaiting"));
  await first.finish({ content: "", outcome: "awaiting_approval", approval: approvalFor(first.sessionId) });
  assert.equal(harness.panel().summary, "Đang chờ anh/chị phản hồi…");
  const second = await harness.approve();
  second.emit(activity("complete", "completed", "done"));
  await second.finish({ content: "Xong." });
  const summaries = harness.folds().map((fold) => fold.querySelector(".acw-thinking-label")?.textContent.trim());
  assert.match(summaries[0] ?? "", /^Đã xử lý trong \d+s$/u, "the paused turn's own duration");
  assert.match(summaries[1] ?? "", /^Đã xử lý trong \d+s$/u);
});

test("history: a paused entry folded with its continuation uses its own durationMs", async () => {
  const harness = await mount({ deferHistory: true });
  await harness.settleHistory([
    { role: "user", content: "Đối soát", at: "2026-09-11T09:00:00.000Z" },
    { role: "assistant", content: "", at: "2026-09-11T09:00:05.000Z", status: "awaiting_approval", turnId: "turn-1",
      work: { durationMs: 5_000, tools: [{ callId: "c0", label: "Đã đọc", status: "succeeded" }] } },
    { role: "assistant", content: "Xong.", at: "2026-09-11T09:00:20.000Z", status: "completed", turnId: "turn-2", continuesTurnId: "turn-1",
      work: { durationMs: 15_000, tools: [{ callId: "c1", label: "Đã ghi", status: "succeeded" }] } },
  ]);
  const summaries = harness.folds().map((fold) => fold.querySelector(".acw-thinking-label")?.textContent.trim());
  assert.deepEqual(summaries, ["Đã xử lý trong 5s", "Đã xử lý trong 15s"]);
});

test("a finished account is marked so its body can be styled apart from the answer, and a running one is not", async () => {
  const harness = await mount();
  const turn = await harness.start("Đối soát");
  turn.emit(...sayText("n1", "Em đọc tệp."), ...toolCall("c1", "Đã đọc tệp"));
  assert.notEqual(harness.folds()[0]?.dataset.complete, "true", "live: chat-styled, no finished mark");
  turn.emit(activity("complete", "completed", "done"));
  await turn.finish({ content: "Xong." });
  assert.equal(harness.folds()[0]?.dataset.complete, "true", "finished: the mark the stylesheet keys on");
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  assert.match(source, /\.acw-thinking\[data-complete="true"\] > \.acw-thinking-body \{[^}]*border-left: 2px solid/u, "the rule sits on the finished body only");
  assert.match(source, /\.acw-thinking\[data-complete="true"\] \.acw-timeline > \.acw-bubble \{[^}]*color: #475467; font-size: 13px/u, "muted 13px narration inside it");
});

test("a turn that pauses for a decision shows a waiting header, never the completion summary that claims it is done", async () => {
  const harness = await mount();
  const turn = await harness.start("Hỗ trợ tôi tính lương");
  turn.emit(working("call-1", "active", "Đang tổng hợp tình hình kỳ lương…"), working("call-1", "done", "Đã tổng hợp tình hình kỳ lương"));
  // The real server reports `turn-completed{outcome:"awaiting_approval"}` for a turn that
  // stopped on a card, which the transport now tells apart from a real ending (spec §3.7 item 7).
  turn.emit(activity("complete", "completed", "awaiting"));
  await turn.finish({ content: "", outcome: "awaiting_approval", approval: approvalFor(turn.sessionId) });
  assert.equal(harness.panel().summary, "Đang chờ anh/chị phản hồi…",
    "the header says the turn is waiting, never that it finished, while a card is still open");

  // Even without that progress frame, the definitive result alone must not fall back to claiming
  // the work is done — the same fix applies wherever the turn's own outcome says it is waiting.
  const second = await harness.start("tiếp tục");
  await second.finish({ content: "", outcome: "awaiting_interaction", interaction: {
    kind: "form", interactionId: "interaction-1", sessionId: second.sessionId, turnId: "turn-2",
    toolId: "request_user_input", requesterId: "agent", message: "Anh/chị xác nhận kỳ lương cần xử lý.",
    requestedSchema: { type: "object", properties: { answer: { type: "string" } } }, expiresAt: inTenMinutes(),
  } });
  assert.equal(harness.panel().summary, "Đang chờ anh/chị phản hồi…",
    "and the same holds when the activity progress frame never arrived at all");
});

test("a decision that lets the work go on says what runs from its first frame, never that it is thinking", async () => {
  const harness = await mount();
  const pausedTurn = async () => {
    const first = await harness.start("Cập nhật phụ cấp, công rồi tạo bảng lương tháng 8");
    first.emit(plan(["adjust", "Đã áp dụng thay đổi công và lương", "completed"], ["create", "Tạo bảng lương nháp cho kỳ lương đã chốt", "in_progress"]));
    await first.finish({ content: "", outcome: "awaiting_approval", approval: approvalFor(first.sessionId) });
    return first;
  };
  await pausedTurn();
  const resumed = await harness.approve();
  let panel = harness.panel();
  assert.deepEqual([panel.live.line, panel.live.source, panel.live.state], ["Tạo bảng lương nháp cho kỳ lương đã chốt", "step", "active"],
    "the step the card was for, while the approved write runs");
  assert.equal(panel.thinking, false);
  resumed.emit(working("call-approved", "active", "Đang tạo bảng lương nháp kỳ mới…"));
  panel = harness.panel();
  assert.deepEqual([panel.live.line, panel.live.call], ["Tạo bảng lương nháp cho kỳ lương đã chốt", "Đang tạo bảng lương nháp kỳ mới…"],
    "and the work itself under it once the server names it");
  resumed.emit(working("call-approved", "done", "Đã tạo bảng lương nháp kỳ mới"));
  assert.deepEqual([harness.panel().live.line, harness.panel().live.call], ["Tạo bảng lương nháp cho kỳ lương đã chốt", "Đã tạo bảng lương nháp kỳ mới"], "still that step, with the call's own ending under it, until the plan moves on");
  await resumed.finish({ content: "Đã tạo bảng lương nháp kỳ 08/2026." });

  // A refusal carries nothing on: the reply to it starts from thinking, not from the refused step.
  await pausedTurn();
  await harness.deny();
  panel = harness.panel();
  assert.equal(panel.thinking, true);
  assert.deepEqual([panel.live.line, panel.live.call], ["Đang suy nghĩ", ""]);
});

test("every tool call is its own plain line, never merged or made to open onto another", async () => {
  const harness = await mount();
  const turn = await harness.start("Tính lương tháng 8");
  turn.emit(working("call-1", "active", "Đang đối chiếu lại dữ liệu vừa ghi…"), working("call-1", "done", "Đã đối chiếu lại dữ liệu vừa ghi"));
  assert.equal(harness.panel().timeline.length, 1);

  // Even the exact same wording is a distinct call, with its own line — never merged into one
  // that then needs a disclosure to see what is inside it (spec §3.7 item 6).
  turn.emit(working("call-2", "active", "Đang đối chiếu lại dữ liệu vừa ghi…"));
  assert.equal(harness.panel().timeline.length, 2, "the same wording again is still its own line");
  turn.emit(working("call-3", "active", "Đang kiểm tra kết nối dữ liệu…"));
  assert.deepEqual(harness.panel().timeline, [
    { kind: "work", state: "done", text: "Đã đối chiếu lại dữ liệu vừa ghi" },
    { kind: "work", state: "active", text: "Đang đối chiếu lại dữ liệu vừa ghi…" },
    { kind: "work", state: "active", text: "Đang kiểm tra kết nối dữ liệu…" },
  ], "three lines, none of them a disclosure to open");

  turn.emit(working("call-2", "done", "Đã đối chiếu lại dữ liệu vừa ghi"), working("call-3", "done", "Đã kiểm tra kết nối dữ liệu"));
  turn.emit(activity("complete", "completed", "done"));
  await turn.finish({ content: "Xong." });
  const fold = harness.folds().at(-1);
  if (fold) fold.open = true;
  assert.deepEqual(lines(fold).map(([, state]) => state), ["done", "done", "done"], "every call settled on its own line");
});

test("the checklist is the plan as it stands: every step in the plan's order, in the agent's own words, with its work under it", async () => {
  const harness = await mount();
  const turn = await harness.start("Tính lương tháng 8");
  turn.emit(plan(["read", "Đọc tổng quan kỳ lương", "pending"], ["close", "Chốt kỳ làm việc", "pending"]));
  assert.deepEqual(harness.panel().timeline, [
    { kind: "step", state: "pending", text: "Đọc tổng quan kỳ lương" },
    { kind: "step", state: "pending", text: "Chốt kỳ làm việc" },
  ], "a plan nobody has started on is a forecast, listed as one: nothing in it claims to be running");

  turn.emit(plan(["read", "Đang đọc tổng quan kỳ lương", "in_progress"], ["close", "Chốt kỳ làm việc", "pending"], ["report", "Báo hiện trạng", "pending"]));
  assert.deepEqual(harness.panel().timeline, [
    { kind: "step", state: "active", text: "Đang đọc tổng quan kỳ lương" },
    { kind: "step", state: "pending", text: "Chốt kỳ làm việc" },
    { kind: "step", state: "pending", text: "Báo hiện trạng" },
  ], "the step being worked on is marked as running, and a step the plan gained is entered where the plan has it");
  turn.emit(plan(["read", "Đang đọc tổng quan kỳ lương tháng 7/2026", "in_progress"], ["close", "Chốt kỳ làm việc", "pending"]));
  assert.deepEqual(harness.panel().timeline, [
    { kind: "step", state: "active", text: "Đang đọc tổng quan kỳ lương tháng 7/2026" },
    { kind: "step", state: "pending", text: "Chốt kỳ làm việc" },
  ], "reworded while it runs, it is the same line — and a step the plan dropped before reaching it leaves with it");

  turn.emit(working("call-1", "active", "Đang lấy dữ liệu bảng công…"), working("call-2", "active", "Đang xem các bảng lương gần đây…"));
  const [work] = flat(harness.panel().timeline).filter((item) => item.kind === "work");
  assert.ok(work, "work done inside a step is kept under it, its own line");
  turn.emit(working("call-1", "done", "Đã lấy dữ liệu bảng công"), working("call-2", "done", "Đã xem các bảng lương gần đây"));

  turn.emit(plan(
    ["read", "Đã xem tổng quan: 4 bảng lương tháng 7/2026 đã khóa", "completed"],
    ["close", "Đã chốt kỳ làm việc: tháng 8/2026", "completed"],
    ["report", "Báo hiện trạng", "pending"],
  ));
  assert.deepEqual(harness.panel().timeline, [
    { kind: "step", state: "done", text: "Đã xem tổng quan: 4 bảng lương tháng 7/2026 đã khóa",
      rows: [
        { kind: "work", state: "done", text: "Đã lấy dữ liệu bảng công" },
        { kind: "work", state: "done", text: "Đã xem các bảng lương gần đây" },
      ] },
    { kind: "step", state: "done", text: "Đã chốt kỳ làm việc: tháng 8/2026" },
    { kind: "step", state: "pending", text: "Báo hiện trạng" },
  ], "a finished step takes the agent's rewritten words on its own entry, each call under it its own line, and every step is entered once, in order");
  assert.equal(harness.count(".acw-check-step"), 3, "never a second entry for the same step");

  turn.emit(activity("complete", "completed", "done"));
  await turn.finish({ content: "Xong." });
  const account = JSON.stringify(harness.panel());
  assert.doesNotMatch(account, /\d+ bước|kế hoạch/u, "no step count and no plan heading, anywhere");
  assert.equal(account.includes("Báo hiện trạng"), false, "a step never reached is not part of what happened: it is gone once the turn is over");
});

test("a plan sent again in a later turn tells only the steps whose state changes in that turn", async () => {
  const steps = (fold: StubNode | undefined) =>
    fold?.querySelectorAll(".acw-check-step").map((line: StubNode) => [line.dataset.state, line.querySelector(".acw-check-label")?.textContent]);
  const harness = await mount();
  const first = await harness.start("Hỗ trợ tôi tính lương");
  first.emit(plan(["s1", "Đang đọc tổng quan kỳ lương", "in_progress"], ["s2", "Chốt kỳ làm việc", "pending"]));
  first.emit(plan(["s1", "Đã đọc tổng quan: 4 bảng lương tháng 7/2026 đã khóa", "completed"], ["s2", "Chốt kỳ làm việc", "pending"]));
  first.emit(activity("complete", "completed", "done"));
  await first.finish({ content: "Anh/chị xác nhận kỳ lương giúp em." });

  // The plan tool sends the whole plan every time, finished steps included.
  const second = await harness.start("ok");
  second.emit(plan(
    ["s1", "Đã đọc tổng quan: 4 bảng lương tháng 7/2026 đã khóa", "completed"],
    ["s2", "Đã chốt kỳ làm việc: tháng 8/2026", "completed"],
    ["s3", "Đang tổng hợp công tháng 8/2026", "in_progress"],
  ));
  assert.deepEqual(steps(harness.folds().at(-1)), [
    ["done", "Đã chốt kỳ làm việc: tháng 8/2026"],
    ["active", "Đang tổng hợp công tháng 8/2026"],
  ], "a step finished in an earlier turn is not told again; one finished or started in this turn is");
  second.emit(activity("complete", "completed", "done"));
  await second.finish({ content: "Em đang tổng hợp công, anh/chị chờ em nhé." });
  assert.deepEqual(steps(harness.folds()[0]), [["done", "Đã đọc tổng quan: 4 bảng lương tháng 7/2026 đã khóa"]],
    "and the earlier turn keeps its own account");

  // s3 was left running when turn 2 ended. Finishing it is a change that belongs to turn 3.
  const third = await harness.start("tiếp tục");
  third.emit(plan(
    ["s1", "Đã đọc tổng quan: 4 bảng lương tháng 7/2026 đã khóa", "completed"],
    ["s2", "Đã chốt kỳ làm việc: tháng 8/2026", "completed"],
    ["s3", "Đã tổng hợp công tháng 8/2026: 128 cán bộ", "completed"],
    ["s4", "Đang kiểm tra thiếu công", "in_progress"],
  ));
  assert.deepEqual(steps(harness.folds().at(-1)), [
    ["done", "Đã tổng hợp công tháng 8/2026: 128 cán bộ"],
    ["active", "Đang kiểm tra thiếu công"],
  ], "a step left running in an earlier turn and finished now is told now");
  third.emit(activity("complete", "completed", "done"));
  await third.finish({ content: "Xong." });

  // A new session starts with no memory of the old plan — including this fake runtime's own
  // idea of what changed, which a real one would reset for a fresh conversation too.
  harness.widget.newSession();
  resetPlanHelper();
  const fresh = await harness.start("Tính lương tháng 9");
  fresh.emit(plan(["s1", "Đã đọc tổng quan kỳ lương tháng 9/2026", "completed"]));
  assert.deepEqual(steps(harness.folds().at(-1)), [["done", "Đã đọc tổng quan kỳ lương tháng 9/2026"]],
    "a new session remembers nothing of the old plan's steps");
  fresh.emit(activity("complete", "completed", "done"));
  await fresh.finish({ content: "Xong." });
});

test("a retired dormant plan's closing frame (a second, foreign planId in the same turn) never repaints its steps into the new task's checklist", async () => {
  const harness = await mount();
  const turn = await harness.start("Việc khác hẳn");
  // Core reports the retired dormant plan's own closing frame before the new plan's proposal
  // (plan-call-execution.ts): the very first frame this turn sees carries a planId it has not
  // adopted yet.
  turn.emit({
    type: "plan-updated", turnId: "t1", cause: "terminal",
    plan: {
      planId: "plan-old", revision: 4, state: "stopped", goal: "Việc trước",
      steps: [
        { id: "old-done", description: "Đã xem tổng quan kỳ lương trước", status: "completed" },
        { id: "old-open", description: "Đang xác nhận kỳ lương trước", status: "in_progress" },
      ],
    },
  });
  assert.deepEqual(harness.panel().timeline, [], "the previous task's retired plan is not this turn's account");

  turn.emit({
    type: "plan-updated", turnId: "t1", cause: "proposal",
    plan: {
      planId: "plan-new", revision: 1, state: "active", goal: "Việc khác hẳn",
      steps: [{ id: "new-open", description: "Đang xử lý việc khác hẳn", status: "in_progress" }],
    },
    changedStepIds: ["new-open"],
  });
  assert.deepEqual(harness.panel().timeline, [{ kind: "step", state: "active", text: "Đang xử lý việc khác hẳn" }],
    "only this turn's own, newly proposed plan is shown");

  // This turn's own plan closing, later, still repaints in place — owning a plan is never confused
  // with ignoring one that never belonged here.
  turn.emit({
    type: "plan-updated", turnId: "t1", cause: "terminal",
    plan: {
      planId: "plan-new", revision: 2, state: "completed", goal: "Việc khác hẳn",
      steps: [{ id: "new-open", description: "Đã xử lý việc khác hẳn", status: "completed" }],
    },
    changedStepIds: ["new-open"],
  });
  assert.deepEqual(harness.panel().timeline, [{ kind: "step", state: "done", text: "Đã xử lý việc khác hẳn" }],
    "a terminal frame for the plan this turn does own still updates it");

  turn.emit(activity("complete", "completed", "done"));
  await turn.finish({ content: "Xong." });
});

test("a view following the bottom still follows it after a paused turn and its continuation fold together", async () => {
  interface FakeAnimation { finish(): void }
  const animations: FakeAnimation[] = [];
  const prototype = StubNode.prototype as unknown as { animate?: (keyframes: unknown) => unknown };
  // The stub has no animation engine: this one runs only when a test finishes it.
  prototype.animate = () => {
    const listeners: (() => void)[] = [];
    const animation = {
      addEventListener: (_type: string, listener: () => void) => { listeners.push(listener); },
      cancel() { /* nothing is held */ },
      finish() { for (const listener of listeners) listener(); },
    };
    animations.push(animation);
    return animation;
  };
  try {
    const harness = await mount();
    const { conversation } = harness;
    const first = await harness.start("Tạo bảng tổng hợp ngày công tháng 8");
    first.emit(working("call-1", "active", "Đang xem các bảng lương gần đây…"), working("call-1", "done", "Đang xem các bảng lương gần đây…"));
    first.emit(activity("complete", "completed", "done"));
    await first.finish({ content: "", outcome: "awaiting_approval", approval: approvalFor(first.sessionId) });
    assert.equal(animations.length, 0, "a turn waiting on the approval does not fold");

    const resumed = await harness.approve();
    resumed.emit(working("call-2", "active", "Đang đối chiếu lại dữ liệu vừa ghi…"), working("call-2", "done", "Đang đối chiếu lại dữ liệu vừa ghi…"));
    // A conversation taller than its view, parked at the bottom. The stub has no layout, so the
    // geometry is set by hand, and both accounts are given a height to fold.
    conversation.clientHeight = 400;
    conversation.scrollHeight = 1600;
    conversation.scrollTop = 1200;
    for (const fold of harness.folds()) {
      const body = fold.querySelector(".acw-thinking-body");
      if (body) body.offsetHeight = 150;
    }
    harness.frame();
    assert.equal(harness.visible(".acw-jump"), false, "the view is following the bottom");

    resumed.emit(activity("complete", "completed", "done"));
    await resumed.finish({ content: "Đã tạo bảng tổng hợp ngày công tháng 8/2026 cho 128 cán bộ." });
    assert.equal(animations.length, 2, "the paused account and its continuation fold together");

    // Mid-fold: the answer below has grown while the blocks above shrink, and the browser raises a
    // scroll event nobody asked for, reading far from the bottom.
    conversation.scrollHeight = 2400;
    conversation.dispatchEvent({ type: "scroll" });
    assert.equal(harness.visible(".acw-jump"), false, "a fold moving the view is not the user leaving the bottom");

    for (const animation of animations) animation.finish();
    harness.frame();
    assert.deepEqual(harness.folds().map((fold) => fold.open), [false, false]);
    assert.equal(conversation.scrollTop, 2400, "once the folds are over, the view is back at the end, with the answer in view");
    assert.equal(harness.visible(".acw-jump"), false, "and the jump button stays hidden");

    // With no fold running, scrolling away is the user's again.
    conversation.scrollTop = 900;
    conversation.dispatchEvent({ type: "scroll" });
    assert.equal(harness.visible(".acw-jump"), true, "a real move away from the bottom still offers the way back");
  } finally {
    delete prototype.animate;
  }
});

test("while a turn runs, the live line says which plan step it is in and the call line what it is calling for it, each replaced in place", async () => {
  const harness = await mount();
  const turn = await harness.start("Tính lương tháng 8");
  const live = () => harness.panel().live;
  assert.deepEqual([live().line, live().call, live().lines], ["Đang suy nghĩ", "", 1], "before anything is known, the turn is thinking");
  const line = harness.foldBody().querySelector(".acw-live-line");
  const callLine = harness.foldBody().querySelector(".acw-call-line");

  turn.emit(plan(["read", "Đọc tổng quan kỳ lương", "in_progress"], ["close", "Chốt kỳ làm việc", "pending"]));
  assert.deepEqual([live().line, live().source, live().state, live().call], ["Đọc tổng quan kỳ lương", "step", "active", ""],
    "then the step being carried out, on the line that shimmers");
  turn.emit(working("call-1", "active", "Đang lấy dữ liệu bảng công…"));
  assert.deepEqual([live().line, live().call], ["Đọc tổng quan kỳ lương", "Đang lấy dữ liệu bảng công…"],
    "a running call no longer hides the step it belongs to: the step stays, and the call is told under it");
  turn.emit(working("call-2", "active", "Đang xem các bảng lương gần đây…"));
  assert.equal(live().call, "Đang xem các bảng lương gần đây…", "the latest call, on the same line");
  turn.emit(working("call-2", "done", "Đang xem các bảng lương gần đây…"));
  assert.equal(live().call, "Đang lấy dữ liệu bảng công…", "back to the call still running");
  turn.emit(working("call-1", "done", "Đã lấy dữ liệu bảng công: 128 dòng"));
  assert.deepEqual([live().line, live().call], ["Đọc tổng quan kỳ lương", "Đã lấy dữ liệu bảng công: 128 dòng"],
    "between calls the last one's ending stays: a line that came and went with each call was on screen for a frame at a time");
  turn.emit(plan(["read", "Đã đọc tổng quan: 4 bảng lương tháng 7/2026 đã khóa", "completed"], ["close", "Chốt kỳ làm việc", "in_progress"]));
  assert.deepEqual([live().line, live().call], ["Chốt kỳ làm việc", ""], "the next step once the plan moves on, with no call of its own yet");

  assert.equal(live().lines, 1, "never a second live line");
  assert.equal(harness.foldBody().querySelector(".acw-live-line"), line, "it is the same line, its words replaced in place");
  assert.equal(harness.foldBody().querySelector(".acw-call-line"), callLine, "and the same call line");
  assert.deepEqual(harness.panel().shown, ["plan", "live"],
    "while the turn runs: the plan sentence, then the step it is in — no step list and no tool rows until the reader asks");
  turn.emit(activity("complete", "completed", "done"));
  await turn.finish({ content: "Xong." });
});

test("with no plan, the live line carries the call itself, and thinking between calls", async () => {
  const harness = await mount();
  const turn = await harness.start("Tính lương tháng 8");
  const live = () => harness.panel().live;
  turn.emit(working("call-1", "active", "Đang lấy dữ liệu bảng công…"));
  assert.deepEqual([live().line, live().source, live().call], ["Đang lấy dữ liệu bảng công…", "work", ""], "one line is enough when there is no step to stand above the call");
  turn.emit(working("call-1", "done", "Đã lấy dữ liệu bảng công: 128 dòng"));
  assert.deepEqual([live().line, live().source], ["Đang suy nghĩ", "thinking"]);
  turn.emit(activity("complete", "completed", "done"));
  await turn.finish({ content: "Xong." });
});

test("the checklist stays closed while the turn runs until the reader opens it with the live line's chevron", async () => {
  const harness = await mount();
  const turn = await harness.start("Tính lương tháng 8");
  assert.equal(harness.panel().live.detail, "none", "nothing to open onto yet, so no chevron");
  harness.toggleDetail();
  assert.equal(harness.panel().live.detail, "none", "and a click on the line does nothing");

  turn.emit(plan(
    ["read", "Đọc tổng quan kỳ lương", "in_progress"], ["close", "Chốt kỳ làm việc", "pending"], ["sum", "Tổng hợp công", "pending"],
  ));
  turn.emit(working("call-1", "active", "Đang lấy dữ liệu bảng công…"));
  assert.equal(harness.panel().live.detail, "closed", "offered once there is a checklist, and closed: the reader opens it if they want it");
  assert.deepEqual(harness.panel().shown, ["plan", "live", "call-line"]);

  harness.toggleDetail();
  assert.equal(harness.panel().live.detail, "open");
  assert.deepEqual(harness.panel().shown, ["plan", "step", "step", "step", "live"],
    "the whole plan, in the plan's order — and no call line under it, which would say the running call twice");
  assert.deepEqual(harness.panel().timeline, [
    { kind: "step", state: "active", text: "Đọc tổng quan kỳ lương", rows: [{ kind: "work", state: "active", text: "Đang lấy dữ liệu bảng công…" }] },
    { kind: "step", state: "pending", text: "Chốt kỳ làm việc" },
    { kind: "step", state: "pending", text: "Tổng hợp công" },
  ], "what is being done with the call under it, and what is still to come");

  // The plan moves on while the checklist is open: the entries update where they stand.
  turn.emit(working("call-1", "done", "Đã lấy dữ liệu bảng công: 128 dòng"));
  turn.emit(plan(
    ["read", "Đã đọc tổng quan kỳ lương", "completed"], ["close", "Chốt kỳ làm việc", "in_progress"], ["sum", "Tổng hợp công", "pending"],
  ));
  assert.deepEqual(harness.panel().timeline.map((entry) => [entry.state, entry.text]), [
    ["done", "Đã đọc tổng quan kỳ lương"], ["active", "Chốt kỳ làm việc"], ["pending", "Tổng hợp công"],
  ]);
  assert.equal(harness.panel().rows[0]?.text, "Đã lấy dữ liệu bảng công: 128 dòng", "a call's line takes the words of its ending");

  harness.toggleDetail();
  assert.deepEqual(harness.panel().shown, ["plan", "live"], "closed again, nothing is lost: the line carries on — on a step that has made no call yet");
  turn.emit(activity("complete", "completed", "done"));
  await turn.finish({ content: "Xong." });
  assert.deepEqual(harness.panel().timeline.map((entry) => entry.state), ["done", "paused"],
    "folded, the account is what happened: the step never reached is not listed under a finished turn");
});

test("everything the agent says while it works stays in the chat, one after the other, until the answer folds it all away", async () => {
  const harness = await mount({ planSentence: false });
  const turn = await harness.start("Xem biểu này");
  const said = () => harness.panel().timeline.filter((entry) => entry.kind === "narration").map((entry) => entry.text);
  turn.emit(narration.start("n1"), narration.delta("n1", "Em sẽ mở tài liệu rồi đọc biểu chi thường xuyên."), narration.end("n1"));
  turn.emit(plan(["open", "Mở tài liệu", "in_progress"], ["read", "Đọc biểu chi thường xuyên", "pending"]));
  turn.emit(working("call-1", "active", "Đang mở tài liệu…"), working("call-1", "done", "Đã mở tài liệu: 46 biểu"));
  turn.emit(narration.start("n2"), narration.delta("n2", "Tài liệu có 46 biểu, em đọc biểu 18 trước."), narration.end("n2"));
  turn.emit(plan(["open", "Mở tài liệu", "completed"], ["read", "Đọc biểu chi thường xuyên", "in_progress"]));
  turn.emit(narration.start("n3"), narration.delta("n3", "Biểu 18 có 110 nhiệm vụ chi, em đang đối chiếu."), narration.end("n3"));
  assert.deepEqual(said(), [
    "Em sẽ mở tài liệu rồi đọc biểu chi thường xuyên.",
    "Tài liệu có 46 biểu, em đọc biểu 18 trước.",
    "Biểu 18 có 110 nhiệm vụ chi, em đang đối chiếu.",
  ], "each thing it said is still there: a later one never takes the place of an earlier one");
  assert.deepEqual(harness.panel().shown, ["narration", "narration", "narration", "live"], "as chat, with the line saying which step it is in under the latest of it");
  assert.equal(harness.panel().live.line, "Đọc biểu chi thường xuyên");

  turn.emit(draft.start("answer"), draft.delta("answer", "Có 110 nhiệm vụ chi."), draft.end("answer", "completed"), activity("complete", "completed", "done"));
  await turn.finish({ content: "Có 110 nhiệm vụ chi." });
  const panel = harness.panel();
  assert.equal(panel.open, false, "the answer in, all of it folds away and only the answer stays in view");
  assert.match(harness.answer().innerHTML, /110 nhiệm vụ chi/u);
  assert.deepEqual(panel.timeline.map((entry) => entry.kind), ["narration", "step", "narration", "step", "narration"],
    "opened again, it is all there in the order it happened: what the agent said, and the plan's steps");
});

test("a model that says nothing beside its calls still tells what each step found, as chat that only grows", async () => {
  // A model may close each step with an `outcome` and write not one sentence of its own; the
  // outcomes are then the only account of the work, so they must reach the chat.
  const harness = await mount({ planSentence: false });
  const turn = await harness.start("phân tích hồ sơ");
  const steps = (...status: readonly string[]) => plan(
    ["context", "Lấy thông tin đơn vị", status[0] ?? "pending", status[0] === "completed" ? "Đã lấy ngữ cảnh: Sở tài chính Agentic, năm 2026." : undefined],
    ["structure", "Đọc cấu trúc file Excel", status[1] ?? "pending", status[1] === "completed" ? "Đã đọc file Excel, nhận diện 46 biểu." : undefined],
    ["extract", "Trích xuất các nhiệm vụ chi", status[2] ?? "pending"],
  );
  turn.emit(steps("in_progress"));
  assert.deepEqual(harness.panel().shown, ["live"],
    "the plan itself is not listed in the chat: a plan with a step per biểu would be twenty lines before any work — it is behind the chevron");

  turn.emit(steps("completed", "in_progress"));
  turn.emit(working("call-1", "active", "Đang mở tài liệu…"), working("call-1", "done", "Đã mở tài liệu: 46 biểu"));
  turn.emit(steps("completed", "completed", "in_progress"));
  for (const id of ["a", "b", "c"]) turn.emit(working(id, "active", `Đang đọc biểu ${id}…`));
  for (const id of ["a", "b", "c"]) turn.emit(working(id, "done", `Đã đọc biểu ${id}`));
  const said = () => harness.panel().timeline.filter((entry) => entry.kind === "step-note").map((entry) => entry.text);
  assert.deepEqual(said(), ["Đã lấy ngữ cảnh: Sở tài chính Agentic, năm 2026.", "Đã đọc file Excel, nhận diện 46 biểu."],
    "what each finished step found, one after the other — the second never took the place of the first");
  assert.deepEqual(harness.panel().shown, ["step-note", "step-note", "live", "call-line"],
    "chat above, then where it is now, then the latest call: the checklist stays closed");
  assert.deepEqual([harness.panel().live.line, harness.panel().live.call], ["Trích xuất các nhiệm vụ chi", "Đã đọc biểu c"],
    "calls made together leave the one that ended last on the call line, not an empty line");
  const callLine = harness.foldBody().querySelector(".acw-call-line");
  assert.equal(callLine?.dataset.state, "done", "and the line says the call is over, whatever tense its phrase is written in");
  turn.emit(working("d", "active", "Đang đọc biểu d…"));
  assert.equal(callLine?.dataset.state, "active", "running again with the next call");
  turn.emit(working("d", "done", "Đang đọc biểu d…"));
  assert.deepEqual([harness.panel().live.call, callLine?.dataset.state], ["Đang đọc biểu d…", "done"],
    "a product with one phrase per tool keeps its phrase, marked finished");

  harness.toggleDetail();
  assert.deepEqual(harness.panel().shown, ["step", "step-note", "step", "step-note", "step", "live"],
    "opened, the checklist is the plan, and each step's finding sits under that step");
  harness.toggleDetail();

  turn.emit(draft.start("answer"), draft.delta("answer", "Có 110 nhiệm vụ chi."), draft.end("answer", "completed"), activity("complete", "completed", "done"));
  await turn.finish({ content: "Có 110 nhiệm vụ chi." });
  const panel = harness.panel();
  assert.equal(panel.open, false, "the answer in, all of it folds away");
  assert.deepEqual(panel.timeline.map((entry) => entry.kind), ["step", "step-note", "step", "step-note", "step"],
    "and opens onto the progress with what the agent recorded at each step");
});

test("what the model is thinking is on the line that shimmers while it thinks, and gone when the thought ends", async () => {
  const harness = await mount({ planSentence: false });
  const turn = await harness.start("phân tích hồ sơ");
  const live = () => harness.panel().live;
  const think = (id: string, ...deltas: readonly string[]) => {
    turn.emit({ type: "assistant-reasoning-start", reasoningId: id, audience: "user" });
    for (const delta of deltas) turn.emit({ type: "assistant-reasoning-delta", reasoningId: id, audience: "user", delta });
    harness.frame();
  };
  const stop = (id: string) => turn.emit({ type: "assistant-reasoning-end", reasoningId: id, audience: "user", status: "completed" });

  think("r1");
  assert.deepEqual([live().line, live().source], ["Đang suy nghĩ", "thinking"], "a product that sends no text still says it is thinking");
  turn.emit({ type: "assistant-reasoning-delta", reasoningId: "r1", audience: "user", delta: "Người dùng muốn dựng danh mục. Trước hết cần xem hồ sơ có những biểu nào." });
  harness.frame();
  assert.deepEqual([live().line, live().source, live().state], ["Trước hết cần xem hồ sơ có những biểu nào.", "thinking", "active"],
    "the sentence being thought now, on the live line, in place of the bare \"thinking\"");
  stop("r1");
  assert.equal(live().line, "Trước hết cần xem hồ sơ có những biểu nào.",
    "the last thought stays while the model writes out what it will do: a server passing whole sentences releases the last one as the thought ends");

  turn.emit(plan(["read", "Đọc biểu chi thường xuyên", "in_progress"]));
  assert.deepEqual([live().line, live().call], ["Đọc biểu chi thường xuyên", ""], "and is gone as soon as the next thing happens — it is not part of the account");
  turn.emit(working("call-1", "active", "Đang đọc biểu 18…"), working("call-1", "done", "Đã đọc biểu 18: 31 dòng"));
  think("r2", "Biểu 18 có 31 dòng, ", "trong đó dòng tổng không phải nhiệm vụ chi nên cần loại ra.");
  const callLine = harness.foldBody().querySelector(".acw-call-line");
  assert.deepEqual([live().line, live().call, callLine?.dataset.state],
    ["Đọc biểu chi thường xuyên", "Biểu 18 có 31 dòng, trong đó dòng tổng không phải nhiệm vụ chi nên cần loại ra.", "thinking"],
    "in a step, the step keeps its line and the thought takes the line under it");
  turn.emit(working("call-2", "active", "Đang đọc biểu 24…"));
  assert.equal(live().call, "Đang đọc biểu 24…", "a call that is running is what is happening: it takes the line from the thought");
  turn.emit(working("call-2", "done", "Đã đọc biểu 24: 32 dòng"));
  stop("r2");
  assert.deepEqual([live().call, callLine?.dataset.state], ["Đã đọc biểu 24: 32 dòng", "done"], "and when the thought ends, the last call's ending is back");

  turn.emit(activity("complete", "completed", "done"));
  await turn.finish({ content: "Xong." });
  assert.doesNotMatch(JSON.stringify(harness.panel().timeline), /dòng tổng không phải/u, "folded, no thought is in the account");
});

test("the plan is told once as a sentence of chat text: not again for the same plan, and not when the agent narrates", async () => {
  const harness = await mount();
  const sentence = () => harness.panel().live.sentence;
  const first = await harness.start("Hỗ trợ tôi tính lương");
  first.emit(plan(
    ["read", "Đang đọc tổng quan kỳ lương: 4 bảng lương", "in_progress"],
    ["close", "Chốt kỳ làm việc – tháng 8/2026", "pending"],
    ["sum", "Tổng hợp công tháng 8/2026.", "pending"],
  ));
  assert.equal(sentence(), "Em sẽ đọc tổng quan kỳ lương, chốt kỳ làm việc rồi tổng hợp công tháng 8/2026.",
    "each remaining step's short title, in order, as one sentence of chat text");
  first.emit(plan(
    ["read", "Đã đọc tổng quan: 4 bảng lương tháng 7/2026 đã khóa", "completed"],
    ["close", "Chốt kỳ làm việc – tháng 8/2026", "in_progress"],
    ["sum", "Tổng hợp công tháng 8/2026.", "pending"],
  ));
  assert.equal(harness.foldBody().querySelectorAll(".acw-plan-sentence").length, 1, "told once, not again as the steps progress");
  assert.equal(sentence(), "Em sẽ đọc tổng quan kỳ lương, chốt kỳ làm việc rồi tổng hợp công tháng 8/2026.");
  first.emit(activity("complete", "completed", "done"));
  await first.finish({ content: "Anh/chị xác nhận kỳ lương giúp em." });

  const second = await harness.start("ok");
  second.emit(plan(
    ["read", "Đã đọc tổng quan: 4 bảng lương tháng 7/2026 đã khóa", "completed"],
    ["close", "Đã chốt kỳ làm việc: tháng 8/2026", "completed"],
    ["sum", "Tổng hợp công tháng 8/2026", "in_progress"],
  ));
  assert.equal(harness.foldBody().querySelector(".acw-plan-sentence"), null, "the same plan, further along, is not told again in a later turn");
  second.emit(activity("complete", "completed", "done"));
  await second.finish({ content: "Em đang tổng hợp công." });

  const third = await harness.start("tạo luôn bảng lương");
  third.emit(plan(
    ["read", "Đã đọc tổng quan: 4 bảng lương tháng 7/2026 đã khóa", "completed"],
    ["close", "Đã chốt kỳ làm việc: tháng 8/2026", "completed"],
    ["sum", "Đã tổng hợp công tháng 8/2026: 128 cán bộ", "completed"],
    ["create", "Tạo bảng lương nháp", "in_progress"],
    ["check", "Kiểm tra bảng lương", "pending"],
  ));
  // The sentence is only ever told on the very first proposal of a brand-new plan (revision 1);
  // this is the same plan, three turns further along, so it is never told again (spec §3.7/§10.6)
  // — even though its remaining steps changed, which is what used to retell it.
  assert.equal(sentence(), "", "the same plan is never told a second time, however much its remaining steps changed");
  third.emit(activity("complete", "completed", "done"));
  await third.finish({ content: "Xong." });

  const fourth = await harness.start("gửi phê duyệt luôn");
  fourth.emit(narration.start("n1"), narration.delta("n1", "Em sẽ gửi bảng lương đi phê duyệt."), narration.end("n1"));
  fourth.emit(plan(["send", "Gửi phê duyệt bảng lương", "in_progress"]));
  assert.equal(harness.foldBody().querySelector(".acw-plan-sentence"), null, "when the agent says it itself, no sentence is made up for it");
  assert.deepEqual(harness.panel().shown, ["narration", "live"], "its own words, and the step it is in");
  fourth.emit(activity("complete", "completed", "done"));
  await fourth.finish({ content: "Xong." });

  harness.widget.newSession();
  resetPlanHelper();
  const long = await harness.start("tính lương cả năm");
  long.emit(plan(
    ["a", "Đọc dữ liệu", "in_progress"], ["b", "Chốt kỳ", "pending"], ["c", "Tổng hợp công", "pending"],
    ["d", "Tạo bảng lương", "pending"], ["e", "Kiểm tra", "pending"], ["f", "Gửi phê duyệt", "pending"],
  ));
  assert.equal(sentence(), "Em sẽ đọc dữ liệu, chốt kỳ, tổng hợp công, tạo bảng lương…", "past five steps, the first four and an ellipsis");
  long.emit(activity("complete", "completed", "done"));
  await long.finish({ content: "Xong." });
});

test("opened after the turn, the account is the plan checklist with each step's work under it, without the live sentence or line", async () => {
  const harness = await mount();
  const turn = await harness.start("Tính lương tháng 8");
  turn.emit(plan(["read", "Đọc tổng quan kỳ lương", "in_progress"], ["close", "Chốt kỳ làm việc", "pending"], ["report", "Báo hiện trạng", "pending"]));
  turn.emit(working("call-1", "active", "Đang lấy dữ liệu bảng công…"), working("call-1", "done", "Đã lấy dữ liệu bảng công"));
  turn.emit(plan(["read", "Đã đọc tổng quan: 4 bảng lương tháng 7/2026 đã khóa", "completed"], ["close", "Chốt kỳ làm việc", "in_progress"], ["report", "Báo hiện trạng", "pending"]));
  turn.emit(working("call-2", "active", "Đang xem danh sách phòng ban…"), working("call-3", "active", "Đang kiểm tra kết nối dữ liệu…"));
  turn.emit(working("call-2", "done", "Đã xem danh sách phòng ban"), working("call-3", "done", "Đã kiểm tra kết nối dữ liệu"));
  turn.emit(activity("complete", "completed", "done"));
  await turn.finish({ content: "Em đã chốt kỳ làm việc tháng 8/2026." });

  const panel = harness.panel();
  assert.equal(panel.open, false);
  assert.deepEqual(panel.shown, ["step", "step"], "folded, the account holds the checklist, and no longer the plan sentence or the live line");
  assert.deepEqual(panel.timeline, [
    { kind: "step", state: "done", text: "Đã đọc tổng quan: 4 bảng lương tháng 7/2026 đã khóa", rows: [{ kind: "work", state: "done", text: "Đã lấy dữ liệu bảng công" }] },
    { kind: "step", state: "paused", text: "Chốt kỳ làm việc", rows: [
      { kind: "work", state: "done", text: "Đã xem danh sách phòng ban" },
      { kind: "work", state: "done", text: "Đã kiểm tra kết nối dữ liệu" },
    ] },
  ], "the finished step with its ✓ and the step it stopped in with its ○, each with the tool work done inside it, each call its own line");
  const steps = harness.foldBody().querySelectorAll(".acw-check-step");
  assert.deepEqual(steps.map((step) => step.classList.contains("acw-thinking-item") && Boolean(step.querySelector(".acw-thinking-dot"))), [true, true],
    "drawn as the plan checklist: a dot on the connecting line");
  const tools = harness.foldBody().querySelectorAll(".acw-check-work .acw-thinking-item");
  assert.equal(tools.length, 3, "every tool call under its step, none of them a disclosure to open");
  assert.equal(harness.answer().hidden, false, "the answer stays in view below");
});

test("the live line's glyph claims no more than happened: a waiting step is an empty circle, only finished work has a check", async () => {
  const harness = await mount();
  const turn = await harness.start("Tạo bảng tổng hợp ngày công tháng 8");
  const live = () => harness.panel().live;
  turn.emit(plan(["prepare", "Chuẩn bị tổng hợp công tháng 8/2026 để tính lương", "in_progress"]));
  assert.deepEqual([live().source, live().icon], ["step", "waiting"], "a step being carried out is not done, so it has no check");
  turn.emit(working("call-1", "active", "Đang tổng hợp tình hình kỳ lương…"));
  assert.deepEqual([live().icon, live().call], ["waiting", "Đang tổng hợp tình hình kỳ lương…"], "a call running under it does not put a check on the step either");
  turn.emit(working("call-1", "done", "Đã tổng hợp tình hình kỳ lương"), activity("complete", "completed", "done"));
  await turn.finish({ content: "", outcome: "awaiting_approval", approval: approvalFor(turn.sessionId) });
  assert.deepEqual([live().line, live().state, live().icon], ["Chuẩn bị tổng hợp công tháng 8/2026 để tính lương", "settled", "waiting"],
    "paused on the approval, the step waits for the user: no check that reads as done");
  assert.equal(harness.foldBody().querySelector(".acw-live-line path")?.getAttribute("d")?.includes("l2.1 2.1"), false,
    "and the glyph drawn is not the check");

  const other = await mount();
  const work = await other.start("Tạo bảng tổng hợp ngày công tháng 8");
  work.emit(working("call-1", "active", "Đang tổng hợp tình hình kỳ lương…"), working("call-1", "done", "Đã tổng hợp tình hình kỳ lương"));
  work.emit(activity("complete", "completed", "done"));
  await work.finish({ content: "", outcome: "awaiting_approval", approval: approvalFor(work.sessionId) });
  assert.deepEqual([other.panel().live.line, other.panel().live.icon], ["Đã tổng hợp tình hình kỳ lương", "done"],
    "with no step to wait in, the line rests on the last work, which did finish, and that carries the check");
  assert.equal(other.foldBody().querySelector(".acw-live-line path")?.getAttribute("d")?.includes("l2.1 2.1"), true);
});

test("a single-question interaction offers its choices as clickable buttons, and submits the raw value picked", async () => {
  const harness = await mount();
  const turn = await harness.start("Cập nhật phụ cấp thâm niên nghề cho anh Quang Huy");
  await turn.finish({ content: "", outcome: "awaiting_interaction", interaction: {
    kind: "form", sessionId: turn.sessionId, interactionId: "interaction-budget", turnId: "turn-1", toolId: "sample-app.payroll/ask",
    requesterId: "sample-app", message: "Chọn giúp em Loại - Khoản của ngân sách.", expiresAt: inTenMinutes(),
    requestedSchema: {
      type: "object",
      // Open, as request_user_input writes every select: the agent's list may miss what the person means.
      properties: { budgetKindItemID: { type: "string", title: "Loại - Khoản", otherAnswer: true, oneOf: [
        { const: "gdmn", title: "Giáo dục mầm non" },
        { const: "gdth", title: "Giáo dục tiểu học" },
      ] } },
      required: ["budgetKindItemID"],
    },
  } });
  assert.equal(harness.visible(".acw-interaction"), true);
  assert.equal(harness.has(".acw-interaction-tabs"), false, "one question has no tab bar and no review step");
  const choices = harness.conversation.querySelectorAll(".acw-choice-button");
  assert.deepEqual(choices.map((button) => button.textContent), ["Giáo dục mầm non", "Giáo dục tiểu học", "Khác…Tự nhập câu trả lời"],
    "options render as their titles, and \"Khác\" is offered on an open list so a list that misses the point can be said so");
  assert.equal(choices[0]?.dataset.selected, "false");
  const send = harness.conversation.querySelector(".acw-approval-approve");
  const skip = harness.conversation.querySelector(".acw-approval-deny");
  assert.ok(send && skip);
  assert.equal(send.parentNode, skip.parentNode, "sending and skipping are answered from one row, not two stacked apart");
  assert.equal(send.hidden, false, "the send button is on the card from the start");
  assert.equal(send.disabled, true, "and waits for the required answer");
  assert.equal(harness.conversation.querySelectorAll(".acw-interaction-notice").every((notice) => notice.hidden && notice.closest(".acw-interaction-field")), true,
    "a question answered by a tap shows no caution about typing secrets");
  choices[1]?.click();
  // A click rebuilds the button list (pagination may need to), so the choice is read back fresh.
  const afterClick = harness.conversation.querySelectorAll(".acw-choice-button");
  assert.equal(afterClick[1]?.dataset.selected, "true", "a tap marks the choice directly, no menu to open first");
  assert.equal(afterClick[0]?.dataset.selected, "false", "single-select keeps only one button marked");
  assert.equal(harness.has(".acw-interaction-tabs"), false, "choosing the answer does not move the card to a review");
  assert.equal(send.disabled, false, "the answer is enough to send it");

  const resumed = await harness.approve();
  // The widget runs in its own vm realm, so its arrays/objects fail a strict identity-aware
  // deepEqual against this file's own literals even when every value matches; round-tripping
  // through JSON compares the data, not which realm built the container.
  assert.deepEqual(JSON.parse(JSON.stringify(resumed.request.content)), { budgetKindItemID: "gdth" },
    "the button's value reaches the agent, never its label");
});

test("\"Khác\" lets the person answer outside an open list, and their words are the field's own value", async () => {
  // A list the agent drew up cannot be assumed to hold what the person means, so request_user_input
  // marks it open (otherAnswer) and the server takes their words as the answer to that question.
  const harness = await mount();
  const turn = await harness.start("Lập danh mục nhiệm vụ chi");
  await turn.finish({ content: "", outcome: "awaiting_interaction", interaction: {
    kind: "form", sessionId: turn.sessionId, interactionId: "interaction-unit", turnId: "turn-1", toolId: "example/ask",
    requesterId: "example", message: "Đơn vị nào nhận danh mục?", expiresAt: inTenMinutes(),
    requestedSchema: {
      type: "object",
      properties: { donVi: { type: "string", title: "Đơn vị", otherAnswer: true, oneOf: [
        { const: "stc", title: "Sở Tài chính" },
        { const: "syt", title: "Sở Y tế" },
      ] } },
      required: ["donVi"],
    },
  } });

  const other = harness.conversation.querySelectorAll(".acw-choice-button").find((button) => (button.textContent ?? "").startsWith("Khác"));
  assert.ok(other, "every choice question offers a way to answer outside the list");
  other.click();
  const input = harness.conversation.querySelector(".acw-interaction-other");
  assert.ok(input, "choosing \"Khác\" opens somewhere to write");
  const siblings = input.parentNode?.children ?? [];
  const notice = siblings[siblings.indexOf(input) + 1];
  assert.equal(notice?.className, "acw-interaction-notice", "the caution about secrets sits right under the box it is about");
  assert.equal(notice.hidden, true, "and waits until the box is clicked");
  input.dispatchEvent({ type: "focus" });
  assert.equal(notice.hidden, false, "clicking into the box shows it");
  input.value = "Xã Đơn Vị Mẫu — đơn vị này chưa có trong danh mục, bổ sung giúp tôi";
  input.dispatchEvent({ type: "input" });

  const resumed = await harness.approve();
  assert.deepEqual([resumed.request.action, JSON.parse(JSON.stringify(resumed.request.content))],
    ["accept", { donVi: "Xã Đơn Vị Mẫu — đơn vị này chưa có trong danh mục, bổ sung giúp tôi" }],
    "the card is answered with their words, not skipped and followed by a message");
  assert.equal(harness.count(".acw-user"), 1, "no message is sent on their behalf: only the request that began the turn");
});

test("a closed list offers no \"Khác\": an MCP elicitation's enum takes only its own choices", async () => {
  const harness = await mount();
  const turn = await harness.start("Kết nối nguồn dữ liệu");
  await turn.finish({ content: "", outcome: "awaiting_interaction", interaction: {
    kind: "form", sessionId: turn.sessionId, interactionId: "interaction-closed", turnId: "turn-1", toolId: "mcp/elicit",
    requesterId: "mcp", message: "Chọn môi trường.", expiresAt: inTenMinutes(),
    requestedSchema: { type: "object", properties: { env: { type: "string", title: "Môi trường", enum: ["test", "production"] } }, required: ["env"] },
  } });
  assert.deepEqual(harness.conversation.querySelectorAll(".acw-choice-button").map((button) => button.dataset.choice), ["test", "production"]);
});

test("many choices paginate, and a selection survives moving to another page", async () => {
  const harness = await mount();
  const turn = await harness.start("Áp dụng phụ cấp cho nhiều phòng ban");
  const departments = Array.from({ length: 8 }, (_, index) => `d${index + 1}`);
  await turn.finish({ content: "", outcome: "awaiting_interaction", interaction: {
    kind: "form", sessionId: turn.sessionId, interactionId: "interaction-departments", turnId: "turn-1", toolId: "sample-app.payroll/ask",
    requesterId: "sample-app", message: "Chọn các phòng ban áp dụng.", expiresAt: inTenMinutes(),
    requestedSchema: { type: "object", properties: {
      departments: { type: "array", title: "Phòng ban áp dụng", items: { enum: departments } },
    } },
  } });
  assert.equal(harness.conversation.querySelectorAll(".acw-choice-button").length, 6, "the first page shows only part of a long list");
  const pager = harness.conversation.querySelector(".acw-interaction-pager-label");
  assert.equal(pager?.textContent, "Trang 1/2");
  harness.conversation.querySelectorAll(".acw-choice-button")[0]?.click(); // d1
  const [prev, next] = harness.conversation.querySelectorAll(".acw-interaction-pager-nav");
  assert.equal(prev?.disabled, true, "already on the first page");
  next?.click();
  assert.equal(harness.conversation.querySelector(".acw-interaction-pager-label")?.textContent, "Trang 2/2");
  const secondPage = harness.conversation.querySelectorAll(".acw-choice-button");
  assert.equal(secondPage.length, 2, "the last page holds only what is left, not a full page of blanks");
  secondPage[1]?.click(); // d8

  const resumed = await harness.approve();
  assert.deepEqual(JSON.parse(JSON.stringify(resumed.request.content)), { departments: ["d1", "d8"] },
    "d1, picked on the page since left behind, is still part of the answer");
});

test("a multiselect written with items.anyOf (an older tool's spelling, which the validator still accepts) renders titled choices too", async () => {
  const harness = await mount();
  const turn = await harness.start("Áp dụng phụ cấp cho nhiều phòng ban");
  await turn.finish({ content: "", outcome: "awaiting_interaction", interaction: {
    kind: "form", sessionId: turn.sessionId, interactionId: "interaction-departments-anyof", turnId: "turn-1", toolId: "sample-app.payroll/ask",
    requesterId: "sample-app", message: "Chọn các phòng ban áp dụng.", expiresAt: inTenMinutes(),
    requestedSchema: { type: "object", properties: {
      departments: { type: "array", title: "Phòng ban áp dụng", items: { anyOf: [
        { const: "d1", title: "Phòng Kế toán" },
        { const: "d2", title: "Phòng Nhân sự" },
      ] } },
    } },
  } });
  const choices = harness.conversation.querySelectorAll(".acw-choice-button");
  assert.deepEqual(choices.map((button) => button.textContent), ["Phòng Kế toán", "Phòng Nhân sự"],
    "items.anyOf renders exactly like items.oneOf — titles as labels, not the raw consts or an empty list");
  choices[1]?.click();
  const resumed = await harness.approve();
  assert.deepEqual(JSON.parse(JSON.stringify(resumed.request.content)), { departments: ["d2"] });
});

test("several questions present as tabs: a choice answer advances on its own, free text needs \"Tiếp theo\", and the last tab recaps everything before it sends", async () => {
  const harness = await mount();
  const turn = await harness.start("Ghi nhận nghỉ phép và cập nhật phụ cấp");
  await turn.finish({ content: "", outcome: "awaiting_interaction", interaction: {
    kind: "form", sessionId: turn.sessionId, interactionId: "interaction-multi", turnId: "turn-1", toolId: "sample-app.payroll/ask",
    requesterId: "sample-app", message: "Em cần thêm hai thông tin trước khi cập nhật.", expiresAt: inTenMinutes(),
    requestedSchema: {
      type: "object",
      properties: {
        budgetKindItemID: { type: "string", title: "Loại - Khoản", oneOf: [
          { const: "gdmn", title: "Giáo dục mầm non" },
          { const: "gdth", title: "Giáo dục tiểu học" },
        ] },
        note: { type: "string", title: "Ghi chú" },
      },
      required: ["budgetKindItemID", "note"],
    },
  } });
  const tabs = harness.conversation.querySelectorAll(".acw-interaction-tab");
  // Each tab is the question's own header chip — no numbering — and the last tab is "Xem lại",
  // the review tab (spec §7 Q4 / A17).
  assert.deepEqual(tabs.map((tab) => tab.textContent), ["Loại - Khoản", "Ghi chú", "Xem lại"]);
  assert.equal(tabs[0]?.dataset.active, "true", "the first question opens by default");

  // Confirming before every required question is answered refuses, and points at what is missing.
  harness.conversation.querySelector(".acw-approval-approve")?.click();
  assert.match(harness.conversation.querySelector(".acw-approval-status")?.textContent ?? "", /Loại - Khoản/u);

  const choice = harness.conversation.querySelectorAll(".acw-choice-button").find((button) => button.textContent === "Giáo dục tiểu học");
  choice?.click();
  assert.equal(tabs[1]?.dataset.active, "true", "a single click fully answers a choice, so it moves on by itself");
  assert.equal(tabs[0]?.dataset.answered, "true");

  const noteInput = harness.conversation.querySelector(".acw-interaction-field input");
  assert.ok(noteInput, "the free-text question has a real input, not buttons");
  noteInput.value = "Đã xác nhận với kế toán trưởng";
  noteInput.dispatchEvent({ type: "input" });
  assert.equal(tabs[2]?.dataset.active, "false", "typing alone does not submit the question");
  // The one a person can actually press: a choice field also carries a "Tiếp theo", kept hidden
  // until they pick "Khác", so selecting the first in the DOM would click an invisible button.
  harness.conversation.querySelectorAll(".acw-interaction-next").find((button) => button.hidden !== true)?.click();
  assert.equal(tabs[2]?.dataset.active, "true", "\"Tiếp theo\" is what moves on from free text");

  const summary = Object.fromEntries(
    harness.conversation.querySelectorAll(".acw-interaction-summary dt").map((term, index) => [
      term.textContent, harness.conversation.querySelectorAll(".acw-interaction-summary dd")[index]?.textContent,
    ]),
  );
  assert.deepEqual(summary, { "Loại - Khoản": "Giáo dục tiểu học", "Ghi chú": "Đã xác nhận với kế toán trưởng" },
    "the summary tab recaps titles and the chosen labels, not raw codes");

  // Clicking a tab directly always works too, not only the auto-advance/"Tiếp theo" path.
  tabs[0]?.click();
  assert.equal(tabs[0]?.dataset.active, "true");
  tabs[2]?.click();

  const resumed = await harness.approve();
  assert.deepEqual(JSON.parse(JSON.stringify(resumed.request.content)), { budgetKindItemID: "gdth", note: "Đã xác nhận với kế toán trưởng" },
    "the confirm button on the summary tab sends every question's answer together");
});

test("a free-text field with examples offers a few quick picks beside the input, and still accepts anything typed", async () => {
  const harness = await mount();
  const turn = await harness.start("Tăng phụ cấp Quang Huy lên 50%");
  await turn.finish({ content: "", outcome: "awaiting_interaction", interaction: {
    kind: "form", sessionId: turn.sessionId, interactionId: "interaction-suggest", turnId: "turn-1", toolId: "sample-app.payroll/ask",
    requesterId: "sample-app", message: "Anh/chị muốn tăng phụ cấp nào của anh Huy lên 50%?", expiresAt: inTenMinutes(),
    requestedSchema: { type: "object", properties: {
      benefitName: { type: "string", title: "Loại phụ cấp", examples: ["Phụ cấp ưu đãi nghề", "Phụ cấp trách nhiệm công việc", "Phụ cấp chức vụ"] },
    } },
  } });
  assert.equal(harness.has(".acw-interaction-tabs"), false, "one question has no review step");
  const chips = harness.conversation.querySelectorAll(".acw-choice-button");
  assert.deepEqual(chips.map((chip) => chip.textContent), ["Phụ cấp ưu đãi nghề", "Phụ cấp trách nhiệm công việc", "Phụ cấp chức vụ"]);
  const input = harness.conversation.querySelector(".acw-interaction-field input");
  assert.ok(input, "a suggestion is a shortcut into a real field, not a substitute for one");
  assert.equal(input.value, "", "no suggestion is picked yet");

  chips[1]?.click();
  assert.equal(input.value, "Phụ cấp trách nhiệm công việc", "tapping a chip fills the field rather than submitting on its own");
  assert.equal(harness.conversation.querySelectorAll(".acw-choice-button")[1]?.dataset.selected, "true");

  // None of the suggestions matched what the accountant actually meant: free text still works.
  input.value = "Phụ cấp độc hại";
  input.dispatchEvent({ type: "input" });
  assert.equal(harness.conversation.querySelectorAll(".acw-choice-button").every((chip) => chip.dataset.selected === "false"), true,
    "typing something the suggestions did not offer leaves none of them marked");

  const resumed = await harness.approve();
  assert.deepEqual(JSON.parse(JSON.stringify(resumed.request.content)), { benefitName: "Phụ cấp độc hại" },
    "a value outside the suggestions is still a valid, unrestricted answer");
});

test("a long kept draft shows as narration cut at 20 000 characters with an ellipsis, never withdrawn", async () => {
  const harness = await mount({ reducedMotion: true });
  const turn = await harness.start("Phân tích file");
  const draft = "Bước một đã xong. ".repeat(340);
  assert.ok(draft.length > 4_000 && draft.length < 20_000, "past the old 4 000 cap, under the new one");
  turn.emit(narration.start("kept"));
  for (let at = 0; at < draft.length; at += 700) turn.emit(narration.delta("kept", draft.slice(at, at + 700)));
  turn.emit(narration.end("kept"));
  assert.equal(harness.panel().timeline.map((entry) => entry.text).join(""), draft.trim(), "the whole draft stays as chat text");

  const huge = "x".repeat(19_500);
  turn.emit(narration.start("huge"), narration.delta("huge", huge), narration.delta("huge", "y".repeat(2_000)), narration.delta("huge", "never kept"), narration.end("huge"));
  const kept = harness.panel().timeline.at(-1)?.text ?? "";
  assert.equal(kept, `${huge}${"y".repeat(499)}…`, "cut at 20 000 characters in total, marked with an ellipsis, later words dropped");
  assert.equal(harness.panel().timeline.length, 2, "both narrations are still there");
  await turn.finish({ content: "Xong." });
  harness.widget.destroy();
});

test("reload of a turn waiting on the user tells the plan sentence the live turn told", async () => {
  const harness = await mount({ deferHistory: true, reducedMotion: true });
  const plan = (status: string) => ({ planId: "p", revision: 1, state: "active", steps: [{ id: "read", description: "Đọc hồ sơ", status }] });
  await harness.settleHistory([
    { role: "user", content: "Phân tích file", at: "2026-10-07T12:00:00Z" },
    { role: "assistant", content: "", status: "awaiting_interaction", at: "2026-10-07T12:05:00Z", turnId: "turn-1",
      work: { durationMs: 60000, plan: { planId: "p", state: "awaiting_user", steps: [{ id: "read", description: "Đọc hồ sơ", status: "in_progress" }] }, tools: [] },
      timeline: [{ type: "plan-updated", cause: "proposal", plan: plan("in_progress") }] },
  ]);
  assert.equal(harness.panel().live.sentence, "Em sẽ đọc hồ sơ.", "the cause survives the round trip, so the sentence is told again");
  harness.widget.destroy();
});

test("reload replays ordered narration and step outcomes, retains attachments, and keeps a partial turn stopped", async () => {
  const harness = await mount({ deferHistory: true, reducedMotion: true });
  const steps = [{ id: "read", description: "Đọc hồ sơ", status: "completed", outcome: "Đã xét 35 dòng, phát hiện 7 nhiệm vụ." }];
  await harness.settleHistory([
    { role: "user", content: "Phân tích file", at: "2026-10-07T12:00:00Z", attachments: [{ id: "file", name: "Dự toán.xlsx", type: "application/xlsx", size: 120, source: "picker" }] },
    { role: "assistant", content: "Còn biểu cần kiểm tra.", status: "partial", at: "2026-10-07T12:05:00Z", work: { durationMs: 300000, plan: { planId: "p", state: "stopped", steps }, tools: [] },
      timeline: [
        { type: "narration", content: "Đã mở hồ sơ." },
        { type: "plan-updated", cause: "restore", plan: { planId: "p", state: "active", steps: [{ id: "read", description: "Đọc hồ sơ", status: "in_progress" }] } },
        { type: "tool-started", callId: "read-call", label: "Đang đọc nguồn", workStepId: "read" },
        { type: "tool-completed", callId: "read-call", label: "Đã đọc 35 dòng", status: "succeeded" },
        { type: "narration", content: "Đã phân loại từng dòng." },
        { type: "plan-updated", cause: "terminal", plan: { planId: "p", state: "stopped", steps } },
      ] },
  ]);
  assert.equal(harness.count(".acw-user-attachment"), 1);
  assert.equal(harness.panel().summary, "Đã dừng khi chưa hoàn tất");
  const text = harness.foldBody().textContent;
  assert.match(text, /Đã mở hồ sơ/);
  assert.match(text, /Đã đọc 35 dòng/);
  assert.match(text, /Đã xét 35 dòng, phát hiện 7 nhiệm vụ/);
  assert.ok(text.indexOf("Đã phân loại từng dòng") < text.indexOf("Đã xét 35 dòng"));
  assert.ok(flat(harness.panel().timeline).every((entry) => entry.state !== "active"));
  harness.widget.destroy();
});

test("a kept draft narration carries the draft label live and from history; an ordinary narration does not", async () => {
  const harness = await mount();
  const turn = await harness.start("Tính lương tháng 8");
  turn.emit({ type: "assistant-narration-start", narrationId: "d1", audience: "user", kind: "draft" }, narration.delta("d1", "Em đã tính xong."), narration.end("d1"));
  turn.emit(narration.start("n1"), narration.delta("n1", "Em kiểm tra tiếp."), narration.end("n1"));
  assert.equal(harness.count('.acw-bubble[data-kind="draft"]'), 1, "only the draft is marked");
  assert.equal(harness.count('.acw-bubble[data-kind="draft"][data-draft-label="Bản nháp — đang rà soát và hoàn thiện"]'), 1);
  assert.equal(harness.count('.acw-bubble[data-message-kind="narration"]'), 2);

  const past = await mount({ deferHistory: true });
  await past.settleHistory([
    { role: "user", content: "Tính lương tháng 8", at: "2026-09-11T09:00:00.000Z" },
    { role: "assistant", content: "Em đã tạo bảng lương nháp.", at: "2026-09-11T09:00:21.000Z",
      narrations: [{ id: "n-1", audience: "user", content: "Em đã tính xong.", draft: true }, { id: "n-2", audience: "user", content: "Mình kiểm tra tiếp." }] },
  ]);
  assert.equal(past.count('.acw-bubble[data-kind="draft"][data-draft-label]'), 1, "replayed draft:true carries the label, the other narration does not");
  assert.equal(past.conversation.querySelector<HTMLElement>('.acw-bubble[data-kind="draft"]')?.hidden, true, "and the turn's answer hides it");
});

// A draft the review sent back (e.g. a closing question the review removed) misleads, so it is never shown: not live, not
// after the answer, not when the turn folds, not from history.
test("a draft the review sent back is never shown, live or after the answer", async () => {
  const harness = await mount();
  const turn = await harness.start("Tìm nhân viên Nguyễn Mẫu Một");
  const visibleDrafts = () => [...harness.conversation.querySelectorAll('.acw-bubble[data-kind="draft"]')].filter((element) => !(element as HTMLElement).hidden).length;
  turn.emit({ type: "assistant-narration-start", narrationId: "d1", audience: "user", kind: "draft" }, narration.delta("d1", "Anh/chị có cần em hỗ trợ thêm không?"), narration.end("d1"));
  turn.emit({ type: "assistant-narration-start", narrationId: "d2", audience: "user", kind: "draft" }, narration.delta("d2", "Chào anh/chị, em là Example Assistant."), narration.end("d2"));
  assert.equal(visibleDrafts(), 0, "not while the turn works");
  await turn.finish({ content: "Em không tìm thấy nhân viên Nguyễn Mẫu Một.", outcome: "completed" });
  assert.equal(visibleDrafts(), 0, "not after the answer, and not when the turn folds");
  assert.equal(harness.count('.acw-bubble[data-kind="draft"]:not([hidden])'), 0, "hidden by the attribute the widget CSS forces to display:none");
  harness.widget.destroy();
});

// A turn the review sends back several times (a kept policy: each attempt becomes a hidden draft narration) must not write
// and wipe the same sentence each time: not even the first attempt is written before the review accepts it.
test("a turn going round a review shows its sentence once, when accepted: every attempt before it waits behind the note", async () => {
  const harness = await mount();
  const turn = await harness.start("đọc file này thử xem có gì");
  const sorry = "Em rất tiếc, hiện tại em không thể đọc được nội dung tệp Excel anh/chị đính kèm.";
  const sentBack = (id: string): StreamEvent[] => [
    { type: "assistant-narration-start", narrationId: id, audience: "user", kind: "draft" }, narration.delta(id, sorry), narration.end(id), draft.end(id, "discarded"),
  ];
  turn.emit(draft.start("a1"), draft.delta("a1", sorry));
  reveal(harness);
  const bubble = harness.answer();
  assert.doesNotMatch(bubble.textContent, /rất tiếc/u, "the first attempt is not painted either");
  assert.equal(bubble.textContent, "Đang soạn câu trả lời…");
  turn.emit(...sentBack("a1"));
  assert.equal(bubble.hidden, false, "sent back, the bubble does not go blank");
  assert.equal(bubble.textContent, "Đang rà soát lại câu trả lời…", "it says the answer is under review");
  for (const id of ["a2", "a3"]) {
    turn.emit(draft.start(id), draft.delta(id, sorry));
    reveal(harness);
    assert.doesNotMatch(bubble.textContent, /rất tiếc/u, `${id} is not painted while it may still be sent back`);
    assert.equal(bubble.textContent, "Đang rà soát lại câu trả lời…");
    turn.emit(...sentBack(id));
    assert.doesNotMatch(bubble.textContent, /rất tiếc/u, `${id}, sent back too, never showed`);
  }
  // The runtime's closing step, accepted.
  turn.emit(draft.start("a4"), draft.delta("a4", sorry));
  reveal(harness);
  assert.doesNotMatch(bubble.textContent, /rất tiếc/u, "not before it is accepted either");
  turn.emit(draft.end("a4", "completed"));
  assert.match(bubble.textContent, /rất tiếc/u, "shown whole once accepted");
  assert.equal(bubble.querySelector(".acw-draft-note"), null);
  assert.equal(harness.count('.acw-bubble[data-kind="draft"]:not([hidden])'), 0, "no sent-back draft is on screen");
  await turn.finish({ content: sorry, outcome: "partial" });
  assert.equal(harness.count('.acw-bubble[data-kind="draft"]:not([hidden])'), 0);
  harness.widget.destroy();
});

test("held after a send-back, text that turns out to lead to work is still told, as narration", async () => {
  const harness = await mount();
  const turn = await harness.start("Tính lương tháng 9");
  turn.emit(draft.start("a1"), draft.delta("a1", "Kỳ 9 chưa có bảng lương."));
  reveal(harness);
  turn.emit({ type: "assistant-narration-start", narrationId: "a1", audience: "user", kind: "draft" }, narration.delta("a1", "Kỳ 9 chưa có bảng lương."), narration.end("a1"), draft.end("a1", "discarded"));
  turn.emit(draft.start("w1"), draft.delta("w1", "Em mở danh sách bảng lương tháng 9 để kiểm tra lại."));
  reveal(harness);
  assert.doesNotMatch(harness.answer().textContent, /danh sách bảng lương/u, "held while it could still be an answer");
  // The step called a tool: the runtime tells the same words as narration under the same id.
  turn.emit(narration.start("w1"), narration.delta("w1", "Em mở danh sách bảng lương tháng 9 để kiểm tra lại."), narration.end("w1"), draft.end("w1", "discarded"));
  // What is on screen: the timeline also carries the sent-back draft, hidden.
  const told = [...harness.conversation.querySelectorAll('.acw-bubble[data-message-kind="narration"]')]
    .filter((element) => !(element as HTMLElement).hidden).map((element) => element.textContent).join(" ");
  assert.match(told, /Em mở danh sách bảng lương tháng 9/u, "the work it announced is told, as any narration is");
  assert.doesNotMatch(told, /Kỳ 9 chưa có bảng lương/u, "the sent-back draft is not");
  await turn.finish({ content: "Đã có bảng lương tháng 9.", outcome: "completed" });
  harness.widget.destroy();
});

test("a permission is asked, not a form: what it changes is on the card, and one press on \"Cho phép\" or \"Từ chối\" answers it", async () => {
  const harness = await mount();
  const turn = await harness.start("Tăng phụ cấp trách nhiệm cho anh Quang Huy lên 50%");
  await turn.finish({ content: "", outcome: "awaiting_approval", approval: { ...approvalFor(turn.sessionId), presentation: {
    action: "Cập nhật phụ cấp", target: "Quang Huy — kỳ 08/2026", summary: "Tăng phụ cấp trách nhiệm.", impact: "Ghi vào hồ sơ lương.",
    fields: [{ label: "Mức mới", value: "50%" }],
  } } });
  const card = harness.conversation.querySelector(".acw-approval");
  assert.ok(card);
  assert.equal(card.querySelectorAll(".acw-interaction-tab").length, 0, "no tabs and no review step: that is the questions' form");
  assert.deepEqual(card.querySelectorAll(".acw-approval-actions button").map((button) => [button.dataset.choice, button.textContent]),
    [["deny", "Từ chối"], ["approve", "Cho phép"]]);
  assert.deepEqual(card.querySelectorAll(".acw-approval-fields dt").map((term) => term.textContent), ["Mức mới"], "what the write changes is shown on the card");
  const resumed = await harness.approve();
  assert.deepEqual([resumed.request.kind, resumed.request.decision], ["approval", "approve"], "the decision is still sent as {decision}");
  assert.equal(card.querySelectorAll(".acw-approval-actions button").every((button) => button.disabled), true, "answered once, locked");
});

// A follow-up about an earlier, unreadable file, where each lap loads a skill (shown in the product's phrase) and writes the
// same apology that the review sends back. What the reader sees: the apology once, when an attempt is accepted, never
// written and wiped; and the live line's chevron
// opens onto the plan's steps with those lookups under them — the product's phrase and a mark, nothing more, because a
// call's identity, arguments and result never reach the widget.
test("a follow-up going round a review: no write-and-wipe, and the checklist holds the step and its lookups only", async () => {
  resetPlanHelper();
  const harness = await mount();
  const turn = await harness.start("đọc lại xem nào");
  const sorry = "Em rất xin lỗi anh/chị, hiện tại em không đọc được tệp đính kèm.";
  const lookup = "Đang tra cứu quy trình nghiệp vụ…";
  let shown = 0, wiped = 0, was = false;
  const watch = () => {
    reveal(harness);
    const now = /xin lỗi/u.test(harness.answer().textContent ?? "") && !harness.answer().hidden;
    if (now && !was) shown += 1;
    if (!now && was) wiped += 1;
    was = now;
  };
  const sentBack = (id: string): StreamEvent[] => [
    { type: "assistant-narration-start", narrationId: id, audience: "user", kind: "draft" }, narration.delta(id, sorry), narration.end(id), draft.end(id, "discarded"),
  ];
  turn.emit(...sayText("n1", "Em sẽ đọc thông tin chung và danh sách sheet của tệp rồi tổng hợp."));
  turn.emit(...toolCall("s1", lookup));
  turn.emit(draft.start("a1"), draft.delta("a1", sorry)); watch();
  turn.emit(...sentBack("a1")); watch();
  turn.emit(plan(["restore", "Thử kích hoạt kỹ năng đối soát để khôi phục công cụ đọc tệp", "in_progress"],
    ["read", "Đọc thông tin chung", "pending"], ["analyze", "Phân tích dữ liệu chi tiết", "pending"], ["report", "Thông báo kết quả", "pending"]));
  turn.emit(...toolCall("s2", lookup, "restore"), ...toolCall("s3", lookup, "restore"));
  for (const id of ["a2", "a3"]) {
    turn.emit(draft.start(id), draft.delta(id, sorry)); watch();
    turn.emit(...sentBack(id)); watch();
  }
  harness.toggleDetail();
  assert.deepEqual(harness.panel().timeline.filter((entry) => entry.kind !== "narration"), [
    { kind: "work", state: "done", text: lookup },
    { kind: "step", state: "active", text: "Thử kích hoạt kỹ năng đối soát để khôi phục công cụ đọc tệp", rows: [
      { kind: "work", state: "done", text: lookup }, { kind: "work", state: "done", text: lookup }] },
    { kind: "step", state: "pending", text: "Đọc thông tin chung" },
    { kind: "step", state: "pending", text: "Phân tích dữ liệu chi tiết" },
    { kind: "step", state: "pending", text: "Thông báo kết quả" },
  ], "opened: the steps and the product's phrase for each lookup, with nothing of what a lookup found or why the file was not read");
  assert.equal(harness.count('.acw-bubble[data-kind="draft"]:not([hidden])'), 0, "no sent-back apology in the opened checklist either");
  harness.toggleDetail();
  turn.emit(draft.start("a4"), draft.delta("a4", sorry)); watch();
  turn.emit(draft.end("a4", "completed")); watch();
  assert.deepEqual([shown, wiped], [1, 0], "no attempt painted before it was accepted; the accepted one shown");
  await turn.finish({ content: sorry, outcome: "partial" });
  assert.match(harness.foldBody().textContent ?? "", /Thử kích hoạt kỹ năng đối soát[\s\S]*Đang tra cứu quy trình nghiệp vụ…/u, "folded, the same account");
  harness.widget.destroy();
});

// One request can run as several turns joined by permission cards, with the review sending answers back in any segment.
// Every answer waits until it is accepted, so a turn resumed after a card holds its answers the same way, and so does a
// new message.
test("a request split by a permission card holds every answer until accepted, before the card and after it, and so does a new message", async () => {
  const harness = await mount();
  const turn = await harness.start("Cập nhật phụ cấp cho 3 nhân viên");
  const early = "Em đã cập nhật xong phụ cấp cho cả 3 nhân viên.";
  const late = "Em đã cập nhật phụ cấp cho Lan và Huy.";
  const sentBack = (id: string, text: string): StreamEvent[] => [
    { type: "assistant-narration-start", narrationId: id, audience: "user", kind: "draft" }, narration.delta(id, text), narration.end(id), draft.end(id, "discarded"),
  ];
  const painted = (pattern: RegExp) => harness.conversation.querySelectorAll(".acw-bubble").some((bubble: StubNode) => !bubble.hidden && pattern.test(bubble.textContent ?? ""));
  // Segment 1: the request's first answer is held too, and goes back.
  turn.emit(draft.start("a1"), draft.delta("a1", early));
  reveal(harness);
  assert.equal(painted(/cả 3 nhân viên/u), false, "the request's first answer waits for the review");
  turn.emit(...sentBack("a1", early));
  await turn.finish({ content: "", outcome: "awaiting_approval", approval: approvalFor(turn.sessionId) });
  // Segment 2, after the card: its draft goes back too, and is never painted.
  const resumed = await harness.approve();
  resumed.emit(draft.start("b1"), draft.delta("b1", late));
  reveal(harness);
  assert.equal(painted(/Lan và Huy/u), false, "held after the card as well");
  resumed.emit(...sentBack("b1", late));
  reveal(harness);
  assert.equal(painted(/Lan và Huy/u), false, "sent back, it never showed");
  // The accepted answer shows whole.
  resumed.emit(draft.start("b2"), draft.delta("b2", late));
  reveal(harness);
  assert.equal(painted(/Lan và Huy/u), false, "not before it is accepted");
  resumed.emit(draft.end("b2", "completed"));
  assert.equal(painted(/Lan và Huy/u), true, "shown once accepted");
  await resumed.finish({ content: late, outcome: "completed" });
  // A new message is held the same way.
  const next = await harness.start("Còn chị Mai thì sao?");
  next.emit(draft.start("c1"), draft.delta("c1", "Chị Mai chưa có phụ cấp trách nhiệm."));
  reveal(harness);
  assert.equal(painted(/Chị Mai/u), false, "a new request's answer waits for the review too");
  next.emit(draft.end("c1", "completed"));
  assert.equal(painted(/Chị Mai/u), true);
  await next.finish({ content: "Chị Mai chưa có phụ cấp trách nhiệm.", outcome: "completed" });
  harness.widget.destroy();
});

// A stop is the person's own decision, not a failure: what the turn showed stays, open, under one neutral line.
const STOPPED = "Đã dừng xử lý theo yêu cầu.";
const toolStarted = (callId: string, label: string): StreamEvent => ({ type: "tool-started", turnId: "turn-2", callId, label });
const askPeriod = (sessionId: string) => ({
  kind: "form", sessionId, interactionId: "interaction-period", turnId: "turn-1", toolId: "sample-app.payroll/ask",
  requesterId: "sample-app", message: "Anh/chị chọn giúp em kỳ lương.", expiresAt: inTenMinutes(),
  requestedSchema: { type: "object", properties: { period: { type: "string", title: "Kỳ lương", oneOf: [
    { const: "07", title: "Tháng 07/2026" }, { const: "08", title: "Tháng 08/2026" }] } }, required: ["period"] },
});
/** Runs the shared middle of a turn: a plan step, a sentence, a call finished and a call still running, an answer gathering. */
const workThenGather = (turn: Turn, prefix: string): void => {
  turn.emit(plan([`${prefix}-s`, "Cập nhật phụ cấp", "in_progress"]), ...sayText(`${prefix}-n`, `Em ${prefix} đang cập nhật phụ cấp.`));
  turn.emit(...toolCall(`${prefix}-c1`, "Đã đọc hồ sơ nhân viên", `${prefix}-s`), toolStarted(`${prefix}-c2`, "Đang ghi phụ cấp…"));
  turn.emit(draft.start(`${prefix}-o`), draft.delta(`${prefix}-o`, "Em đã cập nhật xong cho cả 16 người."));
};
const assertStoppedInPlace = (harness: Harness, said: string, path: string): void => {
  const panel = harness.panel();
  assert.equal(panel.open, true, `${path}: the account stays open`);
  assert.equal(panel.headed, false, `${path}: nothing folds under a summary line`);
  assert.ok(panel.timeline.some((entry) => entry.kind === "narration" && entry.text === said), `${path}: what the turn said is still there`);
  assert.ok(flat(panel.timeline).some((entry) => entry.kind === "step"), `${path}: so is the step it was in`);
  assert.equal(flat(panel.timeline).some((entry) => entry.state === "active"), false, `${path}: nothing is left running`);
  assert.equal(panel.live.state === "active", false, `${path}: the live line is settled`);
  assert.equal(harness.answer().textContent.trim(), STOPPED, `${path}: one neutral line, and nothing of the answer never shown`);
  assert.equal(harness.answer().querySelector(".acw-draft-note"), null, `${path}: no note outlives the stop`);
  assert.equal(harness.has(".acw-error"), false, `${path}: nothing reads as a failure`);
  assert.equal(harness.count(".acw-stop-line"), 1, `${path}: the line is said once`);
};

test("a stop keeps what the turn showed, open, under one neutral line — a plain turn, an approval's resume and a form's resume", async () => {
  const plain = await mount();
  const turn = await plain.start("Cập nhật phụ cấp");
  workThenGather(turn, "plain");
  await turn.cancel();
  assertStoppedInPlace(plain, "Em plain đang cập nhật phụ cấp.", "plain turn");

  const approved = await mount();
  const asking = await approved.start("Cập nhật phụ cấp cho 16 người");
  await asking.finish({ content: "", outcome: "awaiting_approval", approval: approvalFor(asking.sessionId) });
  const resumed = await approved.approve();
  workThenGather(resumed, "approval");
  await resumed.cancel();
  assertStoppedInPlace(approved, "Em approval đang cập nhật phụ cấp.", "approval resume");

  const asked = await mount();
  const form = await asked.start("Tính lương");
  await form.finish({ content: "", outcome: "awaiting_interaction", interaction: askPeriod(form.sessionId) });
  asked.conversation.querySelectorAll(".acw-choice-button")[1]?.click();
  const answered = await asked.approve();
  workThenGather(answered, "form");
  await answered.cancel();
  assertStoppedInPlace(asked, "Em form đang cập nhật phụ cấp.", "form resume");
});

test("a stop keeps an answer already accepted, and the line goes under it", async () => {
  const harness = await mount();
  const turn = await harness.start("Cập nhật phụ cấp");
  turn.emit(draft.start("o1"), draft.delta("o1", "Em đã cập nhật xong."), draft.end("o1", "completed"));
  await turn.cancel();
  assert.match(harness.answer().textContent, /^Em đã cập nhật xong\.\s*Đã dừng xử lý theo yêu cầu\.$/u);
});

test("a card is settled with its decision once the server acted on it; before that it stays answerable, and a denial is unchanged", async () => {
  const card = (harness: Harness) => harness.conversation.querySelectorAll(".acw-approval").at(-1)!;
  const buttonsLive = (harness: Harness) => card(harness).querySelectorAll("button").some((button: StubNode) => !button.disabled);
  const status = (harness: Harness) => card(harness).querySelector(".acw-approval-status")?.textContent ?? "";
  const paused = async (): Promise<Harness> => {
    const harness = await mount();
    const turn = await harness.start("Cập nhật phụ cấp");
    await turn.finish({ content: "", outcome: "awaiting_approval", approval: approvalFor(turn.sessionId) });
    return harness;
  };

  // The approved write started: the server recorded the decision first, so the card says so, whatever ends the turn.
  for (const end of ["stop", "failure"] as const) {
    const harness = await paused();
    const resumed = await harness.approve();
    resumed.emit(activity("analysis", "analyzing"), toolStarted("write", "Đang ghi phụ cấp…"));
    if (end === "stop") await resumed.cancel(); else await resumed.fail("Không thể kết nối tới trợ lý.");
    assert.equal(status(harness), "Đã cho phép thao tác này.", `${end} after the write started: the card keeps its decision`);
    assert.equal(buttonsLive(harness), false, `${end} after the write started: no button left to press again`);
    assert.equal(card(harness).dataset.resolved, "true");
  }

  // The resume began, but nothing the server sends after recording the decision came: the card can be answered again.
  for (const end of ["stop", "failure"] as const) {
    const harness = await paused();
    const resumed = await harness.approve();
    resumed.emit(activity("analysis", "analyzing"), ...sayText("n1", "Em tiếp tục."));
    if (end === "stop") await resumed.cancel(); else await resumed.fail("Không thể kết nối tới trợ lý.");
    assert.equal(buttonsLive(harness), true, `${end} before any call: the card stays answerable`);
    assert.notEqual(card(harness).dataset.resolved, "true");
    assert.equal(status(harness), end === "stop" ? "Đã dừng; có thể thử lại." : "Không thể kết nối tới trợ lý.");
  }

  // A denial carries on nothing the card could show: stopped, it is answerable as before.
  const denied = await paused();
  const after = await denied.deny();
  after.emit(toolStarted("read", "Đang đọc hồ sơ…"));
  await after.cancel();
  assert.equal(buttonsLive(denied), true, "a stopped denial leaves the card answerable");
  assert.equal(status(denied), "Đã dừng; có thể thử lại.");

  // A form: its own resumed call is silent in the product, so the next call is the sign; its answers stay as the receipt.
  const asked = await mount();
  const form = await asked.start("Tính lương");
  await form.finish({ content: "", outcome: "awaiting_interaction", interaction: askPeriod(form.sessionId) });
  asked.conversation.querySelectorAll(".acw-choice-button")[1]?.click();
  const answered = await asked.approve();
  answered.emit(toolStarted("sheet", "Đang lấy bảng lương…"));
  await answered.cancel();
  assert.equal(status(asked), "Thông tin đã được tiếp nhận.");
  assert.equal(card(asked).querySelector(".acw-interaction-summary")?.textContent.includes("Tháng 08/2026"), true, "the receipt shows what was sent");
  assert.equal(buttonsLive(asked), false);
});

test("a card the server already answered opens no turn and shows no red; a superseded card still sends its answer on", async () => {
  const handled = "Yêu cầu này đã được xử lý hoặc đã được thay bằng tin nhắn mới hơn.";
  const harness = await mount();
  const turn = await harness.start("Cập nhật phụ cấp");
  await turn.finish({ content: "", outcome: "awaiting_approval", approval: approvalFor(turn.sessionId) });
  const resumed = await harness.approve();
  resumed.emit(activity("analysis", "analyzing"));
  await resumed.cancel();
  const rows = harness.count(".acw-assistant");
  // The stop raced the server's own record of the decision: the card is still offered, and the second press is refused.
  harness.refuseNextResume("already-resolved", handled);
  await harness.press("approve");
  assert.equal(harness.count(".acw-assistant"), rows, "no new row for a resume that never began");
  const card = harness.conversation.querySelectorAll(".acw-approval").at(-1)!;
  assert.equal(card.querySelector(".acw-approval-status")?.textContent, handled, "the card says, in the product's words, that it was handled");
  assert.equal(card.dataset.resolved, "true");
  assert.equal(card.querySelectorAll("button").every((button: StubNode) => button.disabled), true);
  assert.equal(harness.has(".acw-error"), false, "and nothing anywhere is red");
  assert.equal(harness.widget.isPending(), false);

  const late = await mount();
  const asking = await late.start("Cập nhật phụ cấp");
  await asking.finish({ content: "", outcome: "awaiting_approval", approval: approvalFor(asking.sessionId) });
  late.refuseNextResume("superseded", "Yêu cầu này không còn khớp với nội dung trao đổi mới nhất.");
  await late.press("approve");
  assert.match(String(late.lastRequest()?.content ?? ""), /^Cho phép/u, "the answer goes on as the person's next message (late-answer.ts)");
  late.widget.destroy();
});

test("a stopped turn reloads as it looked live: open, with its work and the neutral line, never folded or red", async () => {
  const harness = await mount({ deferHistory: true, reducedMotion: true });
  await harness.settleHistory([
    { role: "user", content: "Cập nhật phụ cấp", at: "2026-10-16T09:15:00.000Z" },
    { role: "assistant", content: STOPPED, at: "2026-10-16T09:21:30.000Z", status: "failed", failure: { code: "cancelled" }, turnId: "turn-1",
      work: { durationMs: 380_000, plan: { planId: "p", state: "stopped", steps: [{ id: "s", description: "Cập nhật phụ cấp", status: "in_progress" }] }, tools: [] },
      timeline: [
        { type: "plan-updated", cause: "proposal", plan: { planId: "p", state: "active", steps: [{ id: "s", description: "Cập nhật phụ cấp", status: "in_progress" }] } },
        { type: "narration", content: "Em đang cập nhật phụ cấp." },
        { type: "tool-started", callId: "c1", label: "Đang đọc hồ sơ nhân viên", workStepId: "s" },
        { type: "tool-completed", callId: "c1", label: "Đã đọc hồ sơ nhân viên", status: "succeeded" },
      ] },
  ]);
  const panel = harness.panel();
  assert.equal(panel.open, true, "open, as live");
  assert.equal(panel.headed, false, "with no summary line to fold under");
  assert.ok(panel.timeline.some((entry) => entry.kind === "narration" && entry.text === "Em đang cập nhật phụ cấp."));
  assert.equal(flat(panel.timeline).some((entry) => entry.state === "active"), false);
  assert.equal(harness.answer().textContent.trim(), STOPPED);
  assert.equal(harness.count(".acw-stop-line"), 1, "the same neutral line live shows");
  assert.equal(harness.has(".acw-error"), false);
  assert.equal(harness.has(".acw-message-actions button"), false, "a stop line is not an answer to copy");

  // Any other failure still folds, as before.
  const failed = await mount({ deferHistory: true, reducedMotion: true });
  await failed.settleHistory([
    { role: "user", content: "Cập nhật phụ cấp", at: "2026-10-16T09:15:00.000Z" },
    { role: "assistant", content: "Không thể hoàn tất yêu cầu lúc này.", at: "2026-10-16T09:16:00.000Z", status: "failed", failure: { code: "timeout" },
      work: { tools: [{ callId: "c1", label: "Đã đọc hồ sơ nhân viên", status: "succeeded" }] } },
  ]);
  assert.deepEqual([failed.panel().open, failed.panel().headed, failed.panel().summary], [false, true, "Đã kết thúc xử lý"]);
});

// A progressing step adds its sentence; only a step that ran without progress replaces the stuck sentence before it. The runtime says which narration left the chat once a step ran without progress; the widget drops exactly
// that one, never by its words, and a kept draft or a progressing sentence is untouched.
test("a narration the runtime supersedes leaves the chat once the step after it ran; a kept draft and a progressing sentence stay", async () => {
  const harness = await mount({ planSentence: false });
  const turn = await harness.start("Lập đợt chi trả tháng 9");
  const said = () => harness.panel().timeline.filter((entry) => entry.kind === "narration").map((entry) => entry.text);
  const superseded = (narrationId: string, by: string): StreamEvent => ({ type: "assistant-narration-superseded", narrationId, audience: "user", by });
  turn.emit(narration.start("n1"), narration.delta("n1", "Em tìm nút Lưu."), narration.end("n1"));
  turn.emit(working("call-1", "active", "Đang xem màn hình…"), working("call-1", "done", "Đã xem màn hình"));
  turn.emit(narration.start("n2"), narration.delta("n2", "Nút Lưu đang bị che."), narration.end("n2"));
  assert.deepEqual(said(), ["Em tìm nút Lưu.", "Nút Lưu đang bị che."], "both stay while the second step runs");
  turn.emit(working("call-2", "active", "Đang xem màn hình…"), working("call-2", "done", "Đã xem màn hình"), superseded("n1", "n2"));
  assert.deepEqual(said(), ["Nút Lưu đang bị che."], "its step ran without progress: the stuck sentence before it leaves");
  turn.emit({ type: "assistant-narration-start", narrationId: "d1", audience: "user", kind: "draft" }, narration.delta("d1", "Bản nháp."), narration.end("d1"));
  turn.emit(narration.start("n3"), narration.delta("n3", "Danh sách vẫn che nút Lưu."), narration.end("n3"), superseded("n2", "n3"));
  turn.emit(narration.start("n4"), narration.delta("n4", "Em đã đóng danh sách và bấm Lưu."), narration.end("n4"));
  assert.deepEqual(said(), ["Bản nháp.", "Danh sách vẫn che nút Lưu.", "Em đã đóng danh sách và bấm Lưu."],
    "the draft stays where it was; the progressing sentence follows the last stuck one");
  assert.equal(harness.count('.acw-bubble[data-kind="draft"]'), 1, "and the draft is still hidden");
  turn.emit(superseded("missing", "n4"));
  assert.equal(said().length, 3, "a name the turn does not hold drops nothing");

  await turn.finish({ content: "Đã lưu đợt chi trả." });
  assert.deepEqual(harness.panel().timeline.filter((entry) => entry.kind === "narration").map((entry) => entry.text),
    ["Bản nháp.", "Danh sách vẫn che nút Lưu.", "Em đã đóng danh sách và bấm Lưu."], "the folded account holds the same sentences");

  harness.widget.destroy();
});
