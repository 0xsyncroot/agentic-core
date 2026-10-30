import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { createStubDom } from "./dom-stub.js";

/**
 * A backend that dies and comes back, as the panel sees it: the built bundle, its own HTTP
 * transport, and a fake fetch that can be switched down and up.
 *
 * A dead backend must not stack one "cannot connect" bubble per action plus an endless retry
 * line. These tests drive that failure end to end.
 */

/** Runs a scenario and always stops the widget: its recovery loop would otherwise keep the process alive. */
function scenario(name: string, run: (mount: typeof mountTracked) => Promise<void>): void {
  test(name, async () => {
    const opened: Array<{ widget: { destroy(): void } }> = [];
    try { await run(async (recovery) => { const h = await mount(recovery); opened.push(h); return h; }); }
    finally { for (const h of opened) h.widget.destroy(); }
  });
}
type Mounted = Awaited<ReturnType<typeof mount>>;
declare function mountTracked(recovery?: Record<string, number>): Promise<Mounted>;

const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

interface Wire { readonly url: string; readonly body: Record<string, unknown>; readonly lastEventId: string | null }

/** The runtime's own question at the end of a partial turn, as the gateway's result frame carries it. */
function runtimeQuestion(sessionId: unknown): Record<string, unknown> {
  return {
    kind: "form", interactionId: "runtime-question-1", sessionId, turnId: "turn-1", toolId: "runtime", requesterId: "runtime",
    message: "ASK?", expiresAt: new Date(Date.now() + 600_000).toISOString(),
    requestedSchema: { type: "object", required: ["next"], properties: { next: { type: "string", title: "ASK?", oneOf: [
      { const: "continue", title: "CONT" }, { const: "stop", title: "STOP" },
    ] } } },
  };
}

async function mount(recovery: Record<string, number> = {}) {
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const dom = createStubDom();
  const context = createContext({
    ...dom.window,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    document: dom.document, URL, Headers, Response, TextDecoder, DOMException, AbortController, setTimeout, clearTimeout, crypto,
    location: { origin: "https://app.example", href: "https://app.example/", assign: () => undefined },
    CustomEvent: class { readonly type: string; readonly detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
    Event: class { readonly type: string; constructor(type: string) { this.type = type; } },
  });
  (context as unknown as Record<string, unknown>).window = context;
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);
  const api = (context as unknown as { AgentChat: { create(o: Record<string, unknown>): { send(c: string): Promise<void>; isPending(): boolean; destroy(): void } } }).AgentChat;

  const state = { down: false, cutAfterFirstFrames: false, staysUp: false, outcome: undefined as string | undefined, asks: false, attempts: 0, runs: [] as Wire[], probes: 0 };
  const request = async (url: string, init: RequestInit): Promise<Response> => {
    if (new URL(url).pathname.endsWith("/runtime")) {
      state.probes += 1;
      if (state.down) throw new TypeError("connection refused");
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
    state.attempts += 1;
    if (state.down) throw new TypeError("connection refused");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const lastEventId = new Headers(init.headers).get("last-event-id");
    state.runs.push({ url, body, lastEventId });
    const reply = (id: number, delta: string) =>
      `id: ${id}\nevent: assistant-output-delta\ndata: ${JSON.stringify({ outputId: "a", audience: "user", delta })}\n\n`;
    if (state.cutAfterFirstFrames && !lastEventId) {
      // The backend dies after two frames: the stream breaks, and every request after fails.
      state.cutAfterFirstFrames = false;
      state.down = !state.staysUp;
      let sent = false;
      return new Response(new ReadableStream({
        pull(controller) {
          if (!sent) { sent = true; controller.enqueue(encoder.encode(
            `id: 1\nevent: assistant-output-start\ndata: {"outputId":"a","audience":"user"}\n\n${reply(2, "Xin ")}`)); return; }
          controller.error(new TypeError("connection reset"));
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    const first = lastEventId ? Number(lastEventId) : 0;
    // The partial turn's result carries the runtime's question; the answer's own turn asks nothing.
    const question = state.asks && body.kind === undefined ? `,"interaction":${JSON.stringify(runtimeQuestion(body.sessionId))}` : "";
    const frames = first >= 2
      ? `${reply(3, "chào")}id: 4\nevent: assistant-output-end\ndata: {"outputId":"a","audience":"user","status":"completed"}\n\nid: 5\nevent: result\ndata: {"content":"Xin chào"}\n\n`
      : `id: 1\nevent: assistant-output-start\ndata: {"outputId":"a","audience":"user"}\n\n${reply(2, "Xin chào")}id: 3\nevent: result\ndata: {"content":"Xin chào"${state.outcome ? `,"outcome":"${state.outcome}"` : ""}${question}}\n\n`;
    return new Response(frames, { headers: { "content-type": "text/event-stream" } });
  };
  const transport = api === undefined ? undefined : (context as unknown as { AgentChat: { createHarnessTransport(o: Record<string, unknown>): unknown } })
    .AgentChat.createHarnessTransport({
      baseUrl: "https://gateway.example", endpoints: { history: false }, request,
      reconnect: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, idleTimeoutMs: 0, headersTimeoutMs: 0 },
    });
  const widget = api.create({
    persistSession: false, startOpen: true, transport,
    connectionRecovery: { giveUpMs: 150, baseDelayMs: 5, maxDelayMs: 10, slowDelayMs: 20, probeTimeoutMs: 100, ...recovery },
    labels: { transportError: "ERR-BUBBLE", turnInterrupted: "INTERRUPTED", connectionLost: "LOST", connectionGaveUp: "GAVE-UP", connectionWaiting: "WAITING" },
  });
  const text = (selector: string) => dom.body.querySelectorAll(selector).filter((n) => !n.hidden).map((n) => n.textContent);
  return {
    state, widget, dom,
    banner: () => dom.body.querySelectorAll(".acw-link-banner").filter((n) => !n.hidden).length,
    bannerState: () => dom.body.querySelector(".acw-link-banner")?.dataset.state,
    /** Question cards still waiting for an answer; a settled card is locked and not counted. */
    openCards: () => dom.body.querySelectorAll(".acw-interaction").filter((n) => n.dataset.resolved !== "true"),
    tabs: () => dom.body.querySelectorAll(".acw-interaction-tab").map((n) => n.textContent),
    pick: (value: string) => dom.body.querySelector(`.acw-interaction [data-choice="${value}"]`)!.click(),
    submit: () => dom.body.querySelectorAll(".acw-interaction .acw-approval-approve").at(-1)!.click(),
    userBubbles: () => dom.body.querySelectorAll(".acw-user").length,
    errorRows: () => dom.body.querySelectorAll(".acw-error").length,
    retryingRows: () => dom.body.querySelectorAll('[data-code="retrying"][data-state="active"]').length,
    allText: () => dom.body.textContent,
    answers: () => text(".acw-assistant .acw-bubble"),
    placeholder: () => dom.body.querySelector(".acw-composer textarea")?.placeholder,
    async until(check: () => boolean, label: string) {
      for (let i = 0; i < 400 && !check(); i += 1) { dom.flushFrames(); await sleep(5); }
      dom.flushFrames();
      assert.ok(check(), `timed out waiting for: ${label}`);
    },
  };
}

scenario("two sends while the backend is down show one status line, not an error bubble each", async (mountWidget) => {
  const h = await mountWidget();
  h.state.down = true;
  void h.widget.send("một");
  await h.until(() => h.bannerState() === "offline", "the give-up state");
  await h.until(() => !h.widget.isPending(), "the first turn to end");
  assert.equal(h.errorRows(), 1, "the interrupted turn is the only error row");
  assert.ok(h.allText().includes("INTERRUPTED"));
  assert.ok(!h.allText().includes("ERR-BUBBLE"), "the generic transport sentence is not repeated");
  const attemptsBefore = h.state.attempts;
  void h.widget.send("hai");
  await sleep(60);
  assert.equal(h.state.attempts, attemptsBefore, "a held send does not even try the network");
  assert.equal(h.banner(), 1, "one banner, however many actions failed");
  assert.equal(h.errorRows(), 1, "the second send is held, not failed");
  assert.equal(h.placeholder(), "WAITING", "the composer says the send is waiting");
  assert.equal(h.retryingRows(), 0, "no retry row outlives the give-up");
});

scenario("a send held while offline is released once the backend answers", async (mountWidget) => {
  const h = await mountWidget();
  h.state.down = true;
  void h.widget.send("một");
  await h.until(() => h.bannerState() === "offline", "give-up");
  await h.until(() => !h.widget.isPending(), "first turn over");
  void h.widget.send("hai");
  await sleep(40);
  assert.equal(h.state.runs.length, 0, "nothing reached the backend while it was down");
  h.state.down = false;
  await h.until(() => h.state.runs.length === 1, "the held send to be delivered");
  await h.until(() => !h.widget.isPending(), "the held turn to finish");
  assert.equal(h.banner(), 0, "the status clears when the backend is back");
  assert.equal(h.state.runs[0]?.body.content, "hai");
});

scenario("an interrupted turn resumes after the outage with the same request id and last-event-id, without repeating output", async (mountWidget) => {
  const h = await mountWidget({ giveUpMs: 5_000 });
  h.state.cutAfterFirstFrames = true;
  const sending = h.widget.send("chào");
  await h.until(() => h.bannerState() === "reconnecting", "the reconnecting status");
  assert.ok(h.allText().includes("LOST"));
  h.state.down = false;
  await sending;
  assert.equal(h.state.runs.length, 2);
  assert.equal(h.state.runs[1]?.lastEventId, "2");
  assert.equal(h.state.runs[1]?.body.requestId, h.state.runs[0]?.body.requestId, "same identity so the server can deduplicate");
  assert.equal(h.banner(), 0);
  assert.equal(h.retryingRows(), 0);
  assert.equal(h.errorRows(), 0);
  assert.ok(!h.answers().some((t) => t.includes("Xin Xin")));
});

scenario("give-up releases the interrupted turn as one short failure and keeps a retry action", async (mountWidget) => {
  const h = await mountWidget();
  h.state.cutAfterFirstFrames = true;
  void h.widget.send("chào");
  await h.until(() => h.bannerState() === "offline", "give-up");
  await h.until(() => !h.widget.isPending(), "turn over");
  assert.equal(h.errorRows(), 1);
  assert.equal(h.retryingRows(), 0, "the retry row is cleared when reconnection gives up");
  const probesAtGiveUp = h.state.probes;
  await sleep(80);
  assert.ok(h.state.probes > probesAtGiveUp, "probing continues after give-up");
});

scenario("a retry the transport won on its own leaves no active retry row", async (mountWidget) => {
  const h = await mountWidget();
  h.state.cutAfterFirstFrames = true;
  h.state.staysUp = true;
  await h.widget.send("chào");
  assert.equal(h.state.runs.length, 2, "the transport resumed by itself");
  assert.equal(h.retryingRows(), 0, "no row is left saying it is still retrying");
  assert.equal(h.banner(), 0);
});

scenario("the retry button probes at once and clears the status when the backend is back", async (mountWidget) => {
  const h = await mountWidget({ slowDelayMs: 60_000 });
  h.state.down = true;
  void h.widget.send("một");
  await h.until(() => h.bannerState() === "offline", "give-up");
  await h.until(() => !h.widget.isPending(), "turn over");
  h.state.down = false;
  const retry = h.dom.body.querySelector(".acw-link-retry");
  assert.ok(retry && !retry.hidden, "a single retry action is offered");
  retry.click();
  await h.until(() => h.banner() === 0, "the status to clear after the retry");
});

scenario("the runtime's question at the end of a partial turn is one form card with its question and send button, no review step", async (mountWidget) => {
  const h = await mountWidget();
  h.state.outcome = "partial";
  h.state.asks = true;
  await h.widget.send("làm đi");
  assert.deepEqual(h.answers(), ["Xin chào"], "the partial answer stays above the card");
  assert.equal(h.openCards().length, 1);
  assert.equal(h.openCards()[0]?.dataset.requesterId, "runtime", "a stable hook names who asked");
  assert.deepEqual(h.tabs(), [], "one question needs no tab and no review");
  const submit = h.dom.body.querySelector(".acw-interaction .acw-approval-approve")!;
  assert.equal(submit.hidden, false, "the send button is on the card");
  assert.equal(submit.disabled, true, "and waits for the required answer");
  h.pick("continue");
  assert.equal(submit.disabled, false, "one click answers the choice and the card can be sent");
});

scenario("answering it resumes the same task through resolveInteraction, never as a message the user typed", async (mountWidget) => {
  const h = await mountWidget();
  h.state.outcome = "partial";
  h.state.asks = true;
  await h.widget.send("làm đi");
  const bubbles = h.userBubbles();
  h.state.outcome = undefined;
  h.pick("continue");
  h.submit();
  await h.until(() => h.state.runs.length === 2, "the answer to reach the gateway");
  await h.until(() => !h.widget.isPending(), "the resumed turn to finish");
  const answer = h.state.runs[1]!;
  assert.match(answer.url, /\/api\/interactions\/runtime-question-1\/stream$/u);
  assert.deepEqual([answer.body.kind, answer.body.action, answer.body.content], ["form", "accept", { next: "continue" }]);
  assert.equal(h.userBubbles(), bubbles, "no user bubble for the answer");
  assert.equal(h.openCards().length, 0, "the answered card is locked");
  const receipt = h.dom.body.querySelectorAll(".acw-interaction > .acw-interaction-summary").at(-1);
  assert.deepEqual([receipt?.querySelector("dt")?.textContent, receipt?.querySelector("dd")?.textContent], ["ASK?", "CONT"],
    "the settled card reads the answer back, as history does");
});

scenario("a normally completed turn asks nothing", async (mountWidget) => {
  const h = await mountWidget();
  await h.widget.send("một");
  h.state.outcome = "partial";
  await h.widget.send("hai");
  assert.equal(h.openCards().length, 0, "a partial turn without the runtime's question shows no card of the widget's own");
});
