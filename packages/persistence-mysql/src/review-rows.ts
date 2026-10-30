import { AgenticError, checkedLeaseFence, type LeaseFence, type ReviewSessionSummary, type ReviewToolLabel, type ReviewTranscriptEntry } from "@0xsyncroot/contracts";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { isoColumn } from "./mysql-time.js";

/** Row shapes and column lists the review projection and query stores share, so a stored entry reads back as it was given. */

export const SESSION_COLUMNS = `s.tenant_id, s.session_id, s.agent_id, s.channel, s.actor_key, s.actor_key_version,
  ${isoColumn("s.started_at")} AS started_at, ${isoColumn("s.last_turn_at")} AS last_turn_at, s.answers, s.transcript_mask_version`;

export interface SessionRow extends RowDataPacket {
  tenant_id: string; session_id: string; agent_id: string; channel: "live" | "preview"; actor_key: string; actor_key_version: string;
  started_at: string; last_turn_at: string; answers: string | number; transcript_mask_version: string | null; display_name?: string | null;
}

export function sessionFromRow(row: SessionRow): ReviewSessionSummary {
  return {
    tenantId: row.tenant_id, sessionId: row.session_id, agentId: row.agent_id, channel: row.channel, actorKey: row.actor_key,
    actorKeyVersion: row.actor_key_version, startedAt: row.started_at, lastTurnAt: row.last_turn_at, answers: Number(row.answers),
    ...(row.transcript_mask_version === null ? {} : { transcriptMaskVersion: row.transcript_mask_version }),
    ...(row.display_name === null || row.display_name === undefined ? {} : { tenantName: row.display_name }),
  };
}

export const ENTRY_COLUMNS = `mask_version, entry_seq, turn_id, answer_index, role, body_format, body, tool_labels, masked_values, source_hash,
  ${isoColumn("created_at")} AS created_at`;

export interface EntryRow extends RowDataPacket {
  mask_version: string; entry_seq: string | number; turn_id: string; answer_index: string | number | null; role: ReviewTranscriptEntry["role"];
  body_format: ReviewTranscriptEntry["bodyFormat"]; body: string; tool_labels: string | null; masked_values: string | number; source_hash: string; created_at: string;
}

export function entryFromRow(row: EntryRow): ReviewTranscriptEntry {
  return {
    maskVersion: row.mask_version, entrySeq: Number(row.entry_seq), turnId: row.turn_id,
    ...(row.answer_index === null ? {} : { answerIndex: Number(row.answer_index) }),
    role: row.role, bodyFormat: row.body_format, body: row.body,
    ...(row.tool_labels === null ? {} : { toolLabels: JSON.parse(row.tool_labels) as readonly ReviewToolLabel[] }),
    maskedValues: Number(row.masked_values), sourceHash: row.source_hash, at: row.created_at,
  };
}

/** An entry as one comparable text, for "already stored with the same content". */
export function entryContent(entry: ReviewTranscriptEntry): string {
  return JSON.stringify([entry.maskVersion, entry.entrySeq, entry.turnId, entry.answerIndex ?? null, entry.role, entry.bodyFormat, entry.body,
    entry.toolLabels ?? null, entry.maskedValues, entry.sourceHash, entry.at]);
}

/**
 * Refuses the write unless `fence` is the current lease. The shared lock holds the lease row until the transaction ends, so
 * no other worker can take the lease between this check and the commit; SELECT ... FOR SHARE needs only the SELECT grant.
 */
export async function assertFence(connection: PoolConnection, fence: LeaseFence): Promise<void> {
  const checked = checkedLeaseFence(fence);
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT lease_owner IS NOT NULL AND CAST(fencing_token AS CHAR) = ? AND lease_expires_at > UTC_TIMESTAMP(6) AS held
       FROM agentic_worker_lease WHERE worker_kind = ? FOR SHARE`, [checked.fencingToken, checked.workerKind]);
  if (Number(rows[0]?.held) !== 1) throw new AgenticError("conflict", `The ${checked.workerKind} lease is not held under fencing token ${checked.fencingToken}`);
}

/** `LIKE` text matching values that start with `prefix` literally, under `ESCAPE '!'`. */
export function likePrefix(prefix: string): string {
  return `${prefix.replace(/[!%_]/gu, (character) => `!${character}`)}%`;
}
