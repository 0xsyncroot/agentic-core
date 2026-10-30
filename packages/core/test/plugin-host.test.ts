import assert from "node:assert/strict";
import { test } from "node:test";
import type { SecurityContext } from "@0xsyncroot/contracts";
import {
  capabilityToken,
  type AgentPlugin,
  type PluginDescriptor,
  type PluginManifest,
} from "@0xsyncroot/plugin-sdk";
import { PluginHost } from "@0xsyncroot/core";
import { RuntimeSnapshotFactory } from "../src/plugins/runtime-snapshot-factory.js";

const ALPHA = capabilityToken<string>({ id: "test.alpha@1", version: "1.0.0", cardinality: "single", protected: false });
const BETA = capabilityToken<string>({ id: "test.beta@1", version: "1.0.0", cardinality: "single", protected: false });

const security: SecurityContext = {
  tenantId: "tenant-test",
  actorId: "test-runner",
  permissions: new Set(),
  correlationId: "plugin-host-test",
  purpose: "test",
};

function manifest(
  id: string,
  options: Pick<PluginManifest, "requires" | "provides"> = { requires: {} },
): PluginManifest {
  return {
    manifestVersion: 1,
    id,
    version: "1.0.0",
    publisher: "test",
    coreApi: "^1.0.0",
    artifact: { digest: `builtin:${id}`, signature: "test" },
    requires: options.requires,
    ...(options.provides ? { provides: options.provides } : {}),
    permissions: {},
  };
}

function descriptor(id: string, plugin: AgentPlugin, options?: Pick<PluginManifest, "requires" | "provides">): PluginDescriptor {
  return { manifest: manifest(id, options), plugin, trustTier: "platform-core" };
}

const activateOptions = { security, verifyArtifact: async () => true };

test("plugin host activates capability providers before consumers regardless of input order", async () => {
  const order: string[] = [];
  const provider = descriptor(
    "z.test-provider",
    {
      validate: async () => ({ valid: true }),
      activate: async (context) => {
        order.push("provider");
        context.registrations.provide(ALPHA, "ready");
        return { dispose: () => undefined };
      },
    },
    { requires: {}, provides: { [ALPHA.id]: { version: "1.0.0", cardinality: "single" } } },
  );
  const consumer = descriptor(
    "a.test-consumer",
    {
      validate: async () => ({ valid: true }),
      activate: async (context) => {
        assert.equal(context.capabilities.require(ALPHA), "ready");
        order.push("consumer");
        return { dispose: () => undefined };
      },
    },
    { requires: { [ALPHA.id]: "^1.0.0" } },
  );
  const host = new PluginHost();
  await host.activate([consumer, provider], activateOptions);
  assert.deepEqual(order, ["provider", "consumer"]);
  await host.shutdown();
});

test("plugin host rejects missing dependencies, cycles and unregistered declarations", async (context) => {
  await context.test("missing required capability", async () => {
    const host = new PluginHost();
    await assert.rejects(
      host.activate([
        descriptor("a.missing-consumer", {
          validate: async () => ({ valid: true }),
          activate: async () => ({ dispose: () => undefined }),
        }, { requires: { [ALPHA.id]: "^1.0.0" } }),
      ], activateOptions),
      /requires missing/i,
    );
  });

  await context.test("dependency cycle", async () => {
    const plugin = (provide: typeof ALPHA, require: typeof BETA, id: string) => descriptor(
      id,
      {
        validate: async () => ({ valid: true }),
        activate: async (activation) => {
          activation.registrations.provide(provide, id);
          return { dispose: () => undefined };
        },
      },
      {
        requires: { [require.id]: "^1.0.0" },
        provides: { [provide.id]: { version: "1.0.0", cardinality: "single" } },
      },
    );
    const host = new PluginHost();
    await assert.rejects(
      host.activate([plugin(ALPHA, BETA, "a.cycle"), plugin(BETA, ALPHA, "b.cycle")], activateOptions),
      /dependency cycle/i,
    );
  });

  await context.test("declared capability not registered", async () => {
    const host = new PluginHost();
    await assert.rejects(
      host.activate([
        descriptor("a.incomplete-provider", {
          validate: async () => ({ valid: true }),
          activate: async () => ({ dispose: () => undefined }),
        }, { requires: {}, provides: { [ALPHA.id]: { version: "1.0.0", cardinality: "single" } } }),
      ], activateOptions),
      /did not register declared/i,
    );
  });
});

test("shutdown attempts every plugin cleanup even when some fail", async () => {
  const calls: string[] = [];
  const failing = (id: string): PluginDescriptor => descriptor(id, {
    validate: async () => ({ valid: true }),
    activate: async () => ({ dispose: () => { calls.push(`dispose:${id}`); throw new Error(`dispose ${id}`); } }),
    quiesce: async () => { calls.push(`quiesce:${id}`); throw new Error(`quiesce ${id}`); },
  });
  const host = new PluginHost();
  await host.activate([failing("a.cleanup"), failing("b.cleanup")], activateOptions);
  await assert.rejects(host.shutdown(), AggregateError);
  assert.deepEqual(new Set(calls), new Set([
    "quiesce:a.cleanup", "dispose:a.cleanup", "quiesce:b.cleanup", "dispose:b.cleanup",
  ]));
});

test("snapshot lease drains before providers are disposed", async () => {
  let disposed = false;
  const host = new PluginHost();
  await host.activate([descriptor("a.leased", {
    validate: async () => ({ valid: true }),
    activate: async () => ({ dispose: () => { disposed = true; } }),
  })], activateOptions);
  assert.equal("acquireRuntime" in host, false);
  const lease = host.acquireSnapshot();
  const shutdown = host.shutdown(AbortSignal.timeout(1_000));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(host.state, "stopping");
  assert.equal(disposed, false);
  assert.throws(() => host.acquireSnapshot(), /while host is stopping/i);
  lease.release();
  await shutdown;
  assert.equal(disposed, true);
  assert.equal(host.state, "idle");
});

test("shutdown deadline is a hard promise boundary for non-cooperative plugins", async () => {
  let disposeAttempted = false;
  const never = new Promise<void>(() => undefined);
  const host = new PluginHost();
  await host.activate([descriptor("a.hanging", {
    validate: async () => ({ valid: true }),
    activate: async () => ({ dispose: () => { disposeAttempted = true; return never; } }),
    quiesce: async () => never,
  })], activateOptions);
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("test deadline")), 20);
  await assert.rejects(host.shutdown(controller.signal), AggregateError);
  clearTimeout(timer);
  assert.ok(performance.now() - started < 500);
  assert.equal(disposeAttempted, true);
});

test("runtime snapshot identity includes policy revisions", () => {
  const first = new RuntimeSnapshotFactory("1.0.0", { policy: "policy-a", memoryPolicy: "memory-a" }).create([]);
  const second = new RuntimeSnapshotFactory("1.0.0", { policy: "policy-b", memoryPolicy: "memory-a" }).create([]);
  assert.notEqual(first.id, second.id);
  assert.equal(first.pluginSetId, second.pluginSetId);
});

test("drain timeout never disposes providers still held by a snapshot lease", async () => {
  let disposed = false;
  const host = new PluginHost();
  await host.activate([descriptor("a.held", {
    validate: async () => ({ valid: true }),
    activate: async () => ({ dispose: () => { disposed = true; } }),
  })], activateOptions);
  const lease = host.acquireSnapshot();
  const firstDeadline = new AbortController();
  const firstTimer = setTimeout(() => firstDeadline.abort(), 10);
  await assert.rejects(host.shutdown(firstDeadline.signal), AggregateError);
  clearTimeout(firstTimer);
  assert.equal(disposed, false);
  lease.release();
  await host.shutdown(AbortSignal.timeout(1_000));
  assert.equal(disposed, true);
});
