import { randomUUID } from "node:crypto";
import type { RedisCommands } from "@0xsyncroot/redis-connection";
import type { EventDraft, RuntimeSnapshot, SecurityContext, SessionEvent } from "@0xsyncroot/contracts";
import { AgenticError, snapshotEventDraft } from "@0xsyncroot/contracts";
import { sha1, sha256 } from "./hash.js";

export interface WriteContext { readonly security: SecurityContext; readonly runtime: RuntimeSnapshot }

export interface RedisSessionStoreOptions {
  /** Prefix of every key. Change it to share one Redis between environments. */
  readonly keyPrefix?: string;
  /** Idle lifetime of a session's keys, refreshed on every write. Default 30 days. */
  readonly sessionTtlSeconds?: number;
  /** Idle lifetime of the idempotency records of a session, refreshed on every write. Default 24 hours. */
  readonly idempotencyTtlSeconds?: number;
}

export interface ResolvedOptions { readonly prefix: string; readonly sessionTtl: number; readonly idemTtl: number }

export const DEFAULT_KEY_PREFIX = "gateway:session:v1:";
export const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 3600;
export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 3600;

export function resolveOptions(options: RedisSessionStoreOptions): ResolvedOptions {
  const sessionTtl = options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const idemTtl = Math.min(options.idempotencyTtlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS, sessionTtl);
  if (!Number.isInteger(sessionTtl) || sessionTtl < 1) throw new Error("sessionTtlSeconds must be a positive integer");
  if (!Number.isInteger(idemTtl) || idemTtl < 1) throw new Error("idempotencyTtlSeconds must be a positive integer");
  return { prefix: options.keyPrefix ?? DEFAULT_KEY_PREFIX, sessionTtl, idemTtl };
}

export interface LuaScript { readonly source: string; readonly sha: string }
export function defineScript(source: string): LuaScript { return { source, sha: sha1(source) }; }

/** The pieces every store operation shares: the client, the resolved options and script dispatch. */
export class StoreCore {
  constructor(readonly client: RedisCommands, readonly options: ResolvedOptions) {}

  /** EVALSHA first; a server that has not seen the script (restart, failover) gets the source once. */
  async run(script: LuaScript, keys: readonly string[], args: readonly string[]): Promise<unknown[]> {
    const command = { keys: [...keys], arguments: [...args] };
    let reply: unknown;
    try {
      reply = await this.client.evalSha(script.sha, command);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
      reply = await this.client.eval(script.source, command);
    }
    if (!Array.isArray(reply)) throw new AgenticError("transient", "Redis session script returned an unexpected reply", true);
    return reply as unknown[];
  }
}

export function freezeDeep<T>(value: T): T {
  const pending: object[] = [];
  if (value && typeof value === "object") pending.push(value);
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const child of Object.values(current)) if (child && typeof child === "object") pending.push(child);
    Object.freeze(current);
  }
  return value;
}

export function parseEvent(json: unknown): SessionEvent { return freezeDeep(JSON.parse(String(json)) as SessionEvent); }

/** Events of one write, serialized for the script, plus what the script and the directory need. */
export interface Batch {
  readonly events: readonly string[];
  readonly fingerprint: string;
  /** JSON of the last context checkpoint in the batch, or "". */
  readonly checkpoint: string;
  /** recordedAt of the first event, or "" for an empty batch. */
  readonly created: string;
  /** JSON payload of the first user/input event in the batch, or "". */
  readonly input: string;
  readonly hasInput: boolean;
}

/**
 * Builds the events the way the memory store does. The script only checks that the head equals
 * `expectedSeq`, so the sequence numbers are already known here and need no server round trip.
 */
export function buildBatch(sessionId: string, expectedSeq: number, drafts: readonly EventDraft[], context: WriteContext): Batch {
  const safeDrafts = drafts.map(snapshotEventDraft);
  const fingerprint = sha256({
    expectedSeq, drafts: safeDrafts, tenantId: context.security.tenantId, actorId: context.security.actorId,
    runtimeSnapshotId: context.runtime.id,
  });
  const recordedAt = new Date().toISOString();
  const events = safeDrafts.map((draft, index): SessionEvent => {
    const base = {
      ...draft, eventId: randomUUID(), sessionId, seq: expectedSeq + index + 1,
      schemaVersion: draft.schemaVersion ?? 1, occurredAt: recordedAt, recordedAt,
      tenantId: context.security.tenantId, actorId: context.security.actorId,
      correlationId: context.security.correlationId, runtimeSnapshotId: context.runtime.id,
      classification: draft.classification ?? "internal" as const,
    };
    return { ...base, integrityHash: sha256(base) };
  });
  const checkpoint = [...events].reverse().find((event) => event.type === "context/checkpoint");
  const input = events.find((event) => event.type === "user/input");
  return {
    events: events.map((event) => JSON.stringify(event)), fingerprint,
    checkpoint: checkpoint ? JSON.stringify(checkpoint) : "",
    created: events[0]?.recordedAt ?? "", input: input ? JSON.stringify(input.payload) : "", hasInput: input !== undefined,
  };
}

/** Result codes shared by the Lua scripts. */
export const R = {
  ok: 0, idempotency: 1, cas: 2, unleased: 3, leaseLost: 4, owner: 5, leaseExpired: 6, noSession: 7,
  profile: 8, invalidTerminal: 9, repair: 10, completed: 11, inProgress: 12, failed: 13, requestReuse: 14, stale: 16,
} as const;

export function num(value: unknown): number { return Number(value); }

/** Maps a failure code of an append-like script to the error the memory store throws. */
export function appendFailure(code: number, expected: number, head: unknown, turnId: string): AgenticError {
  switch (code) {
    case R.idempotency: return new AgenticError("conflict", "Idempotency key was reused with a different append operation");
    case R.cas: return new AgenticError("conflict", `Session CAS conflict: expected ${expected}, actual ${num(head)}`);
    case R.unleased: return new AgenticError("conflict", "Unleased append is forbidden while a turn owns the session");
    case R.leaseLost: return new AgenticError("conflict", `Turn lease lost: ${turnId}`);
    case R.leaseExpired: return new AgenticError("conflict", `Turn lease expired: ${turnId}`);
    case R.owner: return new AgenticError("denied", "Session owner boundary violation");
    case R.noSession: return new AgenticError("conflict", "Turn lease session does not exist");
    case R.profile: return new AgenticError("denied", "Session is bound to a different agent profile");
    case R.invalidTerminal: return new AgenticError("validation", "finishTurn requires a terminal event for the leased turn");
    case R.requestReuse: return new AgenticError("conflict", "Idempotency key was reused with a different request");
    default: return new AgenticError("transient", `Redis session script failed with code ${code}`, true);
  }
}
