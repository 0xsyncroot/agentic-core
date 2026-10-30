import assert from "node:assert/strict";
import { test } from "node:test";
import type { SecurityContext, TurnAdmissionRequest } from "@0xsyncroot/contracts";
import { RedisTurnAdmissionController } from "../src/redis-turn-admission.js";
import type { AdmissionOutcome, AdmissionSlotInput, RedisAdmissionBus } from "../src/redis-admission-bus.js";

/**
 * A quota is only a quota if every replica counts against the same number.
 *
 * These drive two controllers over one store, the way two API pods do, and move the clock by
 * hand — the expiry path is the one that matters most and the one a real Redis would make
 * untestable without sleeping through it.
 */

/** Sorted-set semantics with a clock the test owns, which is all the Lua actually depends on. */
class FakeAdmissionStore implements RedisAdmissionBus {
  readonly productionSafe = true;
  readonly sets = new Map<string, Map<string, number>>();
  now = 1_000_000;
  failures = 0;

  async admit(input: AdmissionSlotInput): Promise<AdmissionOutcome> {
    if (this.failures > 0) { this.failures -= 1; throw new Error("Redis unavailable"); }
    const active = this.#sweep(input.activeKey, this.now);
    const held = active.has(input.member);
    if (!held && active.size >= input.concurrencyLimit) return { admitted: false, reason: "concurrency", active: active.size };
    if (input.rateLimit > 0) {
      const rate = this.#sweep(input.rateKey, this.now - input.rateWindowMs);
      if (!held && rate.size >= input.rateLimit) return { admitted: false, reason: "rate", active: active.size };
      if (!held) rate.set(input.member, this.now);
    }
    active.set(input.member, this.now + input.ttlMs);
    return { admitted: true, active: active.size };
  }

  async renew(input: { activeKey: string; member: string; ttlMs: number }): Promise<boolean> {
    const active = this.#sweep(input.activeKey, this.now);
    if (!active.has(input.member)) return false;
    active.set(input.member, this.now + input.ttlMs);
    return true;
  }

  async release(input: { activeKey: string; member: string }): Promise<void> {
    this.sets.get(input.activeKey)?.delete(input.member);
  }

  async close(): Promise<void> { this.sets.clear(); }

  activeCount(): number {
    return [...this.sets].filter(([key]) => key.includes(":active:")).reduce((total, [, members]) => total + members.size, 0);
  }

  #sweep(key: string, cutoff: number): Map<string, number> {
    const members = this.sets.get(key) ?? new Map<string, number>();
    for (const [member, expiry] of members) if (expiry <= cutoff) members.delete(member);
    this.sets.set(key, members);
    return members;
  }
}

function request(tenantId: string, idempotencyKey: string, sessionId = "session-a"): TurnAdmissionRequest {
  return {
    security: { tenantId, actorId: "actor-a", permissions: new Set(["*"]) } as unknown as SecurityContext,
    sessionId, idempotencyKey, agentProfileId: "sample-app-payroll",
  };
}

test("one tenant quota holds across replicas, not per replica", async () => {
  const store = new FakeAdmissionStore();
  const options = { maxConcurrentPerTenant: 2, leaseTtlMs: 60_000, renewIntervalMs: 20_000 };
  // Two controllers, one store: this is two API pods, and the in-memory controller would have
  // granted each of them the full limit.
  const podA = new RedisTurnAdmissionController(store, options);
  const podB = new RedisTurnAdmissionController(store, options);

  const first = await podA.acquire(request("acme", "turn-1"));
  await podB.acquire(request("acme", "turn-2"));
  await assert.rejects(() => podA.acquire(request("acme", "turn-3")), /Concurrent turn quota exceeded/u);

  // Another tenant is unaffected: the limit is per tenant, not global.
  await podB.acquire(request("globex", "turn-4"));

  await first.settle({ outcome: "completed" });
  const third = await podA.acquire(request("acme", "turn-3"));
  assert.ok(third.admissionId);
  await podA.close();
  await podB.close();
});

test("a retry of the same turn re-enters its own slot", async () => {
  const store = new FakeAdmissionStore();
  const admission = new RedisTurnAdmissionController(store, { maxConcurrentPerTenant: 1 });
  await admission.acquire(request("acme", "turn-1"));

  // A dropped connection and a client retry is the same turn, and it must not pay twice.
  // With a random member a retry storm would spend the tenant's whole quota on one turn.
  const retry = await admission.acquire(request("acme", "turn-1"));
  assert.equal(store.activeCount(), 1);
  assert.ok(retry.admissionId);

  await assert.rejects(() => admission.acquire(request("acme", "turn-2")), /Concurrent turn quota exceeded/u);
  await admission.close();
});

test("a replica that dies mid-turn gives the slot back on its own", async () => {
  const store = new FakeAdmissionStore();
  const admission = new RedisTurnAdmissionController(store, { maxConcurrentPerTenant: 1, leaseTtlMs: 30_000, renewIntervalMs: 10_000 });
  await admission.acquire(request("acme", "turn-1"));
  await assert.rejects(() => admission.acquire(request("acme", "turn-2")), /Concurrent turn quota exceeded/u);

  // Nothing settled and nothing renewed — the shape of a pod that was killed. The tenant must
  // not lose capacity until an operator notices.
  store.now += 31_000;
  const next = await admission.acquire(request("acme", "turn-2"));
  assert.ok(next.admissionId);
  await admission.close();
});

test("a long turn keeps its slot while it is still alive", async () => {
  const store = new FakeAdmissionStore();
  const admission = new RedisTurnAdmissionController(store, { maxConcurrentPerTenant: 1, leaseTtlMs: 5_000, renewIntervalMs: 1_000 });
  const lease = await admission.acquire(request("acme", "turn-1"));

  // One model call can legitimately outlast the TTL; the heartbeat is what stops a second
  // turn slipping in while the first is still running.
  store.now += 4_000;
  assert.equal(await store.renew({ activeKey: [...store.sets.keys()][0]!, member: lease.admissionId, ttlMs: 5_000 }), true);
  store.now += 4_000;
  await assert.rejects(() => admission.acquire(request("acme", "turn-2")), /Concurrent turn quota exceeded/u);
  await lease.settle({ outcome: "completed" });
  await admission.close();
});

test("the rate gate counts starts per window, and is off unless configured", async () => {
  const store = new FakeAdmissionStore();
  const limited = new RedisTurnAdmissionController(store, {
    maxConcurrentPerTenant: 10, maxTurnsPerWindowPerTenant: 2, rateWindowMs: 60_000,
  });
  const first = await limited.acquire(request("acme", "turn-1"));
  const second = await limited.acquire(request("acme", "turn-2"));
  await first.settle({ outcome: "completed" });
  await second.settle({ outcome: "completed" });

  // Concurrency is free again, but the window is not: a client cannot burn quota by finishing
  // quickly and starting again.
  await assert.rejects(() => limited.acquire(request("acme", "turn-3")), /Turn rate quota exceeded/u);
  store.now += 61_000;
  assert.ok((await limited.acquire(request("acme", "turn-3"))).admissionId);
  await limited.close();
});

test("admission fails closed when its quota store cannot answer", async () => {
  const store = new FakeAdmissionStore();
  const admission = new RedisTurnAdmissionController(store, { maxConcurrentPerTenant: 1 });
  store.failures = 1;

  // Failing open would remove every tenant's limit at exactly the moment the system is under
  // the pressure the limit exists for. Retryable, because the caller may try again.
  await assert.rejects(() => admission.acquire(request("acme", "turn-1")), (error: Error & { code?: string }) => {
    assert.equal(error.code, "transient");
    assert.match(error.message, /could not reach its quota store/u);
    return true;
  });
  assert.ok((await admission.acquire(request("acme", "turn-1"))).admissionId, "and recovers once the store is back");
  await admission.close();
});

test("the controller is production-safe only when its store is", async () => {
  const store = new FakeAdmissionStore();
  assert.equal(new RedisTurnAdmissionController(store, { maxConcurrentPerTenant: 1 }).productionSafe, true);
  // A single-process store cannot make a cross-replica promise, and must not claim to.
  const local = new RedisTurnAdmissionController({ ...store, productionSafe: false } as RedisAdmissionBus, { maxConcurrentPerTenant: 1 });
  assert.equal(local.productionSafe, false);

  assert.throws(() => new RedisTurnAdmissionController(store, { maxConcurrentPerTenant: 1, leaseTtlMs: 10_000, renewIntervalMs: 9_000 }),
    /renewIntervalMs must be less than half/u, "a heartbeat slower than the TTL is not a heartbeat");
  assert.throws(() => new RedisTurnAdmissionController(store, { maxConcurrentPerTenant: 0 }), /maxConcurrentPerTenant is invalid/u);
});
