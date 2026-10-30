import { randomUUID } from "node:crypto";
import type {
  EventDraft,
  ReviewJournalSource,
  RuntimeSnapshot,
  SecurityContext,
  SessionEvent,
  SessionStore,
  TurnClaimCommand,
  TurnClaimResult,
  TurnLease,
} from "@0xsyncroot/contracts";
import { AgenticError, MAX_SESSION_READ_EVENTS } from "@0xsyncroot/contracts";
import { createInterruptedToolResults, snapshotEventDraft } from "@0xsyncroot/contracts";
import { freezeDeep } from "./freeze.js";
import { sha256 } from "./hash.js";
import { AppendClock, InMemoryReviewJournal } from "./review-journal.js";

interface SessionState {
  events: SessionEvent[];
  idempotency: Map<string, { readonly fingerprint: string; readonly resultSeq: number }>;
  tenantId: string;
  ownerActorId: string;
  agentProfileId: string | undefined;
  /** Stamped by the store's append clock whenever events are appended. */
  lastAppendedAt: string | undefined;
  fencingCounter: bigint;
  lease: TurnLease | undefined;
  activeRequestKey: string | undefined;
  turnRequests: Map<string, TurnRequestState>;
}

interface TurnRequestState {
  readonly turnId: string;
  readonly fingerprint: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly runtimeSnapshotId: string;
  status: "running" | "completed" | "failed" | "interrupted";
  resultSeq?: number;
  errorCode?: string;
}

export class InMemorySessionStore implements SessionStore {
  static readonly MAX_CONTEXT_EVENTS = MAX_SESSION_READ_EVENTS;
  readonly #sessions = new Map<string, SessionState>();
  readonly #clock = new AppendClock();

  #sessionKey(tenantId: string, sessionId: string): string { return JSON.stringify([tenantId, sessionId]); }

  /** This store's journal as the review projector reads it: every tenant's streams, without an owner check. */
  reviewJournal(): ReviewJournalSource {
    return new InMemoryReviewJournal(() => [...this.#sessions].map(([key, state]) => ({ ...state, sessionId: (JSON.parse(key) as [string, string])[1] })));
  }

  #assertAccess(state: SessionState, security: SecurityContext): void {
    if (state.tenantId !== security.tenantId) throw new AgenticError("denied", "Tenant boundary violation for session");
    if (state.ownerActorId !== security.actorId) throw new AgenticError("denied", "Session owner boundary violation");
  }

  #createState(security: SecurityContext): SessionState {
    return {
      events: [], idempotency: new Map(), tenantId: security.tenantId, ownerActorId: security.actorId,
      agentProfileId: undefined, lastAppendedAt: undefined,
      fencingCounter: 0n, lease: undefined, activeRequestKey: undefined, turnRequests: new Map(),
    };
  }

  #appendDrafts(
    state: SessionState,
    sessionId: string,
    expectedSeq: number,
    drafts: readonly EventDraft[],
    idempotencyKey: string,
    context: { security: SecurityContext; runtime: RuntimeSnapshot },
  ): number {
    const safeDrafts = drafts.map(snapshotEventDraft);
    const operationFingerprint = sha256({
      expectedSeq, drafts: safeDrafts, tenantId: context.security.tenantId, actorId: context.security.actorId,
      runtimeSnapshotId: context.runtime.id,
    });
    const duplicate = state.idempotency.get(idempotencyKey);
    if (duplicate !== undefined) {
      if (duplicate.fingerprint !== operationFingerprint) throw new AgenticError("conflict", "Idempotency key was reused with a different append operation");
      return duplicate.resultSeq;
    }
    if (state.events.length !== expectedSeq) {
      throw new AgenticError("conflict", `Session CAS conflict: expected ${expectedSeq}, actual ${state.events.length}`);
    }
    const recordedAt = new Date().toISOString();
    const appended = safeDrafts.map((draft, index): SessionEvent => {
      const base = {
        ...draft, eventId: randomUUID(), sessionId, seq: expectedSeq + index + 1,
        schemaVersion: draft.schemaVersion ?? 1, occurredAt: recordedAt, recordedAt,
        tenantId: context.security.tenantId, actorId: context.security.actorId,
        correlationId: context.security.correlationId, runtimeSnapshotId: context.runtime.id,
        classification: draft.classification ?? "internal" as const,
      };
      return freezeDeep({ ...base, integrityHash: sha256(base) });
    });
    state.events.push(...appended);
    if (appended.length > 0) state.lastAppendedAt = this.#clock.next();
    const newSeq = state.events.length;
    state.idempotency.set(idempotencyKey, { fingerprint: operationFingerprint, resultSeq: newSeq });
    return newSeq;
  }

  #assertLease(state: SessionState, lease: TurnLease, security: SecurityContext): void {
    this.#assertAccess(state, security);
    const active = state.lease;
    if (!active || active.turnId !== lease.turnId || active.ownerId !== lease.ownerId || active.fencingToken !== lease.fencingToken) {
      throw new AgenticError("conflict", `Turn lease lost: ${lease.turnId}`);
    }
    if (Date.parse(active.expiresAt) <= Date.now()) throw new AgenticError("conflict", `Turn lease expired: ${lease.turnId}`);
  }

  #repairExpired(state: SessionState, sessionId: string, context: { security: SecurityContext; runtime: RuntimeSnapshot }): void {
    const lease = state.lease;
    if (!lease || Date.parse(lease.expiresAt) > Date.now()) return;
    const key = state.activeRequestKey;
    const request = key ? state.turnRequests.get(key) : undefined;
    if (request?.status === "running") {
      const repairRuntime = { ...context.runtime, id: request.runtimeSnapshotId };
      const repairSecurity = { ...context.security, actorId: request.actorId, correlationId: request.correlationId };
      request.resultSeq = this.#appendDrafts(
        state,
        sessionId,
        state.events.length,
        [
          ...createInterruptedToolResults(state.events.filter((event) => event.turnId === request.turnId), request.turnId),
          { type: "turn/failed", turnId: request.turnId, payload: { code: "worker-lost", message: "Turn interrupted after its worker lease expired", retryable: false, interrupted: true } },
        ],
        `turn-recovery:${request.turnId}`,
        { security: repairSecurity, runtime: repairRuntime },
      );
      request.status = "interrupted";
      request.errorCode = "worker-lost";
    }
    state.lease = undefined;
    state.activeRequestKey = undefined;
  }

  async append(
    sessionId: string,
    expectedSeq: number,
    drafts: readonly EventDraft[],
    idempotencyKey: string,
    context: { security: SecurityContext; runtime: RuntimeSnapshot },
  ): Promise<number> {
    const key = this.#sessionKey(context.security.tenantId, sessionId);
    const existing = this.#sessions.get(key);
    const state = existing ?? this.#createState(context.security);
    this.#assertAccess(state, context.security);
    if (state.lease) throw new AgenticError("conflict", "Unleased append is forbidden while a turn owns the session");
    const newSeq = this.#appendDrafts(state, sessionId, expectedSeq, drafts, idempotencyKey, context);
    this.#sessions.set(key, state);
    return newSeq;
  }

  async claimTurn(command: TurnClaimCommand, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<TurnClaimResult> {
    if (!Number.isInteger(command.leaseTtlMs) || command.leaseTtlMs <= 0) throw new AgenticError("validation", "leaseTtlMs must be a positive integer");
    const key = this.#sessionKey(context.security.tenantId, command.sessionId);
    const state = this.#sessions.get(key) ?? this.#createState(context.security);
    this.#assertAccess(state, context.security);
    const agentProfileId = command.agentProfileId ?? "default";
    if (state.agentProfileId !== undefined && state.agentProfileId !== agentProfileId) {
      throw new AgenticError("denied", "Session is bound to a different agent profile");
    }
    state.agentProfileId = agentProfileId;
    this.#repairExpired(state, command.sessionId, context);
    const prior = state.turnRequests.get(command.idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== command.requestFingerprint) throw new AgenticError("conflict", "Idempotency key was reused with a different request");
      if (prior.status === "completed") return { kind: "completed", turnId: prior.turnId, seq: prior.resultSeq ?? state.events.length };
      if (prior.status !== "running") return { kind: "failed", turnId: prior.turnId, code: prior.errorCode ?? prior.status };
      const retryAfterMs = Math.max(1, Date.parse(state.lease?.expiresAt ?? new Date().toISOString()) - Date.now());
      return { kind: "in-progress", turnId: prior.turnId, retryAfterMs };
    }
    if (state.lease) {
      return { kind: "in-progress", turnId: state.lease.turnId, retryAfterMs: Math.max(1, Date.parse(state.lease.expiresAt) - Date.now()) };
    }
    state.fencingCounter += 1n;
    const lease: TurnLease = {
      sessionId: command.sessionId, turnId: command.turnId, ownerId: command.ownerId,
      fencingToken: state.fencingCounter.toString(), expiresAt: new Date(Date.now() + command.leaseTtlMs).toISOString(),
    };
    state.lease = lease;
    state.activeRequestKey = command.idempotencyKey;
    state.turnRequests.set(command.idempotencyKey, {
      turnId: command.turnId, fingerprint: command.requestFingerprint, actorId: context.security.actorId,
      correlationId: context.security.correlationId, runtimeSnapshotId: context.runtime.id, status: "running",
    });
    const seq = this.#appendDrafts(state, command.sessionId, state.events.length, command.startEvents, `turn-claim:${command.idempotencyKey}`, context);
    this.#sessions.set(key, state);
    return { kind: "acquired", lease, seq };
  }

  async appendLeased(
    lease: TurnLease, expectedSeq: number, drafts: readonly EventDraft[], idempotencyKey: string,
    context: { security: SecurityContext; runtime: RuntimeSnapshot },
  ): Promise<number> {
    const state = this.#sessions.get(this.#sessionKey(context.security.tenantId, lease.sessionId));
    if (!state) throw new AgenticError("conflict", "Turn lease session does not exist");
    this.#assertLease(state, lease, context.security);
    return this.#appendDrafts(state, lease.sessionId, expectedSeq, drafts, idempotencyKey, context);
  }

  async renewTurn(lease: TurnLease, ttlMs: number, security: SecurityContext): Promise<TurnLease> {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new AgenticError("validation", "ttlMs must be a positive integer");
    const state = this.#sessions.get(this.#sessionKey(security.tenantId, lease.sessionId));
    if (!state) throw new AgenticError("conflict", "Turn lease session does not exist");
    this.#assertLease(state, lease, security);
    const renewed = { ...lease, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
    state.lease = renewed;
    return renewed;
  }

  async finishTurn(
    lease: TurnLease, expectedSeq: number, terminal: EventDraft,
    context: { security: SecurityContext; runtime: RuntimeSnapshot },
  ): Promise<number> {
    const state = this.#sessions.get(this.#sessionKey(context.security.tenantId, lease.sessionId));
    if (!state) throw new AgenticError("conflict", "Turn lease session does not exist");
    this.#assertLease(state, lease, context.security);
    if (terminal.turnId !== lease.turnId || (terminal.type !== "turn/end" && terminal.type !== "turn/failed")) {
      throw new AgenticError("validation", "finishTurn requires a terminal event for the leased turn");
    }
    const seq = this.#appendDrafts(state, lease.sessionId, expectedSeq, [terminal], `turn-terminal:${lease.turnId}`, context);
    const key = state.activeRequestKey;
    const request = key ? state.turnRequests.get(key) : undefined;
    if (request) {
      request.status = terminal.type === "turn/end" ? "completed" : "failed";
      request.resultSeq = seq;
      if (terminal.type === "turn/failed") request.errorCode = String((terminal.payload as Record<string, unknown>).code ?? "failed");
    }
    state.lease = undefined;
    state.activeRequestKey = undefined;
    return seq;
  }

  async listSessions(query: import("@0xsyncroot/contracts").SessionDirectoryQuery, security: SecurityContext) {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 51) throw new AgenticError("validation", "Invalid session page size");
    return [...this.#sessions.values()].filter((state) => state.tenantId === security.tenantId && state.ownerActorId === security.actorId &&
      (!query.agentProfileId || (state.agentProfileId ?? "default") === query.agentProfileId))
      .flatMap((state) => {
        const first = state.events[0];
        const input = state.events.find((event) => event.type === "user/input");
        // Listed from its first event, as the SQL stores do; untitled until it has a user input.
        return first ? [{ sessionId: first.sessionId, createdAt: first.occurredAt, ...(input ? { firstInput: input.payload } : {}) }] : [];
      }).filter((entry) => !query.before || entry.createdAt < query.before.createdAt ||
        (entry.createdAt === query.before.createdAt && entry.sessionId < query.before.sessionId))
      .sort((a, b) => a.createdAt === b.createdAt ? (a.sessionId < b.sessionId ? 1 : -1) : (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, query.limit);
  }

  async load(sessionId: string, security: SecurityContext): Promise<readonly SessionEvent[]> {
    const state = this.#sessions.get(this.#sessionKey(security.tenantId, sessionId));
    if (state) this.#assertAccess(state, security);
    return [...(state?.events ?? [])];
  }

  async loadRecent(sessionId: string, limit: number, security: SecurityContext): Promise<readonly SessionEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > InMemorySessionStore.MAX_CONTEXT_EVENTS) {
      throw new AgenticError("validation", `Session recent-event limit must be from 1 to ${InMemorySessionStore.MAX_CONTEXT_EVENTS}`);
    }
    const state = this.#sessions.get(this.#sessionKey(security.tenantId, sessionId));
    if (state) this.#assertAccess(state, security);
    return [...(state?.events.slice(-limit) ?? [])];
  }

  async loadSince(sessionId: string, afterSeq: number, security: SecurityContext, limit: number): Promise<readonly SessionEvent[]> {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new AgenticError("validation", "Session afterSeq must be a non-negative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > InMemorySessionStore.MAX_CONTEXT_EVENTS) {
      throw new AgenticError("validation", `Session since-event limit must be from 1 to ${InMemorySessionStore.MAX_CONTEXT_EVENTS}`);
    }
    const state = this.#sessions.get(this.#sessionKey(security.tenantId, sessionId));
    if (state) this.#assertAccess(state, security);
    // Sequences are dense and start at 1, so the event with seq n sits at index n - 1.
    return state?.events.slice(afterSeq, afterSeq + limit) ?? [];
  }

  async loadContext(sessionId: string, security: SecurityContext) {
    const events = await this.load(sessionId, security);
    const checkpoint = [...events].reverse().find((event) => event.type === "context/checkpoint");
    const raw = events.slice(-(InMemorySessionStore.MAX_CONTEXT_EVENTS + 1));
    const truncated = raw.length > InMemorySessionStore.MAX_CONTEXT_EVENTS;
    const bounded = truncated ? raw.slice(1) : raw;
    const truncatedBeforeSeq = truncated ? bounded[0]?.seq : undefined;
    return {
      ...(checkpoint ? { checkpoint } : {}), events: bounded,
      ...(truncatedBeforeSeq !== undefined ? { truncatedBeforeSeq } : {}),
    };
  }
}
