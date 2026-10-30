import { readRuntimeProfile, readSetting } from "@0xsyncroot/env-settings";
import { DEFAULT_KEY_PREFIX } from "@0xsyncroot/persistence-redis";
import { redisEndpoint, type RedisConcern } from "@0xsyncroot/redis-connection";

/** `redis` stores sessions only; the memory role has no Redis implementation. */
export type PersistenceProvider = "memory" | "postgres" | "mysql" | "sqlserver" | "redis";

export interface PersistenceSelection {
  readonly sessions: PersistenceProvider;
  readonly memory: PersistenceProvider;
}

export interface PersistenceUrls {
  readonly sessions?: string;
  readonly memory?: string;
}

export interface StorageSettings {
  readonly selection: PersistenceSelection;
  readonly urls: PersistenceUrls;
  /** Set only when sessions live in Redis: what the store needs besides the URL. */
  readonly sessionRedis?: SessionRedisSettings;
}

/** Key prefix, plaintext switch and expiry of the Redis session store; the store applies its own TTL defaults to what is unset. */
export interface SessionRedisSettings {
  readonly keyPrefix: string;
  readonly allowInsecureInternal: boolean;
  readonly sessionTtlSeconds?: number;
  readonly idempotencyTtlSeconds?: number;
}

/**
 * The session store is one more Redis concern on the shared topology: `SESSION_REDIS_URL`, else
 * the `REDIS_URL` every product's concerns fall back to, and the one `REDIS_ALLOW_INSECURE_INTERNAL`.
 */
const SESSION_REDIS: RedisConcern = Object.freeze({ id: "session", defaultKeyPrefix: DEFAULT_KEY_PREFIX });

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function configuredProvider(value: string | undefined, setting: string): PersistenceProvider | undefined {
  const normalized = optional(value)?.toLowerCase();
  if (normalized === undefined) return undefined;
  if (normalized === "memory" || normalized === "postgres" || normalized === "mysql" || normalized === "sqlserver" || normalized === "redis") {
    return normalized;
  }
  throw new Error(`Unsupported ${setting}: ${normalized}`);
}

function inferredProvider(url: string | undefined, label: string): PersistenceProvider {
  if (!url) return "memory";
  // Cluster and Sentinel URLs carry a comma host list, which WHATWG URL cannot parse.
  if (/^rediss?(\+cluster|\+sentinel)?:\/\//iu.test(url)) return "redis";
  const protocol = new URL(url).protocol;
  if (protocol === "postgres:" || protocol === "postgresql:") return "postgres";
  if (protocol === "mysql:") return "mysql";
  if (protocol === "sqlserver:" || protocol === "mssql:") return "sqlserver";
  if (protocol === "redis:" || protocol === "rediss:") return "redis";
  throw new Error(`Cannot infer ${label} provider from database URL protocol ${protocol}`);
}

function requireUrl(provider: PersistenceProvider, url: string | undefined, label: string): void {
  if (provider !== "memory" && !url) throw new Error(`${label} database URL is required for ${provider}`);
}

/**
 * Resolves independently replaceable session and memory ports. Legacy common
 * settings remain a fallback, while role-specific settings always win.
 */
export function readStorageSettings(env: NodeJS.ProcessEnv): StorageSettings {
  const commonUrl = optional(env.DATABASE_URL);
  const sessionDatabaseUrl = optional(env.SESSION_DATABASE_URL) ?? commonUrl;
  const memoryUrl = optional(env.MEMORY_DATABASE_URL) ?? commonUrl;
  const commonProvider = configuredProvider(env.AGENTIC_PERSISTENCE_PROVIDER, "AGENTIC_PERSISTENCE_PROVIDER");
  const sessions = configuredProvider(env.AGENTIC_SESSION_STORE_PROVIDER, "AGENTIC_SESSION_STORE_PROVIDER")
    ?? commonProvider
    ?? inferredProvider(sessionDatabaseUrl, "session store");
  // A Redis session store takes its own URL: DATABASE_URL belongs to the SQL engine behind it.
  // Development allows plaintext to loopback hosts without the switch, as every Redis concern does.
  const redis = sessions === "redis" ? redisEndpoint(env, SESSION_REDIS, { development: readRuntimeProfile(env) === "development" }) : undefined;
  const sessionUrl = sessions === "redis" ? redis?.url : sessionDatabaseUrl;
  const memory = configuredProvider(env.AGENTIC_MEMORY_STORE_PROVIDER, "AGENTIC_MEMORY_STORE_PROVIDER")
    ?? commonProvider
    ?? inferredProvider(memoryUrl, "memory store");

  if (memory === "redis") throw new Error("Redis stores sessions only; choose another provider for the memory store");
  if (sessions === "redis" && !redis) throw new Error("SESSION_REDIS_URL or REDIS_URL is required for the Redis session store");
  requireUrl(sessions, sessionUrl, "Session store");
  requireUrl(memory, memoryUrl, "Memory store");
  return Object.freeze({
    selection: Object.freeze({ sessions, memory }),
    urls: Object.freeze({
      ...(sessionUrl ? { sessions: sessionUrl } : {}),
      ...(memoryUrl ? { memory: memoryUrl } : {}),
    }),
    ...(redis ? { sessionRedis: sessionRedisSettings(env, redis.keyPrefix, redis.allowInsecureInternal) } : {}),
  });
}

function positiveSeconds(value: string | undefined, setting: string): number | undefined {
  const raw = optional(value);
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1) throw new Error(`${setting} must be a positive integer number of seconds`);
  return seconds;
}

// Read from the environment the runtime was composed with, never from `process.env`: a product
// composes its own copy, and a setting it removed or overrode must not come back from the process.
function sessionRedisSettings(env: NodeJS.ProcessEnv, keyPrefix: string, allowInsecureInternal: boolean): SessionRedisSettings {
  const sessionTtlSeconds = positiveSeconds(readSetting(env, "AGENTIC_SESSION_TTL_SECONDS"), "AGENTIC_SESSION_TTL_SECONDS");
  const idempotencyTtlSeconds = positiveSeconds(readSetting(env, "AGENTIC_SESSION_IDEMPOTENCY_TTL_SECONDS"), "AGENTIC_SESSION_IDEMPOTENCY_TTL_SECONDS");
  return Object.freeze({
    keyPrefix, allowInsecureInternal,
    ...(sessionTtlSeconds ? { sessionTtlSeconds } : {}),
    ...(idempotencyTtlSeconds ? { idempotencyTtlSeconds } : {}),
  });
}
