import assert from "node:assert/strict";
import test from "node:test";
import type { ResumableAgent, RuntimeSnapshot, SecurityContext, SessionEvent } from "@0xsyncroot/contracts";
import { InMemorySessionStore } from "@0xsyncroot/persistence-memory";
import { createAgentApiFastify } from "../src/fastify/agent-api-fastify.js";
import { sessionDirectory } from "../src/session-directory.js";
import { sessionHistoryEvents } from "../src/session-history.js";

const security: SecurityContext = { tenantId: "history-tenant", actorId: "history-owner", permissions: new Set(), purpose: "test", correlationId: "history-test" };
const runtime: RuntimeSnapshot = { id: "test", coreVersion: "1", pluginSetId: "test", policyRevision: "test", memoryPolicyRevision: "test", createdAt: "2026-10-08T00:00:00.000Z" };
const agent = { runTurn: async () => { throw new Error("History must never run the agent"); } } as unknown as ResumableAgent;

async function seed(store: InMemorySessionStore, id: string, profile = "example-budget", owner = security) {
  const claim = await store.claimTurn({ sessionId: id, turnId: `turn-${id}`, ownerId: "worker", idempotencyKey: id, requestFingerprint: id,
    leaseTtlMs: 10_000, agentProfileId: profile, startEvents: [{ type: "user/input", turnId: `turn-${id}`,
      payload: { content: `Phân tích ${id}`, source: "test", attachments: [{ id: "file", name: "Dự toán.xlsx", mediaType: "application/xlsx", byteSize: 42 }] } }] }, { security: owner, runtime });
  if (claim.kind === "acquired") await store.finishTurn(claim.lease, claim.seq, { type: "turn/end", turnId: claim.lease.turnId, payload: { status: "completed" } }, { security: owner, runtime });
}

test("session directory cursors page named sessions without owner/profile leaks or offset drift", async () => {
  const store = new InMemorySessionStore();
  for (let i = 0; i < 23; i++) await seed(store, `s-${String(i).padStart(2, "0")}`);
  await seed(store, "foreign-owner", "example-budget", { ...security, actorId: "other" });
  await seed(store, "foreign-tenant", "example-budget", { ...security, tenantId: "other" });
  await seed(store, "payroll", "sample-app-payroll");
  const first = await sessionDirectory(store, new URLSearchParams("limit=10"), security, "example-budget");
  assert.equal(first.sessions.length, 10);
  assert.match(first.sessions[0]!.title, /Phân tích .*Dự toán.xlsx/);
  assert.ok(first.nextCursor);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await seed(store, "newly-created");
  const second = await sessionDirectory(store, new URLSearchParams({ limit: "10", cursor: first.nextCursor! }), security, "example-budget");
  const third = await sessionDirectory(store, new URLSearchParams({ limit: "10", cursor: second.nextCursor! }), security, "example-budget");
  const ids = [...first.sessions, ...second.sessions, ...third.sessions].map((entry) => entry.sessionId);
  assert.equal(ids.length, 23);
  assert.equal(new Set(ids).size, 23);
  assert.ok(ids.every((id) => id.startsWith("s-")));
  assert.equal(third.nextCursor, undefined);
  await assert.rejects(sessionDirectory(store, new URLSearchParams("cursor=broken"), security), /cursor/);
});

test("HTTP history reconstructs a >1000 event turn with original summaries, public labels, narration and attachments", async () => {
  const event = (type: string, payload: unknown, seq: number, extra = {}): SessionEvent => ({ type, payload, seq, turnId: "turn-long", sessionId: "session-long",
    occurredAt: new Date(1_790_000_000_000 + seq * 1000).toISOString(), ...extra } as SessionEvent);
  const events = [event("turn/start", {}, 1), event("user/input", { content: "Phân tích file", attachments: [{ id: "file", name: "Nguồn.xlsx", byteSize: 250, mediaType: "application/xlsx", privateLocation: "SECRET_BUCKET" }] }, 2),
    event("assistant/narration", { narrationId: "n1", audience: "user", content: "Đã nhận hồ sơ." }, 3),
    event("work/plan-updated", { planId: "plan", state: "active", goal: "Phân tích", cause: "proposal", steps: [{ id: "read", description: "Đọc hồ sơ", status: "in_progress" }] }, 4),
    event("tool/intent", { executionId: "execution", callId: "call", toolId: "private_tool", arguments: '{"sheet":"Nguồn"}', state: "prepared" }, 5, { callId: "call" }),
    event("tool/result", { executionId: "execution", callId: "call", toolId: "private_tool", state: "succeeded", workStepId: "read", result: { rows: 35, secret: "PRIVATE_RESULT" } }, 6, { callId: "call" })];
  for (let i = 7; i < 1100; i++) events.push(event("internal/test", { secret: "PRIVATE_REASONING" }, i));
  events.push(event("work/plan-updated", { planId: "plan", state: "completed", cause: "terminal", steps: [{ id: "read", description: "Đọc hồ sơ", status: "completed", outcome: "Đã xác định 35 dòng nguồn và 7 nhiệm vụ." }] }, 1100),
    event("assistant/narration", { narrationId: "n2", audience: "user", content: "Đã soát đủ các biểu." }, 1101),
    event("assistant/message", { content: "Có 7 nhiệm vụ." }, 1102), event("turn/end", { status: "completed" }, 1103));
  const reads: number[] = [];
  const sessions = { loadRecent: async (_id: string, limit: number) => events.slice(-limit), loadSince: async (_id: string, after: number, _security: SecurityContext, limit: number) => {
    reads.push(after); assert.ok(limit <= 500); return events.filter((e) => e.seq > after).slice(0, limit);
  } };
  const app = createAgentApiFastify({ agent, sessions, identityResolver: { resolve: async () => security } }, { toolTrace: (_tool, _initiator, call) => call?.phase === "completed" ? `Đã đọc ${String((call.result as { rows: number }).rows)} dòng` : "Đang đọc nguồn" });
  try {
    const response = await app.inject({ method: "GET", url: "/api/sessions/session-long" });
    assert.equal(response.statusCode, 200);
    const messages = response.json().messages;
    assert.deepEqual(reads, [0, 500, 1000]);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].attachments[0].name, "Nguồn.xlsx");
    assert.equal(messages[1].work.plan.steps[0].outcome, "Đã xác định 35 dòng nguồn và 7 nhiệm vụ.");
    assert.equal(messages[1].work.tools[0].label, "Đã đọc 35 dòng");
    assert.equal(messages[1].work.tools[0].status, "succeeded");
    assert.equal(messages[1].narrations.length, 2);
    assert.deepEqual(messages[1].work.timeline.map((item: { type: string }) => item.type), ["narration", "plan-updated", "tool-started", "tool-completed", "plan-updated", "narration"]);
    assert.doesNotMatch(response.body, /SECRET_BUCKET|PRIVATE_RESULT|PRIVATE_REASONING|private_tool/);
  } finally { await app.close(); }
});

test("history snapshot does not chase concurrent append forever or silently return a broken page", async () => {
  const entry = (seq: number) => ({ seq } as SessionEvent);
  const events = await sessionHistoryEvents({ loadRecent: async () => [entry(2)], loadSince: async () => [entry(1), entry(2), entry(3)] }, "s", security);
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
  await assert.rejects(sessionHistoryEvents({ loadRecent: async () => [entry(2)], loadSince: async () => [] }, "s", security), /changed/);
});


test("title search scans bounded cursor pages and finds older matches without omissions", async () => {
  const entries = Array.from({ length: 455 }, (_, i) => ({ sessionId: `s-${i}`, createdAt: new Date(Date.UTC(2026, 9, 8) - i * 60_000).toISOString(),
    firstInput: { content: [222, 244, 300, 454].includes(i) ? "Đề nghị dự toán" : "Hồ sơ khác" } }));
  const reads: number[] = [];
  const reader = { listSessions: async (query: import("@0xsyncroot/contracts").SessionDirectoryQuery, owner: SecurityContext) => {
    assert.equal(owner, security); assert.equal(query.agentProfileId, "example-budget"); assert.ok(query.limit <= 51);
    reads.push(query.limit);
    return entries.filter(e => !query.before || e.createdAt < query.before.createdAt).slice(0, query.limit);
  } };
  const first = await sessionDirectory(reader, new URLSearchParams({ q: "DE NGHI DU TOAN", limit: "2" }), security, "example-budget");
  assert.equal(reads.length, 4); assert.equal(first.sessions.length, 0); assert.ok(first.nextCursor);
  const second = await sessionDirectory(reader, new URLSearchParams({ q: "DE NGHI DU TOAN", limit: "2", cursor: first.nextCursor }), security, "example-budget");
  assert.deepEqual(second.sessions.map(e => e.sessionId), ["s-222", "s-244"]); assert.ok(second.nextCursor);
  const third = await sessionDirectory(reader, new URLSearchParams({ q: "DE NGHI DU TOAN", limit: "2", cursor: second.nextCursor }), security, "example-budget");
  assert.deepEqual(third.sessions.map(e => e.sessionId), ["s-300"]); assert.ok(third.nextCursor);
  const fourth = await sessionDirectory(reader, new URLSearchParams({ q: "DE NGHI DU TOAN", limit: "2", cursor: third.nextCursor }), security, "example-budget");
  assert.deepEqual(fourth.sessions.map(e => e.sessionId), ["s-454"]); assert.equal(fourth.nextCursor, undefined);
  await assert.rejects(sessionDirectory(reader, new URLSearchParams({ q: "x".repeat(181) }), security), /too long/);
});

test("HTTP directory search preserves owner/profile filtering and matches attachment names", async () => {
  const store = new InMemorySessionStore();
  await seed(store, "mine"); await seed(store, "someone-else", "example-budget", { ...security, actorId: "other" });
  await seed(store, "payroll", "sample-app-payroll");
  const app = createAgentApiFastify({ agent, sessions: store, identityResolver: { resolve: async () => security } }, { sessionAgentProfileId: "example-budget" });
  try {
    const reply = await app.inject({ method: "GET", url: "/api/sessions?q=du%20toan.xlsx" });
    assert.equal(reply.statusCode, 200); assert.deepEqual(reply.json().sessions.map((s: { sessionId: string }) => s.sessionId), ["mine"]);
  } finally { await app.close(); }
});
