import assert from "node:assert/strict";
import { test } from "node:test";
import { AgenticError, CAPABILITIES, type SecurityContext, type ToolDefinition } from "@0xsyncroot/contracts";
import { PluginHost, acquireRuntimeView } from "@0xsyncroot/core";
import { InMemoryCatalogStore } from "@0xsyncroot/persistence-memory";
import { TOOL_CAPABILITY, capabilityToken, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { CatalogRuntimeProvider, type CatalogRuntimeProviderOptions } from "../src/composition/catalog/catalog-runtime-provider.js";
import type { GenerationAssembler } from "../src/composition/catalog/generation-cache.js";
import { NO_TOOL_SWITCHES_HASH } from "../src/composition/catalog/generation-route.js";
import { InfraExports } from "../src/composition/catalog/infra-exports.js";

/**
 * A catalog runtime serves each release from its own generation host over one infra host: releases live side by side, a
 * rebuilt generation has the id it had, a pause resumes on the release it paused on, and nothing is served without
 * authentication or to an agent the composition does not list.
 */

const AGENT = "agent-a";
const DEPLOY = "harness:policy-a:model-a";
const INFRA = capabilityToken<{ readonly name: string }>({ id: "test.infra@1", version: "1.0.0", cardinality: "single", protected: false });

function security(overrides: Partial<SecurityContext> = {}): SecurityContext {
  return {
    tenantId: "tenant-a", actorId: "user-a", permissions: new Set(), correlationId: crypto.randomUUID(), purpose: "test",
    authentication: { issuer: "test", subject: "user-a", assurance: "user" }, ...overrides,
  };
}

function descriptor(id: string, manifest: Partial<PluginDescriptor["manifest"]>, activate: PluginDescriptor["plugin"]["activate"]): PluginDescriptor {
  return {
    trustTier: "platform-core",
    manifest: { manifestVersion: 1, id, version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
      artifact: { digest: `builtin:${id}`, signature: "test" }, requires: {}, permissions: {}, ...manifest },
    plugin: { validate: async () => ({ valid: true }), activate },
  };
}

const infraPlugin = descriptor("io.syncroot.test.infra", { provides: { [INFRA.id]: { version: "1.0.0", cardinality: "single" } } },
  async (context) => { context.registrations.provide(INFRA, { name: "shared" }); return { dispose: () => undefined }; });

async function infraHost(): Promise<{ host: PluginHost; exports: InfraExports }> {
  const host = new PluginHost({ policyRevisions: { policy: "policy-a", memoryPolicy: "disabled" } });
  const exports = new InfraExports([infraPlugin]);
  await host.activate(exports.descriptors, { security: security(), verifyArtifact: async () => true });
  return { host, exports };
}

function tool(id: string): ToolDefinition {
  return { id, version: "1.0.0", description: id, inputSchema: { type: "object" }, outputSchema: {}, requiredPermissions: [],
    sideEffect: "none", timeoutMs: 1_000, execute: async () => ({}) };
}

/** Mounts every tool item of the release as a tool of the same id, needing the infra capability to activate. */
function assembler(builds: string[], gate?: Promise<void>): GenerationAssembler {
  return async ({ content }) => {
    builds.push(content.release.releaseId);
    await gate;
    const ids = content.items.filter((item) => item.itemKind === "tool").map((item) => item.itemId);
    return {
      descriptors: [descriptor("io.syncroot.test.release-tools", {
        requires: { [INFRA.id]: "^1.0.0" }, provides: { [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } },
      }, async (context) => {
        assert.equal(context.capabilities.require(INFRA).name, "shared");
        for (const id of ids) context.registrations.provide(TOOL_CAPABILITY, tool(id));
        return { dispose: () => undefined };
      })],
      verifyArtifact: async () => true,
    };
  };
}

async function catalog(): Promise<{ store: InMemoryCatalogStore; release: (tools: readonly string[]) => Promise<string> }> {
  const store = new InMemoryCatalogStore();
  await store.ensureAgent({ agentId: AGENT, productId: "product-a", createdBy: "test" });
  const release = async (tools: readonly string[]) => {
    const items = [];
    for (const itemId of tools) {
      const { revision } = await store.putRevision({ agentId: AGENT, itemKind: "tool", itemId, bodyFormat: "json", schemaVersion: 1,
        displayName: itemId, summary: itemId, requiredToolCount: 0, body: JSON.stringify({ id: itemId }), authorId: "test", authorScope: "import" });
      items.push({ itemKind: "tool" as const, itemId, revisionId: revision.revisionId });
    }
    return (await store.createRelease({ agentId: AGENT, items, createdBy: "test" })).release.releaseId;
  };
  return { store, release };
}

async function moveLive(store: InMemoryCatalogStore, releaseId: string): Promise<void> {
  const live = await store.getChannel(AGENT, "live");
  await store.moveChannel({ agentId: AGENT, channel: "live", releaseId, expectedVersion: live?.version ?? null, updatedBy: "test" });
}

async function provider(store: InMemoryCatalogStore, overrides: Partial<CatalogRuntimeProviderOptions> = {}) {
  const { host: infra, exports } = await infraHost();
  const failures: unknown[] = [];
  const builds: string[] = [];
  const runtime = new CatalogRuntimeProvider({
    infra, infraExports: exports, reader: store, agentIds: [AGENT], routeRevision: DEPLOY,
    assemble: assembler(builds), maxGenerations: 4, pollIntervalMs: 60_000, buildTimeoutMs: 5_000,
    onBackgroundFailure: (error) => failures.push(error), ...overrides,
  });
  await runtime.start();
  return { runtime, failures, builds, close: async () => { await runtime.close(); await infra.shutdown(); } };
}

const toolIds = (lease: { capabilities: { all: (token: typeof TOOL_CAPABILITY) => readonly ToolDefinition[] } }) =>
  lease.capabilities.all(TOOL_CAPABILITY).map((entry) => entry.id).sort();
const request = (pin?: string) => ({ security: security(), agentProfileId: AGENT, ...(pin === undefined ? {} : { pin }) });

test("two releases live side by side; each lease sees its own tools and route", async () => {
  const { store, release } = await catalog();
  const r1 = await release(["read_a", "read_b"]);
  const r2 = await release(["read_a"]);
  await moveLive(store, r1);
  const served = await provider(store);
  try {
    const onR1 = await acquireRuntimeView(served.runtime, request());
    await moveLive(store, r2);
    await served.runtime.refresh();
    const onR2 = await acquireRuntimeView(served.runtime, request());
    assert.deepEqual(toolIds(onR1), ["read_a", "read_b"]);
    assert.deepEqual(toolIds(onR2), ["read_a"]);
    assert.equal(onR1.binding.routeRevision, `${DEPLOY}:${r1}:${NO_TOOL_SWITCHES_HASH}`);
    assert.equal(onR2.binding.routeRevision, `${DEPLOY}:${r2}:${NO_TOOL_SWITCHES_HASH}`);
    assert.notEqual(onR1.snapshot.id, onR2.snapshot.id);
    onR1.release(); onR2.release();
    assert.deepEqual(served.failures, []);
  } finally { await served.close(); }
});

test("an evicted generation is rebuilt with the same snapshot id, and one with a lease is never evicted", async () => {
  const { store, release } = await catalog();
  const [r1, r2, r3] = [await release(["read_a"]), await release(["read_b"]), await release(["read_c"])];
  await moveLive(store, r3);
  const served = await provider(store, { maxGenerations: 1 });
  try {
    const pinned = (releaseId: string) => request(`${DEPLOY}:${releaseId}:${NO_TOOL_SWITCHES_HASH}`);
    const first = await acquireRuntimeView(served.runtime, pinned(r1));
    const firstId = first.snapshot.id;
    const held = await acquireRuntimeView(served.runtime, pinned(r2));
    assert.deepEqual(toolIds(first), ["read_a"], "a leased generation stays usable while the cache is over its cap");
    first.release();
    held.release();
    const again = await acquireRuntimeView(served.runtime, pinned(r1));
    assert.equal(again.snapshot.id, firstId, "same infra and same release give the same id after a rebuild");
    again.release();
    assert.deepEqual(served.builds.filter((id) => id === r1).length, 2, "r1 was evicted once it had no lease, then rebuilt");
    assert.deepEqual(served.failures, []);
  } finally { await served.close(); }
});

test("a pin from a pause on r1 is served while live is r2; a foreign or unknown pin leases live", async () => {
  const { store, release } = await catalog();
  const [r1, r2] = [await release(["read_a", "read_b"]), await release(["read_a"])];
  await moveLive(store, r2);
  const served = await provider(store);
  try {
    const pin = `${DEPLOY}:${r1}:${NO_TOOL_SWITCHES_HASH}`;
    const resumed = await acquireRuntimeView(served.runtime, request(pin));
    assert.equal(resumed.binding.routeRevision, pin);
    assert.deepEqual(toolIds(resumed), ["read_a", "read_b"]);
    resumed.release();
    for (const foreign of [`harness:policy-b:model-a:${r1}:${NO_TOOL_SWITCHES_HASH}`, `${DEPLOY}:${r1}:other-switches`,
      `${DEPLOY}:00000000-0000-4000-8000-000000000000:${NO_TOOL_SWITCHES_HASH}`, "test-route-v1"]) {
      const live = await acquireRuntimeView(served.runtime, request(foreign));
      assert.equal(live.binding.routeRevision, `${DEPLOY}:${r2}:${NO_TOOL_SWITCHES_HASH}`, foreign);
      live.release();
    }
  } finally { await served.close(); }
});

test("a deploy revision with colons still parses the release from the right", async () => {
  const { store, release } = await catalog();
  const [r1, r2] = [await release(["read_a", "read_b"]), await release(["read_a"])];
  await moveLive(store, r2);
  const deploy = "harness:policy:with:colons:model:x";
  const served = await provider(store, { routeRevision: deploy });
  try {
    const resumed = await acquireRuntimeView(served.runtime, request(`${deploy}:${r1}:${NO_TOOL_SWITCHES_HASH}`));
    assert.deepEqual(toolIds(resumed), ["read_a", "read_b"]);
    resumed.release();
  } finally { await served.close(); }
});

test("a pin on a revoked release is refused as a stale binding", async () => {
  const { store, release } = await catalog();
  const [r1, r2] = [await release(["read_a"]), await release(["read_b"])];
  await moveLive(store, r1);
  const served = await provider(store);
  try {
    await moveLive(store, r2);
    await served.runtime.refresh();
    await store.revokeRelease(AGENT, r1, "test");
    await assert.rejects(acquireRuntimeView(served.runtime, request(`${DEPLOY}:${r1}:${NO_TOOL_SWITCHES_HASH}`)),
      (error: unknown) => error instanceof AgenticError && error.code === "conflict" && error.reason === "stale-binding");
  } finally { await served.close(); }
});

test("an unlisted agent and a request without authentication evidence are denied", async () => {
  const { store, release } = await catalog();
  await moveLive(store, await release(["read_a"]));
  const served = await provider(store);
  try {
    const denied = (error: unknown) => error instanceof AgenticError && error.code === "denied";
    await assert.rejects(acquireRuntimeView(served.runtime, { security: security(), agentProfileId: "agent-b" }), denied);
    await assert.rejects(acquireRuntimeView(served.runtime, { security: security() }), denied, "the default profile is not listed");
    const { authentication: _authentication, ...unauthenticated } = security();
    await assert.rejects(acquireRuntimeView(served.runtime, { security: unauthenticated, agentProfileId: AGENT }), denied);
  } finally { await served.close(); }
});

test("a turn waits for a missing generation only up to the build timeout, then the build lands for the next turn", async () => {
  const { store, release } = await catalog();
  const [r1, r2] = [await release(["read_a"]), await release(["read_b"])];
  await moveLive(store, r2);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const builds: string[] = [];
  const slow = assembler(builds);
  const served = await provider(store, { buildTimeoutMs: 20,
    assemble: async (input) => { if (input.content.release.releaseId === r1) await gate; return slow(input); } });
  try {
    const pin = request(`${DEPLOY}:${r1}:${NO_TOOL_SWITCHES_HASH}`);
    const parallel = [acquireRuntimeView(served.runtime, pin), acquireRuntimeView(served.runtime, pin)];
    for (const attempt of parallel) {
      await assert.rejects(attempt, (error: unknown) => error instanceof AgenticError && error.code === "transient" && error.retryable);
    }
    open();
    const later = await acquireRuntimeView(served.runtime, pin);
    assert.deepEqual(toolIds(later), ["read_a"]);
    later.release();
    assert.deepEqual(builds, [r2, r1], "one build per release however many turns asked for it");
  } finally { await served.close(); }
});
