import { AgenticError, MAX_SESSION_READ_EVENTS, type EventDraft, type JsonValue, type PayloadProtector, type RuntimeSnapshot, type SecurityContext, type SessionEvent, type SessionStore, type TurnClaimCommand, type TurnClaimResult, type TurnLease } from "@0xsyncroot/contracts";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { EVENTS_BY_SEQ, mapEvent, type EventRow } from "./event-row.js";
import { isoTimestamp, MySqlSessionWriteRepository } from "./session-write-repository.js";
import { withTenantTransaction } from "./transaction.js";

const MAX_CONTEXT_EVENTS = MAX_SESSION_READ_EVENTS;

/**
 * Why `LIMIT` is written into the statement instead of bound.
 *
 * `execute()` prepares server-side, and MySQL's binary protocol refuses a bound parameter in
 * `LIMIT` — the error it returns is "Incorrect arguments to mysqld_stmt_execute", which says
 * nothing about which argument or why. Every limit here is a number this file has already
 * proved to be an integer inside a fixed range, so there is nothing a caller can inject; the
 * safety comes from the validation above the query, not from the placeholder.
 *
 * Do not "fix" these back to `?`.
 */

export class MySqlSessionStore implements SessionStore {
  readonly #writes: MySqlSessionWriteRepository;
  /** `stampAppends`: write `last_appended_at` with every append; only when `probeAppendStamp` passed for this pool's account. */
  constructor(private readonly pool: Pool, payloadProtector?: PayloadProtector, options: { readonly stampAppends?: boolean } = {}) {
    this.#writes = new MySqlSessionWriteRepository(payloadProtector, options.stampAppends ?? false);
  }

  async append(sessionId: string, expectedSeq: number, drafts: readonly EventDraft[], idempotencyKey: string, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<number> {
    const prepared = await this.#writes.prepareDrafts(drafts, context);
    return withTenantTransaction(this.pool, context.security, async (connection) => {
      await this.#writes.ensureStream(connection, sessionId, context.security);
      const stream = await this.#writes.lockStream(connection, sessionId, context.security);
      if (stream.activeTurnId) throw new AgenticError("conflict", "Unleased append is forbidden while a turn owns the session");
      return this.#writes.appendPreparedDrafts(connection, sessionId, stream.currentSeq, expectedSeq, prepared, idempotencyKey, context);
    });
  }

  async claimTurn(command: TurnClaimCommand, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<TurnClaimResult> {
    if (!Number.isInteger(command.leaseTtlMs) || command.leaseTtlMs <= 0) throw new AgenticError("validation", "leaseTtlMs must be positive");
    const preparedStartEvents = await this.#writes.prepareDrafts(command.startEvents, context);
    return withTenantTransaction(this.pool, context.security, async (connection) => {
      await this.#writes.ensureStream(connection, command.sessionId, context.security, command.agentProfileId ?? "default");
      let stream = await this.#writes.lockStream(connection, command.sessionId, context.security);
      const agentProfileId = command.agentProfileId ?? "default";
      if (stream.agentProfileId !== null && stream.agentProfileId !== agentProfileId) {
        throw new AgenticError("denied", "Session is bound to a different agent profile");
      }
      if (stream.agentProfileId === null) {
        await connection.execute(
          "UPDATE agentic_session_stream SET agent_profile_id=? WHERE tenant_id=? AND session_id=? AND agent_profile_id IS NULL",
          [agentProfileId, context.security.tenantId, command.sessionId],
        );
      }
      const repaired = await this.#writes.repairExpiredTurn(connection, command.sessionId, stream, context);
      if (repaired !== stream.currentSeq || (stream.activeTurnId && !stream.leaseValid)) stream = await this.#writes.lockStream(connection, command.sessionId, context.security);
      const [rows] = await connection.execute<RowDataPacket[]>(
        "SELECT request_fingerprint,turn_id,status,result_seq,error_code FROM agentic_session_turn_request WHERE tenant_id=? AND session_id=? AND idempotency_key=?",
        [context.security.tenantId, command.sessionId, command.idempotencyKey],
      );
      const prior = rows[0];
      if (prior) {
        if (prior.request_fingerprint !== command.requestFingerprint) throw new AgenticError("conflict", "Idempotency key was reused with a different request");
        if (prior.status === "completed") return { kind: "completed", turnId: String(prior.turn_id), seq: Number(prior.result_seq ?? stream.currentSeq) };
        if (prior.status !== "running") return { kind: "failed", turnId: String(prior.turn_id), code: String(prior.error_code ?? prior.status) };
        return { kind: "in-progress", turnId: String(prior.turn_id), retryAfterMs: Math.max(1, Date.parse(stream.leaseExpiresAt ?? new Date().toISOString()) - Date.now()) };
      }
      if (stream.activeTurnId) return { kind: "in-progress", turnId: stream.activeTurnId, retryAfterMs: Math.max(1, Date.parse(stream.leaseExpiresAt ?? new Date().toISOString()) - Date.now()) };
      const token = (BigInt(stream.fencingToken) + 1n).toString();
      await connection.execute(
        `UPDATE agentic_session_stream SET lease_owner=?,lease_fencing_token=?,lease_expires_at=TIMESTAMPADD(MICROSECOND,?*1000,UTC_TIMESTAMP(6)),active_turn_id=?,active_idempotency_key=?
          WHERE tenant_id=? AND session_id=?`,
        [command.ownerId, token, command.leaseTtlMs, command.turnId, command.idempotencyKey, context.security.tenantId, command.sessionId],
      );
      const [leases] = await connection.execute<RowDataPacket[]>("SELECT lease_expires_at FROM agentic_session_stream WHERE tenant_id=? AND session_id=?", [context.security.tenantId, command.sessionId]);
      const expiresAt = leases[0]?.lease_expires_at as Date | string | undefined;
      if (!expiresAt) throw new AgenticError("conflict", "Failed to acquire turn lease");
      await connection.execute(
        `INSERT INTO agentic_session_turn_request(tenant_id,session_id,idempotency_key,request_fingerprint,turn_id,status,fencing_token,actor_id,correlation_id,runtime_snapshot_id)
         VALUES (?,?,?,?,?,'running',?,?,?,?)`,
        [context.security.tenantId, command.sessionId, command.idempotencyKey, command.requestFingerprint, command.turnId, token, context.security.actorId, context.security.correlationId, context.runtime.id],
      );
      const seq = await this.#writes.appendPreparedDrafts(connection, command.sessionId, stream.currentSeq, stream.currentSeq, preparedStartEvents, `turn-claim:${command.idempotencyKey}`, context);
      return { kind: "acquired", lease: { sessionId: command.sessionId, turnId: command.turnId, ownerId: command.ownerId, fencingToken: token, expiresAt: isoTimestamp(expiresAt) }, seq };
    });
  }

  async appendLeased(lease: TurnLease, expectedSeq: number, drafts: readonly EventDraft[], idempotencyKey: string, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<number> {
    const prepared = await this.#writes.prepareDrafts(drafts, context);
    return withTenantTransaction(this.pool, context.security, async (connection) => {
      const stream = await this.#writes.lockStream(connection, lease.sessionId, context.security);
      this.#writes.assertLease(stream, lease);
      return this.#writes.appendPreparedDrafts(connection, lease.sessionId, stream.currentSeq, expectedSeq, prepared, idempotencyKey, context);
    });
  }

  async renewTurn(lease: TurnLease, ttlMs: number, security: SecurityContext): Promise<TurnLease> {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new AgenticError("validation", "lease ttl must be positive");
    return withTenantTransaction(this.pool, security, async (connection) => {
      const [result] = await connection.execute(
        `UPDATE agentic_session_stream SET lease_expires_at=TIMESTAMPADD(MICROSECOND,?*1000,UTC_TIMESTAMP(6))
          WHERE tenant_id=? AND session_id=? AND active_turn_id=? AND lease_owner=? AND lease_fencing_token=? AND lease_expires_at>UTC_TIMESTAMP(6)`,
        [ttlMs, security.tenantId, lease.sessionId, lease.turnId, lease.ownerId, lease.fencingToken],
      );
      if ((result as { affectedRows: number }).affectedRows !== 1) throw new AgenticError("conflict", `Turn lease lost or expired: ${lease.turnId}`);
      const [rows] = await connection.execute<RowDataPacket[]>("SELECT lease_expires_at FROM agentic_session_stream WHERE tenant_id=? AND session_id=?", [security.tenantId, lease.sessionId]);
      return { ...lease, expiresAt: isoTimestamp(rows[0]?.lease_expires_at as Date | string) };
    });
  }

  async finishTurn(lease: TurnLease, expectedSeq: number, terminal: EventDraft, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<number> {
    if (terminal.turnId !== lease.turnId || (terminal.type !== "turn/end" && terminal.type !== "turn/failed")) throw new AgenticError("validation", "finishTurn requires a terminal event for the leased turn");
    const prepared = await this.#writes.prepareDrafts([terminal], context);
    return withTenantTransaction(this.pool, context.security, async (connection) => {
      const stream = await this.#writes.lockStream(connection, lease.sessionId, context.security);
      this.#writes.assertLease(stream, lease);
      const seq = await this.#writes.appendPreparedDrafts(connection, lease.sessionId, stream.currentSeq, expectedSeq, prepared, `turn-terminal:${lease.turnId}`, context);
      const status = terminal.type === "turn/end" ? "completed" : "failed";
      const error = terminal.type === "turn/failed" ? String((terminal.payload as Record<string, unknown>).code ?? "failed") : null;
      await connection.execute("UPDATE agentic_session_turn_request SET status=?,finished_at=UTC_TIMESTAMP(6),result_seq=?,error_code=? WHERE tenant_id=? AND session_id=? AND idempotency_key=? AND fencing_token=?", [status, seq, error, context.security.tenantId, lease.sessionId, stream.activeIdempotencyKey, lease.fencingToken]);
      await connection.execute("UPDATE agentic_session_stream SET lease_owner=NULL,lease_expires_at=NULL,active_turn_id=NULL,active_idempotency_key=NULL WHERE tenant_id=? AND session_id=? AND lease_fencing_token=?", [context.security.tenantId, lease.sessionId, lease.fencingToken]);
      return seq;
    });
  }

  async listSessions(query: import("@0xsyncroot/contracts").SessionDirectoryQuery, security: SecurityContext) {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 51) throw new AgenticError("validation", "Invalid session page size");
    const rows = await withTenantTransaction(this.pool, security, async (connection) => {
      const before = query.before;
      const [entries] = await connection.execute<RowDataPacket[]>(
        `SELECT s.session_id AS stream_session_id, DATE_FORMAT(s.created_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS created_at, e.* FROM
        (SELECT * FROM agentic_session_stream WHERE tenant_id=? AND owner_actor_id=? AND current_seq>0
          ${query.agentProfileId ? "AND COALESCE(agent_profile_id,'default')=?" : ""}
          ${before ? "AND (created_at<? OR (created_at=? AND session_id<?))" : ""}
          ORDER BY created_at DESC,session_id DESC LIMIT ${query.limit}) s
        LEFT JOIN agentic_session_event e ON e.tenant_id=s.tenant_id AND e.session_id=s.session_id AND e.seq=
          (SELECT MIN(i.seq) FROM agentic_session_event i WHERE i.tenant_id=s.tenant_id AND i.session_id=s.session_id AND i.type='user/input')
        ORDER BY s.created_at DESC,s.session_id DESC`,
        [security.tenantId, security.actorId, ...(query.agentProfileId ? [query.agentProfileId] : []),
          ...(before ? [before.createdAt.replace('T',' ').replace('Z',''), before.createdAt.replace('T',' ').replace('Z',''), before.sessionId] : [])]);
      return entries;
    });
    return Promise.all(rows.map(async (row) => {
      const entry = { sessionId: String(row.stream_session_id), createdAt: String(row.created_at) };
      return row.event_id ? { ...entry, firstInput: await this.#firstInput(row as EventRow) } : entry;
    }));
  }

  /**
   * The payload of a session's first input, or an empty one when that row cannot be verified.
   *
   * One damaged row must not take the whole directory down: the list shows that session without a
   * title, and opening it still refuses, because every history read verifies the row again.
   */
  async #firstInput(row: EventRow): Promise<JsonValue> {
    try { return (await mapEvent(row, this.#writes)).payload; }
    catch (error) {
      console.warn(JSON.stringify({ event: "persistence-mysql.session-directory-input-unverified", eventId: row.event_id,
        sessionId: row.session_id, reason: error instanceof Error ? error.message : String(error) }));
      return {};
    }
  }

  async load(sessionId: string, security: SecurityContext): Promise<readonly SessionEvent[]> {
    const rows = await withTenantTransaction(this.pool, security, async (connection) => {
      if (!await visibleStream(connection, sessionId, security)) return [];
      const [events] = await connection.execute<EventRow[]>(`SELECT * FROM ${EVENTS_BY_SEQ} WHERE tenant_id=? AND session_id=? ORDER BY seq`, [security.tenantId, sessionId]);
      return events;
    });
    return this.#mapRows(rows);
  }

  async loadRecent(sessionId: string, limit: number, security: SecurityContext): Promise<readonly SessionEvent[]> {
    assertReadLimit(limit, "recent");
    const rows = await withTenantTransaction(this.pool, security, async (connection) => {
      if (!await visibleStream(connection, sessionId, security)) return [];
      const [newestFirst] = await connection.execute<EventRow[]>(
        `SELECT * FROM ${EVENTS_BY_SEQ} WHERE tenant_id=? AND session_id=? ORDER BY seq DESC LIMIT ${limit}`,
        [security.tenantId, sessionId],
      );
      return oldestFirst(newestFirst);
    });
    return this.#mapRows(rows);
  }

  async loadSince(sessionId: string, afterSeq: number, security: SecurityContext, limit: number): Promise<readonly SessionEvent[]> {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new AgenticError("validation", "Session afterSeq must be a non-negative integer");
    assertReadLimit(limit, "since");
    const rows = await withTenantTransaction(this.pool, security, async (connection) => {
      if (!await visibleStream(connection, sessionId, security)) return [];
      const [events] = await connection.execute<EventRow[]>(
        `SELECT * FROM ${EVENTS_BY_SEQ} WHERE tenant_id=? AND session_id=? AND seq>? ORDER BY seq LIMIT ${limit}`,
        [security.tenantId, sessionId, afterSeq],
      );
      return events;
    });
    return this.#mapRows(rows);
  }

  async loadContext(sessionId: string, security: SecurityContext) {
    const read = await withTenantTransaction(this.pool, security, async (connection) => {
      if (!await visibleStream(connection, sessionId, security)) return undefined;
      const [checkpoints] = await connection.execute<EventRow[]>(
        "SELECT * FROM agentic_session_event WHERE tenant_id=? AND session_id=? AND type='context/checkpoint' ORDER BY seq DESC LIMIT 1",
        [security.tenantId, sessionId],
      );
      const [newestFirst] = await connection.execute<EventRow[]>(
        `SELECT * FROM ${EVENTS_BY_SEQ} WHERE tenant_id=? AND session_id=? ORDER BY seq DESC LIMIT ${MAX_CONTEXT_EVENTS + 1}`,
        [security.tenantId, sessionId],
      );
      return { checkpoint: checkpoints[0], newestFirst };
    });
    if (!read) return { events: [] };
    const checkpoint = read.checkpoint ? await mapEvent(read.checkpoint, this.#writes) : undefined;
    const truncated = read.newestFirst.length > MAX_CONTEXT_EVENTS;
    const events = await this.#mapRows(oldestFirst(read.newestFirst.slice(0, MAX_CONTEXT_EVENTS)));
    return {
      ...(checkpoint ? { checkpoint } : {}), events,
      ...(truncated && events[0] ? { truncatedBeforeSeq: events[0].seq } : {}),
    };
  }

  /**
   * Decrypts and verifies rows after the read transaction has committed.
   *
   * AES-GCM and a sha256 per row are CPU work that needs no database: done inside the callback,
   * they kept one of the pool's few connections checked out for the whole of it, so a long
   * history read could starve the writes of every other turn waiting for a connection.
   */
  #mapRows(rows: readonly EventRow[]): Promise<SessionEvent[]> {
    return Promise.all(rows.map((row) => mapEvent(row, this.#writes)));
  }
}

async function visibleStream(connection: PoolConnection, sessionId: string, security: SecurityContext): Promise<boolean> {
  const [visible] = await connection.execute<RowDataPacket[]>(
    "SELECT 1 FROM agentic_session_stream WHERE tenant_id=? AND session_id=? AND (owner_actor_id IS NULL OR owner_actor_id=?)",
    [security.tenantId, sessionId, security.actorId],
  );
  return visible[0] !== undefined;
}

function assertReadLimit(limit: number, read: "recent" | "since"): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONTEXT_EVENTS) {
    throw new AgenticError("validation", `Session ${read}-event limit must be from 1 to ${MAX_CONTEXT_EVENTS}`);
  }
}

/**
 * Puts a newest-first page back in journal order — here, not in SQL.
 *
 * Both bounded reads used to re-sort in the statement: `SELECT * FROM (… ORDER BY seq DESC LIMIT n)
 * AS recent ORDER BY seq`. The inner order comes free from the (tenant_id, session_id, seq) index;
 * the outer one makes MySQL filesort whole rows, payload included, inside sort_buffer_size (262 144
 * bytes by default). One event that large — an encrypted request snapshot of prompt and tools is
 * enough — and every history and context read of the session fails with "Out of sort memory", on
 * its first turn as readily as its hundredth. Reversing at most a thousand rows here costs nothing
 * and depends on no server setting.
 */
function oldestFirst<T>(newestFirst: readonly T[]): T[] {
  return [...newestFirst].reverse();
}
