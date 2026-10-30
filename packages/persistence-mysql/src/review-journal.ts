import {
  AgenticError, isProtectedDataEnvelope, REVIEW_LIMITS, reviewPageSize, type ChangedSession, type ChangedSessionCursor, type PayloadProtector,
  type ReviewJournalSource, type SessionEvent, type ShardStream, type StreamKeyCursor,
} from "@0xsyncroot/contracts";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { eventBody, EVENTS_BY_SEQ, mapEvent, storedPayload, type EventRow } from "./event-row.js";
import { isoColumn, mysqlTime } from "./mysql-time.js";
import { MySqlSessionWriteRepository } from "./session-write-repository.js";

interface ChangedRow extends RowDataPacket {
  tenant_id: string; session_id: string; owner_actor_id: string | null; agent_profile_id: string | null; current_seq: string | number; appended_at: string | null;
}

const STREAM_COLUMNS = `tenant_id, session_id, owner_actor_id, agent_profile_id, current_seq, ${isoColumn("last_appended_at")} AS appended_at`;
const streamOf = (row: ChangedRow): ShardStream => ({
  tenantId: row.tenant_id, sessionId: row.session_id, ownerActorId: row.owner_actor_id, agentProfileId: row.agent_profile_id,
  currentSeq: Number(row.current_seq), lastAppendedAt: row.appended_at,
});

function streamKey(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new AgenticError("validation", `${field} must be a non-empty string`);
  return value;
}

/**
 * The shard's journal as the projector reads it: no owner check, and every event decoded and integrity-checked as the
 * session store reads it, except a protected payload this source has no protector for, which passes through as its envelope.
 * `changedSince` walks `stream_recent`, whose rows already come in (stamp, tenant, session) order because the secondary index
 * carries the primary key; `streamsByKey` walks the primary key. LIMIT is inlined after `reviewPageSize` proved it an integer.
 */
export class MySqlReviewJournalSource implements ReviewJournalSource {
  readonly #writes: MySqlSessionWriteRepository;
  readonly #decrypts: boolean;
  constructor(private readonly pool: Pool, payloadProtector?: PayloadProtector) {
    this.#writes = new MySqlSessionWriteRepository(payloadProtector);
    this.#decrypts = payloadProtector !== undefined;
  }

  async changedSince(sinceIso: string, limit: number, after?: ChangedSessionCursor): Promise<readonly ChangedSession[]> {
    const size = reviewPageSize(limit, "limit", REVIEW_LIMITS.maxChangedPage);
    const binds: string[] = [mysqlTime(sinceIso, "sinceIso")];
    let keyset = "";
    if (after) {
      const at = mysqlTime(after.lastAppendedAt, "after.lastAppendedAt");
      const tenantId = streamKey(after.tenantId, "after.tenantId"); const sessionId = streamKey(after.sessionId, "after.sessionId");
      keyset = " AND (last_appended_at > ? OR (last_appended_at = ? AND (tenant_id > ? OR (tenant_id = ? AND session_id > ?))))";
      binds.push(at, at, tenantId, tenantId, sessionId);
    }
    const [rows] = await this.pool.execute<ChangedRow[]>(
      `SELECT ${STREAM_COLUMNS} FROM agentic_session_stream FORCE INDEX (stream_recent)
        WHERE last_appended_at >= ?${keyset}
        ORDER BY last_appended_at, tenant_id, session_id LIMIT ${size}`, binds);
    return rows.map((row) => ({ ...streamOf(row), lastAppendedAt: row.appended_at! }));
  }

  async streamsByKey(limit: number, after?: StreamKeyCursor): Promise<readonly ShardStream[]> {
    const size = reviewPageSize(limit, "limit", REVIEW_LIMITS.maxChangedPage);
    const binds: string[] = [];
    let keyset = "";
    if (after) {
      const tenantId = streamKey(after.tenantId, "after.tenantId"); const sessionId = streamKey(after.sessionId, "after.sessionId");
      keyset = " WHERE tenant_id > ? OR (tenant_id = ? AND session_id > ?)";
      binds.push(tenantId, tenantId, sessionId);
    }
    const [rows] = await this.pool.execute<ChangedRow[]>(
      `SELECT ${STREAM_COLUMNS} FROM agentic_session_stream${keyset} ORDER BY tenant_id, session_id LIMIT ${size}`, binds);
    return rows.map(streamOf);
  }

  async eventsAfter(tenantId: string, sessionId: string, afterSeq: number, limit: number): Promise<readonly SessionEvent[]> {
    const size = reviewPageSize(limit, "limit", REVIEW_LIMITS.maxEventPage);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new AgenticError("validation", "afterSeq must be a non-negative integer");
    const [rows] = await this.pool.execute<EventRow[]>(
      `SELECT * FROM ${EVENTS_BY_SEQ} WHERE tenant_id=? AND session_id=? AND seq>? ORDER BY seq LIMIT ${size}`,
      [streamKey(tenantId, "tenantId"), streamKey(sessionId, "sessionId"), afterSeq]);
    return Promise.all(rows.map((row) => this.#event(row)));
  }

  /** The envelope stands in for a payload this source cannot decrypt; its hash covers the plaintext, so it is not checked. */
  async #event(row: EventRow): Promise<SessionEvent> {
    const stored = storedPayload(row);
    if (!this.#decrypts && isProtectedDataEnvelope(stored)) return { ...eventBody(row, stored), integrityHash: row.integrity_hash };
    return mapEvent(row, this.#writes, stored);
  }
}
