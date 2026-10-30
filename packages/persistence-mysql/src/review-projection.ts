import {
  AgenticError, checkedLeaseFence, checkedProjectionCursor, checkedProjectionWatermark, checkedReviewEntries, checkedReviewSession,
  reviewIdentifier, type LeaseFence, type ProjectionCursor, type ProjectionWatermark, type ReviewProjectionStore, type ReviewSessionRecord,
  type ReviewTranscriptEntry,
} from "@0xsyncroot/contracts";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { isoColumn, mysqlTime } from "./mysql-time.js";
import { assertFence, ENTRY_COLUMNS, entryContent, entryFromRow, SESSION_COLUMNS, sessionFromRow, type EntryRow, type SessionRow } from "./review-rows.js";
import { withTransaction } from "./transaction.js";

/** Entries per SELECT or INSERT, and body characters per INSERT, so no statement nears `max_allowed_packet`. */
const ENTRY_BATCH = 100;
const ENTRY_BATCH_CHARS = 1_000_000;
const ENTRY_PLACEHOLDERS = `(${Array.from({ length: 13 }, () => "?").join(",")})`;

function batches(entries: readonly ReviewTranscriptEntry[]): ReviewTranscriptEntry[][] {
  const result: ReviewTranscriptEntry[][] = [];
  let current: ReviewTranscriptEntry[] = []; let chars = 0;
  for (const entry of entries) {
    if (current.length > 0 && (current.length === ENTRY_BATCH || chars + entry.body.length > ENTRY_BATCH_CHARS)) { result.push(current); current = []; chars = 0; }
    current.push(entry); chars += entry.body.length;
  }
  if (current.length > 0) result.push(current);
  return result;
}

/**
 * The projector's writes into one shard. Every write checks its lease fence first, inside the same transaction. Rows are
 * compared before they are written, so a rerun with the same input issues no UPDATE and a header's version moves only when
 * its content does; `started_at` is never updated, which the console account's column grants also hold.
 */
export class MySqlReviewProjectionStore implements ReviewProjectionStore {
  constructor(private readonly pool: Pool) {}

  async cursor(tenantId: string, sessionId: string, projectorId: string): Promise<ProjectionCursor | undefined> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT projected_seq, projector_revision FROM agentic_projection_cursor WHERE tenant_id=? AND session_id=? AND projector_id=?",
      [reviewIdentifier(tenantId, "tenantId", 191), reviewIdentifier(sessionId, "sessionId", 191), reviewIdentifier(projectorId, "projectorId", 64)]);
    const row = rows[0];
    return row ? { tenantId, sessionId, projectorId, projectedSeq: Number(row.projected_seq), projectorRevision: String(row.projector_revision) } : undefined;
  }

  async replace(session: ReviewSessionRecord, entries: readonly ReviewTranscriptEntry[], cursor: ProjectionCursor, fence: LeaseFence): Promise<void> {
    const record = checkedReviewSession(session);
    const checked = checkedReviewEntries(entries);
    const position = checkedProjectionCursor(cursor, record);
    const lease = checkedLeaseFence(fence);
    await withTransaction(this.pool, async (connection) => {
      await assertFence(connection, lease);
      await this.#upsertHeader(connection, record);
      for (const batch of batches(checked)) await this.#insertMissing(connection, record, batch);
      await this.#upsertCursor(connection, position);
    });
  }

  async watermark(projectorId: string): Promise<ProjectionWatermark | undefined> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT ${isoColumn("watermark_at")} AS watermark_at, projector_revision FROM agentic_projection_watermark WHERE projector_id=?`,
      [reviewIdentifier(projectorId, "projectorId", 64)]);
    const row = rows[0];
    return row ? { projectorId, watermarkAt: String(row.watermark_at), projectorRevision: String(row.projector_revision) } : undefined;
  }

  async saveWatermark(watermark: ProjectionWatermark, fence: LeaseFence): Promise<void> {
    const checked = checkedProjectionWatermark(watermark);
    const lease = checkedLeaseFence(fence);
    await withTransaction(this.pool, async (connection) => {
      await assertFence(connection, lease);
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT ${isoColumn("watermark_at")} AS watermark_at, projector_revision FROM agentic_projection_watermark WHERE projector_id=?`, [checked.projectorId]);
      const row = rows[0];
      if (!row) {
        await connection.execute("INSERT INTO agentic_projection_watermark (projector_id, watermark_at, projector_revision, updated_at) VALUES (?,?,?,UTC_TIMESTAMP(6))",
          [checked.projectorId, mysqlTime(checked.watermarkAt, "watermarkAt"), checked.projectorRevision]);
      } else if (row.watermark_at !== checked.watermarkAt || row.projector_revision !== checked.projectorRevision) {
        await connection.execute("UPDATE agentic_projection_watermark SET watermark_at=?, projector_revision=?, updated_at=UTC_TIMESTAMP(6) WHERE projector_id=?",
          [mysqlTime(checked.watermarkAt, "watermarkAt"), checked.projectorRevision, checked.projectorId]);
      }
    });
  }

  async #upsertHeader(connection: PoolConnection, record: ReviewSessionRecord): Promise<void> {
    const [rows] = await connection.execute<SessionRow[]>(
      `SELECT ${SESSION_COLUMNS} FROM agentic_review_session s WHERE s.tenant_id=? AND s.session_id=?`, [record.tenantId, record.sessionId]);
    const stored = rows[0] ? sessionFromRow(rows[0]) : undefined;
    const values = [record.agentId, record.channel, record.actorKey, record.actorKeyVersion, mysqlTime(record.lastTurnAt, "lastTurnAt"), record.answers, record.transcriptMaskVersion ?? null];
    if (!stored) {
      await connection.execute(
        `INSERT INTO agentic_review_session (agent_id, channel, actor_key, actor_key_version, last_turn_at, answers, transcript_mask_version,
           tenant_id, session_id, started_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6))`,
        [...values, record.tenantId, record.sessionId, mysqlTime(record.startedAt, "startedAt")]);
      return;
    }
    if (JSON.stringify({ ...record, startedAt: stored.startedAt }) === JSON.stringify(stored)) return;
    await connection.execute(
      `UPDATE agentic_review_session SET agent_id=?, channel=?, actor_key=?, actor_key_version=?, last_turn_at=?, answers=?, transcript_mask_version=?,
         version=version+1, updated_at=UTC_TIMESTAMP(6) WHERE tenant_id=? AND session_id=?`, [...values, record.tenantId, record.sessionId]);
  }

  async #insertMissing(connection: PoolConnection, record: ReviewSessionRecord, batch: readonly ReviewTranscriptEntry[]): Promise<void> {
    const keys = batch.map(() => "(?,?)").join(",");
    const [rows] = await connection.execute<EntryRow[]>(
      `SELECT ${ENTRY_COLUMNS} FROM agentic_review_transcript WHERE tenant_id=? AND session_id=? AND (mask_version, entry_seq) IN (${keys})`,
      [record.tenantId, record.sessionId, ...batch.flatMap((entry) => [entry.maskVersion, entry.entrySeq])]);
    const stored = new Map(rows.map((row) => { const entry = entryFromRow(row); return [`${entry.maskVersion}\u0000${entry.entrySeq}`, entryContent(entry)]; }));
    const missing = batch.filter((entry) => {
      const content = stored.get(`${entry.maskVersion}\u0000${entry.entrySeq}`);
      if (content !== undefined && content !== entryContent(entry)) {
        throw new AgenticError("conflict", `Transcript entry ${entry.entrySeq} of mask version ${entry.maskVersion} is already stored with other content`);
      }
      return content === undefined;
    });
    if (missing.length === 0) return;
    await connection.execute(
      `INSERT INTO agentic_review_transcript (tenant_id, session_id, mask_version, entry_seq, turn_id, answer_index, role, body_format, body,
         tool_labels, masked_values, source_hash, created_at) VALUES ${missing.map(() => ENTRY_PLACEHOLDERS).join(",")}`,
      missing.flatMap((entry) => [record.tenantId, record.sessionId, entry.maskVersion, entry.entrySeq, entry.turnId, entry.answerIndex ?? null, entry.role,
        entry.bodyFormat, entry.body, entry.toolLabels ? JSON.stringify(entry.toolLabels) : null, entry.maskedValues, entry.sourceHash, mysqlTime(entry.at, "at")]));
  }

  async #upsertCursor(connection: PoolConnection, cursor: ProjectionCursor): Promise<void> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT projected_seq, projector_revision FROM agentic_projection_cursor WHERE tenant_id=? AND session_id=? AND projector_id=?",
      [cursor.tenantId, cursor.sessionId, cursor.projectorId]);
    const row = rows[0];
    if (!row) {
      await connection.execute(
        "INSERT INTO agentic_projection_cursor (tenant_id, session_id, projector_id, projected_seq, projector_revision, updated_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(6))",
        [cursor.tenantId, cursor.sessionId, cursor.projectorId, cursor.projectedSeq, cursor.projectorRevision]);
    } else if (Number(row.projected_seq) !== cursor.projectedSeq || row.projector_revision !== cursor.projectorRevision) {
      await connection.execute(
        "UPDATE agentic_projection_cursor SET projected_seq=?, projector_revision=?, updated_at=UTC_TIMESTAMP(6) WHERE tenant_id=? AND session_id=? AND projector_id=?",
        [cursor.projectedSeq, cursor.projectorRevision, cursor.tenantId, cursor.sessionId, cursor.projectorId]);
    }
  }
}
