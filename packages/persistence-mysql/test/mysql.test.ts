import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { AgenticError, type RuntimeSnapshot, type SecurityContext } from "@0xsyncroot/contracts";
import { createMySqlPersistence, migrateMySql, type MySqlPersistenceEvent } from "@0xsyncroot/persistence-mysql";
import { AesGcmEnvelopeProtector, DerivedTenantKeyProvider } from "@0xsyncroot/adapter-crypto-node";
import { createPool, type RowDataPacket } from "mysql2/promise";

const appUrl = process.env.TEST_MYSQL_URL?.trim() || (process.env.DATABASE_URL?.startsWith("mysql:") ? process.env.DATABASE_URL : undefined);
/**
 * An account that may create tables and grant, for these tests only.
 *
 * Set it, and the suite provisions the way the README tells a database owner to — schema, then
 * the shipped `grants/app-account.sql` — and checks the properties those grants are supposed to
 * buy. Leave it unset and the suite runs everything else against a single account, which is the
 * ordinary local case. The privileges are a file now, so the file is what needs checking: a
 * grant that quietly stopped being applied would otherwise look exactly like a passing test.
 */
const ownerUrl = process.env.TEST_MYSQL_OWNER_URL?.trim();

async function provision(): Promise<void> {
  await migrateMySql({ connectionString: ownerUrl ?? appUrl! });
  if (!ownerUrl) return;
  const pool = createPool({ uri: ownerUrl, connectionLimit: 1, multipleStatements: true });
  try { await pool.query(await readFile(new URL("../grants/app-account.sql", import.meta.url), "utf8")); }
  finally { await pool.end(); }
}
const runtime: RuntimeSnapshot = { id: "mysql-test", coreVersion: "1.0.0", pluginSetId: "mysql", policyRevision: "test", memoryPolicyRevision: "test", createdAt: new Date().toISOString() };
function security(tenantId: string, actorId: string): SecurityContext { return { tenantId, actorId, permissions: new Set(["*"]), correlationId: crypto.randomUUID(), purpose: "mysql-integration-test" }; }

test("MySQL adapter preserves session CAS and tenant-scoped memory", { skip: !appUrl }, async () => {
  if (!appUrl) return;
  await provision();
  const persistence = await createMySqlPersistence(appUrl);
  const suffix = crypto.randomUUID();
  const tenantA = security(`tenant-a-${suffix}`, `actor-a-${suffix}`);
  const tenantB = security(`tenant-b-${suffix}`, `actor-b-${suffix}`);
  const sessionId = `session-${suffix}`;
  try {
    const original = [{ type: "user/input", turnId: "t", payload: { content: "hello", source: "test" } }] as const;
    assert.equal(await persistence.sessions.append(sessionId, 0, original, "input", { security: tenantA, runtime }), 1);
    assert.equal(await persistence.sessions.append(sessionId, 0, original, "input", { security: tenantA, runtime }), 1);
    await assert.rejects(
      persistence.sessions.append(sessionId, 1, [{ type: "ignored", payload: {} }], "input", { security: tenantA, runtime }),
      /different append operation/i,
    );
    assert.equal((await persistence.sessions.load(sessionId, tenantA)).length, 1);
    assert.equal((await persistence.sessions.load(sessionId, tenantB)).length, 0);
    assert.equal(await persistence.sessions.append(sessionId, 0, [{ type: "user/input", turnId: "tenant-b", payload: { content: "tenant B", source: "test" } }], "tenant-b", { security: tenantB, runtime }), 1);
    assert.equal((await persistence.sessions.load(sessionId, tenantB)).length, 1);
    await assert.rejects(persistence.sessions.append(sessionId, 0, [{ type: "user/input", turnId: "denied", payload: { content: "denied", source: "test" } }], "cross", { security: security(tenantA.tenantId, `other-${suffix}`), runtime }), /owner boundary|unavailable/i);
    const leaseSession = `lease-${suffix}`;
    const claims = await Promise.all(["a", "b"].map((owner) => persistence.sessions.claimTurn({
      sessionId: leaseSession, turnId: `turn-${owner}-${suffix}`, ownerId: owner, idempotencyKey: owner,
      requestFingerprint: `fingerprint-${owner}`, leaseTtlMs: 5_000,
      startEvents: [{ type: "turn/start", turnId: `turn-${owner}-${suffix}`, payload: { inputIdempotencyKey: owner } }],
    }, { security: tenantA, runtime })));
    assert.equal(claims.filter((claim) => claim.kind === "acquired").length, 1);
    const acquired = claims.find((claim) => claim.kind === "acquired");
    if (acquired?.kind === "acquired") await persistence.sessions.finishTurn(acquired.lease, acquired.seq, { type: "turn/end", turnId: acquired.lease.turnId, payload: { status: "completed" } }, { security: tenantA, runtime });
    const profileTurnId = `profile-read-${suffix}`;
    const profileClaim = await persistence.sessions.claimTurn({
      sessionId: `profile-${suffix}`, turnId: profileTurnId, ownerId: "profile-worker", idempotencyKey: "profile-read",
      requestFingerprint: "profile-read", agentProfileId: "read", leaseTtlMs: 5_000,
      startEvents: [{ type: "turn/start", turnId: profileTurnId, payload: { inputIdempotencyKey: "profile-read" } }],
    }, { security: tenantA, runtime });
    assert.equal(profileClaim.kind, "acquired");
    if (profileClaim.kind !== "acquired") throw new Error("missing profile lease");
    await persistence.sessions.finishTurn(profileClaim.lease, profileClaim.seq, { type: "turn/end", turnId: profileTurnId, payload: { status: "completed" } }, { security: tenantA, runtime });
    await assert.rejects(persistence.sessions.claimTurn({
      sessionId: `profile-${suffix}`, turnId: `profile-write-${suffix}`, ownerId: "profile-worker", idempotencyKey: "profile-write",
      requestFingerprint: "profile-write", agentProfileId: "write", leaseTtlMs: 5_000,
      startEvents: [{ type: "turn/start", turnId: `profile-write-${suffix}`, payload: { inputIdempotencyKey: "profile-write" } }],
    }, { security: tenantA, runtime }), /different agent profile/i);
    const memory = await persistence.memory.propose({ scope: { tenantId: tenantA.tenantId, type: "actor", id: tenantA.actorId }, kind: "semantic", content: "prefers concise responses", format: "text", classification: "internal", sourceRef: `session:${sessionId}`, authority: "user-stated" }, tenantA);
    const found = await persistence.memory.search({ text: "concise responses", scopes: [memory.scope], limit: 5 }, tenantA);
    assert.equal(found.records[0]?.id, memory.id);
    // A person's message is searched as words, never as full-text operators: "---", a lone quote or a bracket parsed as
    // syntax fails the whole turn with a MySQL error.
    for (const text of ["concise (---) responses", "\"concise responses", "concise) +-responses", "concise @3 responses*",
      "* \"concise responses\" tăng lên 730.000", "\"concise\" * \"responses\""]) {
      assert.equal((await persistence.memory.search({ text, scopes: [memory.scope], limit: 5 }, tenantA)).records[0]?.id, memory.id, text);
    }
    // Nothing left to search once the punctuation is gone: no records, and no error.
    for (const text of ["*", "\"*\"", "--- *** ---"]) {
      assert.deepEqual((await persistence.memory.search({ text, scopes: [memory.scope], limit: 5 }, tenantA)).records, [], text);
    }
    await assert.rejects(persistence.memory.search({ text: "concise", scopes: [memory.scope], limit: 5 }, tenantB), /tenant boundary/i);
    const otherActor = security(tenantA.tenantId, `other-memory-${suffix}`);
    assert.deepEqual((await persistence.memory.search({ text: "concise", scopes: [memory.scope], limit: 5 }, otherActor)).records, []);
    await assert.rejects(persistence.memory.forget(memory.id, otherActor), /another actor/i);
    assert.equal(await persistence.memory.forget(memory.id, tenantB), false);
    await assert.rejects(persistence.memory.propose({ ...memory, content: "unauthorized update" }, otherActor), /another actor/i);
    assert.equal((await persistence.memory.search({ text: "concise", scopes: [memory.scope], limit: 5 }, tenantA)).records[0]?.id, memory.id);
    assert.equal(await persistence.memory.forget(memory.id, tenantA), true);
  } finally { await persistence.close(); }
});

test("MySQL adapter encrypts durable payloads and uses tenant blind indexes", { skip: !appUrl }, async () => {
  if (!appUrl) return;
  await provision();
  const protector = new AesGcmEnvelopeProtector(new DerivedTenantKeyProvider(Buffer.alloc(32, 23), "mysql-test-v1"));
  const persistence = await createMySqlPersistence(appUrl, { payloadProtector: protector, blindIndex: protector });
  const suffix = crypto.randomUUID();
  const tenant = security(`protected-${suffix}`, `actor-${suffix}`);
  const secret = `secret-${suffix}`;
  try {
    await persistence.sessions.append(`session-${suffix}`, 0, [{ type: "user/input", turnId: `turn-${suffix}`, classification: "confidential", payload: { content: secret, source: "test" } }], "input", { security: tenant, runtime });
    // Rows are decrypted and verified after the read transaction commits, on every read path.
    assert.equal(((await persistence.sessions.loadSince(`session-${suffix}`, 0, tenant, 10))[0]?.payload as Record<string, unknown>).content, secret);
    const record = await persistence.memory.propose({ scope: { tenantId: tenant.tenantId, type: "actor", id: tenant.actorId }, kind: "semantic", content: `remember ${secret}`, format: "text", classification: "restricted", sourceRef: "test", authority: "user-stated" }, tenant);
    assert.equal((await persistence.memory.search({ text: secret, scopes: [record.scope], limit: 5 }, tenant)).records[0]?.content, `remember ${secret}`);
    const direct = createPool({ uri: appUrl, connectionLimit: 1, timezone: "Z" });
    try {
      const [events] = await direct.query<Array<{ payload: string | Record<string, unknown> }>>("SELECT payload FROM agentic_session_event WHERE tenant_id=? AND session_id=?", [tenant.tenantId, `session-${suffix}`]);
      const payload = typeof events[0]?.payload === "string" ? JSON.parse(events[0].payload) as Record<string, unknown> : events[0]?.payload;
      assert.equal(payload?._protected, "gateway-envelope-v1");
      assert.equal(JSON.stringify(events).includes(secret), false);
      if (ownerUrl) {
        // Only meaningful once the shipped grants have been applied to this account: an
        // arbitrary account proves nothing either way.
        await assert.rejects(direct.query("UPDATE agentic_session_event SET type='tampered'"), /denied/i);
        await assert.rejects(direct.query("UPDATE agentic_memory_revision SET content='tampered'"), /denied/i);
        await assert.rejects(direct.query("SELECT * FROM agentic_schema_migration"), /denied/i);
      }
    } finally { await direct.end(); }
  } finally { await persistence.close(); }
});

test("the bounded context and history reads work on MySQL", { skip: !appUrl }, async () => {
  if (!appUrl) return;
  // Every turn calls loadContext, so a failure here is not an edge case — it is the agent
  // answering "Incorrect arguments to mysqld_stmt_execute" to the first thing a user types.
  // MySQL's binary protocol refuses a bound parameter in LIMIT, and the error names neither
  // the parameter nor the statement, so the regression is worth pinning per dialect.
  const persistence = await createMySqlPersistence(appUrl);
  const suffix = crypto.randomUUID();
  const tenant = security(`tenant-ctx-${suffix}`, `actor-ctx-${suffix}`);
  const sessionId = `session-ctx-${suffix}`;
  try {
    for (const index of [0, 1, 2]) {
      await persistence.sessions.append(sessionId, index, [{
        type: "user/input", turnId: `turn-${index}`, payload: { content: `message ${index}`, source: "test" },
      }], `key-${index}`, { security: tenant, runtime });
    }
    const context = await persistence.sessions.loadContext(sessionId, tenant);
    assert.equal(context.events.length, 3);
    assert.deepEqual(context.events.map((event) => event.seq), [1, 2, 3], "and in ascending order");

    const recent = await persistence.sessions.loadRecent(sessionId, 2, tenant);
    assert.deepEqual(recent.map((event) => event.seq), [2, 3], "the newest two, oldest first");
    await assert.rejects(persistence.sessions.loadRecent(sessionId, 0, tenant), /limit must be from 1/iu);

    // One event of sort_buffer_size (262 144 bytes by default) or more made both reads fail with
    // "Out of sort memory" while the statement re-sorted whole rows; an encrypted request snapshot
    // is that large on a session's first turn.
    await persistence.sessions.append(sessionId, 3, [{
      type: "user/input", turnId: "turn-large", payload: { content: "x".repeat(300_000), source: "test" },
    }], "key-large", { security: tenant, runtime });
    assert.deepEqual((await persistence.sessions.loadContext(sessionId, tenant)).events.map((event) => event.seq), [1, 2, 3, 4]);
    assert.deepEqual((await persistence.sessions.loadRecent(sessionId, 2, tenant)).map((event) => event.seq), [3, 4]);

    const longSession = `session-long-${suffix}`;
    for (let seq = 0; seq < 1_002; seq += 100) {
      const drafts = Array.from({ length: Math.min(100, 1_002 - seq) }, (_, index) => ({
        type: "user/input" as const, turnId: `turn-long-${seq + index}`, payload: { content: `m ${seq + index}`, source: "test" },
      }));
      await persistence.sessions.append(longSession, seq, drafts, `long-${seq}`, { security: tenant, runtime });
    }
    const bounded = await persistence.sessions.loadContext(longSession, tenant);
    assert.equal(bounded.events.length, 1_000);
    assert.deepEqual([bounded.events[0]?.seq, bounded.events.at(-1)?.seq, bounded.truncatedBeforeSeq], [3, 1_002, 3],
      "the newest thousand, oldest first, with the cut named");
  } finally { await persistence.close(); }
});

test("loadSince reads forward from a sequence on MySQL, and one append of many drafts lands whole", { skip: !appUrl }, async () => {
  if (!appUrl) return;
  await provision();
  const persistence = await createMySqlPersistence(appUrl, { poolSize: 2 });
  const suffix = crypto.randomUUID();
  const tenant = security(`tenant-since-${suffix}`, `actor-since-${suffix}`);
  const sessionId = `session-since-${suffix}`;
  try {
    // Sized so the batch is split by payload bytes: a statement that summed these payloads could
    // cross max_allowed_packet where one statement per row never did.
    const contents = ["first", "x".repeat(700_000), "y".repeat(700_000), "fourth", "fifth"];
    const drafts = contents.map((content, index) => ({ type: "user/input", turnId: `turn-${index}`, payload: { content, source: "test" } }));
    assert.equal(await persistence.sessions.append(sessionId, 0, drafts, "batch", { security: tenant, runtime }), 5);
    const all = await persistence.sessions.loadSince(sessionId, 0, tenant, 10);
    assert.deepEqual(all.map((event) => event.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(all.map((event) => (event.payload as Record<string, unknown>).content), contents,
      "every row verified against its integrity hash, in journal order");

    assert.deepEqual((await persistence.sessions.loadSince(sessionId, 2, tenant, 10)).map((event) => event.seq), [3, 4, 5]);
    assert.deepEqual((await persistence.sessions.loadSince(sessionId, 1, tenant, 2)).map((event) => event.seq), [2, 3]);
    assert.deepEqual(await persistence.sessions.loadSince(sessionId, 5, tenant, 10), []);
    assert.deepEqual(await persistence.sessions.loadSince(sessionId, 0, security(tenant.tenantId, `other-${suffix}`), 10), [],
      "another actor of the same tenant cannot see the session");
    await assert.rejects(persistence.sessions.loadSince(sessionId, 0, tenant, 1_001), /limit must be from 1 to 1000/u);
    await assert.rejects(persistence.sessions.loadSince(sessionId, -1, tenant, 10), /afterSeq/u);

    await assert.rejects(
      persistence.sessions.append(sessionId, 3, [{ type: "user/input", turnId: "stale", payload: { content: "stale", source: "test" } }], "stale", { security: tenant, runtime }),
      (error: unknown) => error instanceof AgenticError && error.code === "conflict" && /expected 3, actual 5/u.test(error.message),
      "the stream's locked sequence is the CAS reference",
    );
    assert.equal(await persistence.sessions.append(sessionId, 0, drafts, "batch", { security: tenant, runtime }), 5,
      "a retried append answers with its first result even though the stream has moved on");

    const claim = await persistence.sessions.claimTurn({
      sessionId, turnId: `turn-lease-${suffix}`, ownerId: "worker", idempotencyKey: "lease", requestFingerprint: "lease", leaseTtlMs: 5_000,
      startEvents: [{ type: "turn/start", turnId: `turn-lease-${suffix}`, payload: { inputIdempotencyKey: "lease" } }],
    }, { security: tenant, runtime });
    if (claim.kind !== "acquired") throw new Error("missing lease");
    const leased = await persistence.sessions.appendLeased(claim.lease, claim.seq, [
      { type: "user/input", turnId: claim.lease.turnId, payload: { content: "a", source: "test" } },
      { type: "user/input", turnId: claim.lease.turnId, payload: { content: "b", source: "test" } },
    ], "leased", { security: tenant, runtime });
    const finished = await persistence.sessions.finishTurn(claim.lease, leased, { type: "turn/end", turnId: claim.lease.turnId, payload: { status: "completed" } }, { security: tenant, runtime });
    assert.deepEqual((await persistence.sessions.loadSince(sessionId, 5, tenant, 10)).map((event) => [event.seq, event.type]),
      [[6, "turn/start"], [7, "user/input"], [8, "user/input"], [9, "turn/end"]]);
    assert.equal(finished, 9);
  } finally { await persistence.close(); }
});

test("migration 0003 leaves the unique key as the only (tenant, session, seq) index", { skip: !appUrl }, async () => {
  if (!appUrl) return;
  await provision();
  const direct = createPool({ uri: appUrl, connectionLimit: 1 });
  try {
    const [rows] = await direct.query<Array<{ index_name: string } & RowDataPacket>>(
      `SELECT DISTINCT index_name AS index_name FROM information_schema.statistics
        WHERE table_schema=DATABASE() AND table_name='agentic_session_event' ORDER BY index_name`,
    );
    assert.deepEqual(rows.map((row) => row.index_name), ["PRIMARY", "session_checkpoint", "session_seq"]);
  } finally { await direct.end(); }
});

test("the MySQL pool size is validated before any connection is opened", async () => {
  await assert.rejects(createMySqlPersistence("mysql://app:secret@127.0.0.1:1/agentic", { poolSize: 0 }), /pool size must be a positive integer/u);
  await assert.rejects(createMySqlPersistence("mysql://app:secret@127.0.0.1:1/agentic", { poolSize: 2.5 }), /pool size must be a positive integer/u);
});

test("a pooled connection that died while idle is replaced before any statement runs", async () => {
  const { withTenantTransaction } = await import("../src/transaction.js");
  const calls: string[] = [];
  const connection = (name: string, begin: () => Promise<void>) => ({
    beginTransaction: begin, commit: async () => { calls.push(`${name}:commit`); },
    rollback: async () => { calls.push(`${name}:rollback`); },
    release: () => { calls.push(`${name}:release`); }, destroy: () => { calls.push(`${name}:destroy`); },
  });
  const handed = [
    connection("stale", async () => { throw Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT", errno: -110, fatal: true }); }),
    connection("fresh", async () => { calls.push("fresh:begin"); }),
  ];
  const pool = { getConnection: async () => handed.shift() } as unknown as Parameters<typeof withTenantTransaction>[0];
  assert.equal(await withTenantTransaction(pool, security("tenant-pool", "actor-pool"), async () => "read"), "read");
  assert.deepEqual(calls, ["stale:destroy", "fresh:begin", "fresh:commit", "fresh:release"],
    "the dead connection is destroyed, never returned to the pool, and the work runs once on a live one");
});

test("a connection lost after the transaction started is not retried", async () => {
  const { withTenantTransaction } = await import("../src/transaction.js");
  let handedOut = 0;
  const calls: string[] = [];
  const pool = { getConnection: async () => {
    handedOut += 1;
    return { beginTransaction: async () => undefined, commit: async () => undefined, rollback: async () => { calls.push("rollback"); },
      release: () => { calls.push("release"); }, destroy: () => { calls.push("destroy"); } };
  } } as unknown as Parameters<typeof withTenantTransaction>[0];
  await assert.rejects(withTenantTransaction(pool, security("tenant-pool", "actor-pool"), async () => {
    throw Object.assign(new Error("Connection lost: The server closed the connection."), { code: "PROTOCOL_CONNECTION_LOST", fatal: true });
  }), /Connection lost/u);
  assert.equal(handedOut, 1, "a write may have reached the server, so it is not repeated");
  assert.deepEqual(calls, ["destroy"]);
});

test("the first read after a minute of silence finds its connection still open", { skip: !appUrl, timeout: 120_000 }, async () => {
  if (!appUrl) return;
  await provision();
  const events: MySqlPersistenceEvent[] = [];
  const persistence = await createMySqlPersistence(appUrl, { log: (event) => events.push(event) });
  const watcher = createPool({ uri: appUrl, connectionLimit: 1 });
  const suffix = crypto.randomUUID();
  const tenant = security(`tenant-warm-${suffix}`, `actor-warm-${suffix}`);
  // The sleeping connections of this schema and account: the pool's, since the watcher is running a query.
  const sleeping = async () => {
    const [rows] = await watcher.query<Array<{ id: string } & RowDataPacket>>(
      "SELECT id AS id FROM information_schema.processlist WHERE user = SUBSTRING_INDEX(USER(), '@', 1) AND db = DATABASE() AND command = 'Sleep' ORDER BY id");
    return rows.map((row) => row.id);
  };
  try {
    const measured = events.find((event) => event.event === "mysql.pool.measured");
    assert.ok(measured && measured.event === "mysql.pool.measured", "the boot measurement is reported");
    assert.ok(measured.coldConnectMs >= 0 && measured.warmPingMs >= 0);
    assert.ok(measured.idleTimeoutMs >= 30_000 && measured.idleTimeoutMs <= 600_000, `idleTimeout ${measured.idleTimeoutMs} ms is within 30 s and 10 min`);
    assert.equal(measured.keepWarmEveryMs, Math.min(30_000, measured.idleTimeoutMs / 2));
    if (measured.waitTimeoutSeconds !== null) {
      assert.equal(measured.idleTimeoutMs, Math.max(30_000, Math.min(600_000, measured.waitTimeoutSeconds * 1000 - 30_000)), "idleTimeout is derived from the server's wait_timeout");
    }

    await persistence.sessions.load(`session-${suffix}`, tenant);
    const before = await sleeping();
    assert.ok(before.length >= 1, "the pool holds a connection after the read");
    // The pool used to drop every connection idle for 60 s; the next read then paid a handshake.
    await new Promise((resolve) => setTimeout(resolve, 65_000));
    assert.deepEqual(await sleeping(), before, "the same connection ids are still open after 65 s");
    await persistence.sessions.load(`session-${suffix}`, tenant);
    assert.deepEqual(await sleeping(), before, "the next read opened no new connection");
    assert.deepEqual(events.filter((event) => event.level === "warn"), [], "no keep-warm failure on a healthy server");
  } finally { await persistence.close(); await watcher.end(); }
});
