import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:http";
import test from "node:test";
import type { IdentityEvidence, ResumableAgent, RunTurnResult, SecurityContext } from "@0xsyncroot/contracts";
import { createAgentApiHandler, type AgentApiRuntime } from "../src/agent-api-handler.js";
import { PublicAgentStreamWriter } from "../src/public-agent-stream.js";
import { resultPayload } from "../src/result-payload.js";

function testSecurity(): SecurityContext {
  return { tenantId: "tenant", actorId: "actor", permissions: new Set(["*"]), correlationId: "c", purpose: "test" };
}

async function post(baseUrl: string, path: string, headers: Record<string, string>): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ content: "hi", sessionId: "session-a", requestId: "request-a" });
    const operation = httpRequest(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers },
    }, (response) => { response.resume(); response.on("end", () => resolve({ status: response.statusCode ?? 0 })); });
    operation.on("error", reject);
    operation.write(body);
    operation.end();
  });
}

test("createAgentApiHandler forwards identityAttributes and wraps the agent call with runWithRequestScope", async () => {
  const seenAttributes: Array<Readonly<Record<string, string>> | undefined> = [];
  const scopeCalls: string[] = [];
  const runtime: AgentApiRuntime = {
    agent: {
      runTurn: async (): Promise<RunTurnResult> => {
        scopeCalls.push("inside-run-turn");
        return { sessionId: "session-a", turnId: "turn-a", content: "ok", outcome: "completed", events: [] } as unknown as RunTurnResult;
      },
      resumeTurn: async () => { throw new Error("not used"); },
      resumeInteraction: async () => { throw new Error("not used"); },
    },
    identityResolver: {
      resolve: async (evidence: IdentityEvidence) => { seenAttributes.push(evidence.attributes); return testSecurity(); },
    },
    sessions: { loadRecent: async () => [] },
  };
  const handler = createAgentApiHandler(runtime, {
    identityAttributes: (request) => ({ mcpSessionRef: String(request.headers["x-test-ref"] ?? "") }),
    runWithRequestScope: async (_context, task) => {
      scopeCalls.push("before-run-turn");
      const result = await task();
      scopeCalls.push("after-run-turn");
      return result;
    },
  });
  const server = createServer(async (request, response) => { await handler.handle(request, response); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const response = await post(baseUrl, "/api/chat", { "x-test-ref": "ref-a" });
    assert.equal(response.status, 200);
    assert.deepEqual(seenAttributes, [{ mcpSessionRef: "ref-a" }]);
    assert.deepEqual(scopeCalls, ["before-run-turn", "inside-run-turn", "after-run-turn"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await handler.close();
  }
});

test("the public stream never publishes a tool id to the browser", () => {
  const published: { event: string; payload: unknown }[] = [];
  const bare = new PublicAgentStreamWriter((event, payload) => published.push({ event, payload }));

  // No labeller: the event is withheld entirely rather than sent with the id removed and nothing
  // in its place, because a trace line that names no work is noise a business user cannot act on.
  bare.progress({ type: "tool-started", turnId: "t1", step: 1, callId: "c1", toolId: "mcp_example_create_spending_template" });
  assert.equal(published.length, 0, "an unlabelled tool event must not reach the browser at all");

  // With a labeller: the product's phrase crosses, the tool's own name does not. Serialised and
  // searched as a string, so a tool id surviving anywhere in the payload fails this — checking
  // named fields would pass a copy tucked into some future field.
  const labelled = new PublicAgentStreamWriter((event, payload) => published.push({ event, payload }), { toolTrace: (toolId) =>
    toolId === "mcp_example_create_spending_template" ? "Đang tạo mẫu biểu" : undefined });
  labelled.progress({ type: "tool-completed", turnId: "t1", step: 1, callId: "c1", toolId: "mcp_example_create_spending_template", status: "succeeded" });
  assert.equal(published.length, 1);
  const wire = JSON.stringify(published[0]);
  assert.ok(wire.includes("Đang tạo mẫu biểu"), `the product phrase should cross: ${wire}`);
  assert.ok(!wire.includes("mcp_example_create_spending_template"), `a tool id reached the browser: ${wire}`);

  // A tool the product wrote no phrase for stays server-side even when a labeller exists.
  labelled.progress({ type: "tool-started", turnId: "t1", step: 2, callId: "c2", toolId: "knowledge_search" });
  assert.equal(published.length, 1, "an unlabelled tool stays server-side even with a labeller present");
});

test("the phrase is published under the name the browser actually reads", () => {
  // The test above proves the phrase crosses by searching the serialised frame, which is blind to
  // the one thing that decides whether anyone sees it: the field's name. This writer published it
  // as `trace` while the widget read `label`, so on a real EXAMPLE run every tool row fell back to
  // one generic sentence and the product's seventeen Vietnamese phrases never reached the screen —
  // with every unit test on both sides green, because each asserted its own spelling.
  //
  // The name is taken from the widget's own wire contract rather than written out here. Asserting
  // a literal would just move the same guess into this file; reading the other side's source means
  // a rename there fails here, which is the only way this seam stays joined.
  const contract = readFileSync(new URL("../../../apps/widget/src/transport/contracts.ts", import.meta.url), "utf8");
  const declaration = /type: "tool-started";[^}]*\}/u.exec(contract)?.[0];
  assert.ok(declaration, "the widget no longer declares a tool-started frame — this seam moved");
  const field = /readonly (\w+)\?: string;/u.exec(declaration)?.[1];
  assert.ok(field, `the widget's tool-started frame carries no optional text field: ${declaration}`);

  const published: { event: string; payload: unknown }[] = [];
  const writer = new PublicAgentStreamWriter((event, payload) => published.push({ event, payload }), { toolTrace: () => "Đang lấy danh mục đơn vị dự toán…" });
  writer.progress({ type: "tool-started", turnId: "t1", step: 1, callId: "c1", toolId: "mcp_example_list_budget_units" });
  assert.equal(published.length, 1);
  const frame = published[0]!.payload as Record<string, unknown>;
  assert.equal(frame[field], "Đang lấy danh mục đơn vị dự toán…", `the browser reads ${field}, this published ${JSON.stringify(frame)}`);
});

test("a call's arguments and result reach the product's labeller and nothing else", () => {
  const published: { event: string; payload: unknown }[] = [];
  const seen: unknown[] = [];
  const writer = new PublicAgentStreamWriter((event, payload) => published.push({ event, payload }), {
    toolTrace: (_toolId, _initiator, call) => {
      seen.push(call);
      const sheet = (call?.arguments as { sheet?: string } | undefined)?.sheet;
      return call?.phase === "completed" ? `Đã đọc biểu «${sheet}»` : `Đang đọc biểu «${sheet}»…`;
    },
  });
  const args = { documentId: "doc-SECRET-HANDLE", sheet: "02 – Chi TX" };
  writer.progress({ type: "tool-started", turnId: "t1", step: 1, callId: "c1", toolId: "mcp_office-docs_read_table", workStepId: "read", arguments: args });
  writer.progress({
    type: "tool-completed", turnId: "t1", step: 1, callId: "c1", toolId: "mcp_office-docs_read_table", status: "succeeded",
    workStepId: "read", arguments: args, result: { rows: [["RESULT-CELL"]] },
  });
  writer.progress({
    type: "tool-completed", turnId: "t1", step: 2, callId: "c2", toolId: "mcp_office-docs_read_table", status: "failed",
    arguments: args, error: { type: "tool_error", message: "document doc-SECRET-HANDLE was not found" },
  });
  assert.deepEqual(seen, [
    { phase: "started", arguments: args },
    { phase: "completed", status: "succeeded", arguments: args, result: { rows: [["RESULT-CELL"]] } },
    { phase: "completed", status: "failed", arguments: args, error: { type: "tool_error", message: "document doc-SECRET-HANDLE was not found" } },
  ]);
  assert.equal(published.length, 3);
  published.pop(); // the failed call's own frame: looked at through the string search below, with the rest
  assert.deepEqual(published.map((frame) => frame.payload), [
    { type: "tool-started", turnId: "t1", step: 1, callId: "c1", label: "Đang đọc biểu «02 – Chi TX»…", workStepId: "read" },
    { type: "tool-completed", turnId: "t1", step: 1, callId: "c1", label: "Đã đọc biểu «02 – Chi TX»", workStepId: "read", status: "succeeded" },
  ]);
  // Searched as a string as well: what the sentence does not say must not be on the wire at all.
  writer.progress({ type: "tool-completed", turnId: "t1", step: 3, callId: "c3", toolId: "mcp_office-docs_read_table", status: "failed", arguments: args, error: { message: "document doc-SECRET-HANDLE was not found" } });
  const wire = JSON.stringify(published);
  assert.ok(!wire.includes("was not found"), `a tool's own error text reached the browser: ${wire}`);
  for (const secret of ["doc-SECRET-HANDLE", "RESULT-CELL", "mcp_office-docs_read_table"]) {
    assert.ok(!wire.includes(secret), `${secret} reached the browser: ${wire}`);
  }
});

test("a labeller that throws or rambles costs its own line, not the stream", () => {
  const published: { event: string; payload: unknown }[] = [];
  const throwing = new PublicAgentStreamWriter((event, payload) => published.push({ event, payload }), { toolTrace: () => { throw new Error("boom"); } });
  throwing.progress({ type: "tool-started", turnId: "t1", step: 1, callId: "c1", toolId: "x" });
  assert.equal(published.length, 0);
  const rambling = new PublicAgentStreamWriter((event, payload) => published.push({ event, payload }), { toolTrace: () => `  nhiều\n dòng ${"x".repeat(1_000)}` });
  rambling.progress({ type: "tool-started", turnId: "t1", step: 1, callId: "c1", toolId: "x" });
  const label = (published[0]!.payload as { label: string }).label;
  assert.equal(label.length, 240);
  assert.ok(label.startsWith("nhiều dòng x"), label);
});

test("the plan crosses without the identifiers the model copied into it, and reasoning only in the sentences the product accepts", () => {
  const published: { event: string; payload: unknown }[] = [];
  const vietnamese = (sentence: string) => /[àáảãạăâđêôơưếệộớợủứữ]/iu.test(sentence);
  const writer = new PublicAgentStreamWriter((event, payload) => published.push({ event, payload }), { reasoning: "text", reasoningSentence: vietnamese });
  // A step outcome as a model writes it: the unit's id copied out of a tool result and onto the page.
  writer.progress({
    type: "plan-updated", turnId: "t1", cause: "proposal",
    plan: { planId: "p1", revision: 2, state: "active", goal: "Dựng danh mục nhiệm vụ chi", updatedAt: "2026-10-02T07:41:00.000Z", steps: [
      { id: "ctx", description: "Lấy thông tin đơn vị", status: "completed", outcome: "Đơn vị hiện tại là Đơn vị Thử Nghiệm (unitId: 00000001-0000-4000-8000-000000000001)." },
      { id: "read", description: "Đọc biểu 18-TH chi theo Nghị định 73/2024/NĐ-CP", status: "in_progress" },
    ] },
  } as never);
  const plan = (published[0]!.payload as { plan: { steps: { description: string; outcome?: string }[] } }).plan;
  assert.equal(plan.steps[0]!.outcome, "Đơn vị hiện tại là Đơn vị Thử Nghiệm.", "the bracket that held nothing but the id goes with it");
  assert.equal(plan.steps[1]!.description, "Đọc biểu 18-TH chi theo Nghị định 73/2024/NĐ-CP", "a sheet name and a decree number are not identifiers");
  assert.doesNotMatch(JSON.stringify(published), /unitId|00000001/u);

  published.length = 0;
  writer.reasoning({ type: "assistant-reasoning-start", turnId: "t1", reasoningId: "r1", audience: "user" } as never);
  for (const delta of ["The user wants me to analyze the budget file. ", "I should call get_agent_context first.\n", "Người dùng muốn dựng danh mục nhiệm vụ chi. ", "Trước hết cần xem hồ sơ có những biểu nào", ". Then read the summary sheet."]) {
    writer.reasoning({ type: "assistant-reasoning-delta", turnId: "t1", reasoningId: "r1", audience: "user", delta } as never);
  }
  writer.reasoning({ type: "assistant-reasoning-end", turnId: "t1", reasoningId: "r1", audience: "user", status: "completed" } as never);
  const thought = published.filter((frame) => frame.event === "assistant-reasoning-delta").map((frame) => (frame.payload as { delta: string }).delta).join("");
  assert.equal(thought.trim(), "Người dùng muốn dựng danh mục nhiệm vụ chi. Trước hết cần xem hồ sơ có những biểu nào.",
    "a model that thinks in another language than its user shows only that it is thinking, not that language");
  assert.deepEqual([published[0]!.event, published.at(-1)!.event], ["assistant-reasoning-start", "assistant-reasoning-end"], "the lifecycle crosses either way");
});

test("with a summarizer, the raw reasoning never crosses: only the sentence written about it, and the thought closes after that sentence", async () => {
  const published: { event: string; payload: unknown }[] = [];
  const seen: string[] = [];
  const release: (() => void)[] = [];
  // A second model call, as slow as one: each summary resolves when the test lets it.
  const summarize = (thought: string) => new Promise<string | undefined>((resolve) => {
    seen.push(thought);
    release.push(() => resolve(seen.length === 1 ? "Đang xem hồ sơ có những biểu nào" : "Đang đối chiếu biểu 18 với documentId 94c5adfc20f243a1c691441e3e7c74bc."));
  });
  const writer = new PublicAgentStreamWriter((event, payload) => published.push({ event, payload }), { reasoning: "text", reasoningSummary: summarize });
  const send = (delta: string) => writer.reasoning({ type: "assistant-reasoning-delta", turnId: "t1", reasoningId: "r1", audience: "user", delta } as never);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const deltas = () => published.filter((frame) => frame.event === "assistant-reasoning-delta").map((frame) => (frame.payload as { delta: string }).delta);

  writer.reasoning({ type: "assistant-reasoning-start", turnId: "t1", reasoningId: "r1", audience: "user" } as never);
  send("The user wants me to analyze the attached Excel file and call mcp_office-docs_read_document. ".repeat(5));
  await settle();
  assert.equal(seen.length, 1, "enough new reasoning for one sentence about it");
  send("More raw thinking in English. ".repeat(20));
  await settle();
  assert.equal(seen.length, 1, "one call at a time: a second sentence about the same seconds is noise");
  assert.deepEqual(deltas(), [], "nothing crosses while the sentence is being written — and never the raw text");
  release[0]!();
  await settle(); await settle();
  assert.deepEqual(deltas(), ["Đang xem hồ sơ có những biểu nào. "], "a whole sentence, ended, so the client shows it whole");
  assert.equal(seen.length, 2, "and the reasoning that arrived meanwhile gets the next one");

  writer.reasoning({ type: "assistant-reasoning-end", turnId: "t1", reasoningId: "r1", audience: "user", status: "completed" } as never);
  assert.equal(published.at(-1)!.event, "assistant-reasoning-delta", "the thought is not closed while a sentence about it is still on its way");
  release[1]!();
  await settle(); await settle();
  assert.deepEqual(published.slice(-2).map((frame) => frame.event), ["assistant-reasoning-delta", "assistant-reasoning-end"]);
  assert.equal(deltas().at(-1), "Đang đối chiếu biểu 18 với … ", "identifiers are taken out of the summary too: the summarizer is a model as well");
  assert.doesNotMatch(JSON.stringify(published), /The user wants|mcp_office|94c5adfc/u);

  // A summarizer that throws or hangs must cost nothing but the sentence.
  published.length = 0;
  const failing = new PublicAgentStreamWriter((event, payload) => published.push({ event, payload }), { reasoning: "text", reasoningSummary: async () => { throw new Error("gateway down"); } });
  failing.reasoning({ type: "assistant-reasoning-start", turnId: "t2", reasoningId: "r2", audience: "user" } as never);
  failing.reasoning({ type: "assistant-reasoning-delta", turnId: "t2", reasoningId: "r2", audience: "user", delta: "thinking ".repeat(60) } as never);
  failing.reasoning({ type: "assistant-reasoning-end", turnId: "t2", reasoningId: "r2", audience: "user", status: "completed" } as never);
  await settle(); await settle();
  assert.deepEqual(published.map((frame) => frame.event), ["assistant-reasoning-start", "assistant-reasoning-end"], "the lifecycle still opens and closes");
});

test("reasoning crosses as a lifecycle by default, and as text only when the product chose it", () => {
  const events = [
    { type: "assistant-reasoning-start", turnId: "t1", reasoningId: "r1", audience: "user", step: 1, attemptId: "a1" },
    { type: "assistant-reasoning-delta", turnId: "t1", reasoningId: "r1", audience: "user", delta: "cần gọi read_document trước" },
    { type: "assistant-reasoning-end", turnId: "t1", reasoningId: "r1", audience: "user", status: "completed" },
  ] as const;
  const run = (options: ConstructorParameters<typeof PublicAgentStreamWriter>[1]) => {
    const published: { event: string; payload: unknown }[] = [];
    const writer = new PublicAgentStreamWriter((event, payload) => published.push({ event, payload }), options);
    for (const event of events) writer.reasoning(event);
    return published;
  };
  assert.deepEqual(run({}), [
    { event: "assistant-reasoning-start", payload: { type: "assistant-reasoning-start", turnId: "t1", reasoningId: "r1", audience: "user" } },
    { event: "assistant-reasoning-end", payload: { type: "assistant-reasoning-end", turnId: "t1", reasoningId: "r1", audience: "user", status: "completed" } },
  ]);
  const text = run({ reasoning: "text" });
  assert.deepEqual(text.map((frame) => frame.event), ["assistant-reasoning-start", "assistant-reasoning-delta", "assistant-reasoning-delta", "assistant-reasoning-end"]);
  assert.equal(text.slice(1, 3).map((frame) => (frame.payload as { delta: string }).delta).join(""), "cần gọi … trước",
    "the thought crosses, the tool it names does not: an identifier is a shape, not a meaning");

  // Fragments split words anywhere, so an id cut in two must not cross as two harmless halves.
  const split: { event: string; payload: unknown }[] = [];
  const writer = new PublicAgentStreamWriter((event, payload) => split.push({ event, payload }), { reasoning: "text" });
  writer.reasoning(events[0]);
  for (const delta of ["Mở tài liệu bc97a4919fce", "5a67bde5a3b091c4d39b bằng mcp_office", "-docs_read_table rồi đọc biểu 18."]) {
    writer.reasoning({ type: "assistant-reasoning-delta", turnId: "t1", reasoningId: "r1", audience: "user", delta });
  }
  writer.reasoning(events[2]);
  const crossed = split.filter((frame) => frame.event === "assistant-reasoning-delta").map((frame) => (frame.payload as { delta: string }).delta).join("");
  assert.equal(crossed, "Mở tài liệu … bằng … rồi đọc biểu 18.");
  assert.doesNotMatch(JSON.stringify(split), /bc97a4919fce|mcp_office|read_table|c4d39b/u);

  // A turn that ends mid-thought closes what it opened, so no client is left showing "thinking".
  const published: { event: string; payload: unknown }[] = [];
  const open = new PublicAgentStreamWriter((event, payload) => published.push({ event, payload }));
  open.reasoning(events[0]);
  open.discardReasonings();
  assert.deepEqual(published.at(-1), { event: "assistant-reasoning-end", payload: { type: "assistant-reasoning-end", turnId: "t1", reasoningId: "r1", audience: "user", status: "discarded" } });
});

test("the result that ends the stream names no tool either", () => {
  // Every frame before it withheld the id; this one listed it once per call, under `work.tools`.
  const at = "2026-10-02T03:00:00.000Z";
  const call = { callId: "c1", executionId: "exec-INTERNAL", toolId: "mcp_office-docs_read_table" };
  const event = (seq: number, draft: Record<string, unknown>) => ({
    ...draft, eventId: `e${seq}`, sessionId: "s1", seq, occurredAt: at, recordedAt: at, tenantId: "t", actorId: "u",
    correlationId: "c", runtimeSnapshotId: "r", integrityHash: `h${seq}`,
  });
  const result = {
    content: "Xong.", sessionId: "s1", turnId: "t1", outcome: "completed",
    events: [
      event(1, { type: "turn/start", turnId: "t1", payload: { inputIdempotencyKey: "k" } }),
      event(2, { type: "tool/intent", turnId: "t1", stepId: "st1", callId: "c1", payload: { ...call, arguments: "{}", state: "prepared", sideEffect: "none" } }),
      event(3, { type: "tool/result", turnId: "t1", stepId: "st1", callId: "c1", payload: { ...call, state: "succeeded", dispatched: true, workStepId: "read" } }),
      event(4, { type: "turn/end", turnId: "t1", payload: { status: "completed", steps: 1 } }),
    ],
  } as unknown as Parameters<typeof resultPayload>[0];
  const payload = resultPayload(result, performance.now());
  assert.deepEqual((payload.work as { tools: unknown }).tools, [{ callId: "c1", state: "succeeded", workStepId: "read" }]);
  const wire = JSON.stringify(payload);
  assert.ok(!wire.includes("mcp_office-docs_read_table") && !wire.includes("exec-INTERNAL"), `the result named a tool: ${wire}`);
});

test("a card carries no tool id either, and still carries what answering it needs", () => {
  const published: { event: string; payload: unknown }[] = [];
  const writer = new PublicAgentStreamWriter((event, payload) => published.push({ event, payload }));

  // Cards were the way the whole tool identity kept crossing after the trace events stopped
  // carrying it — and a card is the event a product is most likely to log, forward or screenshot.
  // Stringified rather than field-checked for the same reason as above.
  writer.progress({
    type: "approval-requested", turnId: "t1", step: 1,
    approval: {
      approvalId: "ap-1", sessionId: "s1", turnId: "t1", callId: "c1",
      toolId: "mcp_example_create_spending_template", sideEffect: "nonIdempotent",
      actionDigest: "d", policyRevision: "p", runtimeSnapshotId: "r", runtimeRouteRevision: "rr",
      agentProfileId: "example-budget", grantRevision: "g", expiresAt: "2026-01-01T00:00:00.000Z",
    },
  });
  writer.progress({
    type: "interaction-requested", turnId: "t1", step: 2,
    interaction: {
      kind: "form", message: "Chọn đơn vị dự toán", requestedSchema: { type: "object" },
      interactionId: "in-1", sessionId: "s1", turnId: "t1", callId: "c2",
      toolId: "mcp_example_list_budget_units", requesterId: "req", actionDigest: "d",
      policyRevision: "p", runtimeSnapshotId: "r", runtimeRouteRevision: "rr",
      agentProfileId: "example-budget", grantRevision: "g", expiresAt: "2026-01-01T00:00:00.000Z",
    },
  });

  const wire = JSON.stringify(published);
  assert.ok(!wire.includes("mcp_example_create_spending_template"), `an approval card carried a tool id: ${wire}`);
  assert.ok(!wire.includes("mcp_example_list_budget_units"), `an interaction card carried a tool id: ${wire}`);
  // Withholding must not gut the card: without its id and deadline the browser cannot answer it,
  // and without the question there is nothing to show — a card stripped to nothing would pass the
  // two assertions above while breaking every approval in the product.
  assert.ok(wire.includes("ap-1") && wire.includes("in-1"), `a card lost the id needed to answer it: ${wire}`);
  assert.ok(wire.includes("2026-01-01T00:00:00.000Z"), `a card lost its deadline: ${wire}`);
  assert.ok(wire.includes("Chọn đơn vị dự toán"), `a card lost the question it asks: ${wire}`);
});
