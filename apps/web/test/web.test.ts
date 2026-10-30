import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { test } from "node:test";
import { AgenticError, type AgentNarrationEvent, type ResumableAgent, type RunTurnInput, type SessionEvent } from "@0xsyncroot/contracts";
import { HmacIdentityResolver, resumableAgentStreamFingerprint, visibleMessages } from "@0xsyncroot/agent-api";
import { createWebApplication, type WebApplicationOptions, type WebRuntime } from "../src/web-application.js";

function testIdentity(tenantId = "server-tenant", actorId = "server-user") {
  return {
    resolve: async (evidence: { correlationId: string; purpose: string }) => ({
      tenantId, actorId, permissions: new Set(["*"]), correlationId: evidence.correlationId, purpose: evidence.purpose,
      authentication: { issuer: "test", subject: actorId, assurance: "user" as const },
      authorizedAgentProfiles: ["default"],
      trustedContext: { companyName: "Server Company", userName: "Nam" },
    }),
  };
}

function signedToken(secret: string, claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

test("stream operation fingerprints canonicalize host context key order", () => {
  const identity = {
    tenantId: "tenant", actorId: "actor", permissions: new Set(["read"]),
    correlationId: "correlation", purpose: "test",
  };
  const base = { sessionId: "session", requestId: "request", content: "hello" };
  assert.equal(
    resumableAgentStreamFingerprint(identity, { ...base, agentContext: { screen: "invoice", id: "42" } }),
    resumableAgentStreamFingerprint(identity, { ...base, agentContext: { id: "42", screen: "invoice" } }),
  );
});

async function listen(runtime: WebRuntime, options: WebApplicationOptions = {}): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createWebApplication(runtime, options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function request(url: string, options: { method?: string; body?: string; headers?: Readonly<Record<string, string>> } = {}): Promise<{ status: number; text: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const operation = httpRequest(url, {
      method: options.method ?? "GET",
      agent: false,
      headers: { ...(options.body ? { "content-type": "application/json", "content-length": Buffer.byteLength(options.body) } : {}), ...options.headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), headers: response.headers }));
    });
    operation.on("error", reject);
    if (options.body) operation.write(options.body);
    operation.end();
  });
}

test("web API serves static UI and derives security context on the server", async () => {
  let received: RunTurnInput | undefined;
  let resumedApproval = "";
  let resumedHuman: { readonly interactionId: string; readonly action: string; readonly content?: unknown } | undefined;
  let historyTenant = "";
  const now = new Date().toISOString();
  const historyBase = {
    sessionId: "history-trace", schemaVersion: 1, occurredAt: now, recordedAt: now,
    tenantId: "server-tenant", actorId: "server-user", correlationId: "history-correlation",
    runtimeSnapshotId: "runtime-web", classification: "internal" as const, turnId: "turn-history",
    integrityHash: "test",
  };
  const historyEvents: SessionEvent[] = [
    { ...historyBase, eventId: "history-1", seq: 1, type: "user/input", payload: { content: "research" } },
    { ...historyBase, eventId: "history-2", seq: 2, type: "step/start", stepId: "step-history", payload: { index: 1 } },
    { ...historyBase, eventId: "history-3", seq: 3, type: "assistant/message", stepId: "step-history", requestId: "request-progress", payload: { content: "Tôi sẽ tìm tài liệu phù hợp.", toolCalls: [{ id: "call-history" }] } },
    { ...historyBase, eventId: "history-4", seq: 4, type: "assistant/narration", stepId: "step-history", payload: { narrationId: "narration-history", audience: "user", content: "Tôi đang kiểm tra tài liệu phù hợp." } },
    { ...historyBase, eventId: "history-5", seq: 5, type: "tool/intent", stepId: "step-history", callId: "call-history", payload: { callId: "call-history", executionId: "execution-history", toolId: "knowledge_search", arguments: "{}", state: "prepared", sideEffect: "none" } },
    { ...historyBase, eventId: "history-6", seq: 6, type: "tool/result", stepId: "step-history", callId: "call-history", payload: { callId: "call-history", executionId: "execution-history", toolId: "knowledge_search", state: "succeeded", dispatched: true, executed: true } },
    { ...historyBase, eventId: "history-7", seq: 7, type: "tool/intent", stepId: "step-history", callId: "call-plan", payload: { callId: "call-plan", executionId: "execution-plan", toolId: "plan_update", arguments: "{}", state: "prepared", sideEffect: "none" } },
    { ...historyBase, eventId: "history-8", seq: 8, type: "tool/result", stepId: "step-history", callId: "call-plan", payload: { callId: "call-plan", executionId: "execution-plan", toolId: "plan_update", state: "succeeded", dispatched: true, executed: true } },
    { ...historyBase, eventId: "history-9", seq: 9, type: "work/plan-updated", stepId: "step-history", callId: "call-plan", payload: {
      planId: "plan-history", revision: 1, state: "completed", cause: "terminal", goal: "Research",
      steps: [{ id: "step-1", description: "Search", status: "completed", outcome: "Found the file" }],
      changedStepIds: ["step-1"], updatedAt: now,
    } },
    { ...historyBase, eventId: "history-10", seq: 10, type: "assistant/message", stepId: "step-history", payload: { content: "answer", ui: [{ type: "actions", actions: [{ id: "confirm", label: "Xác nhận", behavior: "submit" }] }] } },
    { ...historyBase, eventId: "history-11", seq: 11, type: "turn/end", payload: { status: "completed", decision: "finish" } },
    { ...historyBase, eventId: "history-12", seq: 12, turnId: "turn-approval", type: "user/input", payload: { content: "write" } },
    { ...historyBase, eventId: "history-13", seq: 13, turnId: "turn-approval", stepId: "step-approval", type: "assistant/message", payload: { content: null, toolCalls: [{ id: "approval-call", name: "write_tool", arguments: "{}" }] } },
    { ...historyBase, eventId: "history-14", seq: 14, turnId: "turn-approval", stepId: "step-approval", callId: "approval-call", type: "approval/requested", payload: {
      approvalId: "approval-history", callId: "approval-call", executionId: "execution-approval", toolId: "write_tool", arguments: '{"secret":"CANARY_PRIVATE_APPROVAL_ARGUMENT"}',
      sideEffect: "idempotent", actionDigest: "digest", decisionId: "decision", policyRevision: "policy", runtimeSnapshotId: "runtime-web",
      runtimeRouteRevision: "route-web", agentProfileId: "default", requestedBy: "server-user", grantRevision: "grant", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      presentation: {
        summary: "Update one record.", action: "Update record", target: "Record 7", impact: "The selected value changes.",
        fields: [{ label: "Affected records", value: 1 }], rawArguments: "CANARY_PRIVATE_APPROVAL_ARGUMENT",
      },
    } },
    { ...historyBase, eventId: "history-15", seq: 15, turnId: "turn-approval", type: "turn/end", payload: { status: "awaiting_approval" } },
    { ...historyBase, eventId: "history-16", seq: 16, turnId: "turn-interaction", type: "user/input", payload: { content: "lookup" } },
    { ...historyBase, eventId: "history-17", seq: 17, turnId: "turn-interaction", stepId: "step-interaction", type: "assistant/message", payload: { content: null, toolCalls: [{ id: "interaction-call", name: "lookup", arguments: "{}" }] } },
    { ...historyBase, eventId: "history-18", seq: 18, turnId: "turn-interaction", stepId: "step-interaction", callId: "interaction-call", type: "interaction/requested", payload: {
      interactionId: "interaction-history", callId: "interaction-call", executionId: "execution-interaction", toolId: "lookup", requesterId: "geo-mcp", arguments: "{}",
      request: { kind: "form", message: "Choose a region", requestedSchema: { type: "object", properties: { region: { type: "string", enum: ["north", "south"] } }, required: ["region"] } },
      continuation: { requestState: "must-not-leak" }, actionDigest: "digest", decisionId: "decision", policyRevision: "policy", authorizationOutcome: "allow",
      runtimeSnapshotId: "runtime-web", runtimeRouteRevision: "route-web", agentProfileId: "default", requestedBy: "server-user", grantRevision: "grant", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } },
    { ...historyBase, eventId: "history-19", seq: 19, turnId: "turn-interaction", type: "turn/end", payload: { status: "awaiting_interaction" } },
  ];
  const agent: ResumableAgent = {
    runTurn: async (input) => {
      received = input;
      input.onProgress?.({ type: "turn-started", turnId: "turn-web" });
      input.onProgress?.({ type: "step-started", turnId: "turn-web", step: 1 });
      input.onProgress?.({ type: "model-attempt-started", turnId: "turn-web", step: 1, attemptId: "attempt-web" });
      input.onProgress?.({ type: "output-item-started", turnId: "turn-web", step: 1, attemptId: "attempt-web", itemId: "item-web" });
      input.onProgress?.({ type: "output-item-delta", turnId: "turn-web", step: 1, attemptId: "attempt-web", itemId: "item-web", delta: "ok" });
      input.onProgress?.({ type: "output-item-completed", turnId: "turn-web", step: 1, attemptId: "attempt-web", itemId: "item-web" });
      input.onProgress?.({ type: "model-attempt-committed", turnId: "turn-web", step: 1, attemptId: "attempt-web", itemId: "item-web" });
      input.onOutput?.({ type: "assistant-output-start", turnId: "turn-web", outputId: "output-web", audience: "user" });
      input.onOutput?.({ type: "assistant-output-delta", turnId: "turn-web", outputId: "output-web", audience: "user", delta: "ok" });
      input.onOutput?.({ type: "assistant-output-end", turnId: "turn-web", outputId: "output-web", audience: "user", status: "completed" });
      input.onNarration?.({ type: "assistant-narration-start", turnId: "turn-web", narrationId: "narration-web", audience: "user" });
      input.onNarration?.({ type: "assistant-narration-delta", turnId: "turn-web", narrationId: "narration-web", audience: "user", delta: "Tôi đang kiểm tra." });
      input.onNarration?.({ type: "assistant-narration-end", turnId: "turn-web", narrationId: "narration-web", audience: "user", status: "completed" });
      input.onNarration?.({
        type: "assistant-narration-delta", turnId: "turn-web", narrationId: "narration-internal",
        audience: "internal", delta: "private runtime note",
      } as unknown as AgentNarrationEvent);
      input.onNarration?.({ type: "assistant-narration-start", turnId: "turn-web", narrationId: "narration-too-long", audience: "user" });
      input.onNarration?.({ type: "assistant-narration-delta", turnId: "turn-web", narrationId: "narration-too-long", audience: "user", delta: "x".repeat(20_001) });
      input.onNarration?.({ type: "assistant-narration-end", turnId: "turn-web", narrationId: "narration-too-long", audience: "user", status: "completed" });
      input.onProgress?.({ type: "turn-completed", turnId: "turn-web", steps: 1, outcome: "completed" });
      return {
        content: "ok", sessionId: input.sessionId, turnId: "turn-web", outcome: "completed", events: [
          { eventId: "e1", sessionId: input.sessionId, seq: 1, type: "step/start", schemaVersion: 1,
            occurredAt: new Date().toISOString(), recordedAt: new Date().toISOString(), tenantId: input.security.tenantId,
            actorId: input.security.actorId, correlationId: input.security.correlationId, runtimeSnapshotId: "runtime-web",
            classification: "internal", turnId: "turn-web", stepId: "step-web", payload: { index: 1 }, integrityHash: "test" },
          { eventId: "e2", sessionId: input.sessionId, seq: 2, type: "assistant/message", schemaVersion: 1,
            occurredAt: new Date().toISOString(), recordedAt: new Date().toISOString(), tenantId: input.security.tenantId,
            actorId: input.security.actorId, correlationId: input.security.correlationId, runtimeSnapshotId: "runtime-web",
            classification: "internal", turnId: "turn-web", stepId: "step-web", payload: { content: "ok", ui: [{ type: "details", title: "Chi tiết", content: "**Đã xử lý**" }] }, integrityHash: "test" },
        ],
      };
    },
    resumeTurn: async (input) => {
      resumedApproval = input.approvalId;
      input.onProgress?.({ type: "step-started", turnId: "turn-approved", step: 1 });
      input.onNarration?.({ type: "assistant-narration-start", turnId: "turn-approved", narrationId: "approval-narration", audience: "user" });
      input.onNarration?.({ type: "assistant-narration-delta", turnId: "turn-approved", narrationId: "approval-narration", audience: "user", delta: "Tôi đang tiếp tục sau xác nhận." });
      input.onNarration?.({ type: "assistant-narration-end", turnId: "turn-approved", narrationId: "approval-narration", audience: "user", status: "completed" });
      return { content: "approval handled", sessionId: input.sessionId, turnId: "turn-approved", outcome: "completed", events: [] };
    },
    resumeInteraction: async (input) => {
      resumedHuman = { interactionId: input.interactionId, action: input.action, ...(input.content === undefined ? {} : { content: input.content }) };
      input.onProgress?.({ type: "step-started", turnId: "turn-interaction-resumed", step: 1 });
      return { content: "interaction handled", sessionId: input.sessionId, turnId: "turn-interaction-resumed", outcome: "completed", events: [] };
    },
  };
  const runtime: WebRuntime = {
    agent, model: { providerId: "echo", modelId: "echo-test", features: { textStreaming: false, privateReasoning: false } }, storage: { sessions: "memory", memory: "memory" }, knowledgeDocuments: 2,
    availableTools: [{ id: "calculate", description: "Calculate safely" }],
    identityResolver: testIdentity(),
    sessions: { loadRecent: async (sessionId, _limit, context) => { historyTenant = context.tenantId; return sessionId === "history-trace" ? historyEvents : []; } },
    host: { snapshot: { id: "runtime-web" } },
  };
  const server = await listen(runtime, {
    toolTrace: (toolId, _initiator, call) => toolId === "knowledge_search" ? (call?.phase === "completed" ? "Đã tìm tài liệu phù hợp" : "Đang tìm tài liệu phù hợp…") : undefined,
  });
  try {
    const page = await request(server.baseUrl);
    assert.equal(page.status, 200);
    assert.match(page.text, /Agentic Core/);
    assert.match(page.text, /How can I help\?/);
    assert.doesNotMatch(page.text, /Một lõi agentic|Không mang nghiệp vụ|BLANK HARNESS/);
    const webClient = await request(`${server.baseUrl}/app.js`);
    assert.equal(webClient.status, 200);
    assert.match(webClient.text, /assistant-narration-/);
    assert.match(webClient.text, /\/api\/interactions\//);
    assert.doesNotMatch(webClient.text, /progress\.type === "(?:output-item-delta|content-delta|tool-state-changed|plan-updated)"/);
    const widgetDemoRedirect = await request(`${server.baseUrl}/widget-demo?mode=floating`);
    assert.equal(widgetDemoRedirect.status, 308);
    assert.equal(widgetDemoRedirect.headers.location, "/widget-demo/?mode=floating");
    const widgetDemo = await request(`${server.baseUrl}/widget-demo/`);
    assert.equal(widgetDemo.status, 200);
    assert.match(widgetDemo.text, /demo\.js/);
    const widgetDemoScript = await request(`${server.baseUrl}/widget-demo/demo.js`);
    assert.equal(widgetDemoScript.status, 200);
    assert.match(widgetDemoScript.text, /AgentChat\.init/);
    assert.doesNotMatch(widgetDemoScript.text, /window\.fetch\s*=/);
    const widgetScript = await request(`${server.baseUrl}/widget-demo/dist/agentic-chat-widget.js`);
    assert.equal(widgetScript.status, 200);
    assert.match(widgetScript.text, /AgentChat/);
    const response = await request(`${server.baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        content: "hello", sessionId: "web-session", requestId: "request-1", tenantId: "spoofed",
        agentProfileId: "default", agentContext: { screen: "invoice", invoiceId: "INV-42" },
      }),
    });
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.text) as {
      content: string; outcome: string; metrics: { steps: number }; ui?: unknown;
      work?: { status?: string; tools?: unknown[] };
    };
    assert.equal(payload.content, "ok");
    assert.equal(payload.outcome, "completed");
    assert.equal(payload.metrics.steps, 1);
    assert.deepEqual(payload.ui, [{ type: "details", title: "Chi tiết", content: "**Đã xử lý**" }]);
    // The mock result carries no turn/end, so projectTurnWork honestly reports the turn as still
    // open rather than guessing a status from result.outcome.
    assert.equal(payload.work?.status, "in_progress");
    assert.deepEqual(payload.work?.tools, []);
    assert.equal(received?.security.tenantId, "server-tenant");
    assert.equal(received?.security.actorId, "server-user");
    assert.equal(received?.agentProfileId, "default");
    assert.deepEqual(received?.applicationContext, {
      trusted: { companyName: "Server Company", userName: "Nam" },
      untrusted: { screen: "invoice", invoiceId: "INV-42" },
    });
    const attachmentResponse = await request(`${server.baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        content: "Kiểm tra tệp này",
        sessionId: "attachment-session",
        requestId: "request-attachment",
        attachments: [{ id: "attachment-1", name: "bang-luong.png", type: "image/png", size: 1234, source: "paste", data: { url: "https://files.example/bang-luong.png" } }],
      }),
    });
    assert.equal(attachmentResponse.status, 200);
    // The manifest itself is core's job now (packages/core journals it and shows it to the model);
    // apps/web only maps the widget's {type,size} shape onto the platform's TurnAttachment and
    // carries it to runTurn untouched — content keeps exactly what the user typed.
    assert.equal(received?.content, "Kiểm tra tệp này");
    assert.deepEqual(received?.attachments, [
      { id: "attachment-1", name: "bang-luong.png", mediaType: "image/png", byteSize: 1234, source: "paste" },
    ]);
    // A `data.url` is not a handle: a tool must never be handed a client-supplied URL to fetch.
    const storedResponse = await request(`${server.baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        content: "Đọc giúp tôi dự toán này",
        sessionId: "attachment-session",
        requestId: "request-attachment-stored",
        attachments: [{
          id: "client-generated-1", name: "du-toan.xlsx", size: 48_000, source: "picker",
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          data: { documentId: "doc_01HZX", storedAt: "2026-09-20T00:00:00.000Z" },
        }],
      }),
    });
    assert.equal(storedResponse.status, 200);
    // The handle the host's upload answered with wins over the id the browser minted, because that
    // is the only one a tool can resolve.
    assert.equal(received?.attachments?.[0]?.id, "doc_01HZX");
    const runtimeResponse = await request(`${server.baseUrl}/api/runtime`);
    assert.deepEqual(JSON.parse(runtimeResponse.text), { status: "ok" });
    const history = await request(`${server.baseUrl}/api/sessions/web-session`);
    assert.equal(history.status, 200);
    assert.deepEqual(JSON.parse(history.text), { sessionId: "web-session", messages: [] });
    assert.equal(historyTenant, "server-tenant");
    const tracedHistory = await request(`${server.baseUrl}/api/sessions/history-trace`);
    const tracedPayload = JSON.parse(tracedHistory.text) as {
      messages: Array<{
        content?: string; status?: string; narrations?: unknown[]; ui?: unknown;
        work?: { plan?: unknown; tools?: unknown[]; decision?: string };
        approval?: { approvalId?: string; presentation?: unknown; state?: string };
        interaction?: Record<string, unknown> & { state?: string };
      }>
    };
    assert.equal(tracedPayload.messages[1]?.status, "completed");
    assert.deepEqual(tracedPayload.messages[1]?.narrations, [
      { narrationId: "narration-history", audience: "user", content: "Tôi đang kiểm tra tài liệu phù hợp." },
    ]);
    // The browser gets what the product's labeller says about a call and how it ended, never the
    // tool behind it: no tool id, no execution id, and a call the labeller does not name is absent.
    assert.deepEqual(tracedPayload.messages[1]?.work?.tools, [
      { callId: "call-history", label: "Đã tìm tài liệu phù hợp", status: "succeeded" },
    ]);
    assert.doesNotMatch(JSON.stringify(tracedPayload.messages[1]), /toolId|executionId|knowledge_search|plan_update/);
    assert.equal(tracedPayload.messages[1]?.work?.decision, "finish");
    assert.deepEqual(tracedPayload.messages[1]?.work?.plan, {
      planId: "plan-history", state: "completed",
      steps: [{ id: "step-1", description: "Search", status: "completed", outcome: "Found the file" }],
    });
    assert.deepEqual(tracedPayload.messages[1]?.ui, [{ type: "actions", actions: [{ id: "confirm", label: "Xác nhận", behavior: "submit" }] }]);
    assert.equal(tracedPayload.messages[3]?.approval?.approvalId, "approval-history");
    assert.equal(tracedPayload.messages[3]?.approval?.state, "pending");
    assert.equal(tracedPayload.messages[3]?.status, "awaiting_approval");
    assert.equal(tracedPayload.messages[3]?.content, "Approval required.");
    assert.doesNotMatch(tracedPayload.messages[3]?.content ?? "", /write_tool/);
    assert.deepEqual(tracedPayload.messages[3]?.approval?.presentation, {
      summary: "Update one record.", action: "Update record", target: "Record 7", impact: "The selected value changes.",
      fields: [{ label: "Affected records", value: 1 }],
    });
    assert.doesNotMatch(JSON.stringify(tracedPayload.messages[3]?.approval), /CANARY_PRIVATE|rawArguments/);
    assert.equal(tracedPayload.messages[5]?.interaction?.interactionId, "interaction-history");
    assert.equal(tracedPayload.messages[5]?.interaction?.kind, "form");
    assert.equal(tracedPayload.messages[5]?.interaction?.state, "pending");
    assert.equal(tracedPayload.messages[5]?.status, "awaiting_interaction");
    assert.equal("continuation" in (tracedPayload.messages[5]?.interaction ?? {}), false);
    const stream = await request(`${server.baseUrl}/api/chat/stream`, {
      method: "POST",
      body: JSON.stringify({ content: "stream", sessionId: "stream-session", requestId: "request-stream" }),
    });
    assert.equal(stream.status, 200);
    assert.match(String(stream.headers["content-type"]), /^text\/event-stream/);
    assert.equal(stream.headers["cache-control"], "no-store");
    assert.match(stream.text, /event: progress\ndata: .*"type":"step-started"/);
    assert.doesNotMatch(stream.text, /event: progress\ndata: .*"type":"(?:output-item-delta|content-delta)"/);
    assert.match(stream.text, /id: \d+\nevent: assistant-output-delta\ndata: .*"audience":"user".*"delta":"ok"/);
    assert.match(stream.text, /event: assistant-output-end\ndata: .*"outputId":"output-web".*"status":"completed"/);
    assert.match(stream.text, /event: assistant-narration-delta\ndata: .*"audience":"user".*"delta":"Tôi đang kiểm tra\."/);
    assert.doesNotMatch(stream.text, /private runtime note|narration-internal/);
    // A narration past 20 000 characters is cut with "…" and completed, never discarded.
    assert.match(stream.text, /event: assistant-narration-delta\ndata: .*"narrationId":"narration-too-long".*"delta":"x{19999}…"/);
    assert.match(stream.text, /event: assistant-narration-end\ndata: .*"narrationId":"narration-too-long".*"status":"completed"/);
    assert.match(stream.text, /event: result\ndata: .*"content":"ok"/);
    assert.match(stream.text, /event: result\ndata: .*"ui":\[\{"type":"details"/);
    const approval = await request(`${server.baseUrl}/api/approvals/approval-1`, {
      method: "POST",
      body: JSON.stringify({ sessionId: "web-session", requestId: "approval-request-1", decision: "approve" }),
    });
    assert.equal(approval.status, 200);
    assert.equal(JSON.parse(approval.text).content, "approval handled");
    assert.equal(resumedApproval, "approval-1");
    const interaction = await request(`${server.baseUrl}/api/interactions/approval-stream-1/stream`, {
      method: "POST",
      body: JSON.stringify({ kind: "approval", sessionId: "web-session", requestId: "interaction-request-1", decision: "deny" }),
    });
    assert.equal(interaction.status, 200);
    assert.match(String(interaction.headers["content-type"]), /^text\/event-stream/);
    assert.match(interaction.text, /event: progress\ndata: .*"type":"step-started"/);
    assert.match(interaction.text, /event: assistant-narration-delta\ndata: .*"Tôi đang tiếp tục sau xác nhận\."/);
    assert.match(interaction.text, /event: result\ndata: .*"content":"approval handled"/);
    assert.equal(resumedApproval, "approval-stream-1");
    const formInteraction = await request(`${server.baseUrl}/api/interactions/form-stream-1/stream`, {
      method: "POST",
      body: JSON.stringify({ kind: "form", sessionId: "web-session", requestId: "interaction-request-form", action: "accept", content: { region: "north" } }),
    });
    assert.equal(formInteraction.status, 200);
    assert.match(formInteraction.text, /event: result\ndata: .*"content":"interaction handled"/);
    assert.deepEqual(resumedHuman, { interactionId: "form-stream-1", action: "accept", content: { region: "north" } });
    const unsupportedInteraction = await request(`${server.baseUrl}/api/interactions/unsupported/stream`, {
      method: "POST",
      body: JSON.stringify({ kind: "free-form", sessionId: "web-session", requestId: "interaction-request-2", decision: "deny" }),
    });
    assert.equal(unsupportedInteraction.status, 400);
  } finally {
    await server.close();
  }
});

test("web API rejects malformed chat input without exposing internals", async () => {
  const runtime: WebRuntime = {
    agent: { runTurn: async () => { throw new Error("must not run"); }, resumeTurn: async () => { throw new Error("must not resume"); } },
    model: { providerId: "echo", modelId: "echo-test", features: { textStreaming: false, privateReasoning: false } }, storage: { sessions: "memory", memory: "memory" }, knowledgeDocuments: 0, availableTools: [], identityResolver: testIdentity("tenant", "user"), sessions: { loadRecent: async () => [] },
    host: { snapshot: { id: "runtime" } },
  };
  assert.throws(
    () => createWebApplication(runtime, { deploymentProfile: "production" }),
    /shared ResumableAgentStreamRegistry/,
  );
  const server = await listen(runtime);
  try {
    const response = await request(`${server.baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ content: "", sessionId: "bad session", requestId: "request" }),
    });
    assert.equal(response.status, 400);
    const payload = JSON.parse(response.text) as { error: { code: string; message: string } };
    assert.equal(payload.error.code, "validation");
    assert.equal(payload.error.message.includes("stack"), false);
    // An attachment manifest that fails the shared contract (parseTurnAttachments) is rejected the
    // same way any other bad field in the body is — a 400 with code "validation" — never a 500.
    const attachmentResponse = await request(`${server.baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        content: "check this", sessionId: "session", requestId: "request-2",
        attachments: [{ id: "attachment-1", name: "bad.bin", type: "not a media type", size: 10, source: "paste" }],
      }),
    });
    assert.equal(attachmentResponse.status, 400);
    const attachmentPayload = JSON.parse(attachmentResponse.text) as { error: { code: string; message: string } };
    assert.equal(attachmentPayload.error.code, "validation");
    assert.equal(attachmentPayload.error.message.includes("stack"), false);
  } finally {
    await server.close();
  }
});

test("web API allows configured widget origins and rejects other browser origins", async () => {
  const runtime: WebRuntime = {
    agent: { runTurn: async () => { throw new Error("must not run"); }, resumeTurn: async () => { throw new Error("must not resume"); } },
    model: { providerId: "echo", modelId: "echo-test", features: { textStreaming: true, privateReasoning: true } },
    storage: { sessions: "memory", memory: "memory" }, knowledgeDocuments: 0, availableTools: [], identityResolver: testIdentity("tenant", "user"), sessions: { loadRecent: async () => [] },
    host: { snapshot: { id: "runtime" } },
  };
  const server = await listen(runtime, { allowedOrigins: ["https://portal.example"] });
  try {
    const preflight = await request(`${server.baseUrl}/api/runtime`, {
      method: "OPTIONS",
      headers: {
        origin: "https://portal.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], "https://portal.example");
    assert.equal(preflight.headers["access-control-allow-headers"], "authorization");

    const allowed = await request(`${server.baseUrl}/api/runtime`, { headers: { origin: "https://portal.example" } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers["access-control-allow-origin"], "https://portal.example");

    const denied = await request(`${server.baseUrl}/api/runtime`, { headers: { origin: "https://untrusted.example" } });
    assert.equal(denied.status, 403);
    assert.equal(JSON.parse(denied.text).error.code, "denied");
  } finally {
    await server.close();
  }
});

test("web API rejects missing or forged bearer identities and accepts a valid signed identity", async () => {
  const secret = "phase-one-test-secret-that-is-at-least-32-bytes";
  const runtime: WebRuntime = {
    agent: { runTurn: async () => { throw new Error("must not run"); }, resumeTurn: async () => { throw new Error("must not resume"); } },
    model: { providerId: "echo", modelId: "echo-test", features: { textStreaming: false, privateReasoning: false } },
    storage: { sessions: "memory", memory: "memory" }, knowledgeDocuments: 0, availableTools: [], sessions: { loadRecent: async () => [] },
    identityResolver: new HmacIdentityResolver(secret, "issuer.example", "agentic-web"),
    host: { snapshot: { id: "runtime" } },
  };
  const server = await listen(runtime);
  try {
    assert.equal((await request(`${server.baseUrl}/api/runtime`)).status, 403);
    assert.equal((await request(`${server.baseUrl}/api/runtime`, { headers: { authorization: "Bearer forged.token" } })).status, 403);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "issuer.example", aud: "agentic-web", sub: "subject-1", tenantId: "tenant-a", actorId: "user-a",
      permissions: ["knowledge.read"], roles: ["reader"], grantRevision: "grant-7",
      agentProfileIds: ["default"], context: { companyName: "Tenant A" }, iat: now, exp: now + 60,
    };
    for (const invalidClaims of [
      { ...claims, exp: Math.floor(Date.now() / 1000) - 1 },
      { ...claims, exp: now + 301 },
      // Far past the 30 s skew allowance: at now + 31 a request that crossed a second boundary
      // was judged against now + 1 and accepted, which failed this test intermittently.
      { ...claims, iat: now + 120, exp: now + 150 },
      { ...claims, iss: "other-issuer" },
      { ...claims, aud: "other-audience" },
      { ...claims, grantRevision: undefined },
      { ...claims, agentProfileIds: [] },
    ]) {
      const invalid = signedToken(secret, invalidClaims);
      assert.equal((await request(`${server.baseUrl}/api/runtime`, { headers: { authorization: `Bearer ${invalid}` } })).status, 403);
    }
    const token = signedToken(secret, claims);
    const accepted = await request(`${server.baseUrl}/api/runtime`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(accepted.status, 200);
  } finally {
    await server.close();
  }
});

test("POST SSE reconnect resumes from Last-Event-ID without running the turn twice", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let runs = 0;
  const runtime: WebRuntime = {
    agent: {
      runTurn: async (input) => {
        runs += 1;
        input.onOutput?.({ type: "assistant-output-start", turnId: "turn-resume", outputId: "answer-resume", audience: "user" });
        input.onOutput?.({ type: "assistant-output-delta", turnId: "turn-resume", outputId: "answer-resume", audience: "user", delta: "first" });
        await gate;
        input.onOutput?.({ type: "assistant-output-delta", turnId: "turn-resume", outputId: "answer-resume", audience: "user", delta: " second" });
        input.onOutput?.({ type: "assistant-output-end", turnId: "turn-resume", outputId: "answer-resume", audience: "user", status: "completed" });
        return { content: "first second", sessionId: input.sessionId, turnId: "turn-resume", outcome: "completed", events: [] };
      },
      resumeTurn: async () => { throw new Error("must not resume approval"); },
    },
    model: { providerId: "echo", modelId: "echo-test", features: { textStreaming: true, privateReasoning: false } },
    storage: { sessions: "memory", memory: "memory" }, knowledgeDocuments: 0, availableTools: [], identityResolver: testIdentity("tenant-resume", "user-resume"),
    sessions: { loadRecent: async () => [] }, host: { snapshot: { id: "runtime" } },
  };
  const server = await listen(runtime);
  const body = JSON.stringify({ content: "resume", sessionId: "resume-session", requestId: "resume-request" });
  const headers = { "content-type": "application/json", accept: "text/event-stream" };
  try {
    const firstController = new AbortController();
    const first = await fetch(`${server.baseUrl}/api/chat/stream`, { method: "POST", headers, body, signal: firstController.signal });
    const reader = first.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("id: 2\n")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      received += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(received, /id: 1\nevent: assistant-output-start/);
    assert.match(received, /id: 2\nevent: assistant-output-delta/);
    firstController.abort();

    const conflicting = await fetch(`${server.baseUrl}/api/chat/stream`, {
      method: "POST", headers, body: JSON.stringify({ content: "different", sessionId: "resume-session", requestId: "resume-request" }),
    });
    assert.equal(conflicting.status, 409, "one requestId cannot be rebound to different input");

    const resumed = await fetch(`${server.baseUrl}/api/chat/stream`, {
      method: "POST", headers: { ...headers, "last-event-id": "2" }, body,
    });
    assert.equal(resumed.headers.get("x-gateway-stream"), "resumed");
    release();
    const replay = await resumed.text();
    assert.doesNotMatch(replay, /id: [12]\n/);
    assert.match(replay, /id: 3\nevent: assistant-output-delta/);
    assert.match(replay, /id: 4\nevent: assistant-output-end/);
    assert.match(replay, /id: 5\nevent: result/);
    assert.equal(runs, 1);
  } finally {
    release();
    await server.close();
  }
});

test("explicit stream cancellation aborts a detached operation", async () => {
  let aborted = false;
  const runtime: WebRuntime = {
    agent: {
      runTurn: async (input) => {
        input.onProgress?.({ type: "turn-started", turnId: "turn-cancel" });
        await new Promise<void>((_resolve, reject) => input.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(input.signal?.reason);
        }, { once: true }));
        throw new Error("unreachable");
      },
      resumeTurn: async () => { throw new Error("must not resume approval"); },
    },
    model: { providerId: "echo", modelId: "echo-test", features: { textStreaming: true, privateReasoning: false } },
    storage: { sessions: "memory", memory: "memory" }, knowledgeDocuments: 0, availableTools: [], identityResolver: testIdentity("tenant-cancel", "user-cancel"),
    sessions: { loadRecent: async () => [] }, host: { snapshot: { id: "runtime" } },
  };
  const server = await listen(runtime);
  const input = { sessionId: "cancel-session", requestId: "cancel-request" };
  const controller = new AbortController();
  try {
    const stream = await fetch(`${server.baseUrl}/api/chat/stream`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, content: "wait" }), signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    controller.abort();
    const cancelled = await fetch(`${server.baseUrl}/api/chat/cancel`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    assert.equal(cancelled.status, 202);
    assert.deepEqual(await cancelled.json(), { cancelled: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(aborted, true);
  } finally {
    controller.abort();
    await server.close();
  }
});

function cardFixtureBase() {
  const now = new Date().toISOString();
  let seq = 0;
  const base = {
    sessionId: "card-session", schemaVersion: 1, occurredAt: now, recordedAt: now,
    tenantId: "tenant", actorId: "actor", correlationId: "correlation", runtimeSnapshotId: "runtime",
    classification: "internal" as const, integrityHash: "test",
  };
  return { now, base, next: () => { seq += 1; return seq; } };
}

test("history view reads an approval card's state off its resolution event, wherever it landed", () => {
  const { base, next } = cardFixtureBase();
  const approvalTurn = (turnId: string, approvalId: string): SessionEvent[] => [
    { ...base, eventId: `${turnId}-user`, seq: next(), turnId, type: "user/input", payload: { content: "please write" } },
    { ...base, eventId: `${turnId}-assistant`, seq: next(), turnId, type: "assistant/message", payload: { content: null, toolCalls: [{ id: "call", name: "write_tool" }] } },
    { ...base, eventId: `${turnId}-requested`, seq: next(), turnId, callId: "call", type: "approval/requested", payload: {
      approvalId, callId: "call", executionId: `${turnId}-exec`, toolId: "write_tool", arguments: "{}",
      sideEffect: "idempotent", actionDigest: "digest", decisionId: "decision", policyRevision: "policy",
      runtimeSnapshotId: "runtime", runtimeRouteRevision: "route", agentProfileId: "default", requestedBy: "actor",
      grantRevision: "grant", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } },
    { ...base, eventId: `${turnId}-end`, seq: next(), turnId, type: "turn/end", payload: { status: "awaiting_approval" } },
  ];
  // The runtime writes a closure under the NEW (closing) turn, not the paused one (spec §2), so
  // the projection has to find it by approvalId across the whole event list.
  const resolved = (approvalId: string, decision: string, resolvedBy: string): SessionEvent => ({
    ...base, eventId: `${approvalId}-resolved`, seq: next(), turnId: `${approvalId}-resume`, type: "approval/resolved",
    payload: { approvalId, decision, actionDigest: "digest", resolvedBy, resolvedAt: base.occurredAt },
  });
  const events: SessionEvent[] = [
    ...approvalTurn("turn-approved", "appr-approved"), resolved("appr-approved", "approve", "user-a"),
    ...approvalTurn("turn-denied", "appr-denied"), resolved("appr-denied", "deny", "user-a"),
    ...approvalTurn("turn-superseded", "appr-superseded"), resolved("appr-superseded", "superseded", "runtime"),
    ...approvalTurn("turn-expired", "appr-expired"), resolved("appr-expired", "expired", "runtime"),
    ...approvalTurn("turn-pending", "appr-pending"),
  ];
  const messages = visibleMessages(events);
  const stateOf = (turnId: string) => (messages.find((message) => message.turnId === turnId && message.role === "assistant")?.approval as { state?: string } | undefined)?.state;
  assert.equal(stateOf("turn-approved"), "approved");
  assert.equal(stateOf("turn-denied"), "denied");
  assert.equal(stateOf("turn-superseded"), "superseded");
  assert.equal(stateOf("turn-expired"), "expired");
  // Never resolved: the card must still read "pending" rather than being dropped once a later
  // approval's resolution lands in the event list.
  const pending = messages.find((message) => message.turnId === "turn-pending" && message.role === "assistant");
  assert.equal(pending?.status, "awaiting_approval");
  assert.equal((pending?.approval as { state?: string } | undefined)?.state, "pending");
});

test("history view reads an interaction card's state, with a user cancel read as declined", () => {
  const { base, next } = cardFixtureBase();
  const interactionTurn = (turnId: string, interactionId: string): SessionEvent[] => [
    { ...base, eventId: `${turnId}-user`, seq: next(), turnId, type: "user/input", payload: { content: "lookup" } },
    { ...base, eventId: `${turnId}-assistant`, seq: next(), turnId, type: "assistant/message", payload: { content: null, toolCalls: [{ id: "call", name: "lookup" }] } },
    { ...base, eventId: `${turnId}-requested`, seq: next(), turnId, callId: "call", type: "interaction/requested", payload: {
      interactionId, callId: "call", executionId: `${turnId}-exec`, toolId: "lookup", requesterId: "geo-mcp", arguments: "{}",
      request: { kind: "form", message: "Choose a region", requestedSchema: { type: "object", properties: {} } },
      actionDigest: "digest", decisionId: "decision", policyRevision: "policy", authorizationOutcome: "allow",
      runtimeSnapshotId: "runtime", runtimeRouteRevision: "route", agentProfileId: "default", requestedBy: "actor",
      grantRevision: "grant", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } },
    { ...base, eventId: `${turnId}-end`, seq: next(), turnId, type: "turn/end", payload: { status: "awaiting_interaction" } },
  ];
  const resolved = (interactionId: string, action: string, resolvedBy: string, reason?: string): SessionEvent => ({
    ...base, eventId: `${interactionId}-resolved`, seq: next(), turnId: `${interactionId}-resume`, type: "interaction/resolved",
    payload: {
      interactionId, action, actionDigest: "digest", resolvedBy, resolvedAt: base.occurredAt,
      ...(reason ? { reason } : {}), ...(action === "accept" ? { echo: [{ label: "Region", value: "North" }] } : {}),
    },
  });
  const events: SessionEvent[] = [
    ...interactionTurn("turn-answered", "int-answered"), resolved("int-answered", "accept", "user-a"),
    ...interactionTurn("turn-declined", "int-declined"), resolved("int-declined", "decline", "user-a"),
    ...interactionTurn("turn-cancelled", "int-cancelled"), resolved("int-cancelled", "cancel", "user-a"),
    ...interactionTurn("turn-superseded", "int-superseded"), resolved("int-superseded", "cancel", "runtime", "superseded"),
    ...interactionTurn("turn-expired", "int-expired"), resolved("int-expired", "cancel", "runtime", "expired"),
  ];
  const messages = visibleMessages(events);
  const stateOf = (turnId: string) => messages.find((message) => message.turnId === turnId && message.role === "assistant")?.interaction as { state?: string; echo?: unknown } | undefined;
  assert.equal(stateOf("turn-answered")?.state, "answered");
  assert.deepEqual(stateOf("turn-answered")?.echo, [{ label: "Region", value: "North" }]);
  assert.equal(stateOf("turn-declined")?.state, "declined");
  // MCP elicitation's `cancel` and the widget's "Bỏ qua" both resume with action "cancel"; a
  // user-initiated one reads the same as an explicit decline (spec v2.1 §10.8).
  assert.equal(stateOf("turn-cancelled")?.state, "declined");
  assert.equal(stateOf("turn-superseded")?.state, "superseded");
  assert.equal(stateOf("turn-expired")?.state, "expired");
});

test("history view shows a failed turn's business message and an in-progress turn with no terminal yet", () => {
  const { base, next } = cardFixtureBase();
  const events: SessionEvent[] = [
    { ...base, eventId: "failed-user", seq: next(), turnId: "turn-failed", type: "user/input", payload: { content: "break it" } },
    { ...base, eventId: "failed-end", seq: next(), turnId: "turn-failed", type: "turn/failed",
      payload: { code: "permanent", message: "Something broke", retryable: false } },
    { ...base, eventId: "open-user", seq: next(), turnId: "turn-open", type: "user/input", payload: { content: "still going" } },
    { ...base, eventId: "open-step", seq: next(), turnId: "turn-open", type: "step/start", payload: { index: 1 } },
  ];
  const messages = visibleMessages(events);
  const failed = messages.find((message) => message.turnId === "turn-failed" && message.role === "assistant");
  assert.equal(failed?.status, "failed");
  // The runtime's own words ("Something broke") stay in the journal: a reload reads the sentence
  // the product gave for that kind of failure, the same one the live stream showed.
  assert.equal(failed?.content, "A technical problem prevented this request from completing. Please try again shortly.");
  const worded = visibleMessages(events, { businessMessages: { byCode: { permanent: "Em chưa xử lý được yêu cầu này." } } })
    .find((message) => message.turnId === "turn-failed" && message.role === "assistant");
  assert.equal(worded?.content, "Em chưa xử lý được yêu cầu này.");
  const open = messages.find((message) => message.turnId === "turn-open" && message.role === "assistant");
  assert.equal(open?.status, "in_progress");
  assert.equal(open?.content, "");
});

test("includeErrorDetail controls whether the runtime's own error message reaches the response body — apps/web's main.ts turns this on outside production", async () => {
  const runtime: WebRuntime = {
    agent: {
      runTurn: async () => { throw new Error("must not run"); },
      resumeTurn: async () => { throw new AgenticError("conflict", "CANARY_INTERNAL_DETAIL_TEXT", false); },
    },
    model: { providerId: "echo", modelId: "echo-test", features: { textStreaming: false, privateReasoning: false } },
    storage: { sessions: "memory", memory: "memory" }, knowledgeDocuments: 0, availableTools: [],
    identityResolver: testIdentity("tenant-detail", "user-detail"), sessions: { loadRecent: async () => [] },
    host: { snapshot: { id: "runtime" } },
  };
  // Default (no includeErrorDetail passed): the wire body carries only the classified public
  // message, matching @0xsyncroot/agent-api's own safe-by-default. `apps/web`'s main.ts opts back into
  // detail outside production, since this dev/demo harness has no product's business-language
  // copy of its own and the runtime's own message is the only useful thing it can show.
  const withoutDetail = await listen(runtime);
  try {
    const response = await request(`${withoutDetail.baseUrl}/api/approvals/approval-y`, {
      method: "POST", body: JSON.stringify({ sessionId: "s", requestId: "r", decision: "approve" }),
    });
    const payload = JSON.parse(response.text) as { error: { code: string; message: string; detail?: string } };
    assert.equal(payload.error.code, "conflict");
    assert.doesNotMatch(payload.error.message, /CANARY_INTERNAL_DETAIL_TEXT/);
    assert.equal(payload.error.detail, undefined);
  } finally {
    await withoutDetail.close();
  }
  const withDetail = await listen(runtime, { includeErrorDetail: true });
  try {
    const response = await request(`${withDetail.baseUrl}/api/approvals/approval-y`, {
      method: "POST", body: JSON.stringify({ sessionId: "s", requestId: "r", decision: "approve" }),
    });
    const payload = JSON.parse(response.text) as { error: { code: string; message: string; detail?: string } };
    assert.equal(payload.error.detail, "CANARY_INTERNAL_DETAIL_TEXT");
  } finally {
    await withDetail.close();
  }
});

test("AgenticError.reason reaches the direct JSON error body and the streamed error event", async () => {
  const runtime: WebRuntime = {
    agent: {
      runTurn: async () => { throw new Error("must not run"); },
      resumeTurn: async () => { throw new AgenticError("conflict", "Already resolved.", false, { reason: "already-resolved" }); },
      resumeInteraction: async () => { throw new AgenticError("conflict", "Expired.", false, { reason: "expired" }); },
    },
    model: { providerId: "echo", modelId: "echo-test", features: { textStreaming: false, privateReasoning: false } },
    storage: { sessions: "memory", memory: "memory" }, knowledgeDocuments: 0, availableTools: [],
    identityResolver: testIdentity("tenant-reason", "user-reason"), sessions: { loadRecent: async () => [] },
    host: { snapshot: { id: "runtime" } },
  };
  const server = await listen(runtime);
  try {
    const approval = await request(`${server.baseUrl}/api/approvals/approval-x`, {
      method: "POST",
      body: JSON.stringify({ sessionId: "session-x", requestId: "request-x", decision: "approve" }),
    });
    assert.equal(approval.status, 409);
    const approvalPayload = JSON.parse(approval.text) as { error: { code: string; reason?: string } };
    assert.equal(approvalPayload.error.code, "conflict");
    assert.equal(approvalPayload.error.reason, "already-resolved");

    const streamed = await request(`${server.baseUrl}/api/interactions/interaction-x/stream`, {
      method: "POST",
      body: JSON.stringify({ kind: "form", sessionId: "session-x", requestId: "request-y", action: "accept", content: { region: "north" } }),
    });
    assert.equal(streamed.status, 200);
    assert.match(streamed.text, /event: error\ndata: .*"reason":"expired"/);
  } finally {
    await server.close();
  }
});
