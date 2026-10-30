import { randomUUID } from "node:crypto";
import type { RedisCommands } from "@0xsyncroot/redis-connection";
import { AgenticError, actorSettingConflict, assertActorSettingInput, type ActorSetting, type ActorSettingScope, type ActorSettingStore } from "@0xsyncroot/contracts";
import { DEFAULT_KEY_PREFIX, defineScript } from "./core.js";

/**
 * One hash per person, `{tenant|actor}:settings`, beside their session directory: ids are percent-encoded, so a `|`, brace
 * or colon inside one cannot move a key into another person's tag. It carries no expiry: a setting is kept until it is
 * changed (run Redis with AOF and `noeviction`, as for the journal).
 */
export function actorSettingsKey(prefix: string, tenantId: string, actorId: string): string {
  return `${prefix}{${encodeURIComponent(tenantId)}|${encodeURIComponent(actorId)}}:settings`;
}

// ARGV: field, record JSON, expected revision ("" = any). Compares the stored revision and writes in one step.
const PUT = defineScript(`
local current = redis.call('HGET', KEYS[1], ARGV[1])
if ARGV[3] ~= '' then
  if not current then return {0} end
  if cjson.decode(current).revision ~= ARGV[3] then return {0} end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return {1}
`);

function parse(key: string, text: string): ActorSetting {
  const stored = JSON.parse(text) as Partial<ActorSetting>;
  if (typeof stored.value !== "string" || typeof stored.revision !== "string" || typeof stored.updatedAt !== "string") {
    throw new AgenticError("permanent", `Actor setting ${key} is unreadable`);
  }
  return Object.freeze({ key, value: stored.value, revision: stored.revision, updatedAt: stored.updatedAt });
}

/** Per-person settings in Redis, with the observable behaviour of the SQL engines (the shared conformance cases). */
export class RedisActorSettingStore implements ActorSettingStore {
  readonly #prefix: string;

  /** `keyPrefix`: the session store's, so one setting moves an environment's sessions and settings together. */
  constructor(private readonly client: RedisCommands, options: { readonly keyPrefix?: string } = {}) {
    this.#prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  async get(scope: ActorSettingScope, key: string): Promise<ActorSetting | undefined> {
    assertActorSettingInput(scope, key);
    const text = await this.client.hGet(actorSettingsKey(this.#prefix, scope.tenantId, scope.actorId), key);
    return typeof text === "string" ? parse(key, text) : undefined;
  }

  async put(scope: ActorSettingScope, key: string, value: string, expectedRevision?: string): Promise<ActorSetting> {
    assertActorSettingInput(scope, key, value, expectedRevision);
    const setting = Object.freeze({ key, value, revision: randomUUID(), updatedAt: new Date().toISOString() });
    const record = JSON.stringify({ value, revision: setting.revision, updatedAt: setting.updatedAt });
    const command = { keys: [actorSettingsKey(this.#prefix, scope.tenantId, scope.actorId)], arguments: [key, record, expectedRevision ?? ""] };
    let reply: unknown;
    try { reply = await this.client.evalSha(PUT.sha, command); } catch (error) {
      // A server that has not seen the script (restart, failover) gets its source once.
      if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
      reply = await this.client.eval(PUT.source, command);
    }
    if (!Array.isArray(reply)) throw new AgenticError("transient", "Redis actor setting script returned an unexpected reply", true);
    if (Number(reply[0]) !== 1) throw actorSettingConflict(key);
    return setting;
  }
}
