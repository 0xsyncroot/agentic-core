import {
  AgenticError, MAX_SESSION_READ_EVENTS, type DataClassification, type EventDraft, type JsonValue, type PayloadProtector,
  type RuntimeSnapshot, type SecurityContext, type SessionEvent, type SessionStore,
  type TurnClaimCommand, type TurnClaimResult, type TurnLease,
} from "@0xsyncroot/contracts";
import type { ConnectionPool } from "mssql";
import { sha256 } from "./hash.js";
import { isoTimestamp, SqlServerSessionWriteRepository } from "./session-write-repository.js";
import { bigInteger, integer, request, text } from "./sql-request.js";
import { withTenantTransaction } from "./transaction.js";

interface EventRow extends Record<string, unknown> {
  event_id: string; session_id: string; seq: string | number; type: string; schema_version: number;
  occurred_at: Date | string; recorded_at: Date | string; tenant_id: string; actor_id: string; correlation_id: string;
  runtime_snapshot_id: string; classification: DataClassification; payload: string;
  turn_id: string | null; step_id: string | null; request_id: string | null; call_id: string | null; attempt_id: string | null; integrity_hash: string;
}

const MAX_CONTEXT_EVENTS = MAX_SESSION_READ_EVENTS;

async function mapEvent(row: EventRow, writes: SqlServerSessionWriteRepository): Promise<SessionEvent> {
  const payload = await writes.decodePayload({
    eventId: row.event_id, tenantId: row.tenant_id, type: row.type,
    classification: row.classification, payload: JSON.parse(row.payload) as JsonValue,
  });
  const eventWithoutHash = {
    eventId: row.event_id, sessionId: row.session_id, seq: Number(row.seq), type: row.type, schemaVersion: row.schema_version,
    occurredAt: isoTimestamp(row.occurred_at), recordedAt: isoTimestamp(row.recorded_at), tenantId: row.tenant_id,
    actorId: row.actor_id, correlationId: row.correlation_id, runtimeSnapshotId: row.runtime_snapshot_id,
    classification: row.classification, payload, ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.step_id ? { stepId: row.step_id } : {}), ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.call_id ? { callId: row.call_id } : {}), ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
  };
  if (sha256(eventWithoutHash) !== row.integrity_hash) throw new AgenticError("permanent", `Session event integrity check failed: ${row.event_id}`);
  return { ...eventWithoutHash, integrityHash: row.integrity_hash };
}

export class SqlServerSessionStore implements SessionStore {
  readonly #writes: SqlServerSessionWriteRepository;
  constructor(private readonly pool: ConnectionPool, payloadProtector?: PayloadProtector) {
    this.#writes = new SqlServerSessionWriteRepository(payloadProtector);
  }

  async append(sessionId: string, expectedSeq: number, drafts: readonly EventDraft[], idempotencyKey: string, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<number> {
    const prepared = await this.#writes.prepareDrafts(drafts, context);
    return withTenantTransaction(this.pool, context.security, async (transaction) => {
      await this.#writes.ensureStream(transaction, sessionId, context.security);
      const stream = await this.#writes.lockStream(transaction, sessionId, context.security);
      if (stream.activeTurnId) throw new AgenticError("conflict", "Unleased append is forbidden while a turn owns the session");
      return this.#writes.appendPreparedDrafts(transaction, sessionId, expectedSeq, prepared, idempotencyKey, context);
    });
  }

  async claimTurn(command: TurnClaimCommand, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<TurnClaimResult> {
    if (!Number.isInteger(command.leaseTtlMs) || command.leaseTtlMs <= 0) throw new AgenticError("validation", "leaseTtlMs must be positive");
    const preparedStartEvents = await this.#writes.prepareDrafts(command.startEvents, context);
    return withTenantTransaction(this.pool, context.security, async (transaction) => {
      await this.#writes.ensureStream(transaction, command.sessionId, context.security, command.agentProfileId ?? "default");
      let stream = await this.#writes.lockStream(transaction, command.sessionId, context.security);
      const agentProfileId = command.agentProfileId ?? "default";
      if (stream.agentProfileId !== null && stream.agentProfileId !== agentProfileId) {
        throw new AgenticError("denied", "Session is bound to a different agent profile");
      }
      if (stream.agentProfileId === null) {
        let profileInput = text(text(request(transaction), "tenant_id", context.security.tenantId), "session_id", command.sessionId);
        profileInput = text(profileInput, "agent_profile_id", agentProfileId);
        await profileInput.query(`UPDATE agentic.session_stream SET agent_profile_id=@agent_profile_id
          WHERE tenant_id=@tenant_id AND session_id=@session_id AND agent_profile_id IS NULL;`);
      }
      const repaired = await this.#writes.repairExpiredTurn(transaction, command.sessionId, stream, context);
      if (repaired !== stream.currentSeq || (stream.activeTurnId && !stream.leaseValid)) {
        stream = await this.#writes.lockStream(transaction, command.sessionId, context.security);
      }
      let input = text(text(text(request(transaction), "tenant_id", context.security.tenantId), "session_id", command.sessionId), "idempotency_key", command.idempotencyKey);
      const priorResult = await input.query<Record<string, unknown>>(`SELECT request_fingerprint,turn_id,status,result_seq,error_code
        FROM agentic.session_turn_request WHERE tenant_id=@tenant_id AND session_id=@session_id AND idempotency_key=@idempotency_key;`);
      const prior = priorResult.recordset[0];
      if (prior) {
        if (prior.request_fingerprint !== command.requestFingerprint) throw new AgenticError("conflict", "Idempotency key was reused with a different request");
        if (prior.status === "completed") return { kind: "completed", turnId: String(prior.turn_id), seq: Number(prior.result_seq ?? stream.currentSeq) };
        if (prior.status !== "running") return { kind: "failed", turnId: String(prior.turn_id), code: String(prior.error_code ?? prior.status) };
        return { kind: "in-progress", turnId: String(prior.turn_id), retryAfterMs: retryAfter(stream.leaseExpiresAt) };
      }
      if (stream.activeTurnId) return { kind: "in-progress", turnId: stream.activeTurnId, retryAfterMs: retryAfter(stream.leaseExpiresAt) };
      const token = (BigInt(stream.fencingToken) + 1n).toString();
      input = text(text(text(text(text(request(transaction), "tenant_id", context.security.tenantId), "session_id", command.sessionId), "owner_id", command.ownerId), "turn_id", command.turnId), "idempotency_key", command.idempotencyKey);
      bigInteger(input, "token", token); integer(input, "lease_ttl_ms", command.leaseTtlMs);
      const leaseResult = await input.query<{ lease_expires_at: Date }>(`UPDATE agentic.session_stream
        SET lease_owner=@owner_id,lease_fencing_token=@token,lease_expires_at=DATEADD(MILLISECOND,@lease_ttl_ms,SYSUTCDATETIME()),
            active_turn_id=@turn_id,active_idempotency_key=@idempotency_key
        OUTPUT INSERTED.lease_expires_at WHERE tenant_id=@tenant_id AND session_id=@session_id;`);
      const expiresAt = leaseResult.recordset[0]?.lease_expires_at;
      if (!expiresAt) throw new AgenticError("conflict", "Failed to acquire turn lease");
      input = text(text(text(text(text(text(text(text(request(transaction), "tenant_id", context.security.tenantId), "session_id", command.sessionId), "idempotency_key", command.idempotencyKey), "request_fingerprint", command.requestFingerprint, 64), "turn_id", command.turnId), "actor_id", context.security.actorId), "correlation_id", context.security.correlationId), "runtime_snapshot_id", context.runtime.id);
      bigInteger(input, "token", token);
      await input.query(`INSERT INTO agentic.session_turn_request(tenant_id,session_id,idempotency_key,request_fingerprint,turn_id,status,
        fencing_token,actor_id,correlation_id,runtime_snapshot_id) VALUES (@tenant_id,@session_id,@idempotency_key,@request_fingerprint,
        @turn_id,'running',@token,@actor_id,@correlation_id,@runtime_snapshot_id);`);
      const seq = await this.#writes.appendPreparedDrafts(transaction, command.sessionId, stream.currentSeq, preparedStartEvents, `turn-claim:${command.idempotencyKey}`, context);
      return { kind: "acquired", lease: { sessionId: command.sessionId, turnId: command.turnId, ownerId: command.ownerId, fencingToken: token, expiresAt: expiresAt.toISOString() }, seq };
    });
  }

  async appendLeased(lease: TurnLease, expectedSeq: number, drafts: readonly EventDraft[], idempotencyKey: string, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<number> {
    const prepared = await this.#writes.prepareDrafts(drafts, context);
    return withTenantTransaction(this.pool, context.security, async (transaction) => {
      const stream = await this.#writes.lockStream(transaction, lease.sessionId, context.security);
      this.#writes.assertLease(stream, lease);
      return this.#writes.appendPreparedDrafts(transaction, lease.sessionId, expectedSeq, prepared, idempotencyKey, context);
    });
  }

  async renewTurn(lease: TurnLease, ttlMs: number, security: SecurityContext): Promise<TurnLease> {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new AgenticError("validation", "lease ttl must be positive");
    return withTenantTransaction(this.pool, security, async (transaction) => {
      let input = text(text(text(text(request(transaction), "tenant_id", security.tenantId), "session_id", lease.sessionId), "turn_id", lease.turnId), "owner_id", lease.ownerId);
      bigInteger(input, "token", lease.fencingToken);
      integer(input, "ttl_ms", ttlMs);
      const result = await input.query<{ lease_expires_at: Date }>(`UPDATE agentic.session_stream SET lease_expires_at=DATEADD(MILLISECOND,@ttl_ms,SYSUTCDATETIME())
        OUTPUT INSERTED.lease_expires_at WHERE tenant_id=@tenant_id AND session_id=@session_id AND active_turn_id=@turn_id AND lease_owner=@owner_id
        AND lease_fencing_token=@token AND lease_expires_at>SYSUTCDATETIME();`);
      const expiresAt = result.recordset[0]?.lease_expires_at;
      if (!expiresAt) throw new AgenticError("conflict", `Turn lease lost or expired: ${lease.turnId}`);
      return { ...lease, expiresAt: expiresAt.toISOString() };
    });
  }

  async finishTurn(lease: TurnLease, expectedSeq: number, terminal: EventDraft, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<number> {
    if (terminal.turnId !== lease.turnId || (terminal.type !== "turn/end" && terminal.type !== "turn/failed")) throw new AgenticError("validation", "finishTurn requires a terminal event for the leased turn");
    const prepared = await this.#writes.prepareDrafts([terminal], context);
    return withTenantTransaction(this.pool, context.security, async (transaction) => {
      const stream = await this.#writes.lockStream(transaction, lease.sessionId, context.security);
      this.#writes.assertLease(stream, lease);
      const seq = await this.#writes.appendPreparedDrafts(transaction, lease.sessionId, expectedSeq, prepared, `turn-terminal:${lease.turnId}`, context);
      const status = terminal.type === "turn/end" ? "completed" : "failed";
      const errorCode = terminal.type === "turn/failed" ? String((terminal.payload as Record<string, unknown>).code ?? "failed") : null;
      let input = text(text(text(text(request(transaction), "tenant_id", context.security.tenantId), "session_id", lease.sessionId), "idempotency_key", stream.activeIdempotencyKey), "status", status, 32);
      bigInteger(input, "token", lease.fencingToken);
      text(input, "error_code", errorCode); bigInteger(input, "result_seq", seq);
      await input.query(`UPDATE agentic.session_turn_request SET status=@status,finished_at=SYSUTCDATETIME(),result_seq=@result_seq,error_code=@error_code
        WHERE tenant_id=@tenant_id AND session_id=@session_id AND idempotency_key=@idempotency_key AND fencing_token=@token;`);
      input = text(text(request(transaction), "tenant_id", context.security.tenantId), "session_id", lease.sessionId);
      bigInteger(input, "token", lease.fencingToken);
      await input.query(`UPDATE agentic.session_stream SET lease_owner=NULL,lease_expires_at=NULL,active_turn_id=NULL,active_idempotency_key=NULL
        WHERE tenant_id=@tenant_id AND session_id=@session_id AND lease_fencing_token=@token;`);
      return seq;
    });
  }

  async listSessions(query: import("@0xsyncroot/contracts").SessionDirectoryQuery, security: SecurityContext) {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 51) throw new AgenticError("validation", "Invalid session page size");
    const rows = await withTenantTransaction(this.pool, security, async (transaction) => {
      const input = text(text(request(transaction), "tenant_id", security.tenantId), "actor_id", security.actorId);
      integer(input, "limit", query.limit);
      if (query.agentProfileId) text(input, "profile", query.agentProfileId);
      if (query.before) { text(input, "before", query.before.createdAt); text(input, "before_id", query.before.sessionId); }
      const result = await input.query<EventRow & { stream_session_id: string; created_at: string }>(
        `SELECT s.session_id AS stream_session_id,FORMAT(s.created_at,'yyyy-MM-ddTHH:mm:ss.ffffff')+'Z' AS created_at,e.* FROM
        (SELECT TOP (@limit) * FROM agentic.session_stream WHERE tenant_id=@tenant_id AND owner_actor_id=@actor_id AND current_seq>0
          ${query.agentProfileId ? "AND COALESCE(agent_profile_id,'default')=@profile" : ""}
          ${query.before ? "AND (created_at<CONVERT(datetime2,@before,127) OR (created_at=CONVERT(datetime2,@before,127) AND session_id<@before_id))" : ""}
          ORDER BY created_at DESC,session_id DESC) s
        OUTER APPLY (SELECT TOP (1) * FROM agentic.session_event WHERE tenant_id=s.tenant_id AND session_id=s.session_id AND type='user/input' ORDER BY seq) e
        ORDER BY s.created_at DESC,s.session_id DESC`);
      return result.recordset;
    });
    return Promise.all(rows.map(async (row) => ({ sessionId: row.stream_session_id, createdAt: row.created_at,
      ...(row.event_id ? { firstInput: (await mapEvent(row, this.#writes)).payload } : {}) })));
  }

  async load(sessionId: string, security: SecurityContext): Promise<readonly SessionEvent[]> {
    return withTenantTransaction(this.pool, security, async (transaction) => {
      let input = text(text(text(request(transaction), "tenant_id", security.tenantId), "session_id", sessionId), "actor_id", security.actorId);
      const visible = await input.query(`SELECT TOP (1) 1 AS visible FROM agentic.session_stream
        WHERE tenant_id=@tenant_id AND session_id=@session_id AND (owner_actor_id IS NULL OR owner_actor_id=@actor_id);`);
      if (!visible.recordset[0]) return [];
      input = text(text(request(transaction), "tenant_id", security.tenantId), "session_id", sessionId);
      const rows = await input.query<EventRow>("SELECT * FROM agentic.session_event WHERE tenant_id=@tenant_id AND session_id=@session_id ORDER BY seq;");
      return Promise.all(rows.recordset.map((row) => mapEvent(row, this.#writes)));
    });
  }

  async loadRecent(sessionId: string, limit: number, security: SecurityContext): Promise<readonly SessionEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONTEXT_EVENTS) {
      throw new AgenticError("validation", `Session recent-event limit must be from 1 to ${MAX_CONTEXT_EVENTS}`);
    }
    return withTenantTransaction(this.pool, security, async (transaction) => {
      let input = text(text(text(request(transaction), "tenant_id", security.tenantId), "session_id", sessionId), "actor_id", security.actorId);
      const visible = await input.query(`SELECT TOP (1) 1 AS visible FROM agentic.session_stream
        WHERE tenant_id=@tenant_id AND session_id=@session_id AND (owner_actor_id IS NULL OR owner_actor_id=@actor_id);`);
      if (!visible.recordset[0]) return [];
      input = text(text(request(transaction), "tenant_id", security.tenantId), "session_id", sessionId);
      integer(input, "limit", limit);
      const rows = await input.query<EventRow>(`SELECT * FROM (
        SELECT TOP (@limit) * FROM agentic.session_event
        WHERE tenant_id=@tenant_id AND session_id=@session_id ORDER BY seq DESC
      ) AS recent ORDER BY seq;`);
      return Promise.all(rows.recordset.map((row) => mapEvent(row, this.#writes)));
    });
  }

  async loadSince(sessionId: string, afterSeq: number, security: SecurityContext, limit: number): Promise<readonly SessionEvent[]> {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new AgenticError("validation", "Session afterSeq must be a non-negative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONTEXT_EVENTS) {
      throw new AgenticError("validation", `Session since-event limit must be from 1 to ${MAX_CONTEXT_EVENTS}`);
    }
    return withTenantTransaction(this.pool, security, async (transaction) => {
      let input = text(text(text(request(transaction), "tenant_id", security.tenantId), "session_id", sessionId), "actor_id", security.actorId);
      const visible = await input.query(`SELECT TOP (1) 1 AS visible FROM agentic.session_stream
        WHERE tenant_id=@tenant_id AND session_id=@session_id AND (owner_actor_id IS NULL OR owner_actor_id=@actor_id);`);
      if (!visible.recordset[0]) return [];
      input = text(text(request(transaction), "tenant_id", security.tenantId), "session_id", sessionId);
      bigInteger(input, "after_seq", afterSeq);
      integer(input, "limit", limit);
      const rows = await input.query<EventRow>(`SELECT TOP (@limit) * FROM agentic.session_event
        WHERE tenant_id=@tenant_id AND session_id=@session_id AND seq>@after_seq ORDER BY seq;`);
      return Promise.all(rows.recordset.map((row) => mapEvent(row, this.#writes)));
    });
  }

  async loadContext(sessionId: string, security: SecurityContext) {
    return withTenantTransaction(this.pool, security, async (transaction) => {
      let input = text(text(text(request(transaction), "tenant_id", security.tenantId), "session_id", sessionId), "actor_id", security.actorId);
      const visible = await input.query(`SELECT TOP (1) 1 AS visible FROM agentic.session_stream
        WHERE tenant_id=@tenant_id AND session_id=@session_id AND (owner_actor_id IS NULL OR owner_actor_id=@actor_id);`);
      if (!visible.recordset[0]) return { events: [] };
      input = text(text(request(transaction), "tenant_id", security.tenantId), "session_id", sessionId);
      const checkpoints = await input.query<EventRow>(`SELECT TOP (1) * FROM agentic.session_event
        WHERE tenant_id=@tenant_id AND session_id=@session_id AND type=N'context/checkpoint' ORDER BY seq DESC;`);
      const checkpointRow = checkpoints.recordset[0];
      const checkpoint = checkpointRow ? await mapEvent(checkpointRow, this.#writes) : undefined;
      input = text(text(request(transaction), "tenant_id", security.tenantId), "session_id", sessionId);
      integer(input, "limit", MAX_CONTEXT_EVENTS + 1);
      const tail = await input.query<EventRow>(`SELECT * FROM (
        SELECT TOP (@limit) * FROM agentic.session_event
        WHERE tenant_id=@tenant_id AND session_id=@session_id ORDER BY seq DESC
      ) AS bounded ORDER BY seq;`);
      const truncated = tail.recordset.length > MAX_CONTEXT_EVENTS;
      const rows = truncated ? tail.recordset.slice(1) : tail.recordset;
      const events = await Promise.all(rows.map((row) => mapEvent(row, this.#writes)));
      return {
        ...(checkpoint ? { checkpoint } : {}), events,
        ...(truncated && events[0] ? { truncatedBeforeSeq: events[0].seq } : {}),
      };
    });
  }
}

function retryAfter(expiresAt: string | null): number {
  return Math.max(1, Date.parse(expiresAt ?? new Date().toISOString()) - Date.now());
}
