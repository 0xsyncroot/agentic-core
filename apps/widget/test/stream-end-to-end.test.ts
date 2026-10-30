import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { createStubDom, type StubDom, type StubNode } from "./dom-stub.js";

/**
 * The built widget, over a real SSE connection, through its own HTTP transport.
 *
 * Every other test here hands the widget a fake transport and feeds it events directly, which
 * is precise and skips the entire path that actually runs in a browser: the fetch, the stream
 * decoder, the event dialect, the reconnect wrapper. A pacing bug or a dialect mismatch lives
 * exactly there, so this drives the bundle the way a page does and reads the DOM back.
 */

/** A real reply, with paragraphs, a list and bold: the answer renders once, whole, as Markdown. */
const ANSWER = [
  "Em đã kiểm tra hệ thống và ghi nhận thông tin sau:",
  "- Năm 2026 hiện chưa kết nối dữ liệu Nhân sự và Chấm công.\n- Chưa có bảng lương nào được tạo.",
  "Theo đồng hồ nghiệp vụ, kỳ lương gần nhất là **tháng 08/2026**. Anh/chị muốn tính lương cho kỳ này hay một kỳ khác?",
].join("\n\n");

/** Speaks the dialect the Sample App API speaks, frame for frame. */
async function streamServer(completedLabel?: string): Promise<Server> {
  const { PublicAgentStreamWriter } = await import("@0xsyncroot/agent-api");
  return createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    let id = 0;
    const frame = (event: string, data: unknown) =>
      response.write(`id: ${++id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const turnId = "turn-e2e";
    frame("progress", { type: "turn-started", turnId });
    const writer = new PublicAgentStreamWriter(frame, { toolTrace: (_id, _initiator, call) =>
      call?.phase === "completed" && completedLabel ? completedLabel : "Đang xem các bảng lương gần đây…" });
    writer.progress({ type: "tool-started", turnId, step: 1, callId: "c1", toolId: "private-tool" });
    writer.progress({ type: "tool-completed", turnId, step: 1, callId: "c1", toolId: "private-tool", status: "succeeded" });
    frame("progress", { type: "plan-updated", turnId, step: 1, plan: { goal: "Tính lương", steps: [
      { id: "s1", description: "Đã tra cứu kỳ lương gần nhất", status: "completed" },
      { id: "s2", description: "Xác nhận kỳ lương với người dùng", status: "in_progress" },
    ] } });
    frame("assistant-output-start", { type: "assistant-output-start", outputId: "o1", turnId, audience: "user" });
    // The review takes its time after the model has written: the answer must not show before it ends.
    frame("assistant-output-delta", { type: "assistant-output-delta", outputId: "o1", turnId, audience: "user", delta: ANSWER });
    setTimeout(() => {
      frame("assistant-output-end", { type: "assistant-output-end", outputId: "o1", turnId, audience: "user", status: "completed" });
      frame("progress", { type: "turn-completed", turnId, steps: 1, outcome: "completed" });
      frame("result", { content: ANSWER, sessionId: "session-e2e", turnId, outcome: "completed" });
      response.end();
    }, 600);
  });
}

async function mountAgainst(port: number, extra: Record<string, unknown> = {}): Promise<{ readonly dom: StubDom; readonly send: (content: string) => Promise<void> }> {
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const dom = createStubDom();
  const context = createContext({
    ...dom.window, document: dom.document, URL, Headers, Response, Request, TextDecoder, TextEncoder,
    DOMException, AbortController, AbortSignal, ReadableStream, fetch, crypto, setTimeout, clearTimeout,
    location: { origin: "https://sample-app.example", href: "https://sample-app.example/app/", assign: () => undefined },
    CustomEvent: class { readonly type: string; readonly detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
    Event: class { readonly type: string; constructor(type: string) { this.type = type; } },
  });
  const scope = context as unknown as Record<string, unknown>;
  scope.window = context;
  scope.globalThis = context;
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);
  const api = scope.AgentChat as { create(options: Record<string, unknown>): { send(content: string): Promise<void> } };
  const widget = api.create({
    persistSession: false, startOpen: true,
    connection: {
      baseUrl: `http://127.0.0.1:${port}`,
      endpoints: { runtime: "runtime", history: () => "history", turnStream: "turn", interactionStream: () => "i", cancelTurn: "cancel" },
      reconnect: false,
    },
    ...extra,
  });
  return { dom, send: (content) => widget.send(content) };
}

test("the built widget holds a real SSE turn's answer until the runtime accepts it, then shows it whole", async () => {
  const server = await streamServer();
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  try {
    const { dom, send } = await mountAgainst((server.address() as AddressInfo).port);
    const shown: string[] = [];
    const answerText = () => {
      const row = dom.body.querySelectorAll(".acw-assistant").at(-1);
      const bubble = row?.children.find((node: StubNode) => node.classList.contains("acw-bubble"));
      return bubble && !bubble.hidden ? bubble.textContent : "";
    };
    // One frame generation per tick, the way a browser paints, for the 600 ms the answer waits on its end.
    const sampler = setInterval(() => { dom.stepFrame(); shown.push(answerText()); }, 16);
    await send("Hỗ trợ tôi tính lương");
    clearInterval(sampler);
    dom.flushFrames();

    const answered = shown.filter((text) => /kết nối dữ liệu|bảng lương nào/u.test(text));
    assert.ok(shown.length - answered.length > 5, `frames sampled while the answer was open (${shown.length})`);
    assert.equal(new Set(answered).size <= 1, true, `it appears in one step, never partly (${[...new Set(answered)].map((text) => text.length).join(",")})`);
    assert.equal(shown.some((text) => text === "Đang soạn câu trả lời…"), true, "while it is open the bubble says an answer is being written");
    assert.match(answerText(), /kết nối dữ liệu[\s\S]*Chưa có bảng lương nào được tạo\./u, "and the whole answer is there at the end");
    const answer = dom.body.querySelectorAll(".acw-assistant").at(-1)?.children.find((node: StubNode) => node.classList.contains("acw-bubble"));
    assert.match(answer?.innerHTML ?? "", /<strong>tháng 08\/2026<\/strong>/u, "as Markdown");

    const thinking = dom.body.querySelectorAll(".acw-thinking").at(-1);
    assert.equal(thinking?.open, false, "a finished turn collapses to its summary line");
    const rows = thinking?.querySelectorAll(".acw-work-label, .acw-check-label").map((item: StubNode) => item.textContent.trim()) ?? [];
    // The product's phrase for the tool, never its id, and never a step that was not reached.
    assert.equal(rows.some((row) => row.includes("payroll") || row.includes("_")), false, "no tool identity reaches the page");
    assert.ok(rows.includes("Đã tra cứu kỳ lương gần nhất"), "the agent's own words are what the trace shows");
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
});


test("the host learns how much user-addressed text there is, never the text itself: a narration as it streams, an answer once, before it paints", async () => {
  const turnId = "turn-text";
  const line = "Em mở bảng lương tháng 9 trên màn hình.";
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    let id = 0;
    const frame = (event: string, data: Record<string, unknown>) =>
      response.write(`id: ${++id}\nevent: ${event}\ndata: ${JSON.stringify({ type: event, turnId, audience: "user", ...data })}\n\n`);
    // The line said before a click streams as a draft, then is recognised as narration (§10.9).
    frame("assistant-output-start", { outputId: "o1" });
    frame("assistant-output-delta", { outputId: "o1", delta: line.slice(0, 10) });
    frame("assistant-output-delta", { outputId: "o1", delta: line.slice(10) });
    frame("assistant-narration-start", { narrationId: "o1" });
    frame("assistant-narration-delta", { narrationId: "o1", delta: line });
    frame("assistant-narration-end", { narrationId: "o1", status: "completed" });
    frame("assistant-output-end", { outputId: "o1", status: "discarded" });
    frame("assistant-output-start", { outputId: "o2" });
    frame("assistant-output-delta", { outputId: "o2", delta: ANSWER });
    frame("assistant-output-end", { outputId: "o2", status: "completed" });
    response.write(`event: result\ndata: ${JSON.stringify({ content: ANSWER, sessionId: "session-e2e", turnId, outcome: "completed" })}\n\n`);
    response.end();
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  try {
    const seen: unknown[] = [];
    let paintedBeforeTold = false;
    let page: StubDom | undefined;
    const answerShown = () => page?.body.querySelectorAll(".acw-assistant .acw-bubble").some((node: StubNode) => !node.hidden && /bảng lương nào/u.test(node.textContent)) === true;
    const { dom, send } = await mountAgainst((server.address() as AddressInfo).port, { onTextProgress: (text: { readonly kind: string }) => {
      if (text.kind === "answer" && answerShown()) paintedBeforeTold = true;
      seen.push(text);
    } });
    page = dom;
    const sampler = setInterval(() => dom.stepFrame(), 16);
    try { await send("Mở bảng lương tháng 9"); } finally { clearInterval(sampler); }
    // o1 was never an answer: held until its step ended, it became narration. The answer is told once, whole.
    assert.deepEqual(JSON.parse(JSON.stringify(seen)), [
      { kind: "narration", id: "o1", chars: line.length },
      { kind: "answer", id: "o2", chars: ANSWER.length },
    ]);
    assert.equal(paintedBeforeTold, false, "the host is told before the answer paints, so it lays itself out in the same frame");
    assert.equal(answerShown(), true);
  } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); }); }
});

test("the API's valid audit labels above 120 chars survive the real SSE transport into the widget", async () => {
  const report = "Đã xét xong biểu «Biểu nguồn»: 50/50 dòng. Có 22 nhiệm vụ CTX, 2 nhóm. Ví dụ: Chuẩn bị tuyên truyền trực quan chào năm mới (dòng 26). Không còn dòng chưa rõ.";
  assert.ok(report.length > 120 && report.length <= 240);
  const server = await streamServer(report);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const { dom, send } = await mountAgainst((server.address() as AddressInfo).port);
    const sampler = setInterval(() => dom.stepFrame(), 16);
    try { await send("Phân tích tài liệu"); } finally { clearInterval(sampler); }
    dom.flushFrames();
    const labels = dom.body.querySelectorAll(".acw-thinking-item").map((node: StubNode) => node.textContent.trim());
    assert.ok(labels.includes(report), JSON.stringify(labels));
    assert.equal(labels.includes("Đang xem các bảng lương gần đây…"), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});


test("a reload through the real transport keeps the plan sentence of a waiting turn and cuts a long narration at 20 000 characters", async () => {
  const steps = [{ id: "read", description: "Đọc hồ sơ", status: "in_progress" }];
  const history = { messages: [
    { role: "user", content: "Phân tích file", at: "2026-10-07T12:00:00Z" },
    { role: "assistant", content: "", status: "awaiting_interaction", turnId: "turn-1", at: "2026-10-07T12:05:00Z",
      work: { durationMs: 60_000, plan: { planId: "p", state: "awaiting_user", steps }, tools: [], timeline: [
        { type: "plan-updated", cause: "proposal", plan: { planId: "p", revision: 1, state: "active", steps } },
        { type: "narration", content: "y".repeat(25_000) },
      ] } },
  ] };
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(history));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    let ready!: () => void;
    const loaded = new Promise<void>(resolve => { ready = resolve; });
    const { dom } = await mountAgainst((server.address() as AddressInfo).port, { sessionId: "session-e2e", onReady: () => ready(),
      labels: { planSentence: (descriptions: readonly string[]) => `Em sẽ ${descriptions.join(", ").toLowerCase()}.` } });
    await loaded;
    dom.flushFrames();
    const sentence = dom.body.querySelectorAll(".acw-plan-sentence").map((node: StubNode) => node.textContent.trim());
    assert.deepEqual(sentence, ["Em sẽ đọc hồ sơ."], "the cause crossed the transport, so the sentence is told on reload");
    const narrations = dom.body.querySelectorAll(".acw-timeline .acw-bubble").map((node: StubNode) => node.textContent.trim());
    assert.equal(narrations.length, 1, "the long narration is kept");
    assert.equal(narrations[0], `${"y".repeat(19_999)}…`, "cut at 20 000 characters in total, ending in an ellipsis");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

// A progressing step adds its sentence; only a step that ran without progress replaces the stuck sentence before it. One journal, told live over SSE and reloaded from history, through the real agent-api boundaries and the
// real transport: both show the announcement, the last stuck sentence and every progressing one.
for (const scenario of [
  { name: "three stuck steps then progress", progress: true, shown: ["Em sẽ lập đợt chi trả tháng 9.", "Danh sách vẫn che nút Lưu.", "Em đã đóng danh sách và bấm Lưu."] },
  { name: "three stuck steps alone", progress: false, shown: ["Em sẽ lập đợt chi trả tháng 9.", "Danh sách vẫn che nút Lưu."] },
]) {
  test(`${scenario.name}: the chat keeps the last stuck sentence, live and after reload alike`, async () => {
    const { PublicAgentStreamWriter, visibleMessages } = await import("@0xsyncroot/agent-api");
    const turnId = "turn-stuck";
    // Each step's sentence, then what the step's outcome superseded (journaled with the step's end).
    const steps = [
      { narrationId: "a0", content: "Em sẽ lập đợt chi trả tháng 9." },
      { narrationId: "n1", content: "Em tìm nút Lưu trên hộp thoại." },
      { narrationId: "n2", content: "Nút Lưu đang bị danh sách che.", supersedes: "n1" },
      { narrationId: "n3", content: "Danh sách vẫn che nút Lưu.", supersedes: "n2" },
      ...(scenario.progress ? [{ narrationId: "n4", content: "Em đã đóng danh sách và bấm Lưu." }] : []),
    ];
    const at = (seq: number) => new Date(Date.UTC(2026, 9, 19, 8, 0, seq)).toISOString();
    const journal = [
      { type: "turn/start", payload: {} }, { type: "user/input", payload: { content: "Lập đợt chi trả" } },
      ...steps.flatMap(({ narrationId, content, supersedes }) => [{ type: "assistant/narration", payload: { narrationId, content, audience: "user" } },
        ...(supersedes ? [{ type: "assistant/narration-superseded", payload: { narrationId: supersedes, by: narrationId } }] : [])]),
      { type: "assistant/message", payload: { content: "Đã lưu đợt chi trả.", toolCalls: [] } }, { type: "turn/end", payload: { status: "completed" } },
    ].map((event, index) => ({ ...event, seq: index + 1, turnId, sessionId: "session-e2e", occurredAt: at(index + 1) }));
    const shownNarrations = (dom: StubDom) => dom.body.querySelectorAll(".acw-timeline .acw-bubble")
      .filter((node: StubNode) => node.dataset.messageKind === "narration").map((node: StubNode) => node.textContent.trim());

    const live = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
      let id = 0;
      const writer = new PublicAgentStreamWriter((event, data) => response.write(`id: ${++id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      for (const { narrationId, content, supersedes } of steps) {
        writer.narration({ type: "assistant-narration-start", turnId, narrationId, audience: "user" });
        writer.narration({ type: "assistant-narration-delta", turnId, narrationId, audience: "user", delta: content });
        writer.narration({ type: "assistant-narration-end", turnId, narrationId, audience: "user", status: "completed" });
        if (supersedes) writer.narration({ type: "assistant-narration-superseded", turnId, narrationId: supersedes, audience: "user", by: narrationId });
      }
      response.write(`event: result\ndata: ${JSON.stringify({ content: "Đã lưu đợt chi trả.", sessionId: "session-e2e", turnId, outcome: "completed" })}\n\n`);
      response.end();
    });
    await new Promise<void>((resolve) => { live.listen(0, "127.0.0.1", resolve); });
    let liveShown: string[];
    try {
      const { dom, send } = await mountAgainst((live.address() as AddressInfo).port);
      await send("Lập đợt chi trả");
      dom.flushFrames();
      liveShown = shownNarrations(dom);
    } finally { await new Promise<void>((resolve) => { live.close(() => resolve()); }); }
    assert.deepEqual(liveShown, scenario.shown, "live");

    // Reloaded from the timeline the history carries, and from its narration list alone (a history without a timeline).
    const messages = visibleMessages(journal as never) as readonly Record<string, unknown>[];
    const listOnly = messages.map((message) => message.role === "assistant" ? { ...message, work: { ...(message.work as object), timeline: undefined } } : message);
    for (const [shape, served] of [["timeline", messages], ["narration list", listOnly]] as const) {
      const history = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ messages: served }));
      });
      await new Promise<void>((resolve) => { history.listen(0, "127.0.0.1", resolve); });
      try {
        let ready!: () => void;
        const loaded = new Promise<void>((resolve) => { ready = resolve; });
        const { dom } = await mountAgainst((history.address() as AddressInfo).port, { sessionId: "session-e2e", onReady: () => ready() });
        await loaded;
        dom.flushFrames();
        assert.deepEqual(shownNarrations(dom), scenario.shown, `reload from the ${shape} shows what the live stream showed`);
      } finally { await new Promise<void>((resolve) => { history.close(() => resolve()); }); }
    }
  });
}

// A draft the review sent back is never shown — not live, and not after a reload. Agentic Tiền Lương reloads
// through the history timeline, which used to carry a kept draft as a plain narration, so the reload showed it.
test("a kept draft reloaded from the history timeline stays hidden, as it was live", async () => {
  const { visibleMessages } = await import("@0xsyncroot/agent-api");
  const at = (seq: number) => new Date(Date.UTC(2026, 9, 19, 8, 0, seq)).toISOString();
  const journal = [
    { type: "turn/start", payload: {} }, { type: "user/input", payload: { content: "Tính lương tháng 9" } },
    { type: "assistant/narration", payload: { narrationId: "d1", audience: "user", content: "Anh/chị có cần em hỗ trợ thêm không?", draft: true } },
    { type: "assistant/narration", payload: { narrationId: "n1", audience: "user", content: "Em kiểm tra tiếp bảng lương." } },
    { type: "assistant/message", payload: { content: "Đã tính lương tháng 9.", toolCalls: [] } }, { type: "turn/end", payload: { status: "completed" } },
  ].map((event, index) => ({ ...event, seq: index + 1, turnId: "turn-draft", sessionId: "session-e2e", occurredAt: at(index + 1) }));
  const history = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ messages: visibleMessages(journal as never) }));
  });
  await new Promise<void>((resolve) => { history.listen(0, "127.0.0.1", resolve); });
  try {
    let ready!: () => void;
    const loaded = new Promise<void>((resolve) => { ready = resolve; });
    const { dom } = await mountAgainst((history.address() as AddressInfo).port, { sessionId: "session-e2e", onReady: () => ready() });
    await loaded;
    dom.flushFrames();
    const bubbles = dom.body.querySelectorAll(".acw-timeline .acw-bubble").filter((node: StubNode) => node.dataset.messageKind === "narration");
    assert.deepEqual(bubbles.filter((node: StubNode) => !node.hidden).map((node: StubNode) => node.textContent.trim()), ["Em kiểm tra tiếp bảng lương."],
      "only the ordinary narration shows");
    assert.equal(bubbles.filter((node: StubNode) => node.hidden && node.dataset.kind === "draft").length, 1, "the draft is there, hidden and marked");
  } finally { await new Promise<void>((resolve) => { history.close(() => resolve()); }); }
});
