import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { AgenticError, type RuntimeSnapshot, type SecurityContext } from "@0xsyncroot/contracts";
import { createPostgresPersistence, migratePostgres } from "@0xsyncroot/persistence-postgres";
import { AesGcmEnvelopeProtector, DerivedTenantKeyProvider } from "@0xsyncroot/adapter-crypto-node";
import { Pool } from "pg";

const appUrl = process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
// Schema owner, for these tests only: the service's own contract has no such variable, and a
// deployment applies `migrations/` and `grants/app-account.sql` however it already does that.
const ownerUrl = process.env.TEST_POSTGRES_OWNER_URL?.trim();

/**
 * Applies the schema and then the shipped grant script, as a deployment would.
 *
 * The privileges used to be applied by the migration tool, so a test could take them for
 * granted. They are a file now, which means the file itself is what needs checking: run it the
 * way the README tells a database owner to, then assert the properties it is supposed to buy.
 * A grant that silently stopped being applied would otherwise look exactly like a passing test.
 */
async function provision(owner: string): Promise<void> {
  await migratePostgres({ connectionString: owner });
  const pool = new Pool({ connectionString: owner, max: 1 });
  try { await pool.query(await readFile(new URL("../grants/app-account.sql", import.meta.url), "utf8")); }
  finally { await pool.end(); }
}

function security(tenantId: string, actorId: string): SecurityContext {
  return {
    tenantId,
    actorId,
    permissions: new Set(["*"]),
    correlationId: crypto.randomUUID(),
    purpose: "postgres-integration-test",
  };
}

const runtime: RuntimeSnapshot = {
  id: "runtime-postgres-test",
  coreVersion: "1.0.0",
  pluginSetId: "postgres-test",
  policyRevision: "test",
  memoryPolicyRevision: "test",
  createdAt: new Date().toISOString(),
};

test(
  "PostgreSQL providers enforce RLS, CAS, idempotency and full-text memory retrieval",
  { skip: !appUrl || !ownerUrl },
  async () => {
    if (!appUrl || !ownerUrl) return;
    await provision(ownerUrl);
    const persistence = await createPostgresPersistence(appUrl);
    const suffix = crypto.randomUUID();
    const tenantA = security(`tenant-a-${suffix}`, `user-a-${suffix}`);
    const tenantB = security(`tenant-b-${suffix}`, `user-b-${suffix}`);
    const sessionId = `session-${suffix}`;
    try {
      const original = [{ type: "user/input", turnId: "direct-turn", payload: { content: "hello postgres", source: "test" } }] as const;
      const seq = await persistence.sessions.append(
        sessionId,
        0,
        original,
        "input-1",
        { security: tenantA, runtime },
      );
      assert.equal(seq, 1);
      assert.equal(
        await persistence.sessions.append(
          sessionId,
          0,
          original,
          "input-1",
          { security: tenantA, runtime },
        ),
        1,
      );
      await assert.rejects(
        persistence.sessions.append(sessionId, 1, [{ type: "ignored/duplicate", payload: {} }], "input-1", { security: tenantA, runtime }),
        /different append operation/i,
      );
      assert.equal((await persistence.sessions.load(sessionId, tenantA)).length, 1);
      assert.equal((await persistence.sessions.load(sessionId, tenantB)).length, 0);
      assert.equal(await persistence.sessions.append(
        sessionId, 0,
        [{ type: "user/input", turnId: "tenant-b-turn", payload: { content: "tenant B", source: "test" } }],
        "tenant-b-input", { security: tenantB, runtime },
      ), 1);
      assert.equal((await persistence.sessions.load(sessionId, tenantB)).length, 1);
      await assert.rejects(
        persistence.sessions.append(
          sessionId,
          1,
          [{ type: "user/input", turnId: "cross-turn", payload: { content: "cross tenant", source: "test" } }],
          "cross-tenant",
          { security: security(tenantA.tenantId, `other-${suffix}`), runtime },
        ),
        /owner boundary|unavailable/i,
      );

      const leaseSessionId = `lease-${suffix}`;
      const startEvents = (turnId: string, key: string) => [
        { type: "turn/start", turnId, payload: { inputIdempotencyKey: key } },
        { type: "user/input", turnId, payload: { content: key, source: "external" } },
      ] as const;
      const contenders = await Promise.all([
        persistence.sessions.claimTurn({
          sessionId: leaseSessionId, turnId: `turn-a-${suffix}`, ownerId: "worker-a",
          idempotencyKey: "lease-a", requestFingerprint: "fingerprint-a", leaseTtlMs: 5_000,
          startEvents: startEvents(`turn-a-${suffix}`, "lease-a"),
        }, { security: tenantA, runtime }),
        persistence.sessions.claimTurn({
          sessionId: leaseSessionId, turnId: `turn-b-${suffix}`, ownerId: "worker-b",
          idempotencyKey: "lease-b", requestFingerprint: "fingerprint-b", leaseTtlMs: 5_000,
          startEvents: startEvents(`turn-b-${suffix}`, "lease-b"),
        }, { security: tenantA, runtime }),
      ]);
      assert.equal(contenders.filter((claim) => claim.kind === "acquired").length, 1);
      assert.equal(contenders.filter((claim) => claim.kind === "in-progress").length, 1);
      const winner = contenders.find((claim) => claim.kind === "acquired");
      if (!winner || winner.kind !== "acquired") throw new Error("missing lease winner");
      await persistence.sessions.finishTurn(
        winner.lease,
        winner.seq,
        { type: "turn/end", turnId: winner.lease.turnId, payload: { status: "completed" } },
        { security: tenantA, runtime },
      );
      await assert.rejects(
        persistence.sessions.claimTurn({
          sessionId: leaseSessionId, turnId: `turn-mismatch-${suffix}`, ownerId: "worker-c",
          idempotencyKey: winner.lease.turnId.includes("turn-a") ? "lease-a" : "lease-b",
          requestFingerprint: "different-fingerprint", leaseTtlMs: 5_000,
          startEvents: startEvents(`turn-mismatch-${suffix}`, "mismatch"),
        }, { security: tenantA, runtime }),
        /different request/i,
      );
      const profileSessionId = `profile-${suffix}`;
      const profileTurnId = `profile-read-${suffix}`;
      const profileClaim = await persistence.sessions.claimTurn({
        sessionId: profileSessionId, turnId: profileTurnId, ownerId: "profile-worker",
        idempotencyKey: "profile-read", requestFingerprint: "profile-read", agentProfileId: "read", leaseTtlMs: 5_000,
        startEvents: startEvents(profileTurnId, "profile-read"),
      }, { security: tenantA, runtime });
      assert.equal(profileClaim.kind, "acquired");
      if (profileClaim.kind !== "acquired") throw new Error("missing profile lease");
      await persistence.sessions.finishTurn(profileClaim.lease, profileClaim.seq,
        { type: "turn/end", turnId: profileTurnId, payload: { status: "completed" } }, { security: tenantA, runtime });
      await assert.rejects(persistence.sessions.claimTurn({
        sessionId: profileSessionId, turnId: `profile-write-${suffix}`, ownerId: "profile-worker",
        idempotencyKey: "profile-write", requestFingerprint: "profile-write", agentProfileId: "write", leaseTtlMs: 5_000,
        startEvents: startEvents(`profile-write-${suffix}`, "profile-write"),
      }, { security: tenantA, runtime }), /different agent profile/i);
      const sameTenantOtherActor = security(tenantA.tenantId, `other-${suffix}`);
      await assert.rejects(
        persistence.sessions.claimTurn({
          sessionId: leaseSessionId, turnId: `unauthorized-${suffix}`, ownerId: "worker-other",
          idempotencyKey: "unauthorized", requestFingerprint: "unauthorized", leaseTtlMs: 5_000,
          startEvents: startEvents(`unauthorized-${suffix}`, "unauthorized"),
        }, { security: sameTenantOtherActor, runtime }),
        /owner boundary|unavailable|denied/i,
      );

      const recoverySessionId = `recovery-${suffix}`;
      const expiring = await persistence.sessions.claimTurn({
        sessionId: recoverySessionId, turnId: `expired-${suffix}`, ownerId: "old-worker",
        idempotencyKey: "expired-key", requestFingerprint: "expired-fingerprint", leaseTtlMs: 5,
        startEvents: startEvents(`expired-${suffix}`, "expired-key"),
      }, { security: tenantA, runtime });
      assert.equal(expiring.kind, "acquired");
      if (expiring.kind !== "acquired") throw new Error("missing expiring lease");
      await new Promise((resolve) => setTimeout(resolve, 15));
      const recovered = await persistence.sessions.claimTurn({
        sessionId: recoverySessionId, turnId: `recovered-${suffix}`, ownerId: "new-worker",
        idempotencyKey: "recovered-key", requestFingerprint: "recovered-fingerprint", leaseTtlMs: 5_000,
        startEvents: startEvents(`recovered-${suffix}`, "recovered-key"),
      }, { security: tenantA, runtime });
      assert.equal(recovered.kind, "acquired");
      await assert.rejects(
        persistence.sessions.appendLeased(expiring.lease, expiring.seq, [
          { type: "assistant/message", turnId: expiring.lease.turnId, stepId: "stale-step", requestId: "stale-request", payload: { content: "stale" } },
        ], "stale-write", { security: tenantA, runtime }),
        /lease lost|expired/i,
      );
      const recoveryEvents = await persistence.sessions.load(recoverySessionId, tenantA);
      assert.equal(recoveryEvents.filter((event) => event.type === "turn/failed" && event.turnId === expiring.lease.turnId).length, 1);

      const toolRecoverySessionId = `tool-recovery-${suffix}`;
      const toolTurnId = `tool-expired-${suffix}`;
      const toolStepId = `tool-step-${suffix}`;
      const toolLease = await persistence.sessions.claimTurn({
        sessionId: toolRecoverySessionId, turnId: toolTurnId, ownerId: "tool-worker-old",
        idempotencyKey: "tool-expired-key", requestFingerprint: "tool-expired-fingerprint", leaseTtlMs: 10,
        startEvents: startEvents(toolTurnId, "tool-expired-key"),
      }, { security: tenantA, runtime });
      assert.equal(toolLease.kind, "acquired");
      if (toolLease.kind !== "acquired") throw new Error("missing tool recovery lease");
      const toolSeq = await persistence.sessions.appendLeased(toolLease.lease, toolLease.seq, [
        { type: "assistant/message", turnId: toolTurnId, stepId: toolStepId, requestId: `tool-request-${suffix}`, payload: {
          content: null, toolCalls: [
            { id: "tool-uncertain", name: "one", arguments: "{}" },
            { id: "tool-not-started", name: "two", arguments: "{}" },
          ],
        } },
        { type: "tool/intent", turnId: toolTurnId, stepId: toolStepId, callId: "tool-uncertain", payload: {
          callId: "tool-uncertain", executionId: "execution-uncertain", toolId: "one", arguments: "{}", sideEffect: "none", state: "prepared",
        } },
        { type: "tool/state", turnId: toolTurnId, stepId: toolStepId, callId: "tool-uncertain", payload: {
          callId: "tool-uncertain", executionId: "execution-uncertain", toolId: "one", state: "running",
        } },
        { type: "tool/intent", turnId: toolTurnId, stepId: toolStepId, callId: "tool-not-started", payload: {
          callId: "tool-not-started", executionId: "execution-not-started", toolId: "two", arguments: "{}", sideEffect: "none", state: "prepared",
        } },
      ], `tool-recovery-events-${suffix}`, { security: tenantA, runtime });
      assert.equal(toolSeq, toolLease.seq + 4);
      await new Promise((resolve) => setTimeout(resolve, 15));
      const toolRecovered = await persistence.sessions.claimTurn({
        sessionId: toolRecoverySessionId, turnId: `tool-new-${suffix}`, ownerId: "tool-worker-new",
        idempotencyKey: "tool-new-key", requestFingerprint: "tool-new-fingerprint", leaseTtlMs: 5_000,
        startEvents: startEvents(`tool-new-${suffix}`, "tool-new-key"),
      }, { security: tenantA, runtime });
      assert.equal(toolRecovered.kind, "acquired");
      const balanced = (await persistence.sessions.load(toolRecoverySessionId, tenantA)).filter((event) =>
        event.type === "tool/result" && event.turnId === toolTurnId);
      assert.deepEqual(balanced.map((event) => (event.payload as Record<string, unknown>).state), ["outcome_unknown", "not_started"]);
      assert.deepEqual(balanced.map((event) => (event.payload as Record<string, unknown>).dispatched), [true, false]);
      if (toolRecovered.kind === "acquired") {
        await persistence.sessions.finishTurn(toolRecovered.lease, toolRecovered.seq, {
          type: "turn/end", turnId: toolRecovered.lease.turnId, payload: { status: "completed" },
        }, { security: tenantA, runtime });
      }

      const memory = await persistence.memory.propose(
        {
          scope: { tenantId: tenantA.tenantId, type: "actor", id: tenantA.actorId },
          kind: "semantic",
          content: "The actor prefers concise answers",
          format: "text",
          classification: "internal",
          sourceRef: `session:${sessionId}`,
          authority: "user-stated",
        },
        tenantA,
      );
      const found = await persistence.memory.search(
        {
          text: "concise answers",
          scopes: [{ tenantId: tenantA.tenantId, type: "actor", id: tenantA.actorId }],
          limit: 5,
        },
        tenantA,
      );
      assert.equal(found.records[0]?.id, memory.id);
      await assert.rejects(
        persistence.memory.search(
          {
            text: "concise",
            scopes: [{ tenantId: tenantA.tenantId, type: "actor", id: tenantA.actorId }],
            limit: 5,
          },
          tenantB,
        ),
        /tenant boundary/i,
      );
      assert.equal(await persistence.memory.forget(memory.id, tenantA), true);
      assert.equal(
        (
          await persistence.memory.search(
            {
              text: "concise answers",
              scopes: [{ tenantId: tenantA.tenantId, type: "actor", id: tenantA.actorId }],
              limit: 5,
            },
            tenantA,
          )
        ).records.length,
        0,
      );

      const direct = new Pool({ connectionString: appUrl, max: 1 });
      try {
        const withoutTenantContext = await direct.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM agentic.session_event",
        );
        assert.equal(withoutTenantContext.rows[0]?.count, "0");
        await assert.rejects(
          direct.query("UPDATE agentic.session_event SET type = 'tampered'"),
          /permission denied/i,
        );
        await assert.rejects(
          direct.query("UPDATE agentic.memory_revision SET content = 'tampered'"),
          /permission denied/i,
        );
        await assert.rejects(
          direct.query("SELECT * FROM agentic.schema_migration"),
          /permission denied/i,
        );
        await direct.query("BEGIN");
        try {
          await direct.query(
            "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true), set_config('app.purpose', 'direct-owner-test', true)",
            [tenantA.tenantId, sameTenantOtherActor.actorId],
          );
          const hidden = await direct.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM agentic.session_event WHERE session_id = $1",
            [leaseSessionId],
          );
          assert.equal(hidden.rows[0]?.count, "0");
        } finally {
          await direct.query("ROLLBACK");
        }
      } finally {
        await direct.end();
      }
    } finally {
      await persistence.close();
    }
  },
);

test(
  "PostgreSQL loadSince reads forward from a sequence, and a stale append is a typed conflict",
  { skip: !appUrl || !ownerUrl },
  async () => {
    if (!appUrl || !ownerUrl) return;
    await provision(ownerUrl);
    const persistence = await createPostgresPersistence(appUrl);
    const suffix = crypto.randomUUID();
    const owner = security(`since-tenant-${suffix}`, `since-user-${suffix}`);
    const sessionId = `since-session-${suffix}`;
    try {
      const drafts = [1, 2, 3, 4, 5].map((index) => ({
        type: "user/input", turnId: `since-turn-${index}`, payload: { content: `message ${index}`, source: "test" },
      }));
      assert.equal(await persistence.sessions.append(sessionId, 0, drafts, "since-seed", { security: owner, runtime }), 5);
      assert.deepEqual((await persistence.sessions.loadSince(sessionId, 2, owner, 10)).map((event) => event.seq), [3, 4, 5]);
      assert.deepEqual((await persistence.sessions.loadSince(sessionId, 0, owner, 2)).map((event) => event.seq), [1, 2]);
      assert.deepEqual(await persistence.sessions.loadSince(sessionId, 5, owner, 10), []);
      assert.deepEqual(await persistence.sessions.loadSince(sessionId, 0, security(owner.tenantId, `other-${suffix}`), 10), [],
        "row-level security hides the session from another actor of the same tenant");
      await assert.rejects(persistence.sessions.loadSince(sessionId, 0, owner, 1_001), /limit must be from 1 to 1000/u);
      await assert.rejects(persistence.sessions.loadSince(sessionId, -1, owner, 10), /afterSeq/u);
      await assert.rejects(
        persistence.sessions.append(sessionId, 3, [{ type: "user/input", turnId: "stale", payload: { content: "stale", source: "test" } }], "since-stale", { security: owner, runtime }),
        (error: unknown) => error instanceof AgenticError && error.code === "conflict" && /expected 3, actual 5/u.test(error.message),
        "a lost race is a conflict the caller can classify, not an anonymous Error",
      );
    } finally {
      await persistence.close();
    }
  },
);

test(
  "PostgreSQL protects session payloads and memory content while blind-index search remains tenant scoped",
  { skip: !appUrl || !ownerUrl },
  async () => {
    if (!appUrl || !ownerUrl) return;
    await provision(ownerUrl);
    const protector = new AesGcmEnvelopeProtector(new DerivedTenantKeyProvider(Buffer.alloc(32, 19), "integration-v1"));
    const persistence = await createPostgresPersistence(appUrl, { payloadProtector: protector, blindIndex: protector });
    const suffix = crypto.randomUUID();
    const tenant = security(`protected-tenant-${suffix}`, `protected-user-${suffix}`);
    const sessionId = `protected-session-${suffix}`;
    const secret = `private-memory-${suffix}`;
    try {
      await persistence.sessions.append(
        sessionId, 0,
        [{ type: "user/input", turnId: `protected-turn-${suffix}`, classification: "confidential", payload: { content: secret, source: "test" } }],
        "protected-input", { security: tenant, runtime },
      );
      const loaded = await persistence.sessions.load(sessionId, tenant);
      assert.equal((loaded[0]?.payload as Record<string, unknown>).content, secret);

      const memory = await persistence.memory.propose({
        scope: { tenantId: tenant.tenantId, type: "actor", id: tenant.actorId },
        kind: "semantic", content: `remember ${secret}`, format: "text", classification: "restricted",
        sourceRef: `session:${sessionId}`, authority: "user-stated",
      }, tenant);
      const found = await persistence.memory.search({
        text: secret, scopes: [memory.scope], limit: 5,
      }, tenant);
      assert.equal(found.records[0]?.content, `remember ${secret}`);

      const direct = new Pool({ connectionString: appUrl, max: 1 });
      try {
        await direct.query("BEGIN");
        await direct.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true), set_config('app.purpose', 'protected-storage-test', true)",
          [tenant.tenantId, tenant.actorId],
        );
        const event = await direct.query<{ payload: Record<string, unknown> }>(
          "SELECT payload FROM agentic.session_event WHERE session_id = $1 ORDER BY seq LIMIT 1", [sessionId],
        );
        assert.equal(event.rows[0]?.payload._protected, "gateway-envelope-v1");
        assert.equal(JSON.stringify(event.rows[0]?.payload).includes(secret), false);
        const revision = await direct.query<{ content: string; protected_content: Record<string, unknown>; search_tokens: string[] }>(
          "SELECT content, protected_content, search_tokens FROM agentic.memory_revision WHERE memory_id = $1 AND revision = 1", [memory.id],
        );
        assert.equal(revision.rows[0]?.content, "");
        assert.equal(revision.rows[0]?.protected_content._protected, "gateway-envelope-v1");
        assert.ok((revision.rows[0]?.search_tokens.length ?? 0) > 0);
        assert.equal(JSON.stringify(revision.rows[0]).includes(secret), false);
        await direct.query("ROLLBACK");
      } finally {
        await direct.end();
      }
    } finally {
      await persistence.close();
    }
  },
);
