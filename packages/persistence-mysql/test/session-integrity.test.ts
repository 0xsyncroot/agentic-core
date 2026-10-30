import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPool } from "mysql2/promise";
import type { SecurityContext } from "@0xsyncroot/contracts";
import { mapEvent, decodeEventRow, type EventRow } from "../src/event-row.js";
import { MySqlSessionWriteRepository } from "../src/session-write-repository.js";
import { MySqlSessionStore } from "../src/session-store.js";
import { sessionEventHashFormat } from "../src/session-event-integrity.js";
import { sha256 } from "../src/hash.js";

// Hash generated with the unmodified MySQL hash.ts from db80e3b, not the new verifier.
const row = {
  event_id: "11111111-1111-4111-8111-111111111111", session_id: "legacy", seq: 1,
  type: "user/input", schema_version: 1,
  occurred_at: "2026-10-08T09:47:16.123Z", recorded_at: "2026-10-08T09:47:16.123Z",
  tenant_id: "test", actor_id: "owner", correlation_id: "test", runtime_snapshot_id: "old", classification: "internal",
  payload: { content: "Kiểm tra", source: "test", attachments: [{ "10": "ten", "2": "two", _meta: "old", A: "upper", a: "lower" }] },
  turn_id: null, step_id: null, request_id: null, call_id: null, attempt_id: null,
  integrity_hash: "3e991db6f18d055b2a0e2d50f313e0baabbd3ecb5a41c6b97b2eae5b371e5840",
} as EventRow;
const writes = new MySqlSessionWriteRepository();

test("old MySQL event remains verifiable after the canonical JSON upgrade", async () => {
  const body = await decodeEventRow(row, writes);
  assert.notEqual(sha256(body), row.integrity_hash, "reproduces the old reader's integrity failure");
  assert.equal(sessionEventHashFormat(body, row.integrity_hash), "legacy-mysql");
  assert.equal((await mapEvent(row, writes)).integrityHash, row.integrity_hash);
  const current = { ...row, integrity_hash: sha256(body) };
  assert.equal(sessionEventHashFormat(body, current.integrity_hash), "canonical");
  assert.deepEqual((await mapEvent(current, writes)).payload, body.payload);
});

test("both hash formats reject altered payloads and event metadata", async () => {
  const canonical = sha256(await decodeEventRow(row, writes));
  for (const integrity_hash of [canonical, row.integrity_hash]) {
    for (const change of [{ payload: { content: "changed", source: "test" } }, { actor_id: "other" }, { seq: 2 }]) {
      await assert.rejects(mapEvent({ ...row, integrity_hash, ...change } as EventRow, writes), /integrity check failed/u);
    }
  }
});

test("JSON payload and timestamp driver representations preserve hash verification", async () => {
  const serialized = { ...row, payload: JSON.stringify(row.payload), occurred_at: new Date(row.occurred_at), recorded_at: new Date(row.recorded_at) };
  assert.deepEqual(await mapEvent(serialized, writes), await mapEvent(row, writes));
});

test("an empty-string id is a present id: the row verifies against the hash the writer made over it", async () => {
  const written = { ...await decodeEventRow(row, writes), turnId: "", stepId: "", callId: "" };
  const stored = { ...row, turn_id: "", step_id: "", call_id: "", integrity_hash: sha256(written) } as EventRow;
  const event = await mapEvent(stored, writes);
  assert.deepEqual([event.turnId, event.stepId, event.callId, event.requestId], ["", "", "", undefined]);
  await assert.rejects(mapEvent({ ...stored, turn_id: null } as EventRow, writes), /integrity check failed/u, "NULL is absent, not an empty string");
});

const url = process.env.TEST_MYSQL_URL;
test("MySQL history readers load a legacy event and still reject corruption", { skip: !url }, async () => {
  const pool = createPool({ uri: url!, timezone: "Z", supportBigNumbers: true, bigNumberStrings: true });
  const setup = createPool({ uri: process.env.TEST_MYSQL_OWNER_URL ?? url!, timezone: "Z" });
  let inserted = false;
  const store = new MySqlSessionStore(pool);
  const security: SecurityContext = { tenantId: row.tenant_id, actorId: row.actor_id, permissions: new Set(), purpose: "test", correlationId: "test" };
  try {
    // This fixed historical fixture is inserted only into the dedicated TEST_MYSQL_URL database.
    await setup.execute("INSERT INTO agentic_session_stream(tenant_id,session_id,owner_actor_id,current_seq) VALUES (?,?,?,?)",
      [row.tenant_id, row.session_id, row.actor_id, row.seq]);
    inserted = true;
    const columns = Object.keys(row);
    await setup.execute(`INSERT INTO agentic_session_event(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      columns.map((key) => key === "payload" ? JSON.stringify(row[key]) : key.endsWith("_at") ? new Date(row[key]) : row[key]));
    for (const events of [await store.load("legacy", security), await store.loadRecent("legacy", 1, security),
      await store.loadSince("legacy", 0, security, 1), (await store.loadContext("legacy", security)).events]) {
      assert.equal(events[0]?.integrityHash, row.integrity_hash);
    }
    assert.equal((await store.listSessions({ limit: 1 }, security))[0]?.sessionId, "legacy");
    assert.deepEqual(await store.load("legacy", { ...security, actorId: "other" }), []);
    const diagnostic = fileURLToPath(new URL("../../../scripts/diagnose-mysql-session-event.mjs", import.meta.url));
    const env = { ...process.env, SESSION_DATABASE_URL: url!, DATABASE_URL: url!, AGENTIC_SESSION_STORE_PROVIDER: "mysql",
      AGENTIC_MEMORY_STORE_PROVIDER: "mysql", AGENTIC_DATA_ENCRYPTION_KEY: "" };
    const output = execFileSync(process.execPath, ["--import", "tsx", diagnostic, row.event_id], { env, encoding: "utf8" });
    assert.equal(JSON.parse(output).result, "legacy-mysql");
    assert.ok(!output.includes("Kiểm tra") && !output.includes(url!), "diagnostic does not expose payloads or credentials");
    await setup.execute("UPDATE agentic_session_event SET payload=JSON_SET(payload,'$.content','changed') WHERE event_id=?", [row.event_id]);
    await assert.rejects(store.load("legacy", security), /integrity check failed/u);
    const corrupt = spawnSync(process.execPath, ["--import", "tsx", diagnostic, row.event_id], { env, encoding: "utf8" });
    assert.equal(corrupt.status, 2);
    assert.equal(JSON.parse(corrupt.stdout).result, "mismatch");
    const turnId = "22222222-2222-4222-8222-222222222222";
    const failedTool = { ...row, type: "tool/result", turn_id: turnId, payload: {
      toolId: "example_audit_source", state: "failed", error: { code: "validation", message: "operation=rows requires decisions" },
    } } as EventRow;
    await setup.execute("UPDATE agentic_session_event SET type=?,turn_id=?,payload=?,integrity_hash=? WHERE event_id=?",
      [failedTool.type, turnId, JSON.stringify(failedTool.payload), sha256(await decodeEventRow(failedTool, writes)), row.event_id]);
    const turnReport = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", diagnostic, "--turn", turnId], { env, encoding: "utf8" }));
    assert.equal(turnReport.observations[0].hash, "canonical");
    assert.equal(turnReport.observations[0].error.message, "operation=rows requires decisions");
    assert.equal(turnReport.truncated, false);
    assert.equal(turnReport.contextRead.status, "ok");
    assert.equal(turnReport.session.currentSeq, 1);
    await setup.execute("UPDATE agentic_session_event SET integrity_hash=? WHERE event_id=?", ["0".repeat(64), row.event_id]);
    const readFailure = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", diagnostic, "--turn", turnId], { env, encoding: "utf8" }));
    assert.equal(readFailure.contextRead.status, "failed");
    assert.match(readFailure.contextRead.error.message, /Session event integrity check failed/u);
    assert.equal(readFailure.observations[0].hash, "mismatch");
  } finally {
    try {
      if (inserted) await setup.execute("DELETE FROM agentic_session_stream WHERE tenant_id=? AND session_id=?", [row.tenant_id, row.session_id]);
    } finally { await Promise.all([pool.end(), setup.end()]); }
  }
});
