import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createClient, type RedisClientType } from "redis";
import { InMemorySessionStore } from "@0xsyncroot/persistence-memory";
import { RedisSessionStore, sessionKeys } from "../src/index.js";
import { checkpoint, conformance, input, runtime, security, sid } from "../../contracts/test/session-store-conformance.js";
import { redisServerAvailable, startThrowawayRedis, type ThrowawayRedis } from "./redis-server.js";

conformance("in-memory", () => new InMemorySessionStore());

test("a store that owns its connection refuses plaintext Redis unless the deployment allows it", async () => {
  // Formerly hard-wired to allow plaintext; now it follows REDIS_ALLOW_INSECURE_INTERNAL via the harness.
  await assert.rejects(RedisSessionStore.connect({ url: "redis://127.0.0.1:1/0" }), /Session Redis requires rediss:\/\//u);
  await assert.rejects(RedisSessionStore.connect({ url: "redis://127.0.0.1:1/0", allowInsecureInternal: false }), /requires rediss:\/\//u);
  await assert.rejects(RedisSessionStore.connect({ url: "redis://127.0.0.1:1/0", allowInsecureInternal: true, connectTimeoutMs: 250 }),
    /Could not connect the session store to Redis/u, "with consent the URL passes the check and only the connection fails");
});

describe("redis session store", { skip: redisServerAvailable() ? false : "redis-server is not installed; the Redis half of the conformance suite was skipped" }, () => {
  let server: ThrowawayRedis; let client: RedisClientType;
  before(async () => {
    server = await startThrowawayRedis();
    client = createClient({ url: server.url });
    await client.connect();
  });
  after(async () => { if (client?.isOpen) client.destroy(); await server?.stop(); });

  conformance("redis", () => new RedisSessionStore(client));

  test("every key of a session carries the idle ttl, and idempotency records expire sooner", async () => {
    const store = new RedisSessionStore(client, { keyPrefix: "ttl:", sessionTtlSeconds: 1_000, idempotencyTtlSeconds: 100 });
    const who = security("tenant-ttl", "u"); const id = sid();
    const claimed = await store.claimTurn({ sessionId: id, turnId: "t", ownerId: "w", idempotencyKey: "r", requestFingerprint: "f", leaseTtlMs: 5_000, startEvents: [input(1, "t")] }, { security: who, runtime });
    assert.equal(claimed.kind, "acquired");
    if (claimed.kind !== "acquired") return;
    await store.appendLeased(claimed.lease, 1, [checkpoint("s", 1, "t")], "cp", { security: who, runtime });
    const keys = sessionKeys("ttl:", "tenant-ttl", id);
    for (const key of [keys.meta, keys.events, keys.turns, keys.ckpt]) {
      const ttl = await client.ttl(key);
      assert.ok(ttl > 900 && ttl <= 1_000, `${key} ttl ${ttl}`);
    }
    const idem = await client.ttl(keys.idem);
    assert.ok(idem > 0 && idem <= 100, `idempotency ttl ${idem}`);
    assert.ok((await client.ttl(`ttl:{tenant-ttl|u}:dir`)) > 900);
    await client.pExpire(keys.meta, 1_000_000);
    await store.renewTurn(claimed.lease, 5_000, who);
    assert.ok(await client.ttl(keys.meta) <= 1_000 && await client.ttl(keys.meta) > 900, "a renewal refreshes the idle ttl");
  });

  test("concurrent appends with the same expectedSeq: exactly one wins", async () => {
    const store = new RedisSessionStore(client); const who = security("tenant-race", "u"); const id = sid();
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => store.append(id, 0, [input(i)], `race-${i}`, { security: who, runtime })));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await store.load(id, who)).length, 1);
  });

  test("ids containing braces or colons cannot collide or escape the hash tag", async () => {
    const store = new RedisSessionStore(client); const who = security("t:{x}", "u");
    await store.append("a:b", 0, [input(1)], "k", { security: who, runtime });
    await store.append("a", 0, [input(2), input(3)], "k", { security: who, runtime });
    assert.equal((await store.load("a:b", who)).length, 1);
    assert.equal((await store.load("a", who)).length, 2);
  });
});
