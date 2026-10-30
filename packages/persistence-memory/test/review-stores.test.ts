import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemoryAdminPrincipalStore, InMemoryCatalogStore, InMemoryReviewStore, InMemorySessionStore, InMemoryShardDirectory, InMemoryUsageStore, InMemoryWorkerLeaseStore,
} from "@0xsyncroot/persistence-memory";
import { catalogStoreConformance } from "../../contracts/test/catalog-store-conformance.js";
import { controlPlaneConformance } from "../../contracts/test/control-plane-conformance.js";
import { reviewStoreConformance } from "../../contracts/test/review-store-conformance.js";
import { usageStoreConformance } from "../../contracts/test/usage-store-conformance.js";

const DAY_MS = 86_400_000;

/** Leases on a clock the test can move forward, so `expire` ends a lease the way time would. */
function movableLeases() {
  let offset = 0;
  return { leases: new InMemoryWorkerLeaseStore(() => Date.now() + offset), expire: async () => { offset += DAY_MS; } };
}

reviewStoreConformance("in-memory", async () => {
  const sessions = new InMemorySessionStore();
  const { leases, expire } = movableLeases();
  const names = new Map<string, string>();
  const review = new InMemoryReviewStore({ leases, tenantNames: names });
  return {
    sessions, journal: sessions.reviewJournal(), projection: review, query: review, leases, expire,
    profile: async (tenantId, displayName) => { names.set(tenantId, displayName); },
    accessLog: async (tenantId) => review.accessLog(tenantId),
  };
});

usageStoreConformance("in-memory", async () => {
  const leases = new InMemoryWorkerLeaseStore();
  const usage = new InMemoryUsageStore({ leases });
  return {
    projection: usage, query: usage, leases, daily: (tenantId, agentId, day) => usage.dailyGroups(tenantId, agentId, day),
    ending: async (tenantId, sessionId, turnId) => {
      const stored = await usage.turnFact(tenantId, sessionId, turnId);
      if (!stored) return undefined;
      const { status, endedAt, responseMs, firstOutputMs } = stored;
      return { status, ...(endedAt === undefined ? {} : { endedAt }), ...(responseMs === undefined ? {} : { responseMs }), ...(firstOutputMs === undefined ? {} : { firstOutputMs }) };
    },
  };
});

controlPlaneConformance("in-memory", async () => {
  const { leases, expire } = movableLeases();
  const principals = new InMemoryAdminPrincipalStore();
  return { leases, principals, expire, auditOf: async (principalId) => principals.auditLog().filter((row) => row.principalId === principalId) };
});

catalogStoreConformance("in-memory", async () => {
  const catalog = new InMemoryCatalogStore();
  return { editor: catalog, builds: catalog, reader: catalog };
});

test("in-memory shard routing: the default shard alone until shards are given, then those in id order with their routes", async () => {
  const empty = new InMemoryShardDirectory();
  assert.deepEqual(await empty.shards(), [{ shardId: "s0", status: "active", weight: 100 }]);
  assert.equal(await empty.shardOf("tenant-a"), "s0");
  assert.equal(await empty.mapVersion(), 0);
  const routed = new InMemoryShardDirectory({
    shards: [{ shardId: "s2", dsnRef: "secret-2", status: "active", weight: 50 }, { shardId: "s1", dsnRef: "secret-1", status: "draining", weight: 10 }],
    routes: new Map([["tenant-a", "s2"]]), mapVersion: 3,
  });
  assert.deepEqual((await routed.shards()).map((entry) => entry.shardId), ["s1", "s2"]);
  assert.equal(await routed.shardOf("tenant-a"), "s2");
  assert.equal(await routed.shardOf("tenant-b"), "s0");
  assert.equal(await routed.mapVersion(), 3);
  await assert.rejects(routed.shardOf(""), (error: { code?: string }) => error.code === "validation");
});

test("in-memory append stamps strictly increase, so streams appended in the same millisecond keep their order", async () => {
  const sessions = new InMemorySessionStore();
  const security = { tenantId: "tenant-stamp", actorId: "actor", permissions: new Set(["*"]), correlationId: "c", purpose: "test" };
  const runtime = { id: "r", coreVersion: "1.0.0", pluginSetId: "p", policyRevision: "t", memoryPolicyRevision: "t", createdAt: new Date().toISOString() };
  for (let index = 0; index < 20; index += 1) {
    await sessions.append(`s-${index}`, 0, [{ type: "user/input", turnId: "t", payload: { content: "x", source: "test" } }], `k-${index}`, { security, runtime });
  }
  const changed = await sessions.reviewJournal().changedSince(new Date(Date.now() - 60_000).toISOString(), 1000);
  const stamps = changed.filter((item) => item.tenantId === "tenant-stamp").map((item) => item.lastAppendedAt);
  assert.equal(stamps.length, 20);
  for (let index = 1; index < stamps.length; index += 1) assert.ok(stamps[index - 1]! < stamps[index]!);
  assert.deepEqual(changed.map((item) => item.sessionId), Array.from({ length: 20 }, (_, index) => `s-${index}`));
});
