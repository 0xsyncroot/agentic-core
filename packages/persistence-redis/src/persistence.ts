import { checkRedisUrl, connectRedis } from "@0xsyncroot/redis-connection";
import { AgenticError } from "@0xsyncroot/contracts";
import { RedisActorSettingStore } from "./actor-settings.js";
import { RedisSessionStore, type RedisSessionStoreConnection } from "./session-store.js";

export interface RedisPersistence {
  readonly sessions: RedisSessionStore;
  readonly settings: RedisActorSettingStore;
  close(): Promise<void>;
}

/**
 * The sessions and the per-person settings on one connection the caller owns, under one key prefix. Same checks as
 * `RedisSessionStore.connect`: a malformed or plaintext URL without consent is a deployment mistake, said as such.
 */
export async function connectRedisPersistence(connection: RedisSessionStoreConnection): Promise<RedisPersistence> {
  const allowInsecureInternal = connection.allowInsecureInternal ?? false;
  checkRedisUrl(connection.url, { purpose: "Session", allowInsecureInternal });
  let redis;
  try {
    redis = await connectRedis(connection.url, {
      purpose: "Session", allowInsecureInternal,
      ...(connection.connectTimeoutMs !== undefined ? { connectTimeoutMs: connection.connectTimeoutMs } : {}),
      ...(connection.onError ? { onError: connection.onError } : {}),
    });
  } catch (error) {
    throw new AgenticError("transient", "Could not connect the session store to Redis", true, { cause: error });
  }
  return {
    sessions: new RedisSessionStore(redis.commands, connection),
    settings: new RedisActorSettingStore(redis.commands, connection.keyPrefix !== undefined ? { keyPrefix: connection.keyPrefix } : {}),
    close: async () => { redis.destroy(); },
  };
}
