import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createClient, type RedisClientType } from "redis";
import { RedisActorSettingStore, actorSettingsKey } from "../src/index.js";
import { actorSettingConformance } from "../../contracts/test/actor-setting-store-conformance.js";
import { redisServerAvailable, startThrowawayRedis, type ThrowawayRedis } from "./redis-server.js";

describe("redis actor setting store", { skip: redisServerAvailable() ? false : "redis-server is not installed; the Redis actor setting cases were skipped" }, () => {
  let server: ThrowawayRedis; let client: RedisClientType;
  before(async () => {
    server = await startThrowawayRedis();
    client = createClient({ url: server.url });
    await client.connect();
  });
  after(async () => { if (client?.isOpen) client.destroy(); await server?.stop(); });

  actorSettingConformance("redis", () => new RedisActorSettingStore(client));

  test("a setting is durable: its key carries the session prefix and no expiry", async () => {
    const store = new RedisActorSettingStore(client, { keyPrefix: "env-a:" });
    await store.put({ tenantId: "tenant", actorId: "actor" }, "approval-mode", "standing");
    const key = actorSettingsKey("env-a:", "tenant", "actor");
    assert.equal(await client.ttl(key), -1, "no ttl");
    assert.equal(await new RedisActorSettingStore(client, { keyPrefix: "env-b:" }).get({ tenantId: "tenant", actorId: "actor" }, "approval-mode"), undefined,
      "another prefix is another environment");
  });
});
