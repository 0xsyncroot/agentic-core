import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityEvidence, ResumableAgent, RunTurnResult, SecurityContext } from "@0xsyncroot/contracts";
import { createAgentApiFastify } from "../src/fastify/agent-api-fastify.js";
import type { AgentApiRuntime } from "../src/agent-api-handler.js";

function testSecurity(overrides: Partial<SecurityContext> = {}): SecurityContext {
  return { tenantId: "tenant-a", actorId: "actor-a", permissions: new Set(["*"]), correlationId: "c", purpose: "test", ...overrides };
}

function runtime(overrides: Partial<AgentApiRuntime> = {}): AgentApiRuntime {
  return {
    agent: {
      runTurn: async (input): Promise<RunTurnResult> =>
        ({ sessionId: input.sessionId, turnId: "turn-a", content: "ok", outcome: "completed", events: [] } as unknown as RunTurnResult),
      resumeTurn: async () => ({ sessionId: "session-a", turnId: "turn-b", content: "resumed", outcome: "completed", events: [] } as unknown as RunTurnResult),
      resumeInteraction: async () => { throw new Error("not used"); },
    } as ResumableAgent,
    identityResolver: { resolve: async (evidence: IdentityEvidence) => testSecurity({ correlationId: evidence.correlationId }) },
    sessions: { loadRecent: async () => [] },
    ...overrides,
  };
}

test("createAgentApiFastify serves health, runtime, chat, cancel, sessions and approvals through Fastify's own router", async () => {
  const app = createAgentApiFastify(runtime());
  try {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: "ok" });
    assert.equal(health.headers["content-security-policy"], "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; frame-ancestors 'none'");

    const runtimeProbe = await app.inject({ method: "GET", url: "/api/runtime" });
    assert.equal(runtimeProbe.statusCode, 200);
    assert.deepEqual(runtimeProbe.json(), { status: "ok" });

    const chat = await app.inject({
      method: "POST", url: "/api/chat", headers: { "content-type": "application/json" },
      payload: { content: "hi", sessionId: "session-a", requestId: "request-a" },
    });
    assert.equal(chat.statusCode, 200);
    const chatBody = chat.json() as { content: string; sessionId: string; outcome: string; metrics: { steps: number } };
    assert.equal(chatBody.content, "ok");
    assert.equal(chatBody.sessionId, "session-a");
    assert.equal(chatBody.outcome, "completed");

    const cancel = await app.inject({
      method: "POST", url: "/api/chat/cancel", headers: { "content-type": "application/json" },
      payload: { sessionId: "session-a", requestId: "request-a" },
    });
    assert.equal(cancel.statusCode, 200);
    assert.deepEqual(cancel.json(), { cancelled: false });

    // A session id containing a slash is not a single path segment; the original raw-http handler
    // slices everything after "/api/sessions/" and lets SESSION_PATTERN reject it with 400, rather
    // than 404ing on an unmatched route the way a Fastify `:sessionId` param would. The wildcard
    // route registration exists specifically to preserve that.
    const badSession = await app.inject({ method: "GET", url: "/api/sessions/has%2Fslash" });
    assert.equal(badSession.statusCode, 400);
    assert.equal((badSession.json() as { error: { code: string } }).error.code, "validation");

    const sessions = await app.inject({ method: "GET", url: "/api/sessions/session-a" });
    assert.equal(sessions.statusCode, 200);
    assert.deepEqual(sessions.json(), { sessionId: "session-a", messages: [] });

    const approval = await app.inject({
      method: "POST", url: "/api/approvals/approval-1", headers: { "content-type": "application/json" },
      payload: { sessionId: "session-a", requestId: "request-b", decision: "approve" },
    });
    assert.equal(approval.statusCode, 200);
    assert.equal((approval.json() as { content: string }).content, "resumed");

    const notFound = await app.inject({ method: "GET", url: "/api/nowhere" });
    assert.equal(notFound.statusCode, 404);
    assert.equal((notFound.json() as { error: { code: string } }).error.code, "not-found");
  } finally {
    await app.close();
  }
});

test("createAgentApiFastify rejects a disallowed browser origin with no CORS header echoed, and answers a preflight", async () => {
  const app = createAgentApiFastify(runtime(), { allowedOrigins: ["https://portal.example"] });
  try {
    const denied = await app.inject({ method: "GET", url: "/api/runtime", headers: { origin: "https://untrusted.example" } });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
    assert.equal((denied.json() as { error: { code: string } }).error.code, "denied");

    const preflight = await app.inject({
      method: "OPTIONS", url: "/api/chat",
      headers: { origin: "https://portal.example", "access-control-request-method": "POST" },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], "https://portal.example");

    const allowed = await app.inject({ method: "GET", url: "/api/runtime", headers: { origin: "https://portal.example" } });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.headers["access-control-allow-origin"], "https://portal.example");
  } finally {
    await app.close();
  }
});

test("createAgentApiFastify requires a production-safe stream registry in production, same as the raw-http handler", () => {
  assert.throws(() => createAgentApiFastify(runtime(), { deploymentProfile: "production" }), /production-safe shared ResumableAgentStreamRegistry/);
});

test("createAgentApiFastify pins keepAliveTimeout, bodyLimit and maxParamLength, overridable by a consumer", async () => {
  const defaults = createAgentApiFastify(runtime());
  try {
    assert.equal(defaults.server.keepAliveTimeout, 72_000);
    assert.equal(defaults.initialConfig.bodyLimit, 256 * 1024);
  } finally {
    await defaults.close();
  }
  const overridden = createAgentApiFastify(runtime(), { keepAliveTimeoutMs: 5_000, bodyLimit: 1_024 });
  try {
    assert.equal(overridden.server.keepAliveTimeout, 5_000);
    assert.equal(overridden.initialConfig.bodyLimit, 1_024);
  } finally {
    await overridden.close();
  }
});

test("createAgentApiFastify answers a pre-stream validation error on /api/chat/stream instead of hanging the connection forever", async () => {
  const app = createAgentApiFastify(runtime(), { includeErrorDetail: true });
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    // No content-type header: chatInput() throws before servePublicAgentStream ever starts writing,
    // exercising the reply.hijack()-then-error path directly (a regression this caught the first time:
    // reply.send() after hijack() writes nothing, and the connection just hung).
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/stream`, {
      method: "POST", body: JSON.stringify({ content: "hi", sessionId: "session-a", requestId: "request-a" }), signal: controller.signal,
    });
    clearTimeout(timer);
    assert.equal(response.status, 400);
    const body = await response.json() as { error: { code: string; detail?: string } };
    assert.equal(body.error.code, "validation");
    assert.equal(body.error.detail, "Content-Type must be application/json");
  } finally {
    await app.close();
  }
});

test("createAgentApiFastify serves /api/chat/stream over a real socket via reply.hijack(), with the same SSE framing as the raw-http handler", async () => {
  const app = createAgentApiFastify(runtime());
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/stream`, {
      method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ content: "hi", sessionId: "session-stream", requestId: "request-stream" }),
    });
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get("content-type")), /^text\/event-stream/);
    const text = await response.text();
    assert.match(text, /event: result\ndata: .*"content":"ok"/);
  } finally {
    await app.close();
  }
});

/** A turn the way the widget sends one with a file: the JSON body as `request`, the file as `file:<attachment id>`. */
async function multipartTurn(body: Record<string, unknown>, files: Record<string, File>) {
  const form = new FormData();
  form.append("request", JSON.stringify(body));
  for (const [id, file] of Object.entries(files)) form.append(`file:${id}`, file, file.name);
  const encoded = new Response(form);
  return { payload: Buffer.from(await encoded.arrayBuffer()), headers: { "content-type": encoded.headers.get("content-type")! } };
}
const SHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const sheet = (name: string, bytes = "PK-xlsx-bytes") => new File([bytes], name, { type: SHEET });
const attached = (id: string, name: string, size = 13) => ({ id, name, type: SHEET, size, source: "picker" });

test("a file sent with the turn is stored by the service, and the browser is told nothing about where", async () => {
  const stored: { name: string; mediaType: string; bytes: string; tenant: string }[] = [];
  const seenAttachments: unknown[] = [];
  const app = createAgentApiFastify(runtime({
    agent: {
      runTurn: async (input): Promise<RunTurnResult> => {
        seenAttachments.push(input.attachments);
        return { sessionId: input.sessionId, turnId: "turn-a", content: "ok", outcome: "completed", events: [] } as unknown as RunTurnResult;
      },
      resumeTurn: async () => { throw new Error("not used"); },
      resumeInteraction: async () => { throw new Error("not used"); },
    } as ResumableAgent,
  }), {
    attachmentStore: {
      store: async (file, security) => {
        stored.push({ name: file.name, mediaType: file.mediaType, bytes: file.bytes.toString("utf8"), tenant: security.tenantId });
        return `stored-${stored.length}-HANDLE`;
      },
    },
  });
  try {
    const turn = await multipartTurn(
      { content: "xem biểu này", sessionId: "session-a", requestId: "request-a", attachments: [attached("attachment-1", "Dự toán 2027.xlsx")] },
      { "attachment-1": sheet("Dự toán 2027.xlsx") },
    );
    const response = await app.inject({ method: "POST", url: "/api/chat", ...turn });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(stored, [{ name: "Dự toán 2027.xlsx", mediaType: SHEET, bytes: "PK-xlsx-bytes", tenant: "tenant-a" }]);
    assert.deepEqual(seenAttachments, [[{ id: "stored-1-HANDLE", name: "Dự toán 2027.xlsx", mediaType: SHEET, byteSize: 13, source: "picker" }]],
      "the turn names the file by the handle the store gave it — the one a tool can open");
    assert.ok(!response.body.includes("HANDLE") && !response.body.includes("attachment-1"), `the answer carried a handle back: ${response.body}`);

    // The same file attached twice is one stored object: listed once, not refused as a duplicate.
    const app2 = createAgentApiFastify(runtime({
      agent: { runTurn: async (input): Promise<RunTurnResult> => { seenAttachments.push(input.attachments); return { sessionId: input.sessionId, turnId: "t", content: "ok", outcome: "completed", events: [] } as unknown as RunTurnResult; } } as ResumableAgent,
    }), { attachmentStore: { store: async () => "same-HANDLE" } });
    try {
      const twice = await multipartTurn(
        { content: "x", sessionId: "session-a", requestId: "request-b", attachments: [attached("a1", "A.xlsx"), attached("a2", "A (1).xlsx")] },
        { a1: sheet("A.xlsx"), a2: sheet("A (1).xlsx") },
      );
      assert.equal((await app2.inject({ method: "POST", url: "/api/chat", ...twice })).statusCode, 200);
      assert.deepEqual((seenAttachments.at(-1) as { id: string }[]).map((entry) => entry.id), ["same-HANDLE"]);
    } finally { await app2.close(); }
  } finally {
    await app.close();
  }
});

test("a turn with files stores nothing for a caller it cannot identify, or for a request it will refuse", async () => {
  let stores = 0;
  const store = { store: async () => { stores += 1; return "h"; } };
  const anonymous = createAgentApiFastify(runtime({ identityResolver: { resolve: async () => { throw new (await import("@0xsyncroot/contracts")).AgenticError("denied", "no"); } } }), { attachmentStore: store });
  const known = createAgentApiFastify(runtime(), { attachmentStore: store });
  try {
    const good = { content: "x", sessionId: "session-a", requestId: "request-a", attachments: [attached("a1", "A.xlsx")] };
    const denied = await anonymous.inject({ method: "POST", url: "/api/chat", ...await multipartTurn(good, { a1: sheet("A.xlsx") }) });
    assert.equal(denied.statusCode, 403);
    const invalid = await known.inject({ method: "POST", url: "/api/chat", ...await multipartTurn({ ...good, sessionId: "not a session id" }, { a1: sheet("A.xlsx") }) });
    assert.equal(invalid.statusCode, 400);
    const malformed = await known.inject({ method: "POST", url: "/api/chat", headers: { "content-type": "multipart/form-data; boundary=x" }, payload: "not a form" });
    assert.equal(malformed.statusCode, 400);
    assert.equal(stores, 0);
  } finally {
    await anonymous.close();
    await known.close();
  }
});

test("a service with no store drops a turn's files and keeps their names: the turn still runs", async () => {
  const seen: unknown[] = [];
  const app = createAgentApiFastify(runtime({
    agent: { runTurn: async (input): Promise<RunTurnResult> => { seen.push(input.attachments); return { sessionId: input.sessionId, turnId: "t", content: "ok", outcome: "completed", events: [] } as unknown as RunTurnResult; } } as ResumableAgent,
  }));
  try {
    const turn = await multipartTurn({ content: "x", sessionId: "session-a", requestId: "request-a", attachments: [attached("attachment-1", "A.xlsx")] }, { "attachment-1": sheet("A.xlsx") });
    assert.equal((await app.inject({ method: "POST", url: "/api/chat", ...turn })).statusCode, 200);
    assert.deepEqual(seen, [[{ id: "attachment-1", name: "A.xlsx", mediaType: SHEET, byteSize: 13, source: "picker" }]]);
  } finally {
    await app.close();
  }
});

test("a service that stores files refuses a turn naming a file it was not given, and says which side lost it", async () => {
  let runs = 0;
  const app = createAgentApiFastify(runtime({
    agent: { runTurn: async (input): Promise<RunTurnResult> => { runs += 1; return { sessionId: input.sessionId, turnId: "t", content: "ok", outcome: "completed", events: [] } as unknown as RunTurnResult; } } as ResumableAgent,
  }), { attachmentStore: { store: async () => "stored-HANDLE" }, includeErrorDetail: true });
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => { warnings.push(line); };
  try {
    const body = { content: "xem biểu này", sessionId: "session-a", requestId: "request-a", attachments: [attached("attachment-1", "Dự toán 2027.xlsx")] };
    // What a client that predates this sends: the file's name, and no file.
    const json = await app.inject({ method: "POST", url: "/api/chat", headers: { "content-type": "application/json" }, payload: body });
    assert.equal(json.statusCode, 400);
    assert.match(json.body, /arrived without their content: the client sent the turn as JSON/);
    // What a proxy that drops the file part leaves behind.
    const stripped = await app.inject({ method: "POST", url: "/api/chat", ...await multipartTurn(body, {}) });
    assert.equal(stripped.statusCode, 400);
    assert.match(stripped.body, /something between the client and this service dropped the file/);
    assert.equal(runs, 0, "neither turn ran: the assistant is never left asking for a file it was given");
    assert.deepEqual(warnings.map((line) => (JSON.parse(line) as { event: string; transport: string }).transport), ["json", "multipart"]);

    // A file the host stored on its own is not this service's to demand.
    const hosted = await app.inject({ method: "POST", url: "/api/chat", headers: { "content-type": "application/json" },
      payload: { ...body, attachments: [{ ...attached("attachment-1", "Dự toán 2027.xlsx"), data: { documentId: "host-doc-1" } }] } });
    assert.equal(hosted.statusCode, 200);
    assert.equal(runs, 1);
  } finally {
    console.warn = warn;
    await app.close();
  }
});

test("/api/runtime carries the product's words for the lines a chat client writes itself", async () => {
  const app = createAgentApiFastify(runtime(), { clientLabels: { thinking: "Đang suy nghĩ", awaitingUser: "Đang chờ anh/chị phản hồi…", "not a label": "x", blank: " " } });
  const plain = createAgentApiFastify(runtime());
  try {
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/runtime" })).json(),
      { status: "ok", labels: { thinking: "Đang suy nghĩ", awaitingUser: "Đang chờ anh/chị phản hồi…" } });
    assert.deepEqual((await plain.inject({ method: "GET", url: "/api/runtime" })).json(), { status: "ok" }, "a product with none answers as it always did");
  } finally {
    await app.close();
    await plain.close();
  }
});

test("a turn that ends with nothing to say is answered in the product's own words, not left for the client to fill", async () => {
  const ending = (outcome: string, content = "") => runtime({
    agent: { runTurn: async (input): Promise<RunTurnResult> => ({ sessionId: input.sessionId, turnId: "t", content, outcome, events: [] } as unknown as RunTurnResult) } as ResumableAgent,
  });
  const businessMessages = { emptyAnswer: { completed: "Em chưa có nội dung để trả lời.", stopped: "Em phải dừng giữa chừng." } };
  const turn = { method: "POST" as const, url: "/api/chat", headers: { "content-type": "application/json" }, payload: { content: "x", sessionId: "session-a", requestId: "request-a" } };
  for (const [outcome, content, expected] of [
    ["partial", "", "Em phải dừng giữa chừng."], ["completed", "", "Em chưa có nội dung để trả lời."],
    ["completed", "Xong rồi ạ.", "Xong rồi ạ."], ["awaiting_interaction", "", ""],
  ] as const) {
    const app = createAgentApiFastify(ending(outcome, content), { businessMessages });
    try { assert.equal(((await app.inject(turn)).json() as { content: string }).content, expected, outcome); }
    finally { await app.close(); }
  }
  const silent = createAgentApiFastify(ending("partial"));
  try { assert.equal(((await silent.inject(turn)).json() as { content: string }).content, "", "a product that wrote no sentence gets none invented for it"); }
  finally { await silent.close(); }
});

test("Fastify streams answer drafts as core emits them: nothing is held server-side for review", async () => {
  const base = runtime();
  const agent: ResumableAgent = { ...base.agent, runTurn: async (input) => {
    const channel = { turnId: "turn-a", outputId: "draft", audience: "user" as const };
    input.onOutput?.({ type: "assistant-output-start", ...channel });
    input.onOutput?.({ type: "assistant-output-delta", ...channel, delta: "DRAFT_SENT_BACK" });
    input.onProgress?.({ type: "answer-revision-requested", turnId: "turn-a", step: 1, phase: "terminal" });
    input.onOutput?.({ type: "assistant-output-end", ...channel, status: "discarded" });
    const accepted = { ...channel, outputId: "accepted" };
    input.onOutput?.({ type: "assistant-output-start", ...accepted });
    input.onOutput?.({ type: "assistant-output-delta", ...accepted, delta: "**Kết quả đã kiểm tra**" });
    input.onOutput?.({ type: "assistant-output-end", ...accepted, status: "completed" });
    return { sessionId: input.sessionId, turnId: "turn-a", content: "**Kết quả đã kiểm tra**", outcome: "completed", events: [] } as RunTurnResult;
  } };
  const app = createAgentApiFastify({ ...base, agent });
  try {
    const response = await app.inject({ method: "POST", url: "/api/chat/stream", payload: { content: "work", sessionId: "review-session", requestId: "review-request" } });
    assert.equal(response.statusCode, 200);
    const order = ["DRAFT_SENT_BACK", "answer-revision-requested", "Kết quả đã kiểm tra"].map((needle) => response.body.indexOf(needle));
    assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!)), "the draft, its retraction and the accepted answer cross in the order they happened");
  } finally { await app.close(); }
});

test("stream error observer receives the original exception without exposing it to clients", async () => {
  const root = new TypeError("PRIVATE_ORIGINAL_STACK", { cause: new Error("PRIVATE_CAUSE") });
  const base = runtime();
  const seen: unknown[] = [];
  const app = createAgentApiFastify({ ...base, agent: { ...base.agent, runTurn: async () => { throw root; } } }, {
    onStreamError: (error, key) => { seen.push(error, key); throw new Error("Observer failure must not mask the root error"); },
  });
  try {
    const response = await app.inject({ method: "POST", url: "/api/chat/stream", payload: { content: "work", sessionId: "error-session", requestId: "error-request" } });
    assert.equal(response.statusCode, 200);
    assert.equal(seen[0], root);
    assert.equal((seen[1] as { sessionId: string }).sessionId, "error-session");
    assert.match(response.body, /internal/);
    assert.doesNotMatch(response.body, /PRIVATE_|Observer failure/);
  } finally { await app.close(); }
});
