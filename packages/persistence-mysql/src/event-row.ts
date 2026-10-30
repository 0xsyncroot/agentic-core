import { AgenticError, type DataClassification, type JsonValue, type SessionEvent } from "@0xsyncroot/contracts";
import type { RowDataPacket } from "mysql2/promise";
import { isoTimestamp, type MySqlSessionWriteRepository } from "./session-write-repository.js";
import { sessionEventHashFormat } from "./session-event-integrity.js";

/**
 * The event table, read through its unique (tenant_id, session_id, seq) key.
 *
 * Every read in seq order names the index instead of leaving the choice to the optimizer. For
 * `seq > ? ORDER BY seq` MySQL 8.0.33 picked `session_checkpoint` — it matches the same two
 * equality columns — and then sorted whole rows, payload included, inside sort_buffer_size: one
 * large event made the read fail with "Out of sort memory". Walking the unique key returns rows
 * already in journal order, so nothing is sorted and LIMIT stops the scan early.
 */
export const EVENTS_BY_SEQ = "agentic_session_event FORCE INDEX (session_seq)";

export interface EventRow extends RowDataPacket {
  event_id: string; session_id: string; seq: string | number; type: string; schema_version: number;
  occurred_at: Date | string; recorded_at: Date | string; tenant_id: string; actor_id: string; correlation_id: string;
  runtime_snapshot_id: string; classification: DataClassification; payload: JsonValue | string;
  turn_id: string | null; step_id: string | null; request_id: string | null; call_id: string | null; attempt_id: string | null; integrity_hash: string;
}

/**
 * A correlation id the writer was given is part of the hash, empty string included: the column is
 * NULL for an absent id and "" for a present, empty one. Dropping "" on read made such a row fail
 * the check against the hash the writer made over it.
 */
function present<K extends string>(key: K, value: string | null): { [P in K]?: string } {
  return value === null ? {} : { [key]: value } as { [P in K]?: string };
}

/** The payload as stored: plain JSON, or the envelope a payload protector wrote. */
export function storedPayload(row: EventRow): JsonValue {
  return typeof row.payload === "string" ? JSON.parse(row.payload) as JsonValue : row.payload;
}

/** Shared with the read-only diagnostic; callers must verify before using an event. */
export async function decodeEventRow(row: EventRow, writes: MySqlSessionWriteRepository, stored = storedPayload(row)): Promise<Omit<SessionEvent, "integrityHash">> {
  const payload = await writes.decodePayload({ eventId: row.event_id, tenantId: row.tenant_id, type: row.type, classification: row.classification, payload: stored });
  return eventBody(row, payload);
}

/** The event a row holds, with `payload` as the caller decoded it. */
export function eventBody(row: EventRow, payload: JsonValue): Omit<SessionEvent, "integrityHash"> {
  return {
    eventId: row.event_id, sessionId: row.session_id, seq: Number(row.seq), type: row.type, schemaVersion: row.schema_version,
    occurredAt: isoTimestamp(row.occurred_at), recordedAt: isoTimestamp(row.recorded_at), tenantId: row.tenant_id,
    actorId: row.actor_id, correlationId: row.correlation_id, runtimeSnapshotId: row.runtime_snapshot_id,
    classification: row.classification, payload, ...present("turnId", row.turn_id),
    ...present("stepId", row.step_id), ...present("requestId", row.request_id),
    ...present("callId", row.call_id), ...present("attemptId", row.attempt_id),
  };
}

export async function mapEvent(row: EventRow, writes: MySqlSessionWriteRepository, stored?: JsonValue): Promise<SessionEvent> {
  const body = await decodeEventRow(row, writes, stored);
  if (sessionEventHashFormat(body, row.integrity_hash) === "mismatch") {
    throw new AgenticError("permanent", `Session event integrity check failed: ${row.event_id}`);
  }
  return { ...body, integrityHash: row.integrity_hash };
}
