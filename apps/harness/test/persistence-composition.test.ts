import assert from "node:assert/strict";
import { test } from "node:test";
import type { SecurityContext } from "@0xsyncroot/contracts";
import { PluginHost } from "@0xsyncroot/core";
import { InMemoryActorSettingStore, InMemoryMemoryService, InMemorySessionStore } from "@0xsyncroot/persistence-memory";
import { ACTOR_SETTING_CAPABILITY, MEMORY_CAPABILITY, SESSION_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import {
  createPersistencePlugin,
  createPersistencePlugins,
  persistenceDataSourceId,
  PersistenceResourceRegistry,
} from "../src/composition/providers/persistence-provider-catalog.js";
import { AuthenticatedSharedRuntimeProvider } from "../src/composition/authenticated-shared-runtime-provider.js";

const security: SecurityContext = {
  tenantId: "tenant-a",
  actorId: "platform-bootstrap",
  permissions: new Set(),
  correlationId: "persistence-composition-test",
  purpose: "test",
};

test("persistence plugin unregisters without closing its process-owned resource", async () => {
  const sessions = new InMemorySessionStore();
  const memory = new InMemoryMemoryService();
  const settings = new InMemoryActorSettingStore();
  let closes = 0;
  const registry = new PersistenceResourceRegistry();
  const dataSourceId = persistenceDataSourceId("memory");
  const resource = await registry.open(dataSourceId, async () => ({
    sessions, memory, settings, close: async () => { closes += 1; },
  }));
  const descriptor = createPersistencePlugin({
    provider: "memory",
    roles: ["sessions", "memory"],
    dataSourceId,
    resource,
    registry,
  });
  const host = new PluginHost();
  await host.activate([descriptor], {
    security,
    verifyArtifact: async () => true,
  });
  assert.equal(host.capabilities.require(SESSION_CAPABILITY), sessions);
  assert.equal(host.capabilities.require(MEMORY_CAPABILITY), memory);
  assert.equal(host.capabilities.require(ACTOR_SETTING_CAPABILITY), settings, "the settings travel with the sessions");
  const runtimeProvider = new AuthenticatedSharedRuntimeProvider(host, "shared-route-v1");
  const lease = runtimeProvider.acquireRuntime({
    security: {
      ...security,
      actorId: "user-a",
      authentication: { issuer: "test", subject: "user-a", assurance: "user" },
    },
  });
  assert.deepEqual(lease.binding, {
    tenantId: "tenant-a",
    agentProfileId: "default",
    routeRevision: "shared-route-v1",
    runtimeSnapshotId: host.snapshot.id,
  });
  lease.release();
  assert.throws(() => runtimeProvider.acquireRuntime({ security }), /authenticated identity evidence/);
  await assert.rejects(registry.closeAll(), /active registrations/);
  await host.shutdown();
  assert.equal(closes, 0);
  await registry.closeAll();
  assert.equal(closes, 1);
});

test("persistence registry opens and closes each data source exactly once", async () => {
  const registry = new PersistenceResourceRegistry();
  const sessions = new InMemorySessionStore();
  const memory = new InMemoryMemoryService();
  let opens = 0;
  let closes = 0;
  let releaseOpen!: () => void;
  const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
  const open = async () => {
    opens += 1;
    await openGate;
    return { sessions, memory, settings: new InMemoryActorSettingStore(), close: async () => { closes += 1; } };
  };

  const dataSourceId = persistenceDataSourceId("postgres", "postgres://shared.example/agentic");
  const first = registry.open(dataSourceId, open);
  const second = registry.open(dataSourceId, open);
  await Promise.resolve();
  assert.equal(opens, 1);
  releaseOpen();
  assert.equal(await first, await second);

  await Promise.all([registry.closeAll(), registry.closeAll()]);
  await registry.closeAll();
  assert.equal(closes, 1);
});

test("persistence registry retains only failed resources for a shutdown retry", async () => {
  const registry = new PersistenceResourceRegistry();
  let stableCloses = 0;
  let flakyCloses = 0;
  await registry.open("stable", async () => ({
    sessions: new InMemorySessionStore(), memory: new InMemoryMemoryService(), settings: new InMemoryActorSettingStore(),
    close: async () => { stableCloses += 1; },
  }));
  await registry.open("flaky", async () => ({
    sessions: new InMemorySessionStore(), memory: new InMemoryMemoryService(), settings: new InMemoryActorSettingStore(),
    close: async () => {
      flakyCloses += 1;
      if (flakyCloses === 1) throw new Error("temporary close failure");
    },
  }));

  await assert.rejects(registry.closeAll(), /Closing persistence resources failed/);
  assert.equal(registry.size, 1);
  await registry.closeAll();
  assert.equal(registry.size, 0);
  assert.equal(stableCloses, 1);
  assert.equal(flakyCloses, 2);
});

test("createPersistencePlugins accepts a MySQL pool size argument without touching other providers", async () => {
  // AGENTIC_MYSQL_POOL_SIZE only matters to the MySQL factory (packages/persistence-mysql/test
  // covers that it reaches createMySqlPersistence's `poolSize` option); this proves the extra
  // parameter apps/harness now threads through composition leaves every other provider alone.
  const registry = new PersistenceResourceRegistry();
  const descriptors = await createPersistencePlugins(
    { sessions: "memory", memory: "memory" },
    { mcpBearerTokens: {}, persistenceUrls: {}, dataEncryptionKeyId: "test" },
    registry,
    undefined,
    25,
  );
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0]?.config.provider, "memory");
  await registry.closeAll();
});

test("sessions and memory share one resource when provider and URL match", async () => {
  const registry = new PersistenceResourceRegistry();
  const connectionUrl = "postgres://shared.example/agentic";
  const dataSourceId = persistenceDataSourceId("postgres", connectionUrl);
  let closes = 0;
  await registry.open(dataSourceId, async () => ({
    sessions: new InMemorySessionStore(),
    memory: new InMemoryMemoryService(),
    settings: new InMemoryActorSettingStore(),
    close: async () => { closes += 1; },
  }));

  const descriptors = await createPersistencePlugins(
    { sessions: "postgres", memory: "postgres" },
    { mcpBearerTokens: {}, persistenceUrls: { sessions: connectionUrl, memory: connectionUrl }, dataEncryptionKeyId: "test" },
    registry,
  );
  assert.equal(descriptors.length, 1);
  assert.deepEqual(descriptors[0]?.config, {
    provider: "postgres",
    roles: ["sessions", "memory"],
    dataSourceId,
  });
  assert.equal(registry.size, 1);

  await registry.closeAll();
  assert.equal(closes, 1);
});

test("a Redis session store reads the shared Redis names from the composed environment", async () => {
  const { readStorageSettings } = await import("../src/composition/storage-settings.js");
  const redis = { AGENTIC_SESSION_STORE_PROVIDER: "redis", AGENTIC_MEMORY_STORE_PROVIDER: "mysql", DATABASE_URL: "mysql://u:p@db:3306/a" };
  assert.throws(() => readStorageSettings(redis), /SESSION_REDIS_URL or REDIS_URL is required for the Redis session store/u);

  const shared = readStorageSettings({ ...redis, REDIS_URL: "rediss://redis:6379/0" });
  assert.equal(shared.urls.sessions, "rediss://redis:6379/0");
  assert.deepEqual(shared.sessionRedis, { keyPrefix: "gateway:session:v1:", allowInsecureInternal: false },
    "plaintext is off unless REDIS_ALLOW_INSECURE_INTERNAL says otherwise");

  const own = readStorageSettings({
    ...redis, REDIS_URL: "rediss://redis:6379/0", SESSION_REDIS_URL: "redis://sessions:6379/2", REDIS_ALLOW_INSECURE_INTERNAL: "true",
    SESSION_REDIS_KEY_PREFIX: "tenant-x:session:v1", AGENTIC_SESSION_TTL_SECONDS: "3600", AGENTIC_SESSION_IDEMPOTENCY_TTL_SECONDS: "600",
  });
  assert.equal(own.urls.sessions, "redis://sessions:6379/2");
  assert.deepEqual(own.sessionRedis, { keyPrefix: "tenant-x:session:v1", allowInsecureInternal: true, sessionTtlSeconds: 3600, idempotencyTtlSeconds: 600 });
  assert.equal(readStorageSettings({ DATABASE_URL: "mysql://u:p@db:3306/a", REDIS_URL: "rediss://redis:6379/0" }).selection.sessions, "mysql",
    "a shared REDIS_URL never moves sessions into Redis by itself");
  assert.equal(readStorageSettings({ DATABASE_URL: "mysql://u:p@db:3306/a" }).sessionRedis, undefined);
  const loopback = { ...redis, SESSION_REDIS_URL: "redis://127.0.0.1:56379/1" };
  assert.equal(readStorageSettings(loopback).sessionRedis?.allowInsecureInternal, true, "development: plaintext to loopback needs no switch");
  assert.equal(readStorageSettings({ ...loopback, AGENTIC_RUNTIME_PROFILE: "production" }).sessionRedis?.allowInsecureInternal, false,
    "production never relaxes plaintext");
});

test("every engine publishes per-person settings beside its sessions; a memory-only plugin publishes none", async () => {
  const registry = new PersistenceResourceRegistry();
  const descriptors = await createPersistencePlugins(
    { sessions: "memory", memory: "memory" }, { mcpBearerTokens: {}, persistenceUrls: {}, dataEncryptionKeyId: "test" }, registry,
  );
  assert.ok(Object.keys(descriptors[0]!.manifest.provides).includes("agentic.actor-settings@1"));
  const host = new PluginHost();
  await host.activate([...descriptors], { security, verifyArtifact: async () => true });
  const settings = host.capabilities.require(ACTOR_SETTING_CAPABILITY);
  const written = await settings.put({ tenantId: "tenant-a", actorId: "user-a" }, "approval-mode", "standing");
  assert.deepEqual(await settings.get({ tenantId: "tenant-a", actorId: "user-a" }, "approval-mode"), written);
  await host.shutdown();
  await registry.closeAll();

  const memoryOnly = createPersistencePlugin({
    provider: "memory", roles: ["memory"], dataSourceId: "memory-only", registry,
    resource: { sessions: new InMemorySessionStore(), memory: new InMemoryMemoryService(), settings: new InMemoryActorSettingStore() },
  });
  assert.deepEqual(Object.keys(memoryOnly.manifest.provides), ["agentic.memory@1"]);
});
