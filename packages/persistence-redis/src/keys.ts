export interface SessionKeys {
  /** Hash: owner, head seq, created, input, profile, fence counter and the active lease fields. */
  readonly meta: string;
  /** List: one JSON event per element; element i holds seq i + 1. */
  readonly events: string;
  /** Hash: idempotency key -> {fp, seq}. Expires sooner than the rest of the session. */
  readonly idem: string;
  /** Hash: turn request key -> JSON request state. */
  readonly turns: string;
  /** String: JSON of the latest context checkpoint event. */
  readonly ckpt: string;
}

/**
 * Every key of one session shares the hash tag `{tenant:session}`, so a Lua script can touch
 * all of them in one slot on Redis Cluster. Tenant and session ids are percent-encoded: a
 * brace or colon inside an id must not move a key into another tag or merge two sessions.
 */
export function sessionKeys(prefix: string, tenantId: string, sessionId: string): SessionKeys {
  const tag = `{${encodeURIComponent(tenantId)}:${encodeURIComponent(sessionId)}}`;
  return {
    meta: `${prefix}${tag}:meta`, events: `${prefix}${tag}:events`, idem: `${prefix}${tag}:idem`,
    turns: `${prefix}${tag}:turns`, ckpt: `${prefix}${tag}:ckpt`,
  };
}

/** Sorted set of one owner's sessions; a separate slot because it spans sessions. */
export function directoryKey(prefix: string, tenantId: string, actorId: string): string {
  return `${prefix}{${encodeURIComponent(tenantId)}|${encodeURIComponent(actorId)}}:dir`;
}
