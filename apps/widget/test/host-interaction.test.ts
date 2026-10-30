import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { StubNode, createStubDom } from "./dom-stub.js";

/**
 * A host that answers some question cards itself (`onInteractionChange`, `answerInteraction`), through the built bundle:
 * it is told which form card is waiting, it can answer with a value the card does not show (`readOnly`), and nothing
 * else — a wrong id, an expired card, a busy widget — is ever sent.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const MARKER = "x-host-watch";

function card(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "form", interactionId: "review-1", sessionId, turnId: "turn-1", toolId: "test_review", requesterId: "test_review",
    title: "Item 1/3", message: "Review it and save it in the other window.", expiresAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    requestedSchema: { type: "object", required: ["review"], [MARKER]: { item: "a-1", await: "save" }, "x-host-answerable": true, properties: {
      review: { type: "string", title: "Item 1/3", oneOf: [{ const: "saved", title: "SAVED-BY-PAGE", readOnly: true }, { const: "done", title: "DONE" }, { const: "stop", title: "STOP" }] },
      item: { type: "string", title: "Item id", readOnly: true },
    } },
    ...extra,
  };
}

interface Sent { readonly kind: string; readonly request: Record<string, unknown> }

async function mount(options: { readonly history?: readonly Record<string, unknown>[] } = {}) {
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const dom = createStubDom();
  const context = createContext({
    ...dom.window, matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    document: dom.document, URL, Headers, Response, TextDecoder, DOMException, AbortController, setTimeout, clearTimeout, crypto, Element: StubNode,
    location: { origin: "https://app.example", href: "https://app.example/", assign: () => undefined },
    CustomEvent: class { readonly type: string; readonly detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
    Event: class { readonly type: string; constructor(type: string) { this.type = type; } },
  });
  const scope = context as unknown as Record<string, unknown>;
  scope.window = context; scope.globalThis = context;
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);
  const api = scope.AgentChat as { create(o: Record<string, unknown>): Widget };
  const sent: Sent[] = [];
  const reports: (Record<string, unknown> | null)[] = [];
  const links: string[] = [];
  const state = { reply: {} as Record<string, unknown>, hold: undefined as Promise<void> | undefined, fail: false };
  const deliver = (kind: string) => async (request: Record<string, unknown>) => {
    sent.push({ kind, request });
    await state.hold;
    if (state.fail) throw new Script("new TypeError('network down')").runInContext(context);
    return { content: "ok", ...state.reply };
  };
  const widget = api.create({
    persistSession: false, startOpen: true, sessionId: "session-host",
    transport: { checkConnection: () => ({ status: "ok" }), loadHistory: () => options.history ?? [], send: deliver("turn"), resolveInteraction: deliver("interaction") },
    onInteractionChange: (pending: Record<string, unknown> | null) => reports.push(pending ? JSON.parse(JSON.stringify(pending)) : null),
    onLinkClick: (link: { href: string }) => { links.push(link.href); return false; },
  });
  return {
    dom, widget, sent, reports, state, links,
    choices: () => dom.body.querySelectorAll(".acw-interaction [data-choice]").map((node) => node.dataset.choice),
    openCards: () => dom.body.querySelectorAll(".acw-interaction").filter((node) => node.dataset.resolved !== "true"),
    receipt: () => { const list = dom.body.querySelectorAll(".acw-interaction > .acw-interaction-summary").at(-1); return [list?.querySelector("dt")?.textContent, list?.querySelector("dd")?.textContent]; },
    async settle() { for (let i = 0; i < 20; i += 1) { dom.flushFrames(); await sleep(2); } },
  };
}

interface Widget { send(content: string): Promise<void>; answerInteraction(id: string, content: Record<string, unknown>): Promise<boolean>; isPending(): boolean; newSession(): void; destroy(): void }

test("a live card is reported with its own schema, hides a readOnly choice, and takes the host's answer as the person's", async () => {
  const h = await mount();
  try {
    h.state.reply = { interaction: card("session-host") };
    await h.widget.send("go");
    await h.settle();
    assert.equal(h.reports.length, 1);
    assert.deepEqual([h.reports[0]?.interactionId, h.reports[0]?.toolId], ["review-1", "test_review"]);
    assert.deepEqual((h.reports[0]?.requestedSchema as Record<string, unknown>)[MARKER], { item: "a-1", await: "save" }, "the tool's own keyword reaches the host");
    assert.deepEqual(h.choices(), ["done", "stop"], "a readOnly choice is never a button");
    assert.deepEqual(h.dom.body.querySelectorAll(".acw-interaction-tab").map((tab) => tab.textContent), [], "a readOnly field is no question either, so the one left needs no review");
    assert.equal(await h.widget.answerInteraction("review-2", { review: "saved" }), false, "another card's id sends nothing");
    h.state.reply = {};
    assert.equal(await h.widget.answerInteraction("review-1", { review: "saved", item: "a-1" }), true);
    await h.settle();
    const answer = h.sent.at(-1)!;
    assert.deepEqual([answer.kind, answer.request.interactionId, answer.request.action, answer.request.content], ["interaction", "review-1", "accept", { review: "saved", item: "a-1" }]);
    assert.equal(h.openCards().length, 0, "the answered card is locked");
    assert.deepEqual(h.receipt(), ["Item 1/3", "SAVED-BY-PAGE"], "the receipt reads the hidden choice's title, as the server's echo does");
    assert.equal(h.reports.at(-1), null, "nothing is pending any more");
    assert.equal(await h.widget.answerInteraction("review-1", { review: "saved" }), false, "an answered card cannot be answered twice");
  } finally { h.widget.destroy(); }
});

test("a card is not answered while a turn runs", async () => {
  const h = await mount();
  try {
    h.state.reply = { interaction: card("session-host") };
    await h.widget.send("go");
    await h.settle();
    let release!: () => void;
    h.state.hold = new Promise((resolve) => { release = resolve; });
    h.state.reply = {};
    const busy = h.widget.send("something else");
    await sleep(5);
    assert.equal(h.widget.isPending(), true);
    assert.equal(await h.widget.answerInteraction("review-1", { review: "saved" }), false, "a running turn is never interrupted by a host answer");
    release(); await busy; h.state.hold = undefined;
    await h.settle();
    assert.equal(h.sent.filter((entry) => entry.kind === "interaction").length, 0, "nothing was ever sent for it");
  } finally { h.widget.destroy(); }
});

// A card past its time is no
// longer the host's to answer and no longer resumes the paused turn, but the person's answer still reaches the agent: it goes
// as their next message.
test("a card whose time runs out is reported gone, and the person's answer to it goes as their next message", async () => {
  const h = await mount();
  try {
    h.state.reply = { interaction: card("session-host", { expiresAt: new Date(Date.now() + 120).toISOString() }) };
    await h.widget.send("go");
    await h.settle();
    assert.equal(h.reports.at(-1)?.interactionId, "review-1");
    await sleep(200); await h.settle();
    assert.equal(h.reports.at(-1), null);
    assert.equal(await h.widget.answerInteraction("review-1", { review: "saved" }), false, "the host no longer answers it");
    assert.equal(h.openCards().length, 1, "the person still can");
    assert.match(h.dom.body.querySelector(".acw-interaction .acw-approval-status")?.textContent ?? "", /tin nhắn mới/u);
    h.state.reply = {};
    h.dom.body.querySelector('.acw-interaction [data-choice="done"]')!.click();
    h.dom.body.querySelectorAll(".acw-interaction .acw-approval-approve").at(-1)!.click();
    await h.settle();
    assert.deepEqual(h.sent.filter((entry) => entry.kind === "interaction"), [], "nothing is sent to the expired card");
    assert.equal(h.sent.at(-1)?.kind, "turn");
    assert.equal(JSON.stringify(h.sent.at(-1)?.request).includes("DONE"), true, "the answer as the person read it");
    assert.equal(h.openCards().length, 0, "the card is settled");
  } finally { h.widget.destroy(); }
});

test("skipping a card past its time tells the agent so, as a message", async () => {
  const h = await mount();
  try {
    h.state.reply = { interaction: card("session-host", { expiresAt: new Date(Date.now() + 60).toISOString() }) };
    await h.widget.send("go");
    await h.settle();
    await sleep(120); await h.settle();
    h.state.reply = {};
    h.dom.body.querySelectorAll(".acw-interaction .acw-approval-deny").at(-1)!.click();
    await h.settle();
    assert.deepEqual(h.sent.filter((entry) => entry.kind === "interaction"), []);
    assert.equal(JSON.stringify(h.sent.at(-1)?.request).includes("Bỏ qua câu hỏi: Item 1/3"), true, JSON.stringify(h.sent.at(-1)));
  } finally { h.widget.destroy(); }
});

test("a pending card loaded from history is reported, and a new conversation reports none", async () => {
  const h = await mount({ history: [
    { role: "user", content: "go", at: new Date().toISOString() },
    { role: "assistant", content: "Item 1/3: open it", at: new Date().toISOString(), turnId: "turn-1", status: "completed", interaction: card("session-host", { state: "pending" }) },
  ] });
  try {
    for (let i = 0; i < 50 && !h.reports.length; i += 1) await h.settle();
    assert.equal(h.reports.find((report) => report?.interactionId === "review-1")?.toolId, "test_review", "a reload re-arms the host");
    h.widget.newSession();
    await h.settle();
    assert.equal(h.reports.at(-1), null, "a new conversation has nothing pending");
  } finally { h.widget.destroy(); }
});

test("a Markdown link in a card's message is rendered as a link, and nothing else in it is markup", async () => {
  const h = await mount();
  try {
    h.state.reply = { interaction: card("session-host", { message: "[Open item <1>](https://app.example/items/a-1) — review it *now*." }) };
    await h.widget.send("go");
    await h.settle();
    const description = h.dom.body.querySelector(".acw-interaction .acw-approval-description")!;
    const anchor = description.querySelector("a")!;
    assert.equal(anchor.getAttribute("href"), "https://app.example/items/a-1");
    assert.equal(anchor.textContent, "Open item <1>");
    assert.match(description.textContent ?? "", /review it \*now\*\./u, "emphasis stays as written: only links are read");
    // Opened by the conversation's one link handler, as an answer's link is (onLinkClick first): the stub has no anchor `href` to follow.
    assert.equal(anchor.getAttribute("target"), null, "a link into the host page has no new-tab target");
  } finally { h.widget.destroy(); }
});

test("only a card whose tool opted in can be answered by the host: not an ordinary question, an approval or an external step", async () => {
  const h = await mount();
  try {
    const plain = card("session-host", { interactionId: "plain-1" });
    delete (plain.requestedSchema as Record<string, unknown>)["x-host-answerable"];
    h.state.reply = { interaction: plain };
    await h.widget.send("go");
    await h.settle();
    assert.equal(h.reports.length, 0, "a card without the opt-in is never reported");
    assert.equal(await h.widget.answerInteraction("plain-1", { review: "done" }), false);
    h.state.reply = { approval: { kind: "approval", approvalId: "approval-1", sessionId: "session-host", turnId: "turn-2", toolId: "write", requesterId: "write",
      title: "Write", summary: "Write it", risk: "medium", expiresAt: new Date(Date.now() + 600_000).toISOString(), actionDigest: "d", policyRevision: "p" } };
    await h.widget.send("write");
    await h.settle();
    assert.equal(await h.widget.answerInteraction("approval-1", { decision: "approve" }), false, "an approval is the person's");
    h.state.reply = { interaction: { ...card("session-host", { interactionId: "ext-1", requestedSchema: undefined }), kind: "external", url: "https://idp.example/login", externalId: "x-1" } };
    await h.widget.send("login");
    await h.settle();
    assert.equal(await h.widget.answerInteraction("ext-1", {}), false, "an external step is the person's");
    assert.equal(h.sent.filter((entry) => entry.kind === "interaction").length, 0, "nothing was ever sent for them");
  } finally { h.widget.destroy(); }
});

test("a failed send leaves the card answerable and reported: the host sends again", async () => {
  const h = await mount();
  try {
    h.state.reply = { interaction: card("session-host") };
    await h.widget.send("go");
    await h.settle();
    h.state.fail = true;
    assert.equal(await h.widget.answerInteraction("review-1", { review: "saved", item: "a-1" }), true);
    await h.settle();
    assert.equal(h.reports.at(-1)?.interactionId, "review-1", "never reported gone while the send failed");
    h.state.fail = false; h.state.reply = {};
    assert.equal(await h.widget.answerInteraction("review-1", { review: "saved", item: "a-1" }), true, "the same card takes the answer again");
    await h.settle();
    assert.equal(h.reports.at(-1), null);
    assert.equal(h.sent.filter((entry) => entry.kind === "interaction").length, 2);
  } finally { h.widget.destroy(); }
});
