import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { type JsonValue, type RuntimeSnapshot, type SecurityContext } from "@0xsyncroot/contracts";
import { createPool, type Pool } from "mysql2/promise";
import { decodeEventRow, type EventRow } from "../src/event-row.js";
import { sha256 } from "../src/hash.js";
import { diagnoseEventRow } from "../src/session-event-diagnosis.js";
import { MySqlSessionStore } from "../src/session-store.js";
import { MySqlSessionWriteRepository } from "../src/session-write-repository.js";

const writes = new MySqlSessionWriteRepository();
const FLOAT = 29432.685999999998;
const BIG = 9007199254740994;

function eventRow(over: Partial<EventRow> = {}): EventRow {
  return {
    event_id: randomUUID(), session_id: "diagnosis", seq: 1, type: "tool/result", schema_version: 1,
    occurred_at: "2026-10-08T09:47:16.123Z", recorded_at: "2026-10-08T09:47:16.123Z",
    tenant_id: "test", actor_id: "owner", correlation_id: "test", runtime_snapshot_id: "runtime", classification: "internal",
    payload: { rows: [["a", 1]] }, turn_id: null, step_id: null, request_id: null, call_id: null, attempt_id: null,
    integrity_hash: "", ...over,
  } as EventRow;
}

/** A stored row whose hash was made over `hashed` — what the writer saw — while the column holds `row.payload`. */
async function hashedOver(row: EventRow, hashed: Record<string, unknown>): Promise<EventRow> {
  return { ...row, integrity_hash: sha256({ ...await decodeEventRow(row, writes), ...hashed }) };
}
const text = (value: unknown): string => JSON.stringify(value);

// Hash generated with the unmodified MySQL hash.ts from db80e3b (see session-integrity.test.ts).
const legacyRow = eventRow({
  event_id: "11111111-1111-4111-8111-111111111111", type: "user/input", session_id: "legacy", runtime_snapshot_id: "old",
  payload: { content: "Kiểm tra", source: "test", attachments: [{ "10": "ten", "2": "two", _meta: "old", A: "upper", a: "lower" }] },
  integrity_hash: "3e991db6f18d055b2a0e2d50f313e0baabbd3ecb5a41c6b97b2eae5b371e5840",
});

test("diagnosis names the format that reproduces a hash the reader accepts", async () => {
  const row = eventRow();
  assert.deepEqual(await diagnoseEventRow({ ...row, integrity_hash: sha256(await decodeEventRow(row, writes)) }, writes, text(row.payload)), { result: "canonical" });
  assert.deepEqual(await diagnoseEventRow(legacyRow, writes, text(legacyRow.payload)), { result: "legacy-mysql" });
});

test("diagnosis restores empty ids a row stored as NULL", async () => {
  const row = await hashedOver(eventRow(), { turnId: "", callId: "" });
  assert.deepEqual(await diagnoseEventRow(row, writes, text(row.payload)), { result: "empty-id", hash: "canonical", fields: ["turnId", "callId"] });
});

test("diagnosis finds the payload that only decodes without the big-number reviver", async () => {
  const hashed = { payload: { amount: BIG } };
  const row = await hashedOver(eventRow({ payload: { amount: String(BIG) } }), hashed);
  assert.deepEqual(await diagnoseEventRow(row, writes, text(hashed.payload)), { result: "no-big-number-reviver", hash: "canonical" });
});

test("diagnosis of a changed payload counts its non-integer numbers and reports no value", async () => {
  const row = await hashedOver(eventRow({ payload: { sheet: "Chi thường xuyên", amount: 29432.686, rows: [[1, 2.5]] } }),
    { payload: { sheet: "Chi thường xuyên", amount: FLOAT, rows: [[1, 2.5]] } });
  const diagnosis = await diagnoseEventRow(row, writes, text(row.payload));
  assert.deepEqual(diagnosis, {
    result: "mismatch", explanation: "payload đã đổi; có 2 số không nguyên (nghi round-trip số thực)",
    nonIntegerNumbers: { count: 2, paths: ["$.amount", "$.rows.0.1"] },
  });
  assert.ok(!JSON.stringify(diagnosis).includes("Chi thường"), "no document content in the report");
});

test("diagnosis of a tampered integer payload does not blame floating point", async () => {
  const row = await hashedOver(eventRow({ payload: { amount: 2 } }), { payload: { amount: 1 } });
  const diagnosis = await diagnoseEventRow(row, writes, text(row.payload));
  assert.equal(diagnosis.result, "mismatch");
  assert.equal((diagnosis as { explanation: string }).explanation, "payload đã đổi; có 0 số không nguyên");
});

const url = process.env.TEST_MYSQL_URL;
const runtime: RuntimeSnapshot = { id: "diagnosis", coreVersion: "1", pluginSetId: "test", policyRevision: "test", memoryPolicyRevision: "test", createdAt: new Date().toISOString() };
const diagnostic = fileURLToPath(new URL("../../../scripts/diagnose-mysql-session-event.mjs", import.meta.url));
const scriptEnv = { ...process.env, SESSION_DATABASE_URL: url!, DATABASE_URL: url!, AGENTIC_SESSION_STORE_PROVIDER: "mysql", AGENTIC_MEMORY_STORE_PROVIDER: "mysql", AGENTIC_DATA_ENCRYPTION_KEY: "" };

/**
 * Inserts a row the way the adapter did before the text envelope: the payload in the JSON column
 * as the JSON the writer produced, its hash made over the value the writer held.
 */
async function insertNative(setup: Pool, tenantId: string, sessionId: string, payload: JsonValue, ids: Partial<EventRow> = {}): Promise<string> {
  const full = await hashedOver(eventRow({ tenant_id: tenantId, session_id: sessionId, type: "user/input", payload, ...ids }), { payload });
  const columns = Object.keys(full);
  await setup.execute(`INSERT INTO agentic_session_event(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    columns.map((key) => key === "payload" ? JSON.stringify(payload) : key.endsWith("_at") ? new Date(String(full[key])) : full[key]));
  return full.event_id;
}

test("rows from before the text envelope: the reader refuses them, the diagnostic names why, nothing is repaired", { skip: !url }, async () => {
  const pool = createPool({ uri: url!, timezone: "Z", supportBigNumbers: true, bigNumberStrings: true });
  const setup = createPool({ uri: process.env.TEST_MYSQL_OWNER_URL ?? url!, timezone: "Z" });
  const tenantId = `diagnosis-${randomUUID()}`;
  const security: SecurityContext = { tenantId, actorId: "owner", permissions: new Set(), purpose: "test", correlationId: "test" };
  const store = new MySqlSessionStore(pool);
  try {
    for (const sessionId of ["float", "big", "empty"]) {
      await setup.execute("INSERT INTO agentic_session_stream(tenant_id,session_id,owner_actor_id,current_seq) VALUES (?,?,?,1)", [tenantId, sessionId, "owner"]);
    }
    const lossy = await insertNative(setup, tenantId, "float", { amount: FLOAT });
    const big = await insertNative(setup, tenantId, "big", { amount: BIG });
    const empty = await insertNative(setup, tenantId, "empty", { content: "x" }, { turn_id: "", step_id: "" });
    const column = async (id: string) => ((await setup.execute("SELECT CAST(payload AS CHAR) AS payload, integrity_hash FROM agentic_session_event WHERE event_id=?", [id]))[0] as { payload: string; integrity_hash: string }[])[0]!;
    const before = await column(lossy);
    assert.equal(JSON.parse(before.payload).amount, 29432.686, "the JSON column re-prints the double");

    for (const sessionId of ["float", "big"]) await assert.rejects(store.load(sessionId, security), /integrity check failed/u);
    assert.equal((await store.load("empty", security))[0]?.turnId, "", "an empty id verifies");

    const run = (id: string) => spawnSync(process.execPath, ["--import", "tsx", diagnostic, id], { env: scriptEnv, encoding: "utf8" });
    const floatRun = run(lossy);
    assert.equal(floatRun.status, 2);
    assert.deepEqual(JSON.parse(floatRun.stdout).nonIntegerNumbers, { count: 1, paths: ["$.amount"] });
    assert.equal(JSON.parse(floatRun.stdout).explanation, "payload đã đổi; có 1 số không nguyên (nghi round-trip số thực)");
    const bigRun = run(big);
    assert.equal(bigRun.status, 2);
    assert.equal(JSON.parse(bigRun.stdout).result, "no-big-number-reviver");
    assert.equal(JSON.parse(execFileSync(process.execPath, ["--import", "tsx", diagnostic, empty], { env: scriptEnv, encoding: "utf8" })).result, "canonical");
    for (const output of [floatRun.stdout, bigRun.stdout]) assert.ok(!output.includes("29432") && !output.includes(String(BIG)), "no value of the document in the report");
    assert.deepEqual(await column(lossy), before, "the diagnostic changes nothing");
  } finally {
    try { await setup.execute("DELETE FROM agentic_session_stream WHERE tenant_id=?", [tenantId]); }
    finally { await Promise.all([pool.end(), setup.end()]); }
  }
});
