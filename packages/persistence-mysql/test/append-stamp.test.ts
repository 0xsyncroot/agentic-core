import assert from "node:assert/strict";
import { test } from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import { createMySqlPersistence, probeAppendStamp, type MySqlPersistenceEvent } from "../src/index.js";
import { MySqlSessionStore } from "../src/session-store.js";
import { appUrl, openPool, ownerScript, ownerUrl, provision, runtime, security, urlAs } from "./mysql-fixture.js";

/** A connection that answers the probe with one MySQL error, or with success. */
function answering(errno?: number, code?: string) {
  const statements: string[] = [];
  return {
    statements,
    connection: {
      query: async (sql: string) => {
        statements.push(sql);
        if (errno !== undefined) throw Object.assign(new Error(code ?? "error"), { errno, code });
        return [[], []];
      },
    },
  };
}

test("the stamp probe touches no row and turns a missing grant or column into 'off', never into a failed boot", async () => {
  const ok = answering();
  assert.deepEqual(await probeAppendStamp(ok.connection), { enabled: true });
  assert.match(ok.statements[0]!, /UPDATE agentic_session_stream SET last_appended_at=last_appended_at WHERE 1=0/u);
  for (const [errno, code] of [[1142, "ER_TABLEACCESS_DENIED_ERROR"], [1143, "ER_COLUMNACCESS_DENIED_ERROR"], [1054, "ER_BAD_FIELD_ERROR"]] as const) {
    assert.deepEqual(await probeAppendStamp(answering(errno, code).connection), { enabled: false, reason: code });
  }
  // Anything else is not a grant question: a lost connection at boot stays a failed boot.
  await assert.rejects(probeAppendStamp(answering(2013, "PROTOCOL_CONNECTION_LOST").connection), /PROTOCOL_CONNECTION_LOST/u);
});

async function stampOf(tenantId: string, sessionId: string): Promise<{ stamped: string | null; ageMs: number | null }> {
  const pool = openPool(ownerUrl ?? appUrl!);
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT DATE_FORMAT(last_appended_at, '%Y-%m-%d %H:%i:%s.%f') AS stamped, TIMESTAMPDIFF(MICROSECOND, last_appended_at, UTC_TIMESTAMP(6)) AS age FROM agentic_session_stream WHERE tenant_id=? AND session_id=?",
      [tenantId, sessionId]);
    const row = rows[0]!;
    return { stamped: row.stamped === null ? null : String(row.stamped), ageMs: row.age === null ? null : Number(row.age) / 1000 };
  } finally { await pool.end(); }
}

const input = (turnId: string) => [{ type: "user/input", turnId, payload: { content: "hello", source: "test" } }] as const;

test("an append stamps last_appended_at when the boot probe passes", { skip: !appUrl }, async () => {
  await provision();
  const events: MySqlPersistenceEvent[] = [];
  const persistence = await createMySqlPersistence(appUrl!, { log: (event) => events.push(event) });
  const tenant = security(`stamp-on-${crypto.randomUUID()}`);
  try {
    assert.ok(events.some((event) => event.event === "mysql.append-stamp.enabled"));
    await persistence.sessions.append("s", 0, input("t1"), "k1", { security: tenant, runtime });
    const first = await stampOf(tenant.tenantId, "s");
    assert.notEqual(first.stamped, null);
    assert.ok(first.ageMs! >= 0 && first.ageMs! < 60_000, `stamp is the database's UTC now (age ${first.ageMs} ms)`);
    // A turn moves the stamp as well: claim and finish append through the same statement.
    const claim = await persistence.sessions.claimTurn({ sessionId: "s", turnId: "t2", ownerId: "w", idempotencyKey: "k2", requestFingerprint: "f2",
      leaseTtlMs: 5_000, startEvents: [{ type: "turn/start", turnId: "t2", payload: { inputIdempotencyKey: "k1" } }] }, { security: tenant, runtime });
    assert.equal(claim.kind, "acquired");
    const second = await stampOf(tenant.tenantId, "s");
    assert.ok(second.stamped! >= first.stamped!);
  } finally { await persistence.close(); }
});

test("a store built without the probe keeps the old statement and leaves the stamp empty", { skip: !appUrl }, async () => {
  await provision();
  const pool = openPool(appUrl!);
  const tenant = security(`stamp-off-${crypto.randomUUID()}`);
  try {
    await new MySqlSessionStore(pool).append("s", 0, input("t1"), "k1", { security: tenant, runtime });
    assert.equal((await stampOf(tenant.tenantId, "s")).stamped, null);
  } finally { await pool.end(); }
});

test("an account without the column grant boots with the stamp off and still appends", { skip: !ownerUrl }, async () => {
  await provision();
  const user = "agentic_nostamp";
  const schema = new URL(appUrl!).pathname.slice(1);
  await ownerScript(`
    CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY 'nostamp';
    GRANT SELECT, INSERT ON \`${schema}\`.agentic_session_stream TO '${user}'@'%';
    GRANT UPDATE(current_seq, owner_actor_id, agent_profile_id, lease_owner, lease_fencing_token, lease_expires_at, active_turn_id, active_idempotency_key)
      ON \`${schema}\`.agentic_session_stream TO '${user}'@'%';
    GRANT SELECT, INSERT ON \`${schema}\`.agentic_session_event TO '${user}'@'%';
    GRANT SELECT, INSERT ON \`${schema}\`.agentic_session_append_dedupe TO '${user}'@'%';`);
  const events: MySqlPersistenceEvent[] = [];
  const persistence = await createMySqlPersistence(urlAs(appUrl!, user, "nostamp"), { log: (event) => events.push(event) });
  const tenant = security(`stamp-denied-${crypto.randomUUID()}`);
  try {
    assert.deepEqual(events.find((event) => event.event.startsWith("mysql.append-stamp")),
      { event: "mysql.append-stamp.disabled", level: "warn", reason: "ER_COLUMNACCESS_DENIED_ERROR" });
    assert.equal(await persistence.sessions.append("s", 0, input("t1"), "k1", { security: tenant, runtime }), 1);
    assert.equal((await stampOf(tenant.tenantId, "s")).stamped, null);
  } finally {
    await persistence.close();
    await ownerScript(`DROP USER IF EXISTS '${user}'@'%'`);
  }
});

test("revoking the column grant from a running service fails its appends with 1143 until a restart turns the stamp off", { skip: !ownerUrl }, async () => {
  await provision();
  const user = "agentic_revoked";
  const schema = new URL(appUrl!).pathname.slice(1);
  const stream = `\`${schema}\`.agentic_session_stream`;
  await ownerScript(`
    CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY 'revoked';
    GRANT SELECT, INSERT ON ${stream} TO '${user}'@'%';
    GRANT UPDATE(current_seq, owner_actor_id, agent_profile_id, lease_owner, lease_fencing_token, lease_expires_at, active_turn_id, active_idempotency_key,
      last_appended_at) ON ${stream} TO '${user}'@'%';
    GRANT SELECT, INSERT ON \`${schema}\`.agentic_session_event TO '${user}'@'%';
    GRANT SELECT, INSERT ON \`${schema}\`.agentic_session_append_dedupe TO '${user}'@'%';`);
  const url = urlAs(appUrl!, user, "revoked");
  const tenant = security(`stamp-revoked-${crypto.randomUUID()}`);
  const running = await createMySqlPersistence(url);
  let restarted: Awaited<ReturnType<typeof createMySqlPersistence>> | undefined;
  try {
    assert.equal(await running.sessions.append("s", 0, input("t1"), "k1", { security: tenant, runtime }), 1);
    await ownerScript(`REVOKE UPDATE(last_appended_at) ON ${stream} FROM '${user}'@'%'`);
    await assert.rejects(running.sessions.append("s", 1, input("t2"), "k2", { security: tenant, runtime }),
      (error: { errno?: number; cause?: { errno?: number } }) => (error.errno ?? error.cause?.errno) === 1143);
    const events: MySqlPersistenceEvent[] = [];
    restarted = await createMySqlPersistence(url, { log: (event) => events.push(event) });
    assert.ok(events.some((event) => event.event === "mysql.append-stamp.disabled"));
    assert.equal(await restarted.sessions.append("s", 1, input("t2"), "k2", { security: tenant, runtime }), 2);
  } finally {
    await running.close(); await restarted?.close();
    await ownerScript(`DROP USER IF EXISTS '${user}'@'%'`);
  }
});
