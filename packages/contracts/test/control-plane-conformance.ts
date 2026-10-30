import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AgenticError, type AdminPrincipalStore, type CatalogAuditRecord, type MemberRole, type WorkerLeaseStore } from "@0xsyncroot/contracts";

/** The worker lease and operator identity ports as executable cases; every engine runs them unchanged. */
export interface ControlPlaneEngine {
  readonly leases: WorkerLeaseStore;
  readonly principals: AdminPrincipalStore;
  /** Ends the named lease now, by the clock the store judges leases with. */
  expire(workerKind: string): Promise<void>;
  /** The audit rows attributed to the principal (its `principalId`), oldest first. */
  auditOf(principalId: string): Promise<readonly CatalogAuditRecord[]>;
  /** What an operator does when they disable a principal or one role; absent where the engine has no such writer. */
  disable?(principalId: string, role?: MemberRole): Promise<void>;
}

const unique = () => crypto.randomUUID();
const fails = (code: string) => (error: unknown) => error instanceof AgenticError && error.code === code;
const reader: MemberRole = { scopeKind: "platform", scopeId: "", role: "review.reader" };
const agentAdmin: MemberRole = { scopeKind: "agent", scopeId: "agent-a", role: "agent.admin" };
const sortRoles = (roles: readonly MemberRole[]) => [...roles].sort((a, b) => `${a.scopeKind}/${a.scopeId}/${a.role}`.localeCompare(`${b.scopeKind}/${b.scopeId}/${b.role}`));

export function controlPlaneConformance(name: string, make: () => Promise<ControlPlaneEngine>): void {
  describe(`${name} worker leases`, () => {
    test("one holder at a time; each acquisition, the holder's own included, gets a larger token", async () => {
      const { leases } = await make(); const kind = `kind-${unique()}`;
      const first = await leases.acquire(kind, "worker-1", 60_000);
      assert.ok(first);
      assert.equal(first.workerKind, kind); assert.equal(first.owner, "worker-1");
      assert.ok(Date.parse(first.expiresAt) > Date.now() + 30_000);
      assert.equal(await leases.acquire(kind, "worker-2", 60_000), undefined);
      const again = await leases.acquire(kind, "worker-1", 60_000);
      assert.ok(again && BigInt(again.fencingToken) > BigInt(first.fencingToken));
    });

    test("renew extends a current lease and refuses a stale token; release frees only the current one", async () => {
      const { leases } = await make(); const kind = `kind-${unique()}`;
      const first = (await leases.acquire(kind, "worker-1", 1_000))!;
      const renewed = await leases.renew(first, 60_000);
      assert.ok(renewed && renewed.fencingToken === first.fencingToken && renewed.expiresAt > first.expiresAt);
      const current = (await leases.acquire(kind, "worker-1", 60_000))!;
      assert.equal(await leases.renew(first, 60_000), undefined);
      await leases.release(first);
      assert.equal(await leases.acquire(kind, "worker-2", 60_000), undefined);
      await leases.release(current);
      const taken = await leases.acquire(kind, "worker-2", 60_000);
      assert.ok(taken && BigInt(taken.fencingToken) > BigInt(current.fencingToken));
    });

    test("an expired lease goes to the next worker and the old holder can no longer renew it", async () => {
      const engine = await make(); const kind = `kind-${unique()}`;
      const first = (await engine.leases.acquire(kind, "worker-1", 60_000))!;
      await engine.expire(kind);
      const second = await engine.leases.acquire(kind, "worker-2", 60_000);
      assert.ok(second && BigInt(second.fencingToken) > BigInt(first.fencingToken));
      assert.equal(await engine.leases.renew(first, 60_000), undefined);
    });

    test("a ttl or name out of range is refused as validation", async () => {
      const { leases } = await make();
      for (const ttl of [0, -1, 1.5, Number.NaN]) await assert.rejects(leases.acquire("kind", "worker", ttl), fails("validation"));
      await assert.rejects(leases.acquire("", "worker", 1_000), fails("validation"));
      await assert.rejects(leases.acquire("kind", "", 1_000), fails("validation"));
    });
  });

  describe(`${name} admin principals`, () => {
    const seedOf = () => ({ principalId: unique(), issuer: "config", subject: `subject-${unique()}`, displayName: "Operator" });

    test("ensureSeed creates an active principal with its roles once and audits what it created", async () => {
      const engine = await make(); const seed = seedOf();
      const created = await engine.principals.ensureSeed(seed, [reader, agentAdmin]);
      assert.deepEqual(created, { ...seed, status: "active" });
      assert.deepEqual(await engine.principals.get(seed.principalId), created);
      assert.deepEqual(sortRoles(await engine.principals.roles(seed.principalId)), sortRoles([reader, agentAdmin]));
      const audited = await engine.auditOf(seed.principalId);
      assert.deepEqual(audited.map((row) => row.action).sort(), ["member.grant", "member.grant", "principal.create"]);
      assert.ok(audited.every((row) => row.actorScope === "seed" && Number.isFinite(Date.parse(row.at))));
      assert.deepEqual(await engine.principals.ensureSeed(seed, [reader, agentAdmin]), created);
      assert.equal((await engine.auditOf(seed.principalId)).length, 3);
    });

    test("ensureSeed updates a changed display name and adds a missing role", async () => {
      const engine = await make(); const seed = seedOf();
      await engine.principals.ensureSeed(seed, [reader]);
      const renamed = await engine.principals.ensureSeed({ ...seed, displayName: "Renamed" }, [reader, agentAdmin]);
      assert.equal(renamed.displayName, "Renamed");
      assert.deepEqual(sortRoles(await engine.principals.roles(seed.principalId)), sortRoles([reader, agentAdmin]));
      assert.deepEqual((await engine.auditOf(seed.principalId)).map((row) => row.action).sort(), ["member.grant", "member.grant", "principal.create", "principal.update"]);
    });

    test("another principal id holding the issuer and subject, or the id under another identity, is a conflict", async () => {
      const engine = await make(); const seed = seedOf();
      await engine.principals.ensureSeed(seed, [reader]);
      await assert.rejects(engine.principals.ensureSeed({ ...seed, principalId: unique() }, [reader]), fails("conflict"));
      await assert.rejects(engine.principals.ensureSeed({ ...seed, subject: `subject-${unique()}` }, [reader]), fails("conflict"));
      assert.equal(await engine.principals.get(unique()), undefined);
      assert.deepEqual(await engine.principals.roles(unique()), []);
    });

    test("a principal or role an operator disabled stays disabled through the next seeding", async (context) => {
      const engine = await make();
      if (!engine.disable) { context.skip("this engine has no operator writer"); return; }
      const seed = seedOf();
      await engine.principals.ensureSeed(seed, [reader, agentAdmin]);
      await engine.disable(seed.principalId, agentAdmin);
      await engine.principals.ensureSeed(seed, [reader, agentAdmin]);
      assert.deepEqual(await engine.principals.roles(seed.principalId), [reader]);
      await engine.disable(seed.principalId);
      assert.equal((await engine.principals.ensureSeed(seed, [reader])).status, "disabled");
    });

    test("audit appends a row and returns a distinct id", async () => {
      const engine = await make(); const target = unique();
      const row: CatalogAuditRecord = { scopeKind: "platform", scopeId: "", principalId: target, actorScope: "console", action: "session.list", targetKind: "principal", targetId: target, detail: "{}", at: "2026-01-01T00:00:00.000001Z" };
      const ids = [await engine.principals.audit(row), await engine.principals.audit({ ...row, afterHash: "c".repeat(64) })];
      assert.equal(new Set(ids).size, 2);
      assert.deepEqual(await engine.auditOf(target), [row, { ...row, afterHash: "c".repeat(64) }]);
      await assert.rejects(engine.principals.audit({ ...row, at: "now" }), fails("validation"));
    });
  });
}
