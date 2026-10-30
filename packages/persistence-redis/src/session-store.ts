import { checkRedisUrl, connectRedis, type RedisCommands } from "@0xsyncroot/redis-connection";
import type {
  EventDraft, SecurityContext, SessionContextView, SessionDirectoryEntry, SessionDirectoryQuery, SessionEvent, SessionStore,
  TurnClaimCommand, TurnClaimResult, TurnLease,
} from "@0xsyncroot/contracts";
import { AgenticError, MAX_SESSION_READ_EVENTS } from "@0xsyncroot/contracts";
import {
  appendFailure, buildBatch, num, parseEvent, R, resolveOptions, StoreCore, type RedisSessionStoreOptions, type WriteContext,
} from "./core.js";
import { indexSession, listSessions } from "./directory.js";
import { sessionKeys, type SessionKeys } from "./keys.js";
import { APPEND } from "./lua-append.js";
import { READ } from "./lua-read.js";
import { claimTurn, renewTurn, writeLeased } from "./turns.js";

export interface RedisSessionStoreConnection extends RedisSessionStoreOptions {
  readonly url: string;
  /**
   * Allows plaintext (`redis…://`). Off unless the deployment says so: the journal is tenant data,
   * and a store that quietly accepted plaintext would make TLS an accident of the URL.
   */
  readonly allowInsecureInternal?: boolean;
  readonly connectTimeoutMs?: number;
  readonly onError?: (error: Error) => void;
}

function keyList(keys: SessionKeys): string[] { return [keys.meta, keys.events, keys.idem, keys.turns, keys.ckpt]; }

/**
 * Session journal in Redis, with the same observable behaviour as `InMemorySessionStore`.
 *
 * Each session is five keys under one hash tag, written only by Lua scripts, so an append, claim,
 * renewal or finish is one atomic step. Every write refreshes an idle expiry, which bounds the
 * memory a deployment needs; run Redis with AOF and `maxmemory-policy noeviction`, because an
 * eviction would silently drop journal events where a TTL only retires whole idle sessions.
 */
export class RedisSessionStore implements SessionStore {
  static readonly MAX_CONTEXT_EVENTS = MAX_SESSION_READ_EVENTS;
  readonly #core: StoreCore;

  constructor(client: RedisCommands, options: RedisSessionStoreOptions = {}) {
    this.#core = new StoreCore(client, resolveOptions(options));
  }

  /** Connects with a client the store owns (one node, Cluster or Sentinel by URL scheme); `close()` releases it. */
  static async connect(connection: RedisSessionStoreConnection): Promise<RedisSessionStore & { close(): Promise<void> }> {
    const allowInsecureInternal = connection.allowInsecureInternal ?? false;
    // A malformed URL or plaintext without consent is a deployment mistake, not an outage: it is
    // reported as such instead of as a retryable connection failure.
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
    const store = new RedisSessionStore(redis.commands, connection);
    return Object.assign(store, { close: async () => { redis.destroy(); } });
  }

  #keys(security: SecurityContext, sessionId: string): SessionKeys {
    return sessionKeys(this.#core.options.prefix, security.tenantId, sessionId);
  }

  async #read(sessionId: string, security: SecurityContext, mode: string, a: number, b = 0): Promise<unknown[]> {
    const reply = await this.#core.run(READ, keyList(this.#keys(security, sessionId)), [security.actorId, mode, String(a), String(b)]);
    if (num(reply[0]) !== R.ok) throw appendFailure(num(reply[0]), 0, 0, sessionId);
    return reply;
  }

  async append(sessionId: string, expectedSeq: number, drafts: readonly EventDraft[], idempotencyKey: string, context: WriteContext): Promise<number> {
    const { security } = context;
    const batch = buildBatch(sessionId, expectedSeq, drafts, context);
    const { sessionTtl, idemTtl } = this.#core.options;
    const reply = await this.#core.run(APPEND, keyList(this.#keys(security, sessionId)), [
      security.actorId, String(sessionTtl), String(idemTtl), String(expectedSeq), batch.fingerprint, idempotencyKey,
      batch.checkpoint, batch.created, batch.input, ...batch.events,
    ]);
    const code = num(reply[0]);
    if (code !== R.ok) throw appendFailure(code, expectedSeq, reply[1], "");
    if (reply[2]) await indexSession(this.#core, security, sessionId, String(reply[2]));
    return num(reply[1]);
  }

  claimTurn(command: TurnClaimCommand, context: WriteContext): Promise<TurnClaimResult> { return claimTurn(this.#core, command, context); }

  appendLeased(lease: TurnLease, expectedSeq: number, drafts: readonly EventDraft[], idempotencyKey: string, context: WriteContext): Promise<number> {
    return writeLeased(this.#core, { mode: "append", lease, expectedSeq, drafts, idempotencyKey, context });
  }

  renewTurn(lease: TurnLease, ttlMs: number, security: SecurityContext): Promise<TurnLease> { return renewTurn(this.#core, lease, ttlMs, security); }

  finishTurn(lease: TurnLease, expectedSeq: number, terminal: EventDraft, context: WriteContext): Promise<number> {
    const valid = terminal.turnId === lease.turnId && (terminal.type === "turn/end" || terminal.type === "turn/failed");
    const code = terminal.type === "turn/failed" ? String((terminal.payload as Record<string, unknown> | null)?.code ?? "failed") : "";
    return writeLeased(this.#core, {
      mode: "finish", lease, expectedSeq, drafts: [terminal], idempotencyKey: `turn-terminal:${lease.turnId}`, context,
      terminal: { valid, status: terminal.type === "turn/end" ? "completed" : "failed", errorCode: code },
    });
  }

  listSessions(query: SessionDirectoryQuery, security: SecurityContext): Promise<readonly SessionDirectoryEntry[]> {
    return listSessions(this.#core, query, security);
  }

  async load(sessionId: string, security: SecurityContext): Promise<readonly SessionEvent[]> {
    return ((await this.#read(sessionId, security, "all", 0))[1] as unknown[]).map(parseEvent);
  }

  async loadRecent(sessionId: string, limit: number, security: SecurityContext): Promise<readonly SessionEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > RedisSessionStore.MAX_CONTEXT_EVENTS) {
      throw new AgenticError("validation", `Session recent-event limit must be from 1 to ${RedisSessionStore.MAX_CONTEXT_EVENTS}`);
    }
    return ((await this.#read(sessionId, security, "recent", limit))[1] as unknown[]).map(parseEvent);
  }

  async loadSince(sessionId: string, afterSeq: number, security: SecurityContext, limit: number): Promise<readonly SessionEvent[]> {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new AgenticError("validation", "Session afterSeq must be a non-negative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > RedisSessionStore.MAX_CONTEXT_EVENTS) {
      throw new AgenticError("validation", `Session since-event limit must be from 1 to ${RedisSessionStore.MAX_CONTEXT_EVENTS}`);
    }
    // Sequences are dense and start at 1, so the event with seq n sits at list index n - 1.
    return ((await this.#read(sessionId, security, "since", afterSeq, limit))[1] as unknown[]).map(parseEvent);
  }

  async loadContext(sessionId: string, security: SecurityContext): Promise<SessionContextView> {
    const reply = await this.#read(sessionId, security, "context", RedisSessionStore.MAX_CONTEXT_EVENTS + 1);
    const raw = (reply[1] as unknown[]).map(parseEvent);
    const checkpoint = reply[2] ? parseEvent(reply[2]) : undefined;
    const truncated = raw.length > RedisSessionStore.MAX_CONTEXT_EVENTS;
    const events = truncated ? raw.slice(1) : raw;
    const truncatedBeforeSeq = truncated ? events[0]?.seq : undefined;
    return {
      ...(checkpoint ? { checkpoint } : {}), events,
      ...(truncatedBeforeSeq !== undefined ? { truncatedBeforeSeq } : {}),
    };
  }
}
