import type {
  EventDraft,
  PayloadProtector,
  RuntimeSnapshot,
  SecurityContext,
  SessionEvent,
  SessionStore,
  TurnClaimCommand,
  TurnClaimResult,
  TurnLease,
} from "@0xsyncroot/contracts";
import { AgenticError, MAX_SESSION_READ_EVENTS } from "@0xsyncroot/contracts";
import type { Pool } from "pg";
import { mapEvent, type EventRow } from "./event-row.js";
import { isoTimestamp, SessionWriteRepository } from "./session-write-repository.js";
import { withTenantTransaction } from "./transaction.js";

const MAX_CONTEXT_EVENTS = MAX_SESSION_READ_EVENTS;

function iso(value: Date | string): string {
  return isoTimestamp(value);
}

export class PostgresSessionStore implements SessionStore {
  readonly #writes: SessionWriteRepository;
  constructor(private readonly pool: Pool, payloadProtector?: PayloadProtector) {
    this.#writes = new SessionWriteRepository(payloadProtector);
  }

  async append(
    sessionId: string,
    expectedSeq: number,
    drafts: readonly EventDraft[],
    idempotencyKey: string,
    context: { security: SecurityContext; runtime: RuntimeSnapshot },
  ): Promise<number> {
    const prepared = await this.#writes.prepareDrafts(drafts, context);
    return withTenantTransaction(this.pool, context.security, async (client) => {
      await this.#writes.ensureStream(client, sessionId, context.security);
      const stream = await this.#writes.lockStream(client, sessionId);
      if (stream.activeTurnId) throw new AgenticError("conflict", "Unleased append is forbidden while a turn owns the session");
      return this.#writes.appendPreparedDrafts(client, sessionId, expectedSeq, prepared, idempotencyKey, context);
    });
  }

  async claimTurn(command: TurnClaimCommand, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<TurnClaimResult> {
    if (!Number.isInteger(command.leaseTtlMs) || command.leaseTtlMs <= 0) throw new AgenticError("validation", "leaseTtlMs must be a positive integer");
    const preparedStartEvents = await this.#writes.prepareDrafts(command.startEvents, context);
    return withTenantTransaction(this.pool, context.security, async (client) => {
      await this.#writes.ensureStream(client, command.sessionId, context.security, command.agentProfileId ?? "default");
      let stream = await this.#writes.lockStream(client, command.sessionId);
      if (stream.ownerActorId === null) {
        await client.query("UPDATE agentic.session_stream SET owner_actor_id = $3 WHERE tenant_id = $1 AND session_id = $2 AND owner_actor_id IS NULL", [context.security.tenantId, command.sessionId, context.security.actorId]);
      }
      const agentProfileId = command.agentProfileId ?? "default";
      if (stream.agentProfileId !== null && stream.agentProfileId !== agentProfileId) {
        throw new AgenticError("denied", "Session is bound to a different agent profile");
      }
      if (stream.agentProfileId === null) {
        await client.query(
          "UPDATE agentic.session_stream SET agent_profile_id = $3 WHERE tenant_id = $1 AND session_id = $2 AND agent_profile_id IS NULL",
          [context.security.tenantId, command.sessionId, agentProfileId],
        );
      }
      const repairedSeq = await this.#writes.repairExpiredTurn(client, command.sessionId, stream, context);
      if (repairedSeq !== stream.currentSeq || (stream.activeTurnId && !stream.leaseValid)) stream = await this.#writes.lockStream(client, command.sessionId);

      const prior = await client.query<{
        request_fingerprint: string; turn_id: string; status: "running" | "completed" | "failed" | "interrupted";
        result_seq: string | null; error_code: string | null;
      }>(
        `SELECT request_fingerprint, turn_id, status, result_seq, error_code
         FROM agentic.session_turn_request
         WHERE tenant_id = $1 AND session_id = $2 AND idempotency_key = $3`,
        [context.security.tenantId, command.sessionId, command.idempotencyKey],
      );
      const existing = prior.rows[0];
      if (existing) {
        if (existing.request_fingerprint !== command.requestFingerprint) throw new AgenticError("conflict", "Idempotency key was reused with a different request");
        if (existing.status === "completed") return { kind: "completed", turnId: existing.turn_id, seq: Number(existing.result_seq ?? stream.currentSeq) };
        if (existing.status !== "running") return { kind: "failed", turnId: existing.turn_id, code: existing.error_code ?? existing.status };
        const retryAfterMs = Math.max(1, Date.parse(stream.leaseExpiresAt ?? new Date().toISOString()) - Date.now());
        return { kind: "in-progress", turnId: existing.turn_id, retryAfterMs };
      }
      if (stream.activeTurnId) {
        return { kind: "in-progress", turnId: stream.activeTurnId, retryAfterMs: Math.max(1, Date.parse(stream.leaseExpiresAt ?? new Date().toISOString()) - Date.now()) };
      }

      const nextToken = (BigInt(stream.fencingToken) + 1n).toString();
      const leaseResult = await client.query<{ lease_expires_at: Date | string }>(
        `UPDATE agentic.session_stream
         SET lease_owner = $2, lease_fencing_token = $3::bigint,
             lease_expires_at = clock_timestamp() + ($4::text || ' milliseconds')::interval,
             active_turn_id = $5, active_idempotency_key = $6
         WHERE session_id = $1
         RETURNING lease_expires_at`,
        [command.sessionId, command.ownerId, nextToken, command.leaseTtlMs, command.turnId, command.idempotencyKey],
      );
      const expiresAt = leaseResult.rows[0]?.lease_expires_at;
      if (!expiresAt) throw new AgenticError("conflict", "Failed to acquire turn lease");
      await client.query(
        `INSERT INTO agentic.session_turn_request(
           tenant_id, session_id, idempotency_key, request_fingerprint, turn_id, status, fencing_token,
           actor_id, correlation_id, runtime_snapshot_id
         ) VALUES ($1,$2,$3,$4,$5,'running',$6::bigint,$7,$8,$9)`,
        [context.security.tenantId, command.sessionId, command.idempotencyKey, command.requestFingerprint,
          command.turnId, nextToken, context.security.actorId, context.security.correlationId, context.runtime.id],
      );
      const seq = await this.#writes.appendPreparedDrafts(client, command.sessionId, stream.currentSeq, preparedStartEvents, `turn-claim:${command.idempotencyKey}`, context);
      return {
        kind: "acquired",
        lease: { sessionId: command.sessionId, turnId: command.turnId, ownerId: command.ownerId, fencingToken: nextToken, expiresAt: iso(expiresAt) },
        seq,
      };
    });
  }

  async appendLeased(
    lease: TurnLease, expectedSeq: number, drafts: readonly EventDraft[], idempotencyKey: string,
    context: { security: SecurityContext; runtime: RuntimeSnapshot },
  ): Promise<number> {
    const prepared = await this.#writes.prepareDrafts(drafts, context);
    return withTenantTransaction(this.pool, context.security, async (client) => {
      const stream = await this.#writes.lockStream(client, lease.sessionId);
      this.#writes.assertLease(stream, lease);
      return this.#writes.appendPreparedDrafts(client, lease.sessionId, expectedSeq, prepared, idempotencyKey, context);
    });
  }

  async renewTurn(lease: TurnLease, ttlMs: number, security: SecurityContext): Promise<TurnLease> {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new AgenticError("validation", "lease ttl must be a positive integer");
    return withTenantTransaction(this.pool, security, async (client) => {
      const result = await client.query<{ lease_expires_at: Date | string }>(
        `UPDATE agentic.session_stream
         SET lease_expires_at = clock_timestamp() + ($5::text || ' milliseconds')::interval
         WHERE session_id = $1 AND active_turn_id = $2 AND lease_owner = $3
           AND lease_fencing_token = $4::bigint AND lease_expires_at > clock_timestamp()
         RETURNING lease_expires_at`,
        [lease.sessionId, lease.turnId, lease.ownerId, lease.fencingToken, ttlMs],
      );
      const expiresAt = result.rows[0]?.lease_expires_at;
      if (!expiresAt) throw new AgenticError("conflict", `Turn lease lost or expired: ${lease.turnId}`);
      return { ...lease, expiresAt: iso(expiresAt) };
    });
  }

  async finishTurn(
    lease: TurnLease, expectedSeq: number, terminal: EventDraft,
    context: { security: SecurityContext; runtime: RuntimeSnapshot },
  ): Promise<number> {
    if (terminal.turnId !== lease.turnId || (terminal.type !== "turn/end" && terminal.type !== "turn/failed")) {
      throw new AgenticError("validation", "finishTurn requires a terminal event for the leased turn");
    }
    const prepared = await this.#writes.prepareDrafts([terminal], context);
    return withTenantTransaction(this.pool, context.security, async (client) => {
      const stream = await this.#writes.lockStream(client, lease.sessionId);
      this.#writes.assertLease(stream, lease);
      const seq = await this.#writes.appendPreparedDrafts(client, lease.sessionId, expectedSeq, prepared, `turn-terminal:${lease.turnId}`, context);
      const status = terminal.type === "turn/end" ? "completed" : "failed";
      const errorCode = terminal.type === "turn/failed" ? String((terminal.payload as Record<string, unknown>).code ?? "failed") : null;
      await client.query(
        `UPDATE agentic.session_turn_request
         SET status = $3, finished_at = clock_timestamp(), result_seq = $4, error_code = $5
         WHERE session_id = $1 AND idempotency_key = $2 AND fencing_token = $6::bigint`,
        [lease.sessionId, stream.activeIdempotencyKey, status, seq, errorCode, lease.fencingToken],
      );
      await client.query(
        `UPDATE agentic.session_stream
         SET lease_owner = NULL, lease_expires_at = NULL, active_turn_id = NULL, active_idempotency_key = NULL
         WHERE session_id = $1 AND lease_fencing_token = $2::bigint`,
        [lease.sessionId, lease.fencingToken],
      );
      return seq;
    });
  }

  async listSessions(query: import("@0xsyncroot/contracts").SessionDirectoryQuery, security: SecurityContext) {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 51) throw new AgenticError("validation", "Invalid session page size");
    const rows = await withTenantTransaction(this.pool, security, async (client) => {
      const values: unknown[] = [security.tenantId, security.actorId, query.limit];
      let filter = "";
      if (query.agentProfileId) { values.push(query.agentProfileId); filter += ` AND COALESCE(agent_profile_id,'default')=$${values.length}`; }
      if (query.before) {
        values.push(query.before.createdAt, query.before.sessionId);
        filter += ` AND (created_at,session_id)<($${values.length - 1}::timestamptz,$${values.length})`;
      }
      const result = await client.query<EventRow & { stream_session_id: string; created_at: string }>(
        `SELECT s.session_id AS stream_session_id, to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,e.* FROM
        (SELECT * FROM agentic.session_stream WHERE tenant_id=$1 AND owner_actor_id=$2 AND current_seq>0${filter}
          ORDER BY created_at DESC,session_id DESC LIMIT $3) s
        LEFT JOIN LATERAL (SELECT * FROM agentic.session_event WHERE tenant_id=s.tenant_id AND session_id=s.session_id AND type='user/input' ORDER BY seq LIMIT 1) e ON true
        ORDER BY s.created_at DESC,s.session_id DESC`, values);
      return result.rows;
    });
    return Promise.all(rows.map(async (row) => ({ sessionId: row.stream_session_id, createdAt: row.created_at,
      ...(row.event_id ? { firstInput: (await mapEvent(row, this.#writes)).payload } : {}) })));
  }

  async load(sessionId: string, security: SecurityContext): Promise<readonly SessionEvent[]> {
    return withTenantTransaction(this.pool, security, async (client) => {
      const visible = await client.query("SELECT 1 FROM agentic.session_stream WHERE session_id = $1", [sessionId]);
      if (!visible.rows[0]) return [];
      const result = await client.query<EventRow>(
        "SELECT * FROM agentic.session_event WHERE session_id = $1 ORDER BY seq",
        [sessionId],
      );
      return Promise.all(result.rows.map((row) => mapEvent(row, this.#writes)));
    });
  }

  async loadRecent(sessionId: string, limit: number, security: SecurityContext): Promise<readonly SessionEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONTEXT_EVENTS) {
      throw new AgenticError("validation", `Session recent-event limit must be from 1 to ${MAX_CONTEXT_EVENTS}`);
    }
    return withTenantTransaction(this.pool, security, async (client) => {
      const result = await client.query<EventRow>(
        `SELECT * FROM (
           SELECT * FROM agentic.session_event WHERE session_id = $1 ORDER BY seq DESC LIMIT $2
         ) recent ORDER BY seq`,
        [sessionId, limit],
      );
      return Promise.all(result.rows.map((row) => mapEvent(row, this.#writes)));
    });
  }

  async loadSince(sessionId: string, afterSeq: number, security: SecurityContext, limit: number): Promise<readonly SessionEvent[]> {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new AgenticError("validation", "Session afterSeq must be a non-negative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONTEXT_EVENTS) {
      throw new AgenticError("validation", `Session since-event limit must be from 1 to ${MAX_CONTEXT_EVENTS}`);
    }
    return withTenantTransaction(this.pool, security, async (client) => {
      const visible = await client.query("SELECT 1 FROM agentic.session_stream WHERE session_id = $1", [sessionId]);
      if (!visible.rows[0]) return [];
      const result = await client.query<EventRow>(
        "SELECT * FROM agentic.session_event WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT $3",
        [sessionId, afterSeq, limit],
      );
      return Promise.all(result.rows.map((row) => mapEvent(row, this.#writes)));
    });
  }

  async loadContext(sessionId: string, security: SecurityContext) {
    return withTenantTransaction(this.pool, security, async (client) => {
      const visible = await client.query("SELECT 1 FROM agentic.session_stream WHERE session_id = $1", [sessionId]);
      if (!visible.rows[0]) return { events: [] };
      const checkpointResult = await client.query<EventRow>(
        "SELECT * FROM agentic.session_event WHERE session_id = $1 AND type = 'context/checkpoint' ORDER BY seq DESC LIMIT 1",
        [sessionId],
      );
      const checkpointRow = checkpointResult.rows[0];
      const checkpoint = checkpointRow ? await mapEvent(checkpointRow, this.#writes) : undefined;
      const result = await client.query<EventRow>(
        `SELECT * FROM (
           SELECT * FROM agentic.session_event
           WHERE session_id = $1 ORDER BY seq DESC LIMIT $2
         ) bounded ORDER BY seq`,
        [sessionId, MAX_CONTEXT_EVENTS + 1],
      );
      const truncated = result.rows.length > MAX_CONTEXT_EVENTS;
      const rows = truncated ? result.rows.slice(1) : result.rows;
      const events = await Promise.all(rows.map((row) => mapEvent(row, this.#writes)));
      return {
        ...(checkpoint ? { checkpoint } : {}), events,
        ...(truncated && events[0] ? { truncatedBeforeSeq: events[0].seq } : {}),
      };
    });
  }
}
