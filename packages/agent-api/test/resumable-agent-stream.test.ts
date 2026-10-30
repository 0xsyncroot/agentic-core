import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryResumableAgentStreamRegistry } from "../src/in-memory-stream-registry.js";

const KEY = { tenantId: "t", actorId: "a", sessionId: "s", requestId: "r" };

test("InMemoryResumableAgentStreamRegistry reports productionSafe: false", () => {
  assert.equal(new InMemoryResumableAgentStreamRegistry().productionSafe, false);
});

test("drain() waits for an owned run to publish its terminal event within the grace period", async () => {
  const registry = new InMemoryResumableAgentStreamRegistry();
  let resolveRun!: (event: string, payload: unknown) => void;
  const { operation } = await registry.acquire({
    key: KEY, fingerprint: "f",
    run: (publish) => new Promise((resolve) => { resolveRun = (event, payload) => { publish(event, payload); resolve(); }; }),
  });
  operation.start();
  const drained = registry.drain(1_000);
  resolveRun("result", { ok: true });
  await drained;
  assert.equal(operation.terminal, true);
});

test("drain() cancels a run that does not finish within the grace period, and still resolves", async () => {
  const registry = new InMemoryResumableAgentStreamRegistry();
  let sawAbort = false;
  const { operation } = await registry.acquire({
    key: KEY, fingerprint: "f",
    run: (_publish, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { sawAbort = true; resolve(); });
    }),
  });
  operation.start();
  await registry.drain(10);
  assert.equal(sawAbort, true);
  assert.equal(operation.terminal, true);
});

test("acquire() rejects a new operation once draining, but an already-acquired one still works", async () => {
  const registry = new InMemoryResumableAgentStreamRegistry();
  const { operation } = await registry.acquire({
    key: KEY, fingerprint: "f",
    run: (_publish, signal) => new Promise((resolve) => { signal.addEventListener("abort", () => resolve()); }),
  });
  operation.start();
  const drainPromise = registry.drain(10);
  await assert.rejects(
    registry.acquire({ key: { ...KEY, requestId: "other" }, fingerprint: "f2", run: async () => undefined }),
    (error: unknown) => error instanceof Error && /draining/.test(error.message),
  );
  // The already-running operation is still reachable during the drain (same key, same fingerprint).
  const reacquired = await registry.acquire({ key: KEY, fingerprint: "f", run: async () => undefined });
  assert.equal(reacquired.operation, operation);
  await drainPromise;
});

test("drain() is idempotent: concurrent callers share one drain", async () => {
  const registry = new InMemoryResumableAgentStreamRegistry();
  const first = registry.drain(50);
  const second = registry.drain(50);
  assert.equal(first, second);
  await first;
});
