import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpToolsPlugin } from "@0xsyncroot/adapter-mcp";
import { AgenticError, CAPABILITIES, type SkillCatalog, type SkillDefinition, type ToolDefinition } from "@0xsyncroot/contracts";
import { PluginHost, acquireRuntimeView } from "@0xsyncroot/core";
import { InMemoryCatalogStore } from "@0xsyncroot/persistence-memory";
import { CONTEXTUAL_TOOL_SOURCE_CAPABILITY, TOOL_CAPABILITY, capabilityToken, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { catalogDatabaseUrl, createBlankRuntime } from "../src/bootstrap.js";
import type { GenerationBuilder, GenerationView } from "../src/composition/catalog/catalog-generations.js";
import { CatalogRuntimeProvider } from "../src/composition/catalog/catalog-runtime-provider.js";
import { NO_TOOL_SWITCHES_HASH } from "../src/composition/catalog/generation-route.js";
import { InfraExports } from "../src/composition/catalog/infra-exports.js";

/**
 * With catalog routing the boot host keeps persistence, the model and the connectors; each release becomes a generation
 * with the platform plugins, the builder's skills, profile and plugins, routed by release. Without it nothing changes.
 */

const AGENT = "agent-a";
const environment: NodeJS.ProcessEnv = { AGENTIC_ENABLE_DIAGNOSTIC_TOOLS: "false", AGENTIC_KNOWLEDGE_ROOTS: "", AGENTIC_SKILL_ROOTS: "" };
const releaseSkill: SkillDefinition = { id: "release-skill", version: "1.0.0", name: "Release", description: "Looks a release up, then writes it.",
  instructions: "Look the release up before writing it.", requiredTools: ["release_lookup", "release_write"],
  preconditions: { release_write: { after: ["release_lookup"] } } };
const skills: SkillCatalog = { revision: "release-skills", list: () => [releaseSkill], get: (id) => (id === releaseSkill.id ? releaseSkill : undefined) };
const security = (correlationId: string, agentProfileId = AGENT) => ({
  tenantId: "tenant-a", actorId: "user-a", permissions: new Set(["memory.read"]), correlationId, purpose: "test",
  authentication: { issuer: "test", subject: "user-a", assurance: "user" as const }, authorizedAgentProfiles: [agentProfileId],
});

const tool = (id: string): ToolDefinition => ({ id, version: "1.0.0", description: id, inputSchema: { type: "object" },
  outputSchema: {}, requiredPermissions: [], sideEffect: "none", timeoutMs: 1_000, execute: async () => ({}) });

function productTools(ids: readonly string[]): PluginDescriptor {
  return {
    trustTier: "first-party-domain",
    manifest: { manifestVersion: 1, id: "io.syncroot.product.release-tools", version: "1.0.0", publisher: "Product Test", coreApi: "^1.0.0",
      artifact: { digest: "sha256:release-tools", signature: "test-signature" }, requires: {},
      provides: { [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } }, permissions: {} },
    plugin: { validate: async () => ({ valid: true }), activate: async (context) => {
      for (const id of ids) context.registrations.provide(TOOL_CAPABILITY, tool(id));
      return { dispose: () => undefined };
    } },
  };
}

/** Mounts the release's tool items as product tools and records what each generation saw and when it was disposed. */
function builder(views: GenerationView[], disposed: string[], profileId = AGENT, releaseSkills = skills): GenerationBuilder {
  return {
    build: async ({ content }) => ({
      descriptors: [productTools(content.items.filter((item) => item.itemKind === "tool").map((item) => item.itemId))],
      verifyArtifact: async (candidate) => candidate.manifest.artifact.signature === "test-signature",
      skills: releaseSkills,
      agentProfile: { id: profileId, version: "1.0.0", name: "Agent A", description: "Test agent.", supportedDomains: [],
        instructions: "Answer briefly.", contentDigest: "sha256:profile" },
      activated: (view) => { views.push(view); },
      dispose: async () => { disposed.push(content.release.releaseId); },
    }),
  };
}

async function liveRelease(tools: readonly string[]): Promise<{ store: InMemoryCatalogStore; releaseId: string }> {
  const store = new InMemoryCatalogStore();
  await store.ensureAgent({ agentId: AGENT, productId: "product-a", createdBy: "test" });
  const items = [];
  for (const itemId of tools) {
    const { revision } = await store.putRevision({ agentId: AGENT, itemKind: "tool", itemId, bodyFormat: "json", schemaVersion: 1,
      displayName: itemId, summary: itemId, requiredToolCount: 0, body: JSON.stringify({ id: itemId }), authorId: "test", authorScope: "import" });
    items.push({ itemKind: "tool" as const, itemId, revisionId: revision.revisionId });
  }
  const { releaseId } = (await store.createRelease({ agentId: AGENT, items, createdBy: "test" })).release;
  await store.moveChannel({ agentId: AGENT, channel: "live", releaseId, expectedVersion: null, updatedBy: "test" });
  return { store, releaseId };
}

function catalogDependencies(store: InMemoryCatalogStore, build: GenerationBuilder, failures: unknown[] = []) {
  return { reader: store, agentIds: [AGENT], builder: build, pollIntervalMs: 60_000, buildTimeoutMs: 5_000, maxGenerations: 4,
    onBackgroundFailure: (error: unknown) => failures.push(error) };
}

test("a catalog runtime serves the live release's generation and routes turns by release", async () => {
  const { store, releaseId } = await liveRelease(["release_lookup", "release_write"]);
  const views: GenerationView[] = [];
  const disposed: string[] = [];
  const failures: unknown[] = [];
  const runtime = await createBlankRuntime(environment, { catalog: catalogDependencies(store, builder(views, disposed), failures) });
  try {
    const toolIds = runtime.availableTools.map((tool) => tool.id);
    assert.ok(toolIds.includes("release_lookup"), "the builder's tool is mounted in the generation");
    assert.ok(toolIds.includes("calculate"), "the platform tools are mounted around it");
    assert.equal(runtime.agentProfile?.id, AGENT);
    assert.equal(views.length, 1);
    assert.deepEqual([...views[0]!.toolIds].sort(), [...toolIds].sort());
    assert.notEqual(views[0]!.snapshotId, runtime.host.snapshot.id, "the generation is its own host");
    assert.deepEqual(views[0]!.availableTools, runtime.availableTools, "the view lists the tools with their descriptions");
    assert.deepEqual(views[0]!.preconditions.get("release_write"), ["release_lookup"], "the view carries the skills' write order");
    assert.deepEqual([...runtime.preconditions], [...views[0]!.preconditions]);

    const result = await runtime.agent.runTurn({ sessionId: "catalog-turn", content: "hello", security: security("catalog-turn") });
    const started = result.events.find((event) => event.type === "turn/start");
    const binding = (started?.payload as { runtimeBinding?: { agentProfileId?: string; routeRevision?: string; runtimeSnapshotId?: string } })
      .runtimeBinding;
    assert.equal(binding?.agentProfileId, AGENT, "a turn without a profile gets the first listed agent");
    assert.equal(binding?.runtimeSnapshotId, views[0]!.snapshotId);
    assert.ok(binding?.routeRevision?.endsWith(`:${releaseId}:${NO_TOOL_SWITCHES_HASH}`), binding?.routeRevision);
    assert.deepEqual(failures.map(String), []);
  } finally { await runtime.close(); }
  assert.deepEqual(disposed, [releaseId], "close shuts the generation down");
});

test("a generation whose profile is not the release's agent fails the boot", async () => {
  const { store } = await liveRelease(["release_lookup", "release_write"]);
  const failures: unknown[] = [];
  await assert.rejects(createBlankRuntime(environment, { catalog: catalogDependencies(store, builder([], [], "agent-b"), failures) }),
    /No live release could be served for agent agent-a/);
  assert.match(String(failures[0]), /carries agent profile agent-b/);
});

test("catalog routing replaces the provider factory and the additional plugins", async () => {
  const { store } = await liveRelease(["release_lookup", "release_write"]);
  const catalog = catalogDependencies(store, builder([], []));
  await assert.rejects(createBlankRuntime(environment, { catalog, runtimeProviderFactory: () => { throw new Error("not built"); } }),
    /replaces the runtime provider factory/);
  await assert.rejects(createBlankRuntime(environment, { catalog, additionalPlugins: { descriptors: [], verifyArtifact: async () => true } }),
    /replaces the runtime provider factory/);
});

test("without catalog routing turns keep the deploy route revision and the single host", async () => {
  const runtime = await createBlankRuntime(environment);
  try {
    const result = await runtime.agent.runTurn({ sessionId: "flag-off", content: "hello", security: security("flag-off", "default") });
    const started = result.events.find((event) => event.type === "turn/start");
    const binding = (started?.payload as { runtimeBinding?: { routeRevision?: string; runtimeSnapshotId?: string } }).runtimeBinding;
    assert.equal(binding?.runtimeSnapshotId, runtime.host.snapshot.id);
    assert.equal(binding?.routeRevision, `harness:${runtime.config.policyRevision}:${runtime.model.routeRevision}`);
  } finally { await runtime.close(); }
});

test("the catalog reader opens the control-plane database the migration CLI applies the catalog to", () => {
  assert.equal(catalogDatabaseUrl({ CATALOG_DATABASE_URL: "mysql://u@catalog/cp", DATABASE_URL: "mysql://u@shard/s" }), "mysql://u@catalog/cp");
  assert.equal(catalogDatabaseUrl({ CATALOG_DATABASE_URL: " ", DATABASE_URL: "mysql://u@shard/s" }), "mysql://u@shard/s");
  assert.throws(() => catalogDatabaseUrl({}), /set CATALOG_DATABASE_URL or DATABASE_URL/);
  assert.throws(() => catalogDatabaseUrl({ DATABASE_URL: "postgres://u@shard/s" }), /must use mysql:\/\//);
});

test("a generation lists the tools in the order the single host lists them, a static MCP tool of the infra host included", async () => {
  const STORE = capabilityToken<{ readonly name: string }>({ id: "test.store@1", version: "1.0.0", cardinality: "single", protected: false });
  const plugin = (id: string, tools: readonly string[], manifest: Partial<PluginDescriptor["manifest"]> = {}): PluginDescriptor => ({
    trustTier: "platform-core",
    manifest: { manifestVersion: 1, id, version: "0.1.0", publisher: "Test", coreApi: "^1.0.0", artifact: { digest: `builtin:${id}`,
      signature: "trusted-assembly" }, requires: {}, permissions: {}, provides: tools.length > 0
      ? { [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } } : {}, ...manifest },
    plugin: { validate: async () => ({ valid: true }), activate: async (context) => {
      if (manifest.provides?.[STORE.id]) context.registrations.provide(STORE, { name: "store" });
      for (const id of tools) context.registrations.provide(TOOL_CAPABILITY, tool(id));
      return { dispose: () => undefined };
    } },
  });
  const infraPlugins = () => [plugin("io.syncroot.test.store", [], { provides: { [STORE.id]: { version: "1.0.0", cardinality: "single" } } }),
    createMcpToolsPlugin({ serverId: "docs", clientFactory: async () => ({ close: async () => undefined, callTool: async () => ({}),
      listTools: async () => ({ tools: [{ name: "search", inputSchema: { type: "object" } }, { name: "read", inputSchema: { type: "object" } }] }) }) })];
  // Ids on both sides of the connector's, and one that waits for an infra capability: a re-export placed first reorders them.
  const generationPlugins = () => [plugin("io.syncroot.a-tools", ["a_tool"]), plugin("io.syncroot.base-tools", ["base_tool"]),
    plugin("io.syncroot.zz.tools", ["z_tool"]), plugin("io.syncroot.after-store", ["store_tool"], { requires: { [STORE.id]: "^1.0.0" } })];
  const bootSecurity = security("tool-order-boot");
  const single = new PluginHost();
  await single.activate([...infraPlugins(), ...generationPlugins()], { security: bootSecurity, verifyArtifact: async () => true });
  const flagOff = single.capabilities.all(TOOL_CAPABILITY).map((entry) => entry.id);
  await single.shutdown();

  const { store } = await liveRelease(["release_lookup"]);
  const infraExports = new InfraExports(infraPlugins());
  const infra = new PluginHost();
  await infra.activate(infraExports.descriptors, { security: bootSecurity, verifyArtifact: async () => true });
  const provider = new CatalogRuntimeProvider({ infra, infraExports, reader: store, agentIds: [AGENT], routeRevision: "deploy",
    assemble: async () => ({ descriptors: generationPlugins(), verifyArtifact: async () => true }), maxGenerations: 2,
    pollIntervalMs: 60_000, buildTimeoutMs: 5_000, onBackgroundFailure: (error) => { throw error; } });
  try {
    await provider.start();
    const lease = await acquireRuntimeView(provider, { security: security("tool-order"), agentProfileId: AGENT });
    assert.ok(flagOff.includes("mcp_docs_search"), flagOff.join());
    assert.deepEqual(lease.capabilities.all(TOOL_CAPABILITY).map((entry) => entry.id), flagOff);
    lease.release();
  } finally { await provider.close(); await infra.shutdown(); }
});

test("with catalog routing the composed tools keep the order the single-host composition gives them", async () => {
  const configured = { ...environment, AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "docs", endpoint: "https://mcp.example/mcp" },
    { id: "files", endpoint: "https://files.example/mcp" }]) };
  const noSkills: SkillCatalog = { revision: "none", list: () => [], get: () => undefined };
  const ordered = async (runtime: Awaited<ReturnType<typeof createBlankRuntime>>, correlationId: string, agentProfileId: string) => {
    const lease = await runtime.acquireRuntime({ security: security(correlationId, agentProfileId) });
    try {
      return { available: runtime.availableTools.map((entry) => entry.id), tools: lease.capabilities.all(TOOL_CAPABILITY).map((entry) => entry.id),
        sources: lease.capabilities.all(CONTEXTUAL_TOOL_SOURCE_CAPABILITY).map((source) => source.id) };
    } finally { lease.release(); }
  };
  const flagOff = await createBlankRuntime(configured, { additionalPlugins: { descriptors: [productTools(["release_lookup", "release_write"])],
    verifyArtifact: async (candidate) => candidate.manifest.artifact.signature === "test-signature" } });
  let single: Awaited<ReturnType<typeof ordered>>;
  try { single = await ordered(flagOff, "order-flag-off", "default"); } finally { await flagOff.close(); }
  const { store } = await liveRelease(["release_lookup", "release_write"]);
  const catalogMode = await createBlankRuntime(configured, { catalog: catalogDependencies(store, builder([], [], AGENT, noSkills)) });
  try {
    assert.equal(single.sources.length, 2, single.sources.join());
    assert.deepEqual(await ordered(catalogMode, "order-catalog", AGENT), single);
  } finally { await catalogMode.close(); }
});

test("acquireRuntime leases from the agent loop's provider with its checks", async () => {
  const { store, releaseId } = await liveRelease(["release_lookup", "release_write"]);
  const views: GenerationView[] = [];
  const runtime = await createBlankRuntime(environment, { catalog: catalogDependencies(store, builder(views, [])) });
  try {
    const lease = await runtime.acquireRuntime({ security: security("lease-default") });
    assert.equal(lease.binding.agentProfileId, AGENT, "no profile named gets the first listed agent, as a turn does");
    assert.equal(lease.snapshot.id, views[0]!.snapshotId);
    assert.ok(lease.binding.routeRevision.endsWith(`:${releaseId}:${NO_TOOL_SWITCHES_HASH}`), lease.binding.routeRevision);
    lease.release();
    const pinned = await runtime.acquireRuntime({ security: security("lease-pin"), agentProfileId: AGENT, pin: lease.binding.routeRevision });
    assert.equal(pinned.snapshot.id, lease.snapshot.id, "a pin on this deploy's route is served");
    pinned.release();
    await assert.rejects(runtime.acquireRuntime({ security: security("lease-unlisted", "agent-b"), agentProfileId: "agent-b" }),
      (error: unknown) => error instanceof AgenticError && error.code === "denied");
    const { authentication: _evidence, ...anonymous } = security("lease-anonymous");
    await assert.rejects(runtime.acquireRuntime({ security: anonymous, agentProfileId: AGENT }),
      (error: unknown) => error instanceof AgenticError && error.code === "denied");
  } finally { await runtime.close(); }
  const single = await createBlankRuntime(environment);
  try {
    const lease = await single.acquireRuntime({ security: security("lease-flag-off", "default") });
    assert.equal(lease.snapshot.id, single.host.snapshot.id, "without catalog routing the lease is the single host's");
    lease.release();
  } finally { await single.close(); }
});
