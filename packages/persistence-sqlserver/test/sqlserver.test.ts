import assert from "node:assert/strict";
import { test } from "node:test";
import { AesGcmEnvelopeProtector, DerivedTenantKeyProvider } from "@0xsyncroot/adapter-crypto-node";
import type { PayloadProtector, RuntimeSnapshot, SecurityContext } from "@0xsyncroot/contracts";
import { createSqlServerPersistence, migrateSqlServer, parseSqlServerUrl } from "@0xsyncroot/persistence-sqlserver";
import { SqlServerSessionWriteRepository } from "../src/session-write-repository.js";
import { SessionWriteRepository as PostgresSessionWriteRepository } from "../../persistence-postgres/src/session-write-repository.js";
import { MySqlSessionWriteRepository } from "../../persistence-mysql/src/session-write-repository.js";
import sql from "mssql";

function sqlServerUrl(value: string | undefined): string | undefined {
  const source = value?.trim();
  return source?.startsWith("sqlserver:") || source?.startsWith("mssql:") ? source : undefined;
}

const appUrl = sqlServerUrl(process.env.TEST_SQLSERVER_URL) ?? sqlServerUrl(process.env.DATABASE_URL);
// Schema owner, for these tests only: the service's own contract has no such variable, and a
// deployment applies `migrations/` and `grants/app-account.sql` however it already does that.
const ownerUrl = sqlServerUrl(process.env.TEST_SQLSERVER_OWNER_URL) ?? sqlServerUrl(process.env.ADMIN_SQLSERVER_URL);
const runtime: RuntimeSnapshot = {
  id: "sqlserver-test", coreVersion: "1.0.0", pluginSetId: "sqlserver",
  policyRevision: "test", memoryPolicyRevision: "test", createdAt: new Date().toISOString(),
};

function security(tenantId: string, actorId: string): SecurityContext {
  return { tenantId, actorId, permissions: new Set(["*"]), correlationId: crypto.randomUUID(), purpose: "sqlserver-integration-test" };
}

test("SQL Server URL parser keeps transport security explicit", () => {
  const config = parseSqlServerUrl("sqlserver://app:secret@db.example:14330/agentic?encrypt=true&trustServerCertificate=false&poolMax=12");
  assert.equal(config.server, "db.example");
  assert.equal(config.port, 14330);
  assert.equal(config.database, "agentic");
  assert.equal(config.pool?.max, 12);
  assert.equal(config.options?.encrypt, true);
  assert.equal(config.options?.trustServerCertificate, false);
  assert.throws(() => parseSqlServerUrl("postgres://app:secret@db.example/agentic"), /sql server connection string/i);
  assert.throws(() => parseSqlServerUrl("mssql://app:secret@db.example/agentic?encrypt=maybe"), /encrypt must be true or false/i);
});

test("SQL repositories snapshot caller drafts before asynchronous protection", async () => {
  for (const create of [
    (protector: PayloadProtector) => new PostgresSessionWriteRepository(protector),
    (protector: PayloadProtector) => new MySqlSessionWriteRepository(protector),
    (protector: PayloadProtector) => new SqlServerSessionWriteRepository(protector),
  ]) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const protector: PayloadProtector = {
      protect: async (value) => {
        await gate;
        return { _protected: "gateway-envelope-v1", algorithm: "A256GCM", keyId: "test", nonce: "test", ciphertext: JSON.stringify(value), tag: "test" };
      },
      unprotect: async () => ({}),
    };
    const payload = { content: "original" };
    const preparing = create(protector).prepareDrafts([{ type: "extension/test", payload }], {
      security: security("tenant", "actor"), runtime,
    });
    payload.content = "mutated";
    release();
    const prepared = (await preparing)[0]!;
    assert.equal((prepared.draft.payload as Record<string, unknown>).content, "original");
    assert.equal("ciphertext" in prepared.storedPayload && JSON.parse(prepared.storedPayload.ciphertext).content, "original");
  }
});

test("SQL Server adapter preserves session CAS, lease and tenant-scoped memory", { skip: !appUrl || !ownerUrl }, async () => {
  if (!appUrl || !ownerUrl) return;
  await migrateSqlServer({ connectionString: ownerUrl });
  const persistence = await createSqlServerPersistence(appUrl);
  const suffix = crypto.randomUUID();
  const tenantA = security(`tenant-a-${suffix}`, `actor-a-${suffix}`);
  const tenantB = security(`tenant-b-${suffix}`, `actor-b-${suffix}`);
  const sessionId = `session-${suffix}`;
  try {
    const original = [
      { type: "user/input", turnId: "t", payload: { content: "hello", source: "test" } },
    ] as const;
    assert.equal(await persistence.sessions.append(sessionId, 0, original, "input", { security: tenantA, runtime }), 1);
    assert.equal(await persistence.sessions.append(sessionId, 0, original, "input", { security: tenantA, runtime }), 1);
    await assert.rejects(
      persistence.sessions.append(sessionId, 1, [{ type: "ignored", payload: {} }], "input", { security: tenantA, runtime }),
      /different append operation/i,
    );
    assert.equal((await persistence.sessions.load(sessionId, tenantA)).length, 1);
    assert.equal((await persistence.sessions.load(sessionId, tenantB)).length, 0);
    assert.equal(await persistence.sessions.append(sessionId, 0, [
      { type: "user/input", turnId: "tenant-b", payload: { content: "tenant B", source: "test" } },
    ], "tenant-b", { security: tenantB, runtime }), 1);
    assert.equal((await persistence.sessions.load(sessionId, tenantB)).length, 1);
    await assert.rejects(persistence.sessions.append(sessionId, 0, [
      { type: "user/input", turnId: "denied", payload: { content: "denied", source: "test" } },
    ], "cross", { security: security(tenantA.tenantId, `other-${suffix}`), runtime }), /owner boundary|unavailable/i);
    const leaseSession = `lease-${suffix}`;
    const claims = await Promise.all(["a", "b"].map((owner) => persistence.sessions.claimTurn({
      sessionId: leaseSession, turnId: `turn-${owner}-${suffix}`, ownerId: owner, idempotencyKey: owner,
      requestFingerprint: `fingerprint-${owner}`, leaseTtlMs: 5_000,
      startEvents: [{ type: "turn/start", turnId: `turn-${owner}-${suffix}`, payload: { inputIdempotencyKey: owner } }],
    }, { security: tenantA, runtime })));
    assert.equal(claims.filter((claim) => claim.kind === "acquired").length, 1);
    const acquired = claims.find((claim) => claim.kind === "acquired");
    if (acquired?.kind === "acquired") {
      await persistence.sessions.finishTurn(acquired.lease, acquired.seq, {
        type: "turn/end", turnId: acquired.lease.turnId, payload: { status: "completed" },
      }, { security: tenantA, runtime });
    }
    const profileTurnId = `profile-read-${suffix}`;
    const profileClaim = await persistence.sessions.claimTurn({
      sessionId: `profile-${suffix}`, turnId: profileTurnId, ownerId: "profile-worker", idempotencyKey: "profile-read",
      requestFingerprint: "profile-read", agentProfileId: "read", leaseTtlMs: 5_000,
      startEvents: [{ type: "turn/start", turnId: profileTurnId, payload: { inputIdempotencyKey: "profile-read" } }],
    }, { security: tenantA, runtime });
    assert.equal(profileClaim.kind, "acquired");
    if (profileClaim.kind !== "acquired") throw new Error("missing profile lease");
    await persistence.sessions.finishTurn(profileClaim.lease, profileClaim.seq,
      { type: "turn/end", turnId: profileTurnId, payload: { status: "completed" } }, { security: tenantA, runtime });
    await assert.rejects(persistence.sessions.claimTurn({
      sessionId: `profile-${suffix}`, turnId: `profile-write-${suffix}`, ownerId: "profile-worker", idempotencyKey: "profile-write",
      requestFingerprint: "profile-write", agentProfileId: "write", leaseTtlMs: 5_000,
      startEvents: [{ type: "turn/start", turnId: `profile-write-${suffix}`, payload: { inputIdempotencyKey: "profile-write" } }],
    }, { security: tenantA, runtime }), /different agent profile/i);
    const memory = await persistence.memory.propose({
      scope: { tenantId: tenantA.tenantId, type: "actor", id: tenantA.actorId }, kind: "semantic",
      content: "prefers concise responses", format: "text", classification: "internal",
      sourceRef: `session:${sessionId}`, authority: "user-stated",
    }, tenantA);
    assert.equal((await persistence.memory.search({ text: "concise", scopes: [memory.scope], limit: 5 }, tenantA)).records[0]?.id, memory.id);
    await assert.rejects(persistence.memory.search({ text: "concise", scopes: [memory.scope], limit: 5 }, tenantB), /tenant boundary/i);
    assert.equal(await persistence.memory.forget(memory.id, tenantA), true);
  } finally {
    await persistence.close();
  }
});

test("SQL Server loadSince reads forward from a sequence within the owner boundary", { skip: !appUrl || !ownerUrl }, async () => {
  if (!appUrl || !ownerUrl) return;
  await migrateSqlServer({ connectionString: ownerUrl });
  const persistence = await createSqlServerPersistence(appUrl);
  const suffix = crypto.randomUUID();
  const owner = security(`since-tenant-${suffix}`, `since-actor-${suffix}`);
  const sessionId = `since-session-${suffix}`;
  try {
    const drafts = [1, 2, 3, 4, 5].map((index) => ({
      type: "user/input", turnId: `since-turn-${index}`, payload: { content: `message ${index}`, source: "test" },
    }));
    assert.equal(await persistence.sessions.append(sessionId, 0, drafts, "since-seed", { security: owner, runtime }), 5);
    assert.deepEqual((await persistence.sessions.loadSince(sessionId, 2, owner, 10)).map((event) => event.seq), [3, 4, 5]);
    assert.deepEqual((await persistence.sessions.loadSince(sessionId, 0, owner, 2)).map((event) => event.seq), [1, 2]);
    assert.deepEqual(await persistence.sessions.loadSince(sessionId, 5, owner, 10), []);
    assert.deepEqual(await persistence.sessions.loadSince(sessionId, 0, security(owner.tenantId, `other-${suffix}`), 10), []);
    await assert.rejects(persistence.sessions.loadSince(sessionId, 0, owner, 1_001), /limit must be from 1 to 1000/u);
    await assert.rejects(persistence.sessions.loadSince(sessionId, -1, owner, 10), /afterSeq/u);
  } finally {
    await persistence.close();
  }
});

test("SQL Server adapter encrypts payloads, blind-indexes memory and enforces least privilege", { skip: !appUrl || !ownerUrl }, async () => {
  if (!appUrl || !ownerUrl) return;
  await migrateSqlServer({ connectionString: ownerUrl });
  const protector = new AesGcmEnvelopeProtector(new DerivedTenantKeyProvider(Buffer.alloc(32, 29), "sqlserver-test-v1"));
  const persistence = await createSqlServerPersistence(appUrl, { payloadProtector: protector, blindIndex: protector });
  const suffix = crypto.randomUUID();
  const tenant = security(`protected-${suffix}`, `actor-${suffix}`);
  const secret = `secret-${suffix}`;
  try {
    await persistence.sessions.append(`session-${suffix}`, 0, [{
      type: "user/input", turnId: `turn-${suffix}`, classification: "confidential", payload: { content: secret, source: "test" },
    }], "input", { security: tenant, runtime });
    const memory = await persistence.memory.propose({
      scope: { tenantId: tenant.tenantId, type: "actor", id: tenant.actorId }, kind: "semantic", content: `remember ${secret}`,
      format: "text", classification: "restricted", sourceRef: "test", authority: "user-stated",
    }, tenant);
    assert.equal((await persistence.memory.search({ text: secret, scopes: [memory.scope], limit: 5 }, tenant)).records[0]?.content, `remember ${secret}`);
    const direct = await new sql.ConnectionPool(parseSqlServerUrl(appUrl)).connect();
    try {
      assert.equal((await direct.request().query("SELECT * FROM agentic.session_event;")).recordset.length, 0);
      const scoped = direct.request().input("tenant_id", sql.NVarChar(191), tenant.tenantId);
      await scoped.query("EXEC sys.sp_set_session_context @key=N'tenant_id',@value=@tenant_id;");
      const events = await direct.request().query<{ payload: string }>("SELECT payload FROM agentic.session_event;");
      assert.equal((JSON.parse(events.recordset[0]?.payload ?? "{}") as Record<string, unknown>)._protected, "gateway-envelope-v1");
      assert.equal(JSON.stringify(events.recordset).includes(secret), false);
      await assert.rejects(direct.request().query("UPDATE agentic.session_event SET type=N'tampered';"), /permission|denied/i);
      await assert.rejects(direct.request().query("SELECT * FROM agentic.schema_migration;"), /permission|denied/i);
      await direct.request().query("EXEC sys.sp_set_session_context @key=N'tenant_id',@value=NULL;");
    } finally {
      await direct.close();
    }
  } finally {
    await persistence.close();
  }
});
