import { AgenticError } from "../errors/agentic-error.js";

/** Whose setting: one person within one tenant, as their verified identity names them. */
export interface ActorSettingScope {
  readonly tenantId: string;
  readonly actorId: string;
}

/**
 * One named setting of one person. `value` is always text: a product stores its own enumeration ("ask", "standing"),
 * never a boolean, because engines hand flags back in their own spelling (MySQL returns "0" and "1", and `Boolean("0")`
 * is true). `revision` changes on every write; `updatedAt` is ISO 8601.
 */
export interface ActorSetting {
  readonly key: string;
  readonly value: string;
  readonly revision: string;
  readonly updatedAt: string;
}

/**
 * Durable per-person settings, kept by every persistence engine beside the sessions. Settings are few and small, read on
 * the hot path through whatever cache a product puts in front of them, and written when the person changes one.
 */
export interface ActorSettingStore {
  get(scope: ActorSettingScope, key: string): Promise<ActorSetting | undefined>;
  /**
   * Writes `value` and returns the stored setting with a new revision. With `expectedRevision` the write happens only
   * while the stored setting still carries that revision (a missing setting carries none): otherwise `conflict`.
   */
  put(scope: ActorSettingScope, key: string, value: string, expectedRevision?: string): Promise<ActorSetting>;
}

/** Bounds every engine holds: the narrowest column (MySQL `varchar(191)` for identities) decides them. */
export const ACTOR_SETTING_LIMITS = Object.freeze({ identityChars: 191, keyChars: 64, valueChars: 256, revisionChars: 64 });
const KEY_PATTERN = /^[a-z][a-z0-9._-]*$/u;

/** Refuses what no engine could store the same way, before any engine sees it. */
export function assertActorSettingInput(scope: ActorSettingScope, key: string, value?: unknown, expectedRevision?: unknown): void {
  for (const [name, text] of [["tenantId", scope?.tenantId], ["actorId", scope?.actorId]] as const) {
    if (typeof text !== "string" || !text.trim() || text.length > ACTOR_SETTING_LIMITS.identityChars) {
      throw new AgenticError("validation", `Actor setting ${name} must be 1 to ${ACTOR_SETTING_LIMITS.identityChars} characters`);
    }
  }
  if (typeof key !== "string" || key.length > ACTOR_SETTING_LIMITS.keyChars || !KEY_PATTERN.test(key)) {
    throw new AgenticError("validation", `Actor setting key must be 1 to ${ACTOR_SETTING_LIMITS.keyChars} lower-case characters`);
  }
  if (value !== undefined && (typeof value !== "string" || value.length > ACTOR_SETTING_LIMITS.valueChars)) {
    throw new AgenticError("validation", `Actor setting value must be text of at most ${ACTOR_SETTING_LIMITS.valueChars} characters`);
  }
  if (expectedRevision !== undefined && (typeof expectedRevision !== "string" || !expectedRevision || expectedRevision.length > ACTOR_SETTING_LIMITS.revisionChars)) {
    throw new AgenticError("validation", "Actor setting expectedRevision is invalid");
  }
}

/** The refusal every engine gives a write whose `expectedRevision` is no longer the stored one. */
export function actorSettingConflict(key: string): AgenticError {
  return new AgenticError("conflict", `Actor setting ${key} changed since it was read`);
}
