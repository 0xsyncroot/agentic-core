import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script, createContext } from "node:vm";
import { test } from "node:test";

interface BuiltApi {
  readonly version: string;
  create(options: { apiBaseUrl?: string; connection?: unknown; transport?: unknown }): unknown;
  init(options: { apiBaseUrl?: string; connection?: unknown; transport?: unknown }): unknown;
  createHarnessTransport(options: Record<string, unknown>): BuiltTransport;
}

interface BuiltTransport {
  checkConnection?(context: BuiltOperationContext): Promise<unknown>;
  loadHistory?(context: BuiltOperationContext): Promise<readonly { role: string; content: string; narrations?: readonly { id: string; audience: "user"; content: string }[]; approval?: { kind: string; approvalId: string } }[]>;
  send(request: Record<string, unknown>, context: BuiltOperationContext & { onEvent(event: unknown): void; attachmentFiles?: ReadonlyMap<string, File> }): Promise<{ content: string; approval?: unknown }>;
  resolveInteraction?(request: Record<string, unknown>, context: BuiltOperationContext & { onEvent(event: unknown): void }): Promise<{ content: string; approval?: unknown }>;
  cancelTurn?(context: BuiltOperationContext): Promise<void>;
}

interface BuiltOperationContext {
  readonly operation: "runtime" | "history" | "turn" | "interaction" | "cancel";
  readonly sessionId: string;
  readonly requestId: string;
  readonly interactionId?: string;
  readonly interactionKind?: string;
  readonly signal: AbortSignal;
}

async function builtApi(): Promise<BuiltApi> {
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const context = createContext({ URL, document: { baseURI: "https://portal.example/app/" }, Headers, Response, TextDecoder, DOMException, AbortController, setTimeout, clearTimeout, FormData });
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);
  return (context as unknown as { AgentChat: BuiltApi }).AgentChat;
}

test("widget build is a self-contained classic script with init and create APIs", async () => {
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const context = createContext({});
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);
  assert.doesNotThrow(() => new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context));
  const api = (context as unknown as { AgentChat?: BuiltApi }).AgentChat;
  assert.ok(api);
  assert.equal(api.version, "0.1.0");
  assert.equal(typeof api.init, "function");
  assert.equal(typeof api.create, "function");
  assert.equal(typeof api.createHarnessTransport, "function");
  assert.throws(() => api.create({ apiBaseUrl: "" }), /requires connection\.baseUrl, apiBaseUrl, or transport/);
  assert.match(source, /acw-thinking/);
  // The summary a finished turn collapses to, the way every assistant the accountant already
  // uses ends one: a single line saying how long it took, not a column of steps over the answer.
  assert.match(source, /Đã xử lý trong \$\{\w+\}s|Đã xử lý trong /);
  // A turn that stops to ask something has not finished, and the panel must not say it has —
  // its header shows `labels.awaitingUser` instead of the completion summary (spec §3.7 item 7).
  // The widget's own default is neutral English; a business form of address is the host's to
  // supply through `labels`, never the widget's own literal (no persona in generic layers).
  assert.match(source, /Waiting for your response/);
  assert.doesNotMatch(source, /Đang chờ phản hồi|Đang chờ.{0,20}phản hồi/u);
  // Only the agent may call one of its own steps done. `paused` is the state for the step the
  // turn stopped inside, and it deliberately carries neither a ✓ nor a strikethrough.
  assert.match(source, /\[data-state="paused"\]/);
  assert.match(source, /\[data-state="skipped"\] > span:last-child \{ text-decoration: line-through/);
  assert.doesNotMatch(source, /\[data-state="paused"\] \.acw-thinking-dot::after/);
  // The thinking line is the widget's own sentence. The model's private reasoning is written in
  // whatever language it thought in and routinely names the tools it is about to call, which is
  // the one thing the public stream exists to keep server-side.
  assert.match(source, /Đang suy nghĩ/);
  // Movement is what tells a person the turn is alive. The sweep is on the label itself, and it
  // is guarded so a browser without background-clip keeps a readable line instead of losing it.
  assert.match(source, /@supports \(\(background-clip: text\) or \(-webkit-background-clip: text\)\)/);
  assert.match(source, /animation: acw-text-sweep/);
  assert.match(source, /@keyframes acw-pulse/);
  // Reduced motion has to put the colour back, or the label renders transparent and vanishes.
  assert.match(source, /-webkit-text-fill-color: #101828/);
  // A host pipeline that minifies this already-minified file a second time can drop its
  // top-level constants; the page then dies on a bare "X is not defined" inside minified code.
  // `typeof` is the only form that does not itself throw for an undeclared identifier.
  assert.match(source, /typeof \w+>"u"\|\|typeof \w+>"u"/);
  assert.match(source, /the published bundle was altered after build/);
  assert.match(source, /acw-timeline/);
  assert.doesNotMatch(source, /acw-agent-update/);
  assert.match(source, /messageKind/);
  assert.doesNotMatch(source, /acw-public-update/);
  assert.match(source, /acw-resize-handle/);
  assert.match(source, /agentic-chat:before-/);
  assert.match(source, /task-card/);
  assert.match(source, /acw-step-row/);
  assert.match(source, /ui-step-toggle/);
  assert.match(source, /M11\.667 3\.333h5v5/);
  assert.match(source, /onUiAction/);
  assert.match(source, /<circle cx="4\.75" cy="10" r="1\.35"/);
  assert.match(source, /M9\.102 7\.814/);
  assert.match(source, /m17\.41 1\.672/);
  assert.match(source, /Dừng xử lý/);
  assert.match(source, /acw-header-menu/);
  assert.match(source, /acw-attachment-menu/);
  assert.match(source, /Ctrl\+Alt\+S/);
  assert.match(source, /attachment-add/);
  assert.match(source, /reply-change/);
  assert.match(source, /copy-result/);
  assert.match(source, /showLauncher/);
  assert.match(source, /welcomeImageUrl/);
  assert.match(source, /assistant-output-start/);
  assert.match(source, /assistant-narration-start/);
  assert.match(source, /onNarration/);
  assert.match(source, /last-event-id/);
  assert.match(source, /api\/chat\/cancel/);
  assert.match(source, /api\/interactions\//);
  assert.match(source, /acw-approval/);
  // The operation name and its scope are part of what the approval digest binds; rendering
  // them is what stops every payroll card sharing one generic title.
  assert.match(source, /acw-approval-target/);
  assert.match(source, /presentation\?\.action/);
  assert.match(source, /acw-approval-fields/);
  // Suggestions are one row on the floor of the greeting that scrolls sideways; a chip never wraps its words.
  assert.match(source, /\.acw-suggestions\s*\{[^}]*flex-wrap:\s*nowrap[^}]*overflow-x:\s*auto/);
  assert.match(source, /\.acw-suggestion\s*\{[^}]*flex:\s*0 0 auto[^}]*white-space:\s*nowrap/);
  // The user's own message is shown as typed or pasted: its line breaks are in the text (the
  // composer is a textarea), and without pre-wrap the page collapsed them into spaces on send.
  assert.match(source, /\.acw-user \.acw-bubble\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*white-space:\s*pre-wrap/);
  // select/multiselect both read labelled `oneOf` choices (spec §7 Q4: `items.oneOf` for
  // multiselect, same as a single choice); a multiselect's `items` also falls back to `anyOf`,
  // which HumanInteractionValidator still accepts for tools written before `oneOf`.
  assert.match(source, /oneOf/);
  assert.match(source, /anyOf/);
});

test("HTTP harness transport resolves independent endpoints and fresh headers", async () => {
  const api = await builtApi();
  const calls: Array<{ url: string; init: RequestInit; operation: string }> = [];
  let token = 0;
  const transport = api.createHarnessTransport({
    baseUrl: "https://gateway.example/root",
    endpoints: {
      runtime: false,
      history: ({ sessionId }: { sessionId: string }) => `history/${sessionId}`,
      turnStream: "https://stream.example/v2/chat",
      interactionStream: ({ interactionId }: { interactionId?: string }) => `interactions/${interactionId}/stream`,
    },
    headers: async ({ operation }: { operation: string }) => ({ authorization: `Bearer ${operation}-${++token}` }),
    request: async (url: string, init: RequestInit, context: { operation: string }) => {
      calls.push({ url, init, operation: context.operation });
      if (context.operation === "history") return new Response(JSON.stringify({ messages: [
        {
          role: "assistant", content: "old", work: { interactions: [
            { type: "message", content: "must stay hidden" },
            { type: "narration", narrationId: "n-history", audience: "user", content: "Tôi đang kiểm tra." },
            { type: "tool", toolId: "private_tool" },
          ] },
        },
        {
          role: "assistant", content: "new", narrations: [
            { id: "n-internal", audience: "internal", content: "must also stay hidden" },
            { id: "n-public", audience: "user", content: "Tôi đã đối chiếu xong." },
          ],
        },
        {
          role: "assistant", content: "approval needed", approval: {
            approvalId: "approval-1", sessionId: "session-1", turnId: "turn-approval", toolId: "write_tool",
            sideEffect: "nonIdempotent", expiresAt: "2099-01-01T00:00:00.000Z",
            presentation: {
              summary: "Update one payroll record.", action: "Update payroll record", target: "Payroll period 08/2026",
              impact: "The selected record will be overwritten.", fields: [{ label: "Affected records", value: 1 }],
              rawArguments: { secret: "CANARY_PRIVATE_WIDGET_ARGUMENT" },
            },
          },
        },
      ] }), { headers: { "content-type": "application/json" } });
      return new Response('event: result\ndata: {"content":"done"}\n\n', { headers: { "content-type": "text/event-stream" } });
    },
  });
  const controller = new AbortController();
  const base = { sessionId: "session-1", requestId: "request-1", signal: controller.signal } as const;
  await transport.checkConnection?.({ ...base, operation: "runtime" });
  const history = await transport.loadHistory?.({ ...base, operation: "history" });
  const result = await transport.send({ content: "hello", sessionId: base.sessionId, requestId: base.requestId, attachments: [] }, { ...base, operation: "turn", onEvent: () => undefined });
  const interaction = await transport.resolveInteraction?.({
    kind: "approval", interactionId: "approval-1", sessionId: base.sessionId, requestId: "interaction-1", decision: "approve",
  }, {
    ...base, operation: "interaction", requestId: "interaction-1", interactionId: "approval-1", interactionKind: "approval", onEvent: () => undefined,
  });
  await transport.resolveInteraction?.({
    kind: "form", interactionId: "form-1", sessionId: base.sessionId, requestId: "interaction-2",
    action: "accept", content: { region: "north" },
  }, {
    ...base, operation: "interaction", requestId: "interaction-2", interactionId: "form-1", interactionKind: "form", onEvent: () => undefined,
  });

  assert.equal(history?.[0]?.content, "old");
  assert.deepEqual(JSON.parse(JSON.stringify(history?.[0]?.narrations)), [{ id: "n-history", audience: "user", content: "Tôi đang kiểm tra." }]);
  assert.deepEqual(JSON.parse(JSON.stringify(history?.[1]?.narrations)), [{ id: "n-public", audience: "user", content: "Tôi đã đối chiếu xong." }]);
  assert.deepEqual(JSON.parse(JSON.stringify(history?.[2]?.approval)), {
    kind: "approval", approvalId: "approval-1", sessionId: "session-1", turnId: "turn-approval", toolId: "write_tool",
    sideEffect: "nonIdempotent", expiresAt: "2099-01-01T00:00:00.000Z",
    presentation: {
      summary: "Update one payroll record.", action: "Update payroll record", target: "Payroll period 08/2026",
      impact: "The selected record will be overwritten.", fields: [{ label: "Affected records", value: 1 }],
    },
  });
  assert.equal(history?.[2]?.content, "", "approval card must be the only user-facing action description");
  assert.doesNotMatch(JSON.stringify(history?.[2]?.approval), /CANARY_PRIVATE|rawArguments/);
  assert.equal(result.content, "done");
  assert.equal(interaction?.content, "done");
  assert.deepEqual(calls.map((call) => [call.operation, call.url]), [
    ["history", "https://gateway.example/root/history/session-1"],
    ["turn", "https://stream.example/v2/chat"],
    ["interaction", "https://gateway.example/root/interactions/approval-1/stream"],
    ["interaction", "https://gateway.example/root/interactions/form-1/stream"],
  ]);
  assert.equal(new Headers(calls[0]?.init.headers).get("authorization"), "Bearer history-1");
  assert.equal(new Headers(calls[1]?.init.headers).get("authorization"), "Bearer turn-2");
  assert.equal(new Headers(calls[1]?.init.headers).get("accept"), "text/event-stream");
  assert.equal(new Headers(calls[2]?.init.headers).get("authorization"), "Bearer interaction-3");
  assert.equal(new Headers(calls[2]?.init.headers).get("accept"), "text/event-stream");
  assert.equal(new Headers(calls[3]?.init.headers).get("authorization"), "Bearer interaction-4");
  assert.deepEqual(JSON.parse(String(calls[2]?.init.body)), {
    kind: "approval", sessionId: "session-1", requestId: "interaction-1", decision: "approve",
  });
  assert.deepEqual(JSON.parse(String(calls[3]?.init.body)), {
    kind: "form", sessionId: "session-1", requestId: "interaction-2", action: "accept", content: { region: "north" },
  });
});

test("HTTP transport suppresses legacy approval text that exposes an internal tool ID", async () => {
  const api = await builtApi();
  const transport = api.createHarnessTransport({
    baseUrl: "https://gateway.example",
    endpoints: { runtime: false, history: false },
    request: async () => new Response(
      'event: result\ndata: {"content":"Approval required before using secret_write_tool.","outcome":"awaiting_approval","approval":{"approvalId":"approval-1","sessionId":"session-1","turnId":"turn-1","toolId":"secret_write_tool","sideEffect":"idempotent","expiresAt":"2099-01-01T00:00:00.000Z","presentation":{"summary":"Update the selected record.","action":"Update record","target":"Record 7","impact":"The value changes."}}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ),
  });
  const result = await transport.send({ content: "write", sessionId: "session-1", requestId: "request-1", attachments: [] }, {
    operation: "turn", sessionId: "session-1", requestId: "request-1", signal: new AbortController().signal,
    onEvent: () => undefined,
  });
  assert.equal(result.content, "");
  assert.ok(result.approval);
});

test("HTTP transport sends a turn's files with the turn itself, in one request", async () => {
  const api = await builtApi();
  const calls: { url: string; init: RequestInit }[] = [];
  const transport = api.createHarnessTransport({
    baseUrl: "https://gateway.example",
    endpoints: { runtime: false, history: false },
    request: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('event: result\ndata: {"content":"done"}\n\n', { headers: { "content-type": "text/event-stream" } });
    },
  });
  const file = new File(["PK-xlsx-bytes"], "Dự toán 2027.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const attachments = [{ id: "attachment-1", name: file.name, type: file.type, size: file.size, source: "picker" }];
  const base = { operation: "turn" as const, sessionId: "s", requestId: "r", signal: new AbortController().signal, onEvent: () => undefined };

  await transport.send({ content: "xem biểu này", sessionId: "s", requestId: "r", attachments }, { ...base, attachmentFiles: new Map([["attachment-1", file]]) });
  const sent = calls[0]!;
  assert.equal(calls.length, 1, "one request: there is no separate upload for anyone to find");
  assert.equal(sent.url, "https://gateway.example/api/chat/stream");
  assert.ok(sent.init.body instanceof FormData, "the file and the message travel together");
  assert.equal(new Headers(sent.init.headers).get("content-type"), null, "the form names its own content type, boundary included");
  const form = sent.init.body as FormData;
  assert.deepEqual(JSON.parse(String(form.get("request"))), { content: "xem biểu này", sessionId: "s", requestId: "r", attachments });
  const part = form.get("file:attachment-1") as File;
  assert.deepEqual([part.name, part.type, await part.text()], [file.name, file.type, "PK-xlsx-bytes"]);

  // A turn with no file of its own is the JSON it always was.
  await transport.send({ content: "xin chào", sessionId: "s", requestId: "r2", attachments: [] }, base);
  assert.equal(typeof calls[1]!.init.body, "string");
  assert.equal(new Headers(calls[1]!.init.headers).get("content-type"), "application/json");
});

test("HTTP harness transport explains browser network and CORS failures without leaking query secrets", async () => {
  const api = await builtApi();
  const transport = api.createHarnessTransport({
    baseUrl: "https://gateway.example/root/",
    endpoints: { runtime: "api/runtime?access_token=secret" },
    request: async () => { throw new TypeError("Failed to fetch"); },
  });
  const controller = new AbortController();
  await assert.rejects(
    transport.checkConnection?.({ operation: "runtime", sessionId: "s", requestId: "r", signal: controller.signal }),
    (error: unknown) => {
      assert.ok(error && typeof error === "object" && "message" in error);
      const message = String((error as { message: unknown }).message);
      assert.match(message, /gateway\.example\/root\/api\/runtime/);
      assert.match(message, /CORS.*Content Security Policy/);
      assert.doesNotMatch(message, /access_token|secret/);
      return true;
    },
  );
});

test("SSE decoder handles CRLF split across chunks and normalized progress", async () => {
  const api = await builtApi();
  const encoder = new TextEncoder();
  const chunks = [
    "event: progress\r",
    '\ndata: {"type":"turn-started"}\r\n\r',
    '\nevent: progress\r\ndata: {"type":"output-item-started","attemptId":"a1","itemId":"m1"}\r\n\r\n',
    'event: progress\r\ndata: {"type":"output-item-delta","attemptId":"a1","itemId":"m1","delta":"Đang kiểm tra"}\r\n\r\n',
    'event: progress\r\ndata: {"type":"output-item-completed","attemptId":"a1","itemId":"m1"}\r\n\r\n',
    'event: progress\r\ndata: {"type":"tool-state-changed","toolId":"current_time","callId":"c1","state":"running"}\r\n\r\n',
    'id: 6\r\nevent: assistant-output-start\r\ndata: {"type":"assistant-output-start","turnId":"t1","outputId":"o1","audience":"user"}\r\n\r\n',
    'id: 7\r\nevent: assistant-output-delta\r\ndata: {"type":"assistant-output-delta","turnId":"t1","outputId":"o1","audience":"user","delta":"Câu trả lời"}\r\n\r\n',
    'id: 8\r\nevent: assistant-output-end\r\ndata: {"type":"assistant-output-end","turnId":"t1","outputId":"o1","audience":"user","status":"completed"}\r\n\r\n',
    'event: assistant-narration-start\r\ndata: {"type":"assistant-narration-start","turnId":"t1","narrationId":"n1","audience":"user"}\r\n\r\n',
    'event: assistant-narration-delta\r\ndata: {"type":"assistant-narration-delta","turnId":"t1","narrationId":"n1","audience":"user","delta":"Tôi đang kiểm tra dữ liệu."}\r\n\r\n',
    'event: assistant-narration-end\r\ndata: {"type":"assistant-narration-end","turnId":"t1","narrationId":"n1","audience":"user","status":"completed"}\r\n\r\n',
    'event: text-delta\r\ndata: {"delta":"legacy raw text"}\r\n\r\n',
    'event: result\r\ndata: {"content":"ok"}\r\n\r\n',
  ];
  const transport = api.createHarnessTransport({
    baseUrl: "https://gateway.example",
    endpoints: { runtime: false, history: false },
    request: async () => new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream; charset=utf-8" } }),
  });
  const events: unknown[] = [];
  const controller = new AbortController();
  const result = await transport.send({ content: "hello", sessionId: "s", requestId: "r", attachments: [] }, {
    operation: "turn", sessionId: "s", requestId: "r", signal: controller.signal, onEvent: (event) => events.push(event),
  });
  assert.equal(result.content, "ok");
  const normalized = JSON.parse(JSON.stringify(events)) as Array<Record<string, unknown>>;
  assert.deepEqual(normalized.filter((event) => String(event.type).startsWith("assistant-output")), [
    { type: "assistant-output-start", outputId: "o1", audience: "user", turnId: "t1" },
    { type: "assistant-output-delta", outputId: "o1", audience: "user", delta: "Câu trả lời", turnId: "t1" },
    { type: "assistant-output-end", outputId: "o1", audience: "user", status: "completed", turnId: "t1" },
  ]);
  assert.deepEqual(normalized.filter((event) => String(event.type).startsWith("assistant-narration")), [
    { type: "assistant-narration-start", narrationId: "n1", audience: "user", turnId: "t1" },
    { type: "assistant-narration-delta", narrationId: "n1", audience: "user", delta: "Tôi đang kiểm tra dữ liệu.", turnId: "t1" },
    { type: "assistant-narration-end", narrationId: "n1", audience: "user", status: "completed", turnId: "t1" },
  ]);
  assert.deepEqual(normalized.filter((event) => event.type === "activity"), [
    { type: "activity", activity: { id: "analysis", code: "analyzing", state: "active" } },
    { type: "activity", activity: { id: "composing", code: "composing", state: "active" } },
  ]);
  assert.equal(normalized.filter((event) => event.type === "progress").length, 5, "raw progress remains observable");
  const uiEvents = normalized.filter((event) => event.type === "activity" || String(event.type).startsWith("assistant-narration") || String(event.type).startsWith("assistant-output"));
  assert.doesNotMatch(JSON.stringify(uiEvents), /current_time|toolId|tool-state|Đang kiểm tra\"|legacy raw text/);
  assert.equal(normalized.some((event) => event.type === "metadata"), true, "unknown legacy frames remain observable but are not rendered");
});

test("agent-authored plan and private reasoning reach the trace without leaking internals", async () => {
  const api = await builtApi();
  const encoder = new TextEncoder();
  const chunks = [
    'event: progress\ndata: {"type":"turn-started","turnId":"t1"}\n\n',
    'event: progress\ndata: {"type":"step-started","turnId":"t1","step":2}\n\n',
    'event: assistant-reasoning-start\ndata: {"type":"assistant-reasoning-start","turnId":"t1","reasoningId":"r1","audience":"user"}\n\n',
    'event: assistant-reasoning-delta\ndata: {"type":"assistant-reasoning-delta","turnId":"t1","reasoningId":"r1","audience":"user","delta":"Cần đọc dữ liệu công."}\n\n',
    'event: assistant-reasoning-end\ndata: {"type":"assistant-reasoning-end","turnId":"t1","reasoningId":"r1","audience":"user","status":"completed"}\n\n',
    'event: progress\ndata: {"type":"plan-updated","turnId":"t1","step":2,"cause":"proposal","plan":{"planId":"p1","revision":1,"state":"active","goal":"Tính lương tháng 8","steps":[{"id":"s1","description":"Đã lấy dữ liệu: 152 nhân viên","status":"completed"},{"id":"s2","description":"Đối chiếu thông tin nhân sự","status":"in_progress"},{"id":"s3","description":"Tạo bảng lương","status":"pending"}]},"changedStepIds":["s1","s2"]}\n\n',
    'event: progress\ndata: {"type":"plan-updated","turnId":"t1","step":2,"cause":"proposal","plan":{"objective":"CANARY","tasks":[]}}\n\n',
    'event: progress\ndata: {"type":"tool-started","turnId":"t1","step":2,"callId":"c1","label":"Đang tính bảng lương…","workStepId":"s2"}\n\n',
    'event: progress\ndata: {"type":"tool-completed","turnId":"t1","step":2,"callId":"c1","status":"succeeded","workStepId":"s2"}\n\n',
    'event: progress\ndata: {"type":"answer-revision-requested","turnId":"t1","step":2}\n\n',
    'event: result\ndata: {"content":"xong"}\n\n',
  ];
  const transport = api.createHarnessTransport({
    baseUrl: "https://gateway.example",
    endpoints: { runtime: false, history: false },
    request: async () => new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream; charset=utf-8" } }),
  });
  const events: unknown[] = [];
  const controller = new AbortController();
  await transport.send({ content: "tính lương tháng 8", sessionId: "s", requestId: "r", attachments: [] }, {
    operation: "turn", sessionId: "s", requestId: "r", signal: controller.signal, onEvent: (event) => events.push(event),
  });
  const normalized = JSON.parse(JSON.stringify(events)) as Array<Record<string, unknown>>;
  assert.deepEqual(normalized.filter((event) => String(event.type).startsWith("assistant-reasoning")), [
    { type: "assistant-reasoning-start", reasoningId: "r1", audience: "user", turnId: "t1" },
    { type: "assistant-reasoning-delta", reasoningId: "r1", audience: "user", delta: "Cần đọc dữ liệu công.", turnId: "t1" },
    { type: "assistant-reasoning-end", reasoningId: "r1", audience: "user", status: "completed", turnId: "t1" },
  ], "private reasoning is delivered so the trace can show what the agent is actually doing");
  assert.deepEqual(normalized.filter((event) => event.type === "plan-updated"), [
    { type: "plan-updated", turnId: "t1", cause: "proposal", plan: { planId: "p1", revision: 1, state: "active", goal: "Tính lương tháng 8", steps: [
      { id: "s1", description: "Đã lấy dữ liệu: 152 nhân viên", status: "completed" },
      { id: "s2", description: "Đối chiếu thông tin nhân sự", status: "in_progress" },
      { id: "s3", description: "Tạo bảng lương", status: "pending" },
    ] }, changedStepIds: ["s1", "s2"] },
  ], "the runtime owns identity, scope and closure; a malformed plan yields no event at all");
  assert.deepEqual(normalized.filter((event) => event.type === "tool-started" || event.type === "tool-completed"), [
    { type: "tool-started", turnId: "t1", callId: "c1", label: "Đang tính bảng lương…", workStepId: "s2" },
    { type: "tool-completed", turnId: "t1", callId: "c1", status: "succeeded", workStepId: "s2" },
  ], "tool status comes straight from the runtime, never guessed from a phrase");
  assert.deepEqual(normalized.filter((event) => event.type === "activity"), [
    { type: "activity", activity: { id: "analysis", code: "analyzing", state: "active" } },
    { type: "activity", activity: { id: "revision", code: "revising", state: "active" } },
  ], "a step boundary no longer invents a duplicate activity line, and tool work is its own event now");
  const rendered = normalized.filter((event) => event.type === "plan-updated" || event.type === "tool-started" || event.type === "tool-completed"
    || event.type === "activity" || String(event.type).startsWith("assistant-reasoning"));
  assert.doesNotMatch(JSON.stringify(rendered), /CANARY|toolId|payroll_/);
});

test("turn-completed tells a paused ending apart from a real one, so the widget can show a waiting header instead of the completion summary", async () => {
  const api = await builtApi();
  const encoder = new TextEncoder();
  const chunksFor = (outcome: string) => [
    `event: progress\ndata: {"type":"turn-completed","turnId":"t1","steps":2,"outcome":"${outcome}"}\n\n`,
    'event: result\ndata: {"content":"","outcome":"' + outcome + '","approval":{"approvalId":"a1","sessionId":"s","turnId":"t1","toolId":"tool",'
      + '"sideEffect":"none","expiresAt":"2099-01-01T00:00:00.000Z"},"interaction":{"kind":"form","interactionId":"i1","sessionId":"s","turnId":"t1",'
      + '"toolId":"tool","requesterId":"agent","message":"m","expiresAt":"2099-01-01T00:00:00.000Z","requestedSchema":{"type":"object","properties":{"a":{"type":"string"}}}}}\n\n',
  ];
  for (const [outcome, expectedState] of [["awaiting_approval", "awaiting"], ["awaiting_interaction", "awaiting"], ["completed", "done"], ["partial", "partial"]] as const) {
    const transport = api.createHarnessTransport({
      baseUrl: "https://gateway.example",
      endpoints: { runtime: false, history: false },
      request: async () => new Response(new ReadableStream({
        start(controller) {
          for (const chunk of chunksFor(outcome)) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream; charset=utf-8" } }),
    });
    const events: unknown[] = [];
    const controller = new AbortController();
    await transport.send({ content: "x", sessionId: "s", requestId: "r", attachments: [] }, {
      operation: "turn", sessionId: "s", requestId: "r", signal: controller.signal, onEvent: (event) => events.push(event),
    });
    const activity = (JSON.parse(JSON.stringify(events)) as Array<{ type: string; activity?: { id: string; state: string } }>)
      .find((event) => event.type === "activity" && event.activity?.id === "complete");
    assert.equal(activity?.activity?.state, expectedState, `outcome ${outcome} maps to activity state ${expectedState}`);
  }
});

test("HTTP transport resumes an interrupted POST stream without duplicating delivered events", async () => {
  const api = await builtApi();
  const encoder = new TextEncoder();
  const calls: Array<{ body: string | null; headers: Headers }> = [];
  let attempt = 0;
  const transport = api.createHarnessTransport({
    baseUrl: "https://gateway.example",
    reconnect: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    request: async (_url: string, init: RequestInit) => {
      attempt += 1;
      calls.push({ body: typeof init.body === "string" ? init.body : null, headers: new Headers(init.headers) });
      if (attempt === 1) {
        let delivered = false;
        return new Response(new ReadableStream({
          pull(controller) {
            if (!delivered) {
              delivered = true;
              controller.enqueue(encoder.encode(
                'id: 1\nevent: assistant-output-start\ndata: {"outputId":"answer","audience":"user"}\n\n' +
                'id: 2\nevent: assistant-output-delta\ndata: {"outputId":"answer","audience":"user","delta":"first"}\n\n',
              ));
              return;
            }
            controller.error(new TypeError("connection reset"));
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(
        'id: 3\nevent: assistant-output-delta\ndata: {"outputId":"answer","audience":"user","delta":" second"}\n\n' +
        'id: 4\nevent: assistant-output-end\ndata: {"outputId":"answer","audience":"user","status":"completed"}\n\n' +
        'id: 5\nevent: result\ndata: {"content":"first second"}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const events: unknown[] = [];
  const controller = new AbortController();
  const result = await transport.send({ content: "hello", sessionId: "s", requestId: "same-request", attachments: [] }, {
    operation: "turn", sessionId: "s", requestId: "same-request", signal: controller.signal, onEvent: (event) => events.push(event),
  });
  assert.equal(result.content, "first second");
  assert.equal(attempt, 2);
  assert.equal(calls[0]?.body, calls[1]?.body, "reconnect must reuse the exact idempotent payload");
  assert.equal(calls[0]?.headers.get("last-event-id"), null);
  assert.equal(calls[1]?.headers.get("last-event-id"), "2");
  const normalized = JSON.parse(JSON.stringify(events)) as Array<Record<string, unknown>>;
  assert.deepEqual(normalized.filter((event) => event.type === "assistant-output-delta").map((event) => event.delta), ["first", " second"]);
  assert.equal(normalized.filter((event) => event.type === "assistant-output-start").length, 1);
  assert.equal(normalized.some((event) => event.type === "activity" && (event.activity as { code?: string }).code === "retrying"), true);
});

test("a reasoned 409 conflict is refused once and never retried, so a card can settle final without three rejected resumes (audit P1-4)", async () => {
  const api = await builtApi();
  let attempts = 0;
  const transport = api.createHarnessTransport({
    baseUrl: "https://gateway.example",
    reconnect: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    request: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: { code: "conflict", message: "Yêu cầu này đã hết hiệu lực.", reason: "expired" } }),
        { status: 409, headers: { "content-type": "application/json" } });
    },
  });
  const controller = new AbortController();
  await assert.rejects(
    transport.resolveInteraction?.(
      { kind: "form", action: "accept", content: {}, interactionId: "i1", sessionId: "s", requestId: "r" },
      { operation: "interaction", sessionId: "s", requestId: "r", signal: controller.signal, onEvent: () => undefined },
    )!,
    (error: unknown) => typeof error === "object" && error !== null && (error as { reason?: string }).reason === "expired",
  );
  assert.equal(attempts, 1, "a reasoned conflict is the card's final state already — retrying it can never change the answer");
});

test("a 409 conflict with no reason is still retried, exactly as before this fix", async () => {
  const api = await builtApi();
  let attempts = 0;
  const transport = api.createHarnessTransport({
    baseUrl: "https://gateway.example",
    reconnect: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    request: async () => {
      attempts += 1;
      if (attempts < 3) {
        return new Response(JSON.stringify({ error: { code: "conflict", message: "stale runtime lease" } }),
          { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response('event: result\ndata: {"content":"done"}\n\n', { headers: { "content-type": "text/event-stream" } });
    },
  });
  const controller = new AbortController();
  const result = await transport.send({ content: "hello", sessionId: "s", requestId: "r", attachments: [] }, {
    operation: "turn", sessionId: "s", requestId: "r", signal: controller.signal, onEvent: () => undefined,
  });
  assert.equal(result.content, "done");
  assert.equal(attempts, 3, "an unreasoned conflict — a lost race, a stale lease — can still resolve on its own, so it keeps retrying");
});

test("HTTP transport sends explicit cancellation to the dedicated endpoint", async () => {
  const api = await builtApi();
  let captured: { url: string; init: RequestInit; operation: string } | undefined;
  const transport = api.createHarnessTransport({
    baseUrl: "https://gateway.example/root/",
    endpoints: { cancelTurn: "turn/cancel" },
    request: async (url: string, init: RequestInit, context: { operation: string }) => {
      captured = { url, init, operation: context.operation };
      return new Response('{"cancelled":true}', { status: 202, headers: { "content-type": "application/json" } });
    },
  });
  const controller = new AbortController();
  await transport.cancelTurn?.({ operation: "cancel", sessionId: "session", requestId: "request", signal: controller.signal });
  assert.equal(captured?.url, "https://gateway.example/root/turn/cancel");
  assert.equal(captured?.operation, "cancel");
  assert.deepEqual(JSON.parse(String(captured?.init.body)), { sessionId: "session", requestId: "request" });
});

test("built-in transport rejects narration that is not explicitly addressed to the user", async () => {
  const api = await builtApi();
  const transport = api.createHarnessTransport({
    baseUrl: "https://gateway.example",
    endpoints: { runtime: false, history: false },
    request: async () => new Response(
      'event: assistant-narration-start\ndata: {"narrationId":"n-private","audience":"internal"}\n\nevent: result\ndata: {"content":"done"}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ),
  });
  const controller = new AbortController();
  await assert.rejects(
    transport.send({ content: "hello", sessionId: "s", requestId: "r", attachments: [] }, {
      operation: "turn", sessionId: "s", requestId: "r", signal: controller.signal, onEvent: () => undefined,
    }),
    /SSE narration frame does not match the public shape/,
  );
});

test("built-in transport requires the SSE response media type", async () => {
  const api = await builtApi();
  const transport = api.createHarnessTransport({
    baseUrl: "https://gateway.example",
    endpoints: { runtime: false, history: false },
    request: async () => new Response('event: result\ndata: {"content":"done"}\n\n'),
  });
  const controller = new AbortController();
  await assert.rejects(
    transport.send({ content: "hello", sessionId: "s", requestId: "r", attachments: [] }, {
      operation: "turn", sessionId: "s", requestId: "r", signal: controller.signal, onEvent: () => undefined,
    }),
    /must return SSE/,
  );
});

test("built-in transport rejects an approval challenge bound to another session", async () => {
  const api = await builtApi();
  const transport = api.createHarnessTransport({
    baseUrl: "https://gateway.example",
    endpoints: { runtime: false, history: false },
    request: async () => new Response(
      'event: result\ndata: {"content":"approval needed","outcome":"awaiting_approval","approval":{"approvalId":"approval-1","sessionId":"other-session","turnId":"turn-1","toolId":"write_tool","sideEffect":"nonIdempotent","expiresAt":"2099-01-01T00:00:00.000Z"}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ),
  });
  const controller = new AbortController();
  await assert.rejects(
    transport.send({ content: "hello", sessionId: "expected-session", requestId: "r", attachments: [] }, {
      operation: "turn", sessionId: "expected-session", requestId: "r", signal: controller.signal, onEvent: () => undefined,
    }),
    /missing a valid approval challenge for the current session/,
  );
});

test("custom SSE protocol maps a different event dialect", async () => {
  const api = await builtApi();
  const transport = api.createHarnessTransport({
    baseUrl: "https://gateway.example",
    protocol: (frame: { event: string; data: string }) => {
      const payload = JSON.parse(frame.data) as { text: string };
      return frame.event === "answer.done" ? { type: "result", result: { content: payload.text } } : null;
    },
    request: async () => new Response('event: answer.done\ndata: {"text":"mapped"}\n\n', { headers: { "content-type": "text/event-stream" } }),
  });
  const controller = new AbortController();
  const result = await transport.send({ content: "hello", sessionId: "s", requestId: "r", attachments: [] }, {
    operation: "turn", sessionId: "s", requestId: "r", signal: controller.signal, onEvent: () => undefined,
  });
  assert.equal(result.content, "mapped");
});

test("controller source no longer owns HTTP routes or SSE parsing", async () => {
  const [entry, controller, narrationBubbles, transport, streamProtocol] = await Promise.all([
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/core/widget.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/core/narration-superseded.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/transport/harness-http-transport.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/transport/harness-stream-protocol.ts", import.meta.url), "utf8"),
  ]);
  assert.ok(entry.split("\n").length < 30, "index.ts should remain a small composition root");
  assert.doesNotMatch(controller, /\/api\//);
  assert.doesNotMatch(controller, /\bfetch\s*\(/);
  assert.doesNotMatch(controller, /parseSse/);
  assert.match(narrationBubbles, /dataset\.messageKind = "narration"/, "narration bubbles are built in their own module");
  assert.match(controller, /narrationBubble\(/);
  assert.doesNotMatch(controller, /acw-agent-update/);
  assert.doesNotMatch(controller, /acw-thinking-updates|acw-public-update/);
  assert.doesNotMatch(controller, /Đang dùng|Đã dùng|Không được phép dùng|#toolLabel/);
  assert.doesNotMatch(controller, /output-item-|tool-state-changed/);
  assert.match(controller, /#renderApproval/);
  assert.match(controller, /assistant-output-start/);
  assert.match(controller, /assistant-narration-start/);
  assert.match(transport, /api\/chat\/stream/);
  assert.match(transport, /AgentChatSseDecoder/);
  assert.match(streamProtocol, /projectHarnessProgress/);
});

test("history keeps a failed turn's classified code, so a stopped turn can replay as it looked live", async () => {
  const api = await builtApi();
  const entry = (status: string, failure: unknown) => ({ role: "assistant", content: "Đã dừng xử lý theo yêu cầu.", status, failure });
  const transport = api.createHarnessTransport({
    baseUrl: "https://gateway.example", endpoints: { runtime: false },
    request: async () => new Response(JSON.stringify({ messages: [
      entry("failed", { code: "cancelled" }), entry("failed", { code: "timeout" }),
      // Malformed or out of place, it is dropped rather than trusted.
      entry("failed", { code: "<script>" }), entry("failed", "cancelled"), entry("completed", { code: "cancelled" }),
    ] }), { headers: { "content-type": "application/json" } }),
  });
  const history = await transport.loadHistory?.({ operation: "history", sessionId: "s", requestId: "r", signal: new AbortController().signal });
  assert.deepEqual(JSON.parse(JSON.stringify(history?.map((message) => (message as { failure?: unknown }).failure ?? null))),
    [{ code: "cancelled" }, { code: "timeout" }, null, null, null]);
});
