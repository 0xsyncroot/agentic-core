import { createHash } from "node:crypto";
import { CAPABILITIES, type ActorSettingStore, type BlindIndexEncoder, type MemoryService, type PayloadProtector, type SessionStore } from "@0xsyncroot/contracts";
import { InMemoryActorSettingStore, InMemoryMemoryService, InMemorySessionStore } from "@0xsyncroot/persistence-memory";
import { createMySqlPersistence } from "@0xsyncroot/persistence-mysql";
import { connectRedisPersistence } from "@0xsyncroot/persistence-redis";
import { createPostgresPersistence } from "@0xsyncroot/persistence-postgres";
import { createSqlServerPersistence } from "@0xsyncroot/persistence-sqlserver";
import { ACTOR_SETTING_CAPABILITY, MEMORY_CAPABILITY, SESSION_CAPABILITY, type AgentPlugin, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import type { PersistenceProvider, PersistenceSelection, RuntimeSecrets, SessionRedisSettings } from "../runtime-config.js";

type StorageProtector = PayloadProtector & BlindIndexEncoder;
export type PersistenceRole = "sessions" | "memory";

export interface PersistenceResource {
  readonly sessions: SessionStore;
  readonly memory: MemoryService;
  /**
   * Per-person settings, kept by the engine that keeps the sessions and published with them. Every engine has it, so a
   * deployment that changes its database keeps its users' settings working.
   */
  readonly settings: ActorSettingStore;
  close?(): Promise<void>;
}

export interface PersistenceOpenInput {
  readonly connectionUrl?: string;
  readonly protector?: StorageProtector;
  /** MySQL connection pool size (env `AGENTIC_MYSQL_POOL_SIZE`). The other engines ignore it. */
  readonly poolSize?: number;
  /** Prefix, plaintext switch and expiry of the Redis session store. The other engines ignore it. */
  readonly sessionRedis?: SessionRedisSettings;
}

export type PersistenceProviderFactory = (input: PersistenceOpenInput) => Promise<PersistenceResource>;

interface PersistenceResourceEntry {
  readonly resource: Promise<PersistenceResource>;
  registrations: number;
}

/**
 * Composition-instance owner for persistence connections. Plugins only register a
 * non-owning use of a resource, so reconfiguring a host cannot close a pool
 * that is shared by another persistence role.
 */
export class PersistenceResourceRegistry {
  readonly #entries = new Map<string, PersistenceResourceEntry>();
  #state: "open" | "closing" | "close-failed" | "closed" = "open";
  #closing: Promise<void> | undefined;

  get size(): number { return this.#entries.size; }

  open(dataSourceId: string, factory: () => Promise<PersistenceResource>): Promise<PersistenceResource> {
    if (!dataSourceId) throw new Error("Persistence dataSourceId is required");
    if (this.#state !== "open") throw new Error(`Persistence resource registry is ${this.#state}`);
    const existing = this.#entries.get(dataSourceId);
    if (existing) return existing.resource;

    const resource = Promise.resolve().then(factory);
    const entry: PersistenceResourceEntry = { resource, registrations: 0 };
    this.#entries.set(dataSourceId, entry);
    void resource.catch(() => {
      if (this.#state === "open" && this.#entries.get(dataSourceId) === entry && entry.registrations === 0) {
        this.#entries.delete(dataSourceId);
      }
    });
    return resource;
  }

  register(dataSourceId: string): () => void {
    if (this.#state !== "open") throw new Error(`Persistence resource registry is ${this.#state}`);
    const entry = this.#entries.get(dataSourceId);
    if (!entry) throw new Error(`Persistence resource is not open: ${dataSourceId}`);
    entry.registrations += 1;
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      entry.registrations -= 1;
    };
  }

  closeAll(): Promise<void> {
    if (this.#state === "closed") return Promise.resolve();
    if (this.#closing) return this.#closing;
    const active = [...this.#entries.entries()].filter(([, entry]) => entry.registrations > 0);
    if (active.length > 0) {
      return Promise.reject(new Error(`Cannot close persistence resources with active registrations: ${active.map(([id]) => id).join(", ")}`));
    }

    this.#state = "closing";
    const operation = (async () => {
      const errors: unknown[] = [];
      for (const [dataSourceId, entry] of this.#entries) {
        let resource: PersistenceResource;
        try {
          resource = await entry.resource;
        } catch {
          // A resource that never opened has no live handle to retain or close.
          this.#entries.delete(dataSourceId);
          continue;
        }
        try {
          await resource.close?.();
          this.#entries.delete(dataSourceId);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        this.#state = "close-failed";
        throw new AggregateError(errors, "Closing persistence resources failed");
      }
      this.#state = "closed";
    })();
    this.#closing = operation.then(
      () => { this.#closing = undefined; },
      (error: unknown) => { this.#closing = undefined; throw error; },
    );
    return this.#closing;
  }
}

export function persistenceDataSourceId(provider: PersistenceProvider, connectionUrl?: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([provider, connectionUrl ?? null]))
    .digest("hex")
    .slice(0, 24);
  return `${provider}:${digest}`;
}

function durableUrl(input: PersistenceOpenInput, provider: PersistenceProvider): string {
  if (!input.connectionUrl) throw new Error(`Database URL is required for ${provider}`);
  return input.connectionUrl;
}

const PERSISTENCE_PROVIDERS: Readonly<Record<PersistenceProvider, PersistenceProviderFactory>> = Object.freeze({
  memory: async () => ({ sessions: new InMemorySessionStore(), memory: new InMemoryMemoryService(), settings: new InMemoryActorSettingStore() }),
  postgres: async (input) => createPostgresPersistence(durableUrl(input, "postgres"), input.protector
    ? { payloadProtector: input.protector, blindIndex: input.protector }
    : {}),
  mysql: async (input) => createMySqlPersistence(durableUrl(input, "mysql"), {
    ...(input.protector ? { payloadProtector: input.protector, blindIndex: input.protector } : {}),
    ...(input.poolSize !== undefined ? { poolSize: input.poolSize } : {}),
  }),
  // Sessions only (storage-settings rejects it for the memory role), so `memory` is never published.
  // Prefix, plaintext switch and expiry come from the composed settings, never from `process.env`.
  redis: async (input) => {
    const { sessions, settings, close } = await connectRedisPersistence({ url: durableUrl(input, "redis"), ...input.sessionRedis });
    return { sessions, memory: new InMemoryMemoryService(), settings, close };
  },
  sqlserver: async (input) => createSqlServerPersistence(durableUrl(input, "sqlserver"), input.protector
    ? { payloadProtector: input.protector, blindIndex: input.protector }
    : {}),
});

export interface PersistencePluginOptions {
  readonly provider: PersistenceProvider;
  readonly roles: readonly PersistenceRole[];
  readonly dataSourceId: string;
  readonly resource: PersistenceResource;
  readonly registry: PersistenceResourceRegistry;
}

/**
 * Publishes non-owning persistence capabilities. The process registry owns
 * connection disposal after all plugin hosts have stopped using the resource.
 */
export function createPersistencePlugin(options: PersistencePluginOptions): PluginDescriptor {
  if (options.roles.length === 0) throw new Error("Persistence plugin requires at least one role");
  const roles = [...new Set(options.roles)];
  const suffix = roles.length === 2 ? "bundle" : roles[0];
  const id = `io.syncroot.persistence.${options.provider}.${suffix}`;
  // The settings travel with the sessions: the engine that keeps a person's conversations keeps their settings.
  const provides = Object.fromEntries(roles.flatMap((role) => role === "sessions" ? [CAPABILITIES.sessions, CAPABILITIES.actorSettings] : [CAPABILITIES.memory])
    .map((capability) => [capability, { version: "1.0.0", cardinality: "single" as const }]));
  let active: PersistenceResource | undefined;
  const plugin: AgentPlugin = {
    validate: async () => ({ valid: true }),
    activate: async (context) => {
      const unregister = options.registry.register(options.dataSourceId);
      try {
        if (roles.includes("sessions")) {
          context.registrations.provide(SESSION_CAPABILITY, options.resource.sessions);
          context.registrations.provide(ACTOR_SETTING_CAPABILITY, options.resource.settings);
        }
        if (roles.includes("memory")) context.registrations.provide(MEMORY_CAPABILITY, options.resource.memory);
        active = options.resource;
      } catch (error) {
        unregister();
        throw error;
      }
      return {
        dispose: () => {
          active = undefined;
          unregister();
        },
      };
    },
    health: async () => ({ healthy: active !== undefined, ...(!active ? { detail: "not active" } : {}) }),
  };
  return {
    trustTier: "platform-core",
    manifest: {
      manifestVersion: 1,
      id,
      version: "0.1.0",
      publisher: "Agentic Platform",
      coreApi: "^1.0.0",
      artifact: { digest: `builtin:${id}@0.1.0`, signature: "trusted-assembly" },
      requires: {},
      provides,
      permissions: {},
    },
    plugin,
    config: { provider: options.provider, roles, dataSourceId: options.dataSourceId },
  };
}

function urlFor(role: PersistenceRole, secrets: RuntimeSecrets): string | undefined {
  return secrets.persistenceUrls[role];
}

async function openResource(
  registry: PersistenceResourceRegistry,
  provider: PersistenceProvider,
  connectionUrl: string | undefined,
  protector: StorageProtector | undefined,
  poolSize: number | undefined,
  sessionRedis?: SessionRedisSettings,
): Promise<{ readonly dataSourceId: string; readonly resource: PersistenceResource }> {
  const dataSourceId = persistenceDataSourceId(provider, connectionUrl);
  const resource = await registry.open(dataSourceId, () => PERSISTENCE_PROVIDERS[provider]({
    ...(connectionUrl ? { connectionUrl } : {}),
    ...(protector ? { protector } : {}),
    ...(poolSize !== undefined ? { poolSize } : {}),
    ...(sessionRedis ? { sessionRedis } : {}),
  }));
  return { dataSourceId, resource };
}

export async function createPersistencePlugins(
  selection: PersistenceSelection,
  secrets: RuntimeSecrets,
  registry: PersistenceResourceRegistry,
  protector?: StorageProtector,
  /** MySQL pool size (env `AGENTIC_MYSQL_POOL_SIZE`); the other engines ignore it. */
  poolSize?: number,
  /** Redis session store settings (`config.sessionRedis`); the other engines ignore them. */
  sessionRedis?: SessionRedisSettings,
): Promise<readonly PluginDescriptor[]> {
  const sameProvider = selection.sessions === selection.memory;
  const sessionUrl = urlFor("sessions", secrets);
  const memoryUrl = urlFor("memory", secrets);
  const sameUrl = sessionUrl === memoryUrl;
  if (sameProvider && sameUrl) {
    const opened = await openResource(registry, selection.sessions, sessionUrl, protector, poolSize, sessionRedis);
    return [createPersistencePlugin({
      provider: selection.sessions,
      roles: ["sessions", "memory"],
      ...opened,
      registry,
    })];
  }
  return Promise.all((["sessions", "memory"] as const).map(async (role) => {
    const connectionUrl = role === "sessions" ? sessionUrl : memoryUrl;
    const opened = await openResource(registry, selection[role], connectionUrl, protector, poolSize, sessionRedis);
    return createPersistencePlugin({
      provider: selection[role],
      roles: [role],
      ...opened,
      registry,
    });
  }));
}
