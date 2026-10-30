import { AgenticError, type DataClassification, type SessionEvent } from "@0xsyncroot/contracts";
import { sha256 } from "./hash.js";
import { isoTimestamp, type SessionWriteRepository } from "./session-write-repository.js";

export interface EventRow {
  event_id: string;
  session_id: string;
  seq: string;
  type: string;
  schema_version: number;
  occurred_at: Date | string;
  recorded_at: Date | string;
  tenant_id: string;
  actor_id: string;
  correlation_id: string;
  runtime_snapshot_id: string;
  classification: DataClassification;
  payload: SessionEvent["payload"];
  turn_id: string | null;
  step_id: string | null;
  request_id: string | null;
  call_id: string | null;
  attempt_id: string | null;
  integrity_hash: string;
}

/** Rebuilds a journal event from its row, decrypting the payload and refusing a row whose hash no longer matches. */
export async function mapEvent(row: EventRow, writes: SessionWriteRepository): Promise<SessionEvent> {
  const payload = await writes.decodePayload({
    eventId: row.event_id, tenantId: row.tenant_id, type: row.type,
    classification: row.classification, payload: row.payload,
  });
  const eventWithoutHash = {
    eventId: row.event_id,
    sessionId: row.session_id,
    seq: Number(row.seq),
    type: row.type,
    schemaVersion: row.schema_version,
    occurredAt: isoTimestamp(row.occurred_at),
    recordedAt: isoTimestamp(row.recorded_at),
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    correlationId: row.correlation_id,
    runtimeSnapshotId: row.runtime_snapshot_id,
    classification: row.classification,
    payload,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.step_id ? { stepId: row.step_id } : {}),
    ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.call_id ? { callId: row.call_id } : {}),
    ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
  };
  if (sha256(eventWithoutHash) !== row.integrity_hash) {
    throw new AgenticError("permanent", `Session event integrity check failed: ${row.event_id}`);
  }
  return { ...eventWithoutHash, integrityHash: row.integrity_hash };
}
