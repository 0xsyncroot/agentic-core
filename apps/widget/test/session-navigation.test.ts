import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { createStubDom } from "./dom-stub.js";

interface Page { sessions: { sessionId: string; title: string; createdAt: string }[]; nextCursor?: string }
const session = (id: string) => ({ sessionId: id, title: `Hồ sơ ${id}`, createdAt: "2026-10-07T12:00:00Z" });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function mount(loadHistory: (context: { sessionId: string; signal: AbortSignal }) => unknown = () => []) {
  const dom = createStubDom();
  const context = createContext({ ...dom.window, document: dom.document, URL, Headers, Response,
    TextDecoder, DOMException, AbortController, crypto,
    location: { origin: "https://example.test", href: "https://example.test/" },
    CustomEvent: class { constructor(readonly type: string, readonly detail?: unknown) {} },
  });
  Object.assign(context, { window: context, globalThis: context });
  new Script(await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8")).runInContext(context);
  const requests: { cursor?: string; query?: string; signal: AbortSignal; resolve(page: Page): void; reject(error: Error): void }[] = [];
  const widget = (context.AgentChat as { create(options: unknown): { destroy(): void; send(content: string): Promise<void> } }).create({
    persistSession: false, startOpen: true, sessionId: "initial-session",
    transport: { loadHistory, send: () => ({ content: "" }),
      loadSessions: (ctx: { signal: AbortSignal }, cursor?: string, query?: string) => new Promise<Page>((resolve, reject) => {
        requests.push({ cursor, query, signal: ctx.signal, resolve, reject });
      }),
    },
  });
  await tick();
  const node = (selector: string) => { const value = dom.body.querySelector(selector); assert.ok(value, selector); return value; };
  const open = () => node(".acw-menu-history").click();
  const list = node(".acw-session-list");
  list.clientHeight = 400; list.scrollHeight = 1600;
  const scroll = () => { list.scrollTop = 1200; list.dispatchEvent({ type: "scroll" }); };
  return { dom, requests, widget, node, open, scroll };
}

test("history scroll follows cursors once, preserves rows during loading and stops at the end", async () => {
  const h = await mount();
  try {
    h.open();
    assert.equal(h.dom.body.querySelectorAll(".acw-session-placeholder").length, 7);
    h.requests[0]!.resolve({ sessions: [session("one")], nextCursor: "cursor-A" }); await tick();
    h.scroll(); h.scroll();
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1]!.cursor, "cursor-A");
    assert.equal(h.dom.body.querySelectorAll(".acw-session-entry").length, 1);
    assert.equal(h.dom.body.querySelectorAll(".acw-session-placeholder").length, 3);
    h.requests[1]!.resolve({ sessions: [session("one"), session("two")] }); await tick();
    h.scroll(); h.dom.flushFrames();
    assert.equal(h.requests.length, 2);
    assert.equal(h.dom.body.querySelectorAll(".acw-session-entry").length, 2);
    assert.equal(h.dom.body.querySelectorAll(".acw-session-placeholder").length, 0);
    assert.equal(h.node(".acw-sessions-retry").hidden, true);
  } finally { h.widget.destroy(); }
});

test("failed pages require retry and a cyclic cursor cannot trigger a request loop", async () => {
  const h = await mount();
  try {
    h.open(); h.requests[0]!.resolve({ sessions: [session("one")], nextCursor: "A" }); await tick();
    h.scroll(); h.requests[1]!.reject(new Error("offline")); await tick();
    h.scroll(); h.dom.flushFrames();
    assert.equal(h.requests.length, 2);
    assert.equal(h.node(".acw-sessions-retry").hidden, false);
    h.node(".acw-sessions-retry").click();
    assert.equal(h.requests[2]!.cursor, "A");
    h.requests[2]!.resolve({ sessions: [session("two")], nextCursor: "B" }); await tick();
    h.scroll(); h.requests[3]!.resolve({ sessions: [session("three")], nextCursor: "A" }); await tick();
    h.scroll(); h.dom.flushFrames();
    assert.equal(h.requests.length, 4);
    assert.equal(h.node(".acw-sessions-retry").hidden, false);
    assert.equal(h.dom.body.querySelectorAll(".acw-session-entry").length, 2);
  } finally { h.widget.destroy(); }
});

test("closing aborts directory loads and a late response cannot overwrite a reopened list", async () => {
  const h = await mount();
  try {
    h.open(); h.node(".acw-browser-heading button").click();
    assert.equal(h.requests[0]!.signal.aborted, true);
    h.open();
    h.requests[0]!.resolve({ sessions: [session("stale")] }); await tick();
    assert.equal(h.dom.body.querySelectorAll(".acw-session-placeholder").length, 7);
    h.requests[1]!.resolve({ sessions: [session("fresh")] }); await tick();
    assert.equal(h.node(".acw-session-entry").dataset.sessionId, "fresh");
    h.node(".acw-session-entry").click(); await tick();
    assert.equal(h.node(".acw-session-browser").hidden, true);
    assert.equal(h.node(".acw-history-empty").textContent, "Cuộc trò chuyện này chưa có tin nhắn.");
    await h.widget.send("Tin nhắn đầu tiên");
    assert.equal(h.dom.body.querySelector(".acw-history-empty"), null);
  } finally { h.widget.destroy(); }
});

test("selecting another session ignores the previous session's late history response", async () => {
  const loads: { id: string; signal: AbortSignal; resolve(messages: unknown[]): void }[] = [];
  const h = await mount((ctx) => ctx.sessionId === "initial-session" ? [] : new Promise((resolve) => {
    loads.push({ id: ctx.sessionId, signal: ctx.signal, resolve });
  }));
  try {
    h.open(); h.requests[0]!.resolve({ sessions: [session("older")] }); await tick();
    h.node(".acw-session-entry").click();
    h.open(); h.requests[1]!.resolve({ sessions: [session("newer")] }); await tick();
    h.node(".acw-session-entry").click();
    assert.equal(loads[0]!.signal.aborted, true);
    loads[1]!.resolve([{ role: "user", content: "Nội dung phiên mới", at: "2026-10-07T12:00:00Z" }]); await tick();
    loads[0]!.resolve([{ role: "user", content: "Nội dung cũ đến muộn" }]); await tick();
    assert.equal(h.node(".acw-user .acw-bubble").textContent, "Nội dung phiên mới");
    assert.equal(h.dom.body.querySelectorAll(".acw-user").length, 1);
  } finally { h.widget.destroy(); }
});


test("calendar groups are plain headings over always-visible rows and survive another cursor page", async () => {
  const h = await mount();
  const dated = (id: string, days: number) => {
    const date = new Date(); date.setDate(date.getDate() - days);
    return { ...session(id), createdAt: date.toISOString() };
  };
  try {
    h.open();
    h.requests[0]!.resolve({ sessions: [dated("today", 0), dated("yesterday", 1), dated("week", 2)], nextCursor: "next" }); await tick();
    assert.equal(h.dom.body.querySelectorAll(".acw-session-list details, .acw-session-list summary").length, 0, "no group is a disclosure");
    assert.equal(h.dom.body.querySelectorAll(".acw-session-group svg").length, 0, "no chevron");
    assert.deepEqual(h.dom.body.querySelectorAll(".acw-session-group")[0]!.children.map(child => child.tagName), ["h3", "button"], "a heading is not a control");
    assert.equal(h.dom.body.querySelectorAll(".acw-session-heading button, .acw-session-heading a").length, 0);
    assert.equal(h.dom.body.querySelectorAll(".acw-session-entry").length, 3, "rows are present without any click");
    h.scroll();
    h.requests[1]!.resolve({ sessions: [dated("week-end", 7), dated("month", 8), dated("month-end", 30), dated("older", 31), dated("last-year", 400)] }); await tick();
    const groups = h.dom.body.querySelectorAll(".acw-session-group");
    assert.deepEqual(groups.slice(0, 4).map(g => g.querySelector(".acw-session-heading")!.textContent), ["Hôm nay", "Hôm qua", "Gần đây", "30 ngày trước"]);
    assert.equal(groups.length, 6);
    assert.equal(groups[0]!.querySelector(".acw-session-heading")!.tagName, "h3");
    assert.equal(groups[0]!.getAttribute("aria-label"), "Hôm nay");
    assert.equal(groups[2]!.querySelectorAll(".acw-session-entry").length, 2);
    assert.equal(groups[3]!.querySelectorAll(".acw-session-entry").length, 2);
    assert.match(groups[4]!.querySelector(".acw-session-heading")!.textContent, /^Tháng /);
    assert.match(groups[5]!.querySelector(".acw-session-heading")!.textContent, / năm /);
    h.node(".acw-browser-heading button").click();
    h.open();
    h.requests[2]!.resolve({ sessions: [dated("again", 0)] }); await tick();
    assert.equal(h.dom.body.querySelectorAll(".acw-session-entry").length, 1, "reopening starts from a visible list");
  } finally { h.widget.destroy(); }
});

test("the current conversation is marked on its row", async () => {
  const h = await mount();
  try {
    h.open();
    h.requests[0]!.resolve({ sessions: [session("initial-session"), session("other")] }); await tick();
    const rows = h.dom.body.querySelectorAll(".acw-session-entry");
    assert.deepEqual(rows.map(row => row.getAttribute("aria-current")), ["true", "false"]);
  } finally { h.widget.destroy(); }
});

test("history search resets the cursor and ignores stale pages, clearing restores the directory", async () => {
  const h = await mount();
  try {
    h.open();
    const input = h.node(".acw-session-filter input");
    input.value = "Dự toán"; input.dispatchEvent({ type: "input" });
    assert.equal(h.requests[0]!.signal.aborted, true);
    h.requests[0]!.resolve({ sessions: [session("stale")] }); await tick();
    assert.equal(h.dom.body.querySelectorAll(".acw-session-entry").length, 0);
    await new Promise(resolve => setTimeout(resolve, 280));
    assert.equal(h.requests[1]!.query, "Dự toán"); assert.equal(h.requests[1]!.cursor, undefined);
    h.requests[1]!.resolve({ sessions: [], nextCursor: "older-results" }); await tick();
    assert.doesNotMatch(h.node(".acw-browser-status").textContent, /Không tìm thấy/);
    h.scroll(); assert.equal(h.requests[2]!.cursor, "older-results"); assert.equal(h.requests[2]!.query, "Dự toán");
    h.requests[2]!.resolve({ sessions: [session("found")] }); await tick();
    assert.equal(h.node(".acw-session-entry").dataset.sessionId, "found");
    input.value = ""; input.dispatchEvent({ type: "input" });
    await new Promise(resolve => setTimeout(resolve, 280));
    assert.equal(h.requests[3]!.query, undefined); assert.equal(h.requests[3]!.cursor, undefined);
    h.requests[3]!.resolve({ sessions: [session("all")] }); await tick();
    assert.equal(h.node(".acw-session-entry").dataset.sessionId, "all");
  } finally { h.widget.destroy(); }
});
