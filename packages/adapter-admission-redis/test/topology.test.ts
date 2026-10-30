import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { SecurityContext, TurnAdmissionRequest } from "@0xsyncroot/contracts";
import { createNodeRedisAdmissionBus, RedisTurnAdmissionController } from "../src/index.js";
import {
  startThrowawayCluster, startThrowawaySentinel, topologyTest, topologyUnavailable, type ThrowawayTopology,
} from "../../redis-connection/test/topology-servers.js";

/** The quota is arithmetic inside one Lua script per tenant; on a Cluster it must still hold across replicas. */
function request(tenantId: string, idempotencyKey: string): TurnAdmissionRequest {
  return {
    security: { tenantId, actorId: "actor-a", permissions: new Set(["*"]) } as unknown as SecurityContext,
    sessionId: "session-a", idempotencyKey, agentProfileId: "profile",
  };
}

function suite(name: string, start: () => Promise<ThrowawayTopology>): void {
  describe(`distributed admission over ${name}`, { skip: topologyUnavailable() ?? false }, () => {
    let server: ThrowawayTopology;
    before(async () => { server = await start(); });
    after(async () => { await server?.stop(); });

    topologyTest("two replicas share one concurrency and rate count per tenant", async () => {
      const keyPrefix = `admission-${randomUUID().slice(0, 8)}`;
      const busA = await createNodeRedisAdmissionBus({ url: server.url, allowInsecureInternal: true });
      const busB = await createNodeRedisAdmissionBus({ url: server.url, allowInsecureInternal: true });
      const options = { maxConcurrentPerTenant: 2, maxTurnsPerWindowPerTenant: 3, keyPrefix };
      const podA = new RedisTurnAdmissionController(busA, options);
      const podB = new RedisTurnAdmissionController(busB, options);
      try {
        assert.equal(podA.productionSafe, true);
        // Several tenants, so their keys spread over the nodes of the cluster.
        for (const tenant of ["acme", "globex", "initech", "umbrella", "hooli"]) {
          const first = await podA.acquire(request(tenant, `${tenant}-1`));
          const second = await podB.acquire(request(tenant, `${tenant}-2`));
          await assert.rejects(() => podA.acquire(request(tenant, `${tenant}-3`)), /Concurrent turn quota exceeded/u);
          await first.settle({ outcome: "completed" });
          const third = await podB.acquire(request(tenant, `${tenant}-3`));
          await second.settle({ outcome: "completed" });
          await assert.rejects(() => podA.acquire(request(tenant, `${tenant}-4`)), /Turn rate quota exceeded/u);
          await third.settle({ outcome: "completed" });
        }
      } finally {
        await podA.close(); await podB.close(); await busA.close(); await busB.close();
      }
    });
  });
}

suite("a 3-master Redis Cluster", startThrowawayCluster);
suite("Redis Sentinel", startThrowawaySentinel);

test("admission refuses a plaintext Cluster or Sentinel URL unless the flag is set", async () => {
  for (const url of ["redis+cluster://127.0.0.1:1", "redis+sentinel://127.0.0.1:1/m"]) {
    await assert.rejects(createNodeRedisAdmissionBus({ url }), /Admission Redis requires rediss:\/\/ unless allowInsecureInternal/u);
  }
  await assert.rejects(createNodeRedisAdmissionBus({ url: "redis+cluster://", allowInsecureInternal: true }), /Admission Redis URL is invalid: .*Expected/u);
});
