import assert from "node:assert/strict";
import { test } from "node:test";
import { keepPoolWarm, warmSettings, type MySqlPersistenceEvent } from "../src/index.js";

/**
 * The keep-warm ping runs against a stand-in pool, because what needs pinning is what happens to
 * each connection and to the log, not what MySQL does: a connection that times out must be
 * destroyed, a failing tick must not escape the timer, and a down server must not fill the log.
 */

interface FakeConnection { readonly queries: unknown[]; released: number; destroyed: number }

function fakePool(plan: Array<"ok" | "query-fails" | "acquire-fails">) {
  const connections: FakeConnection[] = [];
  let acquired = 0;
  const pool = {
    getConnection: async () => {
      const step = plan[Math.min(acquired, plan.length - 1)];
      acquired += 1;
      if (step === "acquire-fails") throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
      const state: FakeConnection = { queries: [], released: 0, destroyed: 0 };
      connections.push(state);
      return {
        query: async (statement: unknown) => {
          state.queries.push(statement);
          if (step === "query-fails") throw Object.assign(new Error("Query inactivity timeout"), { code: "PROTOCOL_SEQUENCE_TIMEOUT" });
          return [[], []];
        },
        release: () => { state.released += 1; },
        destroy: () => { state.destroyed += 1; },
      };
    },
  } as unknown as Parameters<typeof keepPoolWarm>[0];
  return { pool, connections, acquired: () => acquired };
}

test("idle timeout follows the server's wait_timeout, 30 s early, between 30 s and 10 min", () => {
  assert.deepEqual(warmSettings(28_800), { idleTimeoutMs: 600_000, keepWarmEveryMs: 30_000 }, "a long server timeout is capped");
  assert.deepEqual(warmSettings(300), { idleTimeoutMs: 270_000, keepWarmEveryMs: 30_000 });
  assert.deepEqual(warmSettings(90), { idleTimeoutMs: 60_000, keepWarmEveryMs: 30_000 });
  assert.deepEqual(warmSettings(60), { idleTimeoutMs: 30_000, keepWarmEveryMs: 15_000 }, "the pool lets go 30 s before the server");
  assert.deepEqual(warmSettings(40), { idleTimeoutMs: 30_000, keepWarmEveryMs: 15_000 }, "never below 30 s");
  for (const unknown of [undefined, Number.NaN, 0, -5]) {
    assert.deepEqual(warmSettings(unknown), { idleTimeoutMs: 60_000, keepWarmEveryMs: 30_000 }, "an unreported value keeps the previous minute");
  }
});

test("a ping runs one bounded SELECT 1 and hands the connection back", async () => {
  const { pool, connections } = fakePool(["ok"]);
  const events: MySqlPersistenceEvent[] = [];
  const warm = keepPoolWarm(pool, 60_000, (event) => events.push(event));
  await warm.ping();
  await warm.stop();
  assert.deepEqual(connections.map((c) => [c.queries, c.released, c.destroyed]), [[[{ sql: "SELECT 1", timeout: 5_000 }], 1, 0]]);
  assert.deepEqual(events, [], "a healthy tick says nothing");
});

test("a failing tick destroys its connection, never rejects, and logs once per streak and once on recovery", async () => {
  const { pool, connections } = fakePool(["query-fails", "query-fails", "acquire-fails", "ok", "query-fails", "ok"]);
  const events: MySqlPersistenceEvent[] = [];
  const warm = keepPoolWarm(pool, 60_000, (event) => events.push(event));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    for (let tick = 0; tick < 6; tick += 1) await warm.ping();
    await warm.stop();
    await new Promise((resolve) => setImmediate(resolve));
  } finally { process.off("unhandledRejection", onUnhandled); }

  assert.deepEqual(unhandled, [], "no tick leaves a rejection behind");
  assert.deepEqual(events, [
    { event: "mysql.pool.keep-warm-failed", level: "warn", reason: "PROTOCOL_SEQUENCE_TIMEOUT" },
    { event: "mysql.pool.keep-warm-recovered", level: "info", failedTicks: 3 },
    { event: "mysql.pool.keep-warm-failed", level: "warn", reason: "PROTOCOL_SEQUENCE_TIMEOUT" },
    { event: "mysql.pool.keep-warm-recovered", level: "info", failedTicks: 1 },
  ], "three failing ticks are one line, the next failure after a recovery is a new streak");
  assert.deepEqual(connections.map((c) => [c.released, c.destroyed]), [[0, 1], [0, 1], [1, 0], [0, 1], [1, 0]],
    "a connection whose query failed is destroyed, never released into the pool");
});

test("pings in flight are shared, and stop waits for the one running", async () => {
  let finishQuery: () => void = () => undefined;
  const state = { acquired: 0, released: 0 };
  const pool = {
    getConnection: async () => {
      state.acquired += 1;
      return {
        query: () => new Promise<void>((resolve) => { finishQuery = resolve; }),
        release: () => { state.released += 1; }, destroy: () => undefined,
      };
    },
  } as unknown as Parameters<typeof keepPoolWarm>[0];
  const warm = keepPoolWarm(pool, 60_000, () => undefined);
  const first = warm.ping();
  const second = warm.ping();
  assert.equal(first, second, "a second tick while one is running joins it");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.acquired, 1);

  let stopped = false;
  const stopping = warm.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "stop does not return while the ping still holds a connection");
  finishQuery();
  await stopping;
  assert.equal(state.released, 1, "the pool gets its connection back before it is ended");
  await warm.ping();
  assert.equal(state.acquired, 1, "no ping starts after stop");
});

test("the timer pings every interval and stops with the pool", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { pool, acquired } = fakePool(["ok"]);
  const warm = keepPoolWarm(pool, 30_000, () => undefined);
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acquired(), 1);
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acquired(), 2);
  await warm.stop();
  t.mock.timers.tick(120_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acquired(), 2, "a stopped keep-warm never asks the pool for a connection again");
});
