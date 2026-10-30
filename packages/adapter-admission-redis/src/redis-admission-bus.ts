import { AgenticError } from "@0xsyncroot/contracts";
import { checkRedisUrl, connectRedis, type RedisConnection } from "@0xsyncroot/redis-connection";

/**
 * The three operations distributed admission needs, and nothing else.
 *
 * A narrow port rather than a Redis client handle: the decisions here are arithmetic on a
 * shared counter, so they have to be one atomic step on the server. Exposing the steps as
 * named operations keeps the Lua in one place and lets a test drive the controller without a
 * Redis server — which is the only way the expiry and contention paths get covered at all.
 */
export interface RedisAdmissionBus {
  /** True only when the counter is shared by every replica that admits turns. */
  readonly productionSafe: boolean;
  admit(input: AdmissionSlotInput): Promise<AdmissionOutcome>;
  renew(input: { readonly activeKey: string; readonly member: string; readonly ttlMs: number }): Promise<boolean>;
  release(input: { readonly activeKey: string; readonly member: string }): Promise<void>;
  close(): Promise<void>;
}

export interface AdmissionSlotInput {
  readonly activeKey: string;
  readonly rateKey: string;
  readonly member: string;
  readonly concurrencyLimit: number;
  readonly ttlMs: number;
  /** Turns allowed per window; zero disables the rate gate entirely. */
  readonly rateLimit: number;
  readonly rateWindowMs: number;
}

export type AdmissionOutcome =
  | { readonly admitted: true; readonly active: number }
  | { readonly admitted: false; readonly reason: "concurrency" | "rate"; readonly active: number };

/**
 * One atomic admission decision.
 *
 * Expired holders are swept by score before anything is counted, so a replica that died
 * mid-turn releases its slot on its own clock rather than holding the tenant's capacity until
 * someone notices. The member is derived from the caller's idempotency key, so a client
 * retrying the same turn re-enters its own slot instead of consuming a second one — which is
 * what makes a retry storm cost one slot per turn rather than one per attempt.
 *
 * `TIME` is read from the server: admission compares timestamps written by different replicas,
 * and replica clock skew would otherwise decide who is admitted.
 */
const ADMIT = `
local clock = redis.call('TIME')
local now = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local held = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not held and redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  return {0, redis.call('ZCARD', KEYS[1])}
end
if tonumber(ARGV[4]) > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[5]))
  if not held and redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then
    return {-1, redis.call('ZCARD', KEYS[1])}
  end
  if not held then
    redis.call('ZADD', KEYS[2], now, ARGV[1])
    redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[5]) + 5000)
  end
end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) + 5000)
return {1, redis.call('ZCARD', KEYS[1])}`;

const RENEW = `
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
local clock = redis.call('TIME')
local now = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) + 5000)
return 1`;

const RELEASE = `
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
return 1`;

function outcome(result: unknown): AdmissionOutcome {
  const pair = Array.isArray(result) ? result : [];
  const status = Number(pair[0] ?? 0);
  const active = Number(pair[1] ?? 0);
  if (status === 1) return { admitted: true, active };
  return { admitted: false, reason: status === -1 ? "rate" : "concurrency", active };
}

class NodeRedisAdmissionBus implements RedisAdmissionBus {
  readonly productionSafe = true;

  constructor(private readonly connection: RedisConnection) { this.commands = connection.commands; }
  private readonly commands: RedisConnection["commands"];

  async admit(input: AdmissionSlotInput): Promise<AdmissionOutcome> {
    return outcome(await this.commands.eval(ADMIT, {
      keys: [input.activeKey, input.rateKey],
      arguments: [input.member, String(input.concurrencyLimit), String(input.ttlMs),
        String(input.rateLimit), String(input.rateWindowMs)],
    }));
  }

  async renew(input: { activeKey: string; member: string; ttlMs: number }): Promise<boolean> {
    return await this.commands.eval(RENEW, {
      keys: [input.activeKey], arguments: [input.member, String(input.ttlMs)],
    }) === 1;
  }

  async release(input: { activeKey: string; member: string }): Promise<void> {
    await this.commands.eval(RELEASE, { keys: [input.activeKey], arguments: [input.member] });
  }

  async close(): Promise<void> {
    this.connection.destroy();
  }
}

export interface NodeRedisAdmissionBusOptions {
  readonly url: string;
  readonly connectTimeoutMs?: number;
  /**
   * Allows `redis://` instead of `rediss://`.
   *
   * Admission carries tenant identifiers, so plaintext is a deliberate deployment decision for
   * a private network hop, never a default.
   */
  readonly allowInsecureInternal?: boolean;
  readonly onError?: (error: Error) => void;
}

/** Validates the setting: one node, Cluster or Sentinel URL, and TLS unless plaintext is allowed. */
export function admissionRedisUrl(value: string, allowInsecureInternal: boolean): string {
  checkRedisUrl(value, { purpose: "Admission", allowInsecureInternal });
  return value.trim();
}

export async function createNodeRedisAdmissionBus(options: NodeRedisAdmissionBusOptions): Promise<RedisAdmissionBus> {
  admissionRedisUrl(options.url, options.allowInsecureInternal === true);
  try {
    return new NodeRedisAdmissionBus(await connectRedis(options.url, {
      purpose: "Admission", allowInsecureInternal: options.allowInsecureInternal === true,
      ...(options.connectTimeoutMs !== undefined ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
    }));
  } catch (error) {
    throw new AgenticError("transient", "Could not connect turn admission to Redis", true, { cause: error });
  }
}
