import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { createStubDom } from "./dom-stub.js";

/**
 * Adding a sentence to a turn that is still running, through the built bundle.
 *
 * The behaviour worth pinning is the part a user feels: the composer stays usable while the agent
 * works, pressing Enter with words in it adds to the turn instead of killing it, and a sentence
 * the turn would not take is said to be refused rather than left on screen looking delivered.
 */

interface Widget {
  open(): void;
  close(): void;
  setCompactMode(compact: boolean): void;
  setDraft(content: string): void;
  interject(content: string): Promise<boolean>;
  isPending(): boolean;
  destroy(): void;
}

test("compact mode uses the same avatar and running turn, expands on click and restores on completion", async () => {
  const harness = await mount();
  try {
    await startTurn(harness);
    const panel = harness.dom.document.querySelector(".acw-panel")!;
    const avatar = harness.dom.document.querySelector(".acw-launcher")!;
    const status = harness.dom.document.querySelector(".acw-compact-status")!;
    harness.widget.setDraft("lời bổ sung đang soạn");
    harness.widget.setCompactMode(true);
    assert.equal(panel.hidden, true);
    assert.equal(avatar.hidden, false);
    assert.equal(status.hidden, false);
    assert.equal(harness.widget.isPending(), true);
    avatar.dispatchEvent({ type: "click" });
    assert.equal(panel.hidden, false);
    assert.equal(status.hidden, true);
    assert.equal(harness.draft(), "lời bổ sung đang soạn");
    harness.widget.setCompactMode(true);
    assert.equal(await harness.widget.interject("chỉ đọc ô đang chọn"), true);
    await harness.finishTurn();
    assert.equal(panel.hidden, false);
    assert.equal(avatar.hidden, true);
    assert.equal(status.hidden, true);
    assert.ok(harness.text().indexOf("chỉ đọc ô đang chọn") < harness.text().lastIndexOf("xong"));
  } finally { harness.widget.destroy(); }
});

test("destroying a compact widget resets the host's presentation before detaching", async () => {
  const changes: boolean[] = [];
  const harness = await mount({ onCompactChange: compact => changes.push(compact) });
  await startTurn(harness);
  harness.widget.setCompactMode(true);
  harness.widget.destroy();
  assert.deepEqual(changes, [true, false]);
  await harness.finishTurn();
});

test("closing the compact assistant is respected when the turn finishes", async () => {
  const harness = await mount();
  try {
    await startTurn(harness);
    harness.widget.setCompactMode(true);
    harness.widget.close();
    await harness.finishTurn();
    assert.equal(harness.dom.document.querySelector(".acw-panel")!.hidden, true);
    assert.equal(harness.dom.document.querySelector(".acw-compact-status")!.hidden, true);
  } finally { harness.widget.destroy(); }
});

async function mount(options: { readonly duringInterject?: (content: string) => void; readonly canInterject?: boolean; readonly settleNow?: boolean; readonly uploadFails?: boolean; readonly onCompactChange?: (compact: boolean) => void } = {}) {
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const dom = createStubDom();
  const context = createContext({
    ...dom.window,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    document: dom.document, URL, Headers, Response, TextDecoder, DOMException,
    AbortController, AbortSignal, setTimeout, clearTimeout, crypto,
    location: { origin: "https://example.test", href: "https://example.test/app/", assign: () => undefined },
    CustomEvent: class { readonly type: string; readonly detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
    Event: class { readonly type: string; constructor(type: string) { this.type = type; } },
  });
  const scope = context as unknown as Record<string, unknown>;
  scope.window = context;
  scope.globalThis = context;
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);

  const taken: { content: string; requestId: string; operation: string }[] = [];
  const sent: string[] = [];
  let accept = true;
  let onEvent: ((event: unknown) => void) | undefined;
  let settleTurn!: () => void;
  const running = new Promise<void>((resolve) => { settleTurn = resolve; });
  const transport: Record<string, unknown> = {
    checkConnection: async () => ({ status: "ok" }),
    loadHistory: async () => [],
    send: async (request: Record<string, unknown>, sendContext: { onEvent: (event: unknown) => void }) => {
      sent.push(JSON.stringify(request));
      onEvent = sendContext.onEvent;
      if (!options.settleNow) await running;
      return { content: "xong", sessionId: String(request.sessionId), turnId: "t1", outcome: "completed" };
    },
  };
  if (options.canInterject !== false) {
    transport.interjectTurn = async (request: { content: string }, operationContext: { requestId: string; operation: string }) => {
      taken.push({ content: request.content, requestId: operationContext.requestId, operation: operationContext.operation });
      options.duringInterject?.(request.content);
      return accept;
    };
  }
  const api = (context as unknown as { AgentChat: { create(options: Record<string, unknown>): Widget } }).AgentChat;
  const widget = api.create({
    transport, sessionId: "session-a",
    onCompactChange: options.onCompactChange,
    ...(options.uploadFails
      ? { uploadAttachment: async () => { throw new Error("upload failed: tên tệp không gửi được"); } }
      : {}),
  });
  widget.open();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    widget, taken, dom, sent,
    submit: (content: string) => {
      const input = dom.document.querySelector("textarea") as unknown as { value: string; dispatchEvent(event: unknown): void };
      input.value = content;
      input.dispatchEvent({ type: "input" });
      (dom.document.querySelector("form") as unknown as { dispatchEvent(event: unknown): void }).dispatchEvent({ type: "submit", preventDefault: () => undefined });
      return new Promise((resolve) => setTimeout(resolve, 0));
    },
    refuseNext: () => { accept = false; },
    progress: (progress: unknown) => onEvent?.({ type: "progress", progress }),
    finishTurn: () => { settleTurn(); return new Promise((resolve) => setTimeout(resolve, 0)); },
    text: () => dom.document.body.textContent ?? "",
    composerDisabled: () => Boolean((dom.document.querySelector("textarea") as { disabled?: boolean } | null)?.disabled),
    draft: () => String((dom.document.querySelector("textarea") as { value?: string } | null)?.value ?? ""),
  };
}

async function startTurn(harness: Awaited<ReturnType<typeof mount>>): Promise<void> {
  void (harness.widget as unknown as { send(content: string): Promise<void> }).send("lập biểu chi thường xuyên");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.widget.isPending(), true, "the turn should be running for the rest of this test");
}

test("the composer stays usable while a turn runs, and what is typed reaches that turn", async () => {
  const harness = await mount();
  try {
    await startTurn(harness);
    assert.equal(harness.composerDisabled(), false, "a user watching the agent go wrong must be able to type");

    const accepted = await harness.widget.interject("nhầm sheet rồi, lấy ở PT CTX");
    assert.equal(accepted, true);
    assert.equal(harness.taken.length, 1);
    assert.equal(harness.taken[0]!.content, "nhầm sheet rồi, lấy ở PT CTX");
    assert.equal(harness.taken[0]!.operation, "interject");
    assert.ok(harness.taken[0]!.requestId, "it must name the turn it is being added to");
    assert.ok(harness.text().includes("nhầm sheet rồi"), "the words appear as the user's own message");
    assert.equal(harness.draft(), "", "the composer is cleared, like any sent message");
    assert.ok(harness.text().indexOf("nhầm sheet rồi") < harness.text().lastIndexOf("Thinking…"),
      "added words appear before the answer that is still running");
    assert.equal(await harness.widget.interject("chỉ đọc, không sửa dữ liệu"), true);
    await harness.finishTurn();
    const conversation = harness.text();
    assert.ok(conversation.indexOf("nhầm sheet rồi") < conversation.indexOf("chỉ đọc, không sửa dữ liệu"),
      "several additions retain their order");
    assert.ok(conversation.indexOf("chỉ đọc, không sửa dữ liệu") < conversation.lastIndexOf("xong"),
      "the settled answer follows every addition, with each message shown once");
  } finally { harness.widget.destroy(); }
});

test("a turn that would not take it says so, instead of leaving it looking delivered", async () => {
  const harness = await mount();
  try {
    await startTurn(harness);
    harness.refuseNext();
    const accepted = await harness.widget.interject("quá muộn");
    assert.equal(accepted, false);
    assert.ok(harness.text().includes("quá muộn"), "the user's words stay on screen — they did type them");
    assert.ok(/did not reach the current request/u.test(harness.text()),
      `the refusal has to be visible beside them: ${harness.text().slice(-400)}`);
    await harness.finishTurn();
  } finally { harness.widget.destroy(); }
});

test("a gateway that cannot take mid-turn messages queues what is written and sends it as the next turn", async () => {
  const harness = await mount({ canInterject: false });
  try {
    await startTurn(harness);
    assert.equal(harness.composerDisabled(), false, "the user can keep writing while the agent works");
    assert.equal(await harness.widget.interject("bổ sung"), false, "the running turn cannot take it");
    await harness.submit("bổ sung kỳ tháng 9");
    assert.equal(harness.widget.isPending(), true, "Enter with words in the box never stops the running turn");
    assert.ok(harness.text().includes("bổ sung kỳ tháng 9"), "the message is on screen at once, as the user's own");
    assert.ok(harness.text().includes("Queued"), "and says it waits for the running request");
    assert.equal(harness.draft(), "", "the composer is free for the next one");
    assert.equal(harness.sent.filter((request) => request.includes("bổ sung kỳ tháng 9")).length, 0, "nothing is sent while the turn runs");
    await harness.finishTurn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.sent.filter((request) => request.includes("bổ sung kỳ tháng 9")).length, 1, "it goes out once the turn is over");
    assert.equal(harness.text().includes("Queued"), false, "and no longer says it waits");
    assert.equal(harness.text().split("bổ sung kỳ tháng 9").length - 1, 1, "shown once, not echoed by the send");
    assert.equal(harness.taken.length, 0);
  } finally { harness.widget.destroy(); }
});

test("nothing is sent for an empty draft, or once the turn has finished", async () => {
  const harness = await mount();
  try {
    await startTurn(harness);
    assert.equal(await harness.widget.interject("   "), false);
    await harness.finishTurn();
    assert.equal(harness.widget.isPending(), false);
    assert.equal(await harness.widget.interject("sau khi xong"), false, "there is no turn left to add to");
    assert.equal(harness.taken.length, 0);
  } finally { harness.widget.destroy(); }
});

test("a send whose attachment upload fails says so instead of doing nothing", async () => {
  // The failure this guards is silence: the upload threw, the error went to onError, and send
  // returned — no message, no notice, the typed text still in the box. A file whose Vietnamese
  // name cannot go in an HTTP header hits it, and the page just stops responding to the button.
  const harness = await mount({ settleNow: true, uploadFails: true });
  try {
    const widget = harness.widget as unknown as {
      addAttachments(files: readonly unknown[]): Promise<void>;
      getAttachments(): readonly unknown[];
      send(content: string): Promise<void>;
    };
    await widget.addAttachments([{ name: "Xã Đơn Vị Mẫu.xlsx", size: 2_752_986, type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }]);
    assert.equal(widget.getAttachments().length, 1, "the file must be staged for this test to mean anything");
    await widget.send("dựng danh mục giúp tôi");
    assert.ok(harness.text().includes("dựng danh mục giúp tôi"), "the user's words must appear — they did type them");
    // Either the upload's own sentence or the host's transport label — which of the two depends
    // on whether the thrown object is an Error *in the widget's realm*, and a test that threw
    // across realms cannot pin that down. What is under test is that the send is not silent.
    assert.ok(/upload failed|Something went wrong reaching the assistant/u.test(harness.text()),
      `the failure has to be visible beside them: ${harness.text().slice(-300)}`);
  } finally { harness.widget.destroy(); }
});

async function body(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text;
}

test("the built-in HTTP transport delivers a mid-turn sentence to the running turn", async () => {
  // Every test above hands the widget a plain-object transport. The class the widget builds for
  // `connection` keeps its endpoints in private fields, and a detached call to its method threw
  // before fetch: the chat said "did not reach" and no request ever left the page.
  const interjections: { url: string; payload: Record<string, unknown> }[] = [];
  let finishTurn!: () => void;
  const turnHeld = new Promise<void>((resolve) => { finishTurn = resolve; });
  let turnRequestId = "";
  const server = createServer(async (request, response) => {
    const url = request.url ?? "";
    if (url.endsWith("/v1/agent/turns/stream")) {
      turnRequestId = String((JSON.parse(await body(request)) as { requestId?: unknown }).requestId ?? "");
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.write(`id: 1\nevent: progress\ndata: ${JSON.stringify({ type: "turn-started", turnId: "t1" })}\n\n`);
      await turnHeld;
      response.end(`id: 2\nevent: result\ndata: ${JSON.stringify({ content: "xong", sessionId: "session-a", turnId: "t1", outcome: "completed" })}\n\n`);
      return;
    }
    if (url.endsWith("/v1/agent/turns/interject")) {
      interjections.push({ url, payload: JSON.parse(await body(request)) as Record<string, unknown> });
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: true }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(url.includes("runtime") ? JSON.stringify({ status: "ok" }) : JSON.stringify({ messages: [] }));
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const dom = createStubDom();
  const context = createContext({
    ...dom.window, document: dom.document, URL, Headers, Response, Request, TextDecoder, TextEncoder,
    DOMException, AbortController, AbortSignal, ReadableStream, fetch, crypto, setTimeout, clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    location: { origin: "https://example.test", href: "https://example.test/app/", assign: () => undefined },
    CustomEvent: class { readonly type: string; readonly detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
    Event: class { readonly type: string; constructor(type: string) { this.type = type; } },
  });
  const scope = context as unknown as Record<string, unknown>;
  scope.window = context;
  scope.globalThis = context;
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);
  const api = scope.AgentChat as { create(options: Record<string, unknown>): Widget & { send(content: string): Promise<void> } };
  const widget = api.create({
    persistSession: false, startOpen: true, sessionId: "session-a",
    labels: { interjectionRefused: "Tin nhắn này chưa tới được trợ lý." },
    connection: {
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      endpoints: {
        runtime: "v1/agent/runtime", history: () => "v1/agent/history", turnStream: "v1/agent/turns/stream",
        interactionStream: () => "v1/agent/i", cancelTurn: "v1/agent/turns/cancel", interjectTurn: "v1/agent/turns/interject",
      },
      reconnect: false,
    },
  });
  try {
    const sent = widget.send("Mở bảng lương tháng 9");
    const deadline = Date.now() + 2_000;
    while ((!widget.isPending() || !turnRequestId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(widget.isPending(), true, "the turn must still be running");

    const accepted = await widget.interject("Thôi, mở danh sách cán bộ");
    assert.equal(accepted, true, `the running turn took it: ${(dom.document.body.textContent ?? "").slice(-200)}`);
    assert.equal(interjections.length, 1, "exactly one request reached the gateway");
    assert.deepEqual(interjections[0]!.payload, { sessionId: "session-a", requestId: turnRequestId, content: "Thôi, mở danh sách cán bộ" },
      "it names the running turn's requestId, so the gateway can find the operation");
    assert.equal(/chưa tới được/u.test(dom.document.body.textContent ?? ""), false, "nothing says it was refused");
    finishTurn();
    await sent;
  } finally {
    finishTurn();
    widget.destroy();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
});

async function mountWith(send: (request: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const dom = createStubDom();
  const context = createContext({
    ...dom.window,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    document: dom.document, URL, Headers, Response, TextDecoder, DOMException,
    AbortController, AbortSignal, setTimeout, clearTimeout, crypto, queueMicrotask,
    location: { origin: "https://example.test", href: "https://example.test/app/", assign: () => undefined },
    CustomEvent: class { readonly type: string; readonly detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
    Event: class { readonly type: string; constructor(type: string) { this.type = type; } },
  });
  const scope = context as unknown as Record<string, unknown>;
  scope.window = context;
  scope.globalThis = context;
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);
  const api = scope.AgentChat as { create(options: Record<string, unknown>): Widget & { send(content: string): Promise<void> } };
  const widget = api.create({ sessionId: "session-a", labels: { interjectionRefused: "Tin nhắn này chưa tới được trợ lý." },
    transport: { checkConnection: async () => ({ status: "ok" }), loadHistory: async () => [], send, interjectTurn: async () => true } });
  widget.open();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { widget, dom, text: () => dom.document.body.textContent ?? "" };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("a compact assistant opens again on its card when the turn stops on an approval or a question", async () => {
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const endings = [
    { card: ".acw-approval", result: { content: "", sessionId: "session-a", turnId: "t1", outcome: "awaiting_approval", approval: {
      approvalId: "approval-1", sessionId: "session-a", turnId: "t1", toolId: "sample-app.payroll/create-draft", sideEffect: "nonIdempotent", expiresAt } } },
    { card: ".acw-interaction", result: { content: "", sessionId: "session-a", turnId: "t1", outcome: "awaiting_interaction", interaction: {
      kind: "form", sessionId: "session-a", interactionId: "interaction-1", turnId: "t1", toolId: "sample-app.payroll/ask", requesterId: "sample-app",
      message: "Anh/chị chọn giúp em kỳ lương cần tính.", expiresAt,
      requestedSchema: { type: "object", properties: { period: { type: "string", title: "Kỳ lương", enum: ["07/2026", "08/2026"] } } } } } },
  ];
  for (const ending of endings) {
    let stop!: () => void;
    const paused = new Promise<void>((resolve) => { stop = resolve; });
    const harness = await mountWith(async () => { await paused; return ending.result; });
    try {
      void harness.widget.send("Tính lương tháng 8");
      await settle();
      harness.widget.setCompactMode(true);
      const panel = harness.dom.document.querySelector(".acw-panel")!;
      assert.equal(panel.hidden, true, "the agent is working on the page");
      stop();
      const deadline = Date.now() + 2_000;
      while (harness.widget.isPending() && Date.now() < deadline) await settle();
      assert.equal(panel.hidden, false, `${ending.card}: the full chat is back for the user to answer`);
      assert.equal(harness.dom.document.querySelector(".acw-compact-status")!.hidden, true);
      assert.ok(harness.dom.document.querySelectorAll(ending.card).some((card) => !card.hidden), `${ending.card} is on screen`);
    } finally { stop(); harness.widget.destroy(); }
  }
});

test("a sentence the turn took but never read is sent on as the next turn, shown once", async () => {
  const sent: string[] = [];
  let finishFirst!: () => void;
  const first = new Promise<void>((resolve) => { finishFirst = resolve; });
  const harness = await mountWith(async (request) => {
    sent.push(String(request.content));
    if (sent.length === 1) {
      await first;
      return { content: "Đã đọc 8 dòng.", sessionId: "session-a", turnId: "t1", outcome: "completed", unreadInterjections: ["Thôi, mở danh sách cán bộ"] };
    }
    return { content: "Có 300 cán bộ.", sessionId: "session-a", turnId: "t2", outcome: "completed" };
  });
  try {
    void harness.widget.send("Mở bảng lương tháng 9");
    await settle();
    assert.equal(await harness.widget.interject("Thôi, mở danh sách cán bộ"), true);
    finishFirst();
    const deadline = Date.now() + 2_000;
    while (sent.length < 2 && Date.now() < deadline) await settle();
    while (harness.widget.isPending() && Date.now() < deadline) await settle();
    assert.deepEqual(sent, ["Mở bảng lương tháng 9", "Thôi, mở danh sách cán bộ"], "the unread sentence became the next turn");
    assert.equal(harness.text().split("Thôi, mở danh sách cán bộ").length - 1, 1, "it is on screen once, as the user typed it");
    assert.ok(harness.text().includes("Có 300 cán bộ."));
    assert.ok(harness.text().indexOf("Thôi, mở danh sách cán bộ") < harness.text().indexOf("Có 300 cán bộ."),
      "the follow-up answer also appears after the added request");
    assert.equal(/chưa tới được/u.test(harness.text()), false);
  } finally { finishFirst(); harness.widget.destroy(); }
});

test("a turn that stopped to wait for the user marks the unread sentence as not delivered instead", async () => {
  let finishFirst!: () => void;
  const first = new Promise<void>((resolve) => { finishFirst = resolve; });
  const sent: string[] = [];
  const harness = await mountWith(async (request) => {
    sent.push(String(request.content));
    await first;
    return { content: "Cần anh/chị điền form.", sessionId: "session-a", turnId: "t1", outcome: "awaiting_interaction", unreadInterjections: ["đổi sang tháng 8"] };
  });
  try {
    void harness.widget.send("Tính lương");
    await settle();
    assert.equal(await harness.widget.interject("đổi sang tháng 8"), true);
    finishFirst();
    const deadline = Date.now() + 2_000;
    while (harness.widget.isPending() && Date.now() < deadline) await settle();
    await settle();
    assert.deepEqual(sent, ["Tính lương"], "no new turn while the agent waits for an answer");
    assert.match(harness.text(), /đổi sang tháng 8[\s\S]*Tin nhắn này chưa tới được trợ lý\./u);
  } finally { finishFirst(); harness.widget.destroy(); }
});

test("each added message is marked read when the turn reads it, identical ones one by one, in the order they were sent", async () => {
  const harness = await mount();
  try {
    await startTurn(harness);
    assert.equal(await harness.widget.interject("lấy tháng 8"), true);
    assert.equal(await harness.widget.interject("lấy tháng 8"), true);
    const read = () => harness.dom.document.querySelectorAll(".acw-user-read").length;
    assert.equal(read(), 0, "nothing is read yet");
    harness.progress({ type: "interjection-received", turnId: "t1", content: "lấy tháng 8" });
    assert.equal(read(), 1, "the turn read one of the two");
    harness.progress({ type: "interjection-received", turnId: "t1", content: "một câu không ai gửi" });
    assert.equal(read(), 1, "a receipt for words nobody sent marks nothing");
    harness.progress({ type: "interjection-received", turnId: "t1", content: "lấy tháng 8" });
    assert.equal(read(), 2, "then the other");
    assert.ok(harness.text().includes("Read"));
    await harness.finishTurn();
  } finally { harness.widget.destroy(); }
});

test("a read reported before the send itself is answered still marks the message read", async () => {
  let progress: ((value: unknown) => void) | undefined;
  const harness = await mount({ duringInterject: (content) => progress?.({ type: "interjection-received", turnId: "t1", content }) });
  try {
    await startTurn(harness);
    progress = harness.progress;
    assert.equal(await harness.widget.interject("lấy tháng 8\r\nvà tháng 9"), true);
    assert.equal(harness.dom.document.querySelectorAll(".acw-user-read").length, 1);
    await harness.finishTurn();
  } finally { harness.widget.destroy(); }
});

test("a message the turn refused is never marked read", async () => {
  const harness = await mount();
  try {
    await startTurn(harness);
    harness.refuseNext();
    assert.equal(await harness.widget.interject("quá muộn"), false);
    harness.progress({ type: "interjection-received", turnId: "t1", content: "quá muộn" });
    assert.equal(harness.dom.document.querySelectorAll(".acw-user-read").length, 0);
    await harness.finishTurn();
  } finally { harness.widget.destroy(); }
});
