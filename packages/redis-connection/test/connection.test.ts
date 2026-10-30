import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { connectRedis, type RedisConnection } from "../src/index.js";
import { startThrowawayCluster, startThrowawaySentinel, topologyTest, topologyUnavailable, type ThrowawayTopology } from "./topology-servers.js";

const skip = topologyUnavailable();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function suite(name: string, mode: "cluster" | "sentinel", start: () => Promise<ThrowawayTopology>): void {
  describe(`redis connection over ${name}`, { skip: skip ?? false }, () => {
    let server: ThrowawayTopology; let connection: RedisConnection; const errors: Error[] = [];
    before(async () => {
      server = await start();
      connection = await connectRedis(server.url, { purpose: "Test", allowInsecureInternal: true, onError: (error) => errors.push(error) });
    });
    after(async () => { connection?.destroy(); await server?.stop(); });

    topologyTest("reports its mode and answers keyless commands", async () => {
      assert.equal(connection.mode, mode);
      assert.equal(connection.isOpen, true);
      await connection.commands.ping();
      assert.equal(typeof await connection.commands.publish("nobody-listens", "x"), "number");
    });

    topologyTest("keyed commands reach the owning node, with scripts by EVAL and EVALSHA", async () => {
      const { commands } = connection; const prefix = `t:${randomUUID()}`;
      for (let index = 0; index < 40; index += 1) {
        assert.equal(await commands.set(`${prefix}:${index}`, String(index), { PX: 60_000 }), "OK");
      }
      for (let index = 0; index < 40; index += 1) assert.equal(await commands.get(`${prefix}:${index}`), String(index));
      assert.equal(await commands.set(`${prefix}:nx`, "1", { NX: true, EX: 60 }), "OK");
      assert.equal(await commands.set(`${prefix}:nx`, "2", { NX: true, EX: 60 }), null);
      assert.equal(await commands.getDel(`${prefix}:nx`), "1");
      const script = "redis.call('RPUSH', KEYS[1], ARGV[1]); redis.call('RPUSH', KEYS[1], ARGV[2]); return redis.call('LRANGE', KEYS[1], 0, -1)";
      const key = `{${prefix}}:list`;
      assert.deepEqual(await commands.eval(script, { keys: [key], arguments: ["a", "b"] }), ["a", "b"]);
      assert.deepEqual(await commands.lRange(key, 0, -1), ["a", "b"]);
      await assert.rejects(commands.evalSha("0".repeat(40), { keys: [key], arguments: [] }), /NOSCRIPT/u);
      await commands.hGetAll(`{${prefix}}:h`);
    });

    topologyTest("publish on one connection reaches a subscriber connection", async () => {
      const subscriber = await connection.subscriber();
      const channel = `chan:${randomUUID()}`; const received: string[] = [];
      const listener = (message: string) => { received.push(message); };
      try {
        await subscriber.subscribe(channel, listener);
        const sender = await connectRedis(server.url, { purpose: "Test sender", allowInsecureInternal: true });
        try {
          for (let index = 0; index < 5; index += 1) assert.equal(await sender.commands.publish(channel, `m${index}`), 1, "the reply counts the subscribers, as the UI bridge relies on");
        } finally { sender.destroy(); }
        for (let waited = 0; received.length < 5 && waited < 3_000; waited += 25) await delay(25);
        assert.deepEqual(received, ["m0", "m1", "m2", "m3", "m4"]);
        await subscriber.unsubscribe(channel, listener);
      } finally { subscriber.destroy(); }
    });

    topologyTest("close lets queued commands finish; destroy leaves the connection closed", async () => {
      const own = await connectRedis(server.url, { purpose: "Test", allowInsecureInternal: true });
      const key = `t:{${randomUUID()}}:c`;
      const pending = own.commands.set(key, "v", { PX: 10_000 });
      await own.close();
      assert.equal(await pending, "OK");
      assert.equal(own.isOpen, false);
      own.destroy();
      assert.deepEqual(errors, []);
    });
  });
}

suite("a 3-master Redis Cluster", "cluster", startThrowawayCluster);
suite("Redis Sentinel", "sentinel", startThrowawaySentinel);

test("startThrowawayCluster returns only when every node itself reports cluster_state:ok", { skip: skip ?? false }, async () => {
  const cluster = await startThrowawayCluster();
  try {
    const nodes = cluster.url.replace("redis+cluster://", "").split(",");
    assert.equal(nodes.length, 3);
    // A node that is still starting answers CLUSTERDOWN to the first command; node-redis does not retry that.
    const states = nodes.map((node) => /cluster_state:(\w+)/u.exec(spawnSync("redis-cli", ["-p", node.split(":")[1] ?? "", "cluster", "info"], { encoding: "utf8" }).stdout)?.[1]);
    assert.deepEqual(states, ["ok", "ok", "ok"]);
  } finally { await cluster.stop(); }
});

test("an unreachable Redis fails within the connect timeout, and plaintext needs the explicit flag", async () => {
  const started = performance.now();
  await assert.rejects(connectRedis("redis+cluster://127.0.0.1:1", { purpose: "Test", allowInsecureInternal: true, connectTimeoutMs: 300 }),
    /did not connect within 300ms|root nodes are unavailable/u);
  assert.ok(performance.now() - started < 5_000);
  await assert.rejects(connectRedis("redis+sentinel://127.0.0.1:1/m", { purpose: "Test", allowInsecureInternal: false }), /Test Redis requires rediss/u);
});
