import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPool } from "mysql2/promise";
import type { EventDraft, RuntimeSnapshot, SecurityContext } from "@0xsyncroot/contracts";
import { AesGcmEnvelopeProtector, DerivedTenantKeyProvider } from "@0xsyncroot/adapter-crypto-node";
import { MySqlSessionStore } from "../src/session-store.js";
import { decodeSessionPayload, encodeSessionPayload } from "../src/session-payload.js";

const url = process.env.TEST_MYSQL_URL;

for (const encrypted of [false, true]) test(`MySQL preserves exact numeric tool results through every journal reader (encrypted=${encrypted})`, { skip: !url }, async () => {
  const pool = createPool({ uri: url!, timezone: "Z" });
  const setup = createPool({ uri: process.env.TEST_MYSQL_OWNER_URL ?? url!, timezone: "Z" });
  const id = randomUUID();
  const security: SecurityContext = { tenantId: id, actorId: id, permissions: new Set(), purpose: "test", correlationId: id };
  const runtime: RuntimeSnapshot = { id, coreVersion: "1", pluginSetId: "test", policyRevision: "test", memoryPolicyRevision: "test", createdAt: new Date().toISOString() };
  // 29432.685999999998 is re-printed as 29432.686 by a JSON column; integers from 2**53 up come back as strings through mysql2.
  const numbers = [123456789012345.67, 0.30000000000000004, -123456789012345.67, 1e-7, Number.MIN_VALUE, Number.MAX_VALUE,
    29432.685999999998, 2 ** 53, 9007199254740994, 1e21];
  const draft: EventDraft = { type: "tool/result", turnId: id, stepId: "step", callId: "call", payload: {
    callId: "call", executionId: "execution", toolId: "mcp_office_docs_read_document", state: "succeeded", dispatched: true,
    result: { rows: [numbers], text: "Số liệu dự toán", nested: { amount: numbers[0]! } },
  } };
  const protector = encrypted ? new AesGcmEnvelopeProtector(new DerivedTenantKeyProvider(Buffer.alloc(32, 17), "test")) : undefined;
  const store = new MySqlSessionStore(pool, protector);
  try {
    await store.append(id, 0, [draft], "numeric-result", { security, runtime });
    for (const events of [await store.load(id, security), await store.loadSince(id, 0, security, 10),
      await store.loadRecent(id, 10, security), (await store.loadContext(id, security)).events]) {
      assert.deepEqual(events[0]?.payload, draft.payload);
    }
    assert.equal(await store.append(id, 0, [draft], "numeric-result", { security, runtime }), 1, "idempotency survives storage encoding");
    if (!encrypted) {
      // A valid storage envelope does not make altered data trustworthy.
      await setup.execute("UPDATE agentic_session_event SET payload=JSON_SET(payload,'$.json',?) WHERE tenant_id=? AND session_id=?",
        [JSON.stringify({ ...draft.payload as object, result: { amount: 1 } }), id, id]);
      await assert.rejects(store.loadContext(id, security), /integrity check failed/u);
    }
  } finally {
    try { await setup.execute("DELETE FROM agentic_session_stream WHERE tenant_id=? AND session_id=?", [id, id]); }
    finally { await Promise.all([pool.end(), setup.end()]); }
  }
});

test("session storage codec preserves wrapper-shaped application data and rejects broken envelopes", () => {
  const payload = { _mysql: "gateway-session-json-text-v1", json: "application text, not JSON" };
  assert.deepEqual(decodeSessionPayload(encodeSessionPayload(payload)), payload);
  assert.throws(() => decodeSessionPayload(payload), /Invalid MySQL session JSON text envelope/u);
  assert.throws(() => decodeSessionPayload({ _mysql: "gateway-session-json-text-v1", json: 1 }), /Invalid MySQL session JSON text envelope/u);
});

for (const encrypted of [false, true]) test(`a turn whose tool results carry unsafe numbers runs to its end and the session reopens (encrypted=${encrypted})`, { skip: !url }, async () => {
  const pool = createPool({ uri: url!, timezone: "Z", supportBigNumbers: true, bigNumberStrings: true });
  const setup = createPool({ uri: process.env.TEST_MYSQL_OWNER_URL ?? url!, timezone: "Z" });
  const id = randomUUID();
  const security: SecurityContext = { tenantId: id, actorId: id, permissions: new Set(), purpose: "test", correlationId: id };
  const runtime: RuntimeSnapshot = { id, coreVersion: "1", pluginSetId: "test", policyRevision: "test", memoryPolicyRevision: "test", createdAt: new Date().toISOString() };
  const protector = encrypted ? new AesGcmEnvelopeProtector(new DerivedTenantKeyProvider(Buffer.alloc(32, 17), "test")) : undefined;
  const store = new MySqlSessionStore(pool, protector);
  const result = (callId: string, amount: number): EventDraft => ({ type: "tool/result", turnId: "turn-1", stepId: "step-1", callId, payload: {
    callId, executionId: `execution-${callId}`, toolId: "read_table", state: "succeeded", dispatched: true, result: { rows: [["Chi thường xuyên", amount]] },
  } });
  try {
    const claim = await store.claimTurn({ sessionId: id, turnId: "turn-1", ownerId: "worker", idempotencyKey: "turn-1", requestFingerprint: "turn-1", leaseTtlMs: 5_000,
      startEvents: [{ type: "turn/start", turnId: "turn-1", payload: { inputIdempotencyKey: "turn-1" } },
        { type: "user/input", turnId: "turn-1", payload: { content: "đọc", source: "test" } }] }, { security, runtime });
    assert.equal(claim.kind, "acquired");
    if (claim.kind !== "acquired") return;
    let seq = await store.appendLeased(claim.lease, claim.seq, [result("a", 29432.685999999998), result("b", 9007199254740994)], "tool-results", { security, runtime });
    // The next step of the turn reads what the previous one wrote, as the turn journal view does.
    const since = await store.loadSince(id, claim.seq, security, 10);
    assert.deepEqual(since.map((event) => (event.payload as { result: { rows: unknown[][] } }).result.rows[0]![1]), [29432.685999999998, 9007199254740994]);
    seq = await store.finishTurn(claim.lease, seq, { type: "turn/end", turnId: "turn-1", payload: { status: "completed" } }, { security, runtime });
    assert.equal((await store.load(id, security)).length, seq);
    assert.equal((await store.loadContext(id, security)).events.length, seq);
    assert.deepEqual((await store.listSessions({ limit: 5 }, security)).map((entry) => entry.firstInput), [{ content: "đọc", source: "test" }]);
    const next = await store.claimTurn({ sessionId: id, turnId: "turn-2", ownerId: "worker", idempotencyKey: "turn-2", requestFingerprint: "turn-2", leaseTtlMs: 5_000,
      startEvents: [{ type: "turn/start", turnId: "turn-2", payload: { inputIdempotencyKey: "turn-2" } }] }, { security, runtime });
    assert.equal(next.kind, "acquired", "the session is not locked after the turn");
  } finally {
    try { await setup.execute("DELETE FROM agentic_session_stream WHERE tenant_id=? AND session_id=?", [id, id]); }
    finally { await Promise.all([pool.end(), setup.end()]); }
  }
});
