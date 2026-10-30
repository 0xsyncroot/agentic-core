import { randomUUID } from "node:crypto";
import { AgenticError, createInterruptedToolResults, isProtectedDataEnvelope, snapshotEventDraft, type DataClassification, type EventDraft, type JsonValue, type PayloadProtector, type ProtectedDataEnvelope, type RuntimeSnapshot, type SecurityContext, type ToolRecoveryEvent, type TurnLease } from "@0xsyncroot/contracts";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { sha256 } from "./hash.js";
import { decodeSessionPayload, encodeSessionPayload } from "./session-payload.js";

export interface LockedStream {
  readonly currentSeq: number; readonly ownerActorId: string | null; readonly leaseOwner: string | null;
  readonly agentProfileId: string | null;
  readonly fencingToken: string; readonly leaseExpiresAt: string | null; readonly leaseValid: boolean;
  readonly activeTurnId: string | null; readonly activeIdempotencyKey: string | null;
}

export interface PreparedSessionDraft {
  readonly draft: EventDraft;
  readonly eventId: string;
  readonly recordedAt: string;
  readonly storedPayload: JsonValue | ProtectedDataEnvelope;
}

export function isoTimestamp(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }

const EVENT_ROW_PLACEHOLDERS = `(${Array.from({ length: 19 }, () => "?").join(",")})`;
/** Rows per INSERT: enough for any batch the runtime writes, far below MySQL's 65 535 placeholders. */
const MAX_ROWS_PER_INSERT = 100;
/**
 * Payload characters per INSERT before the next row starts a new statement.
 *
 * One statement per row used to mean each row only had to fit `max_allowed_packet` on its own.
 * Batching must keep that promise: a statement that sums several large payloads could cross a
 * limit that none of them crosses alone. A single row larger than this still goes, by itself.
 */
const MAX_PAYLOAD_CHARS_PER_INSERT = 1_048_576;

function insertBatches<T extends { readonly payloadChars: number }>(rows: readonly T[]): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const row of rows) {
    if (current.length > 0 && (current.length === MAX_ROWS_PER_INSERT || chars + row.payloadChars > MAX_PAYLOAD_CHARS_PER_INSERT)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(row);
    chars += row.payloadChars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export class MySqlSessionWriteRepository {
  /** `stampAppends` is set only once the boot probe proved this account may write `last_appended_at`. */
  constructor(private readonly payloadProtector?: PayloadProtector, private readonly stampAppends = false) {}

  async decodePayload(input: { readonly eventId: string; readonly tenantId: string; readonly type: string; readonly classification: DataClassification; readonly payload: JsonValue }): Promise<JsonValue> {
    if (!isProtectedDataEnvelope(input.payload)) return decodeSessionPayload(input.payload);
    if (!this.payloadProtector) throw new AgenticError("permanent", `Session event ${input.eventId} is protected but no payload protector is configured`);
    return this.payloadProtector.unprotect(input.payload, { tenantId: input.tenantId, recordId: input.eventId, purpose: `session-event:${input.type}`, classification: input.classification });
  }

  async ensureStream(connection: PoolConnection, sessionId: string, security: SecurityContext, agentProfileId?: string): Promise<void> {
    await connection.execute(
      "INSERT IGNORE INTO agentic_session_stream(tenant_id, session_id, owner_actor_id, agent_profile_id) VALUES (?,?,?,?)",
      [security.tenantId, sessionId, security.actorId, agentProfileId ?? null],
    );
  }

  async prepareDrafts(
    drafts: readonly EventDraft[],
    context: { security: SecurityContext; runtime: RuntimeSnapshot },
  ): Promise<readonly PreparedSessionDraft[]> {
    const safeDrafts = drafts.map(snapshotEventDraft);
    const tenantId = context.security.tenantId;
    const recordedAt = new Date().toISOString();
    return Promise.all(safeDrafts.map(async (draft) => {
      const eventId = randomUUID();
      const classification = draft.classification ?? "internal";
      const storedPayload = this.payloadProtector ? await this.payloadProtector.protect(draft.payload, {
        tenantId, recordId: eventId,
        purpose: `session-event:${draft.type}`, classification,
      }) : draft.payload;
      return { draft, eventId, recordedAt, storedPayload: encodeSessionPayload(storedPayload) };
    }));
  }

  async lockStream(connection: PoolConnection, sessionId: string, security: SecurityContext): Promise<LockedStream> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT current_seq, owner_actor_id, agent_profile_id, lease_owner, lease_fencing_token, lease_expires_at,
              (lease_expires_at IS NOT NULL AND lease_expires_at > UTC_TIMESTAMP(6)) AS lease_valid,
              active_turn_id, active_idempotency_key
         FROM agentic_session_stream
        WHERE tenant_id = ? AND session_id = ? AND (owner_actor_id IS NULL OR owner_actor_id = ?) FOR UPDATE`,
      [security.tenantId, sessionId, security.actorId],
    );
    const row = rows[0];
    if (!row) throw new AgenticError("denied", "Session identifier unavailable or owner boundary violation");
    return {
      currentSeq: Number(row.current_seq), ownerActorId: row.owner_actor_id as string | null,
      agentProfileId: row.agent_profile_id as string | null,
      leaseOwner: row.lease_owner as string | null, fencingToken: String(row.lease_fencing_token),
      leaseExpiresAt: row.lease_expires_at ? isoTimestamp(row.lease_expires_at as Date | string) : null,
      // The pool returns BIGINT as strings (bigNumberStrings), so a false comparison arrives as "0",
      // which Boolean() reads as true: expired leases then looked valid and were never repaired.
      leaseValid: Number(row.lease_valid) === 1, activeTurnId: row.active_turn_id as string | null,
      activeIdempotencyKey: row.active_idempotency_key as string | null,
    };
  }

  async appendDrafts(connection: PoolConnection, sessionId: string, currentSeq: number, expectedSeq: number, drafts: readonly EventDraft[], idempotencyKey: string, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<number> {
    return this.appendPreparedDrafts(connection, sessionId, currentSeq, expectedSeq, await this.prepareDrafts(drafts, context), idempotencyKey, context);
  }

  /**
   * Appends under the stream row lock the caller already holds.
   *
   * `currentSeq` is what `lockStream` read under `FOR UPDATE` in this transaction (or what this
   * transaction has since written), so reading it again would only repeat a round trip on every
   * append. The dedupe lookup still comes first: a retried append answers with its original
   * sequence even though the stream has moved on since.
   */
  async appendPreparedDrafts(connection: PoolConnection, sessionId: string, currentSeq: number, expectedSeq: number, preparedDrafts: readonly PreparedSessionDraft[], idempotencyKey: string, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<number> {
    const operationFingerprint = sha256({
      expectedSeq, drafts: preparedDrafts.map(({ draft }) => draft), tenantId: context.security.tenantId,
      actorId: context.security.actorId, runtimeSnapshotId: context.runtime.id,
    });
    const [dedupe] = await connection.execute<RowDataPacket[]>(
      "SELECT result_seq,operation_fingerprint FROM agentic_session_append_dedupe WHERE tenant_id=? AND session_id=? AND idempotency_key=?",
      [context.security.tenantId, sessionId, idempotencyKey],
    );
    if (dedupe[0]) {
      if (dedupe[0].operation_fingerprint === null) throw new AgenticError("conflict", "Legacy idempotency key has no operation binding");
      if (dedupe[0].operation_fingerprint !== operationFingerprint) throw new AgenticError("conflict", "Idempotency key was reused with a different append operation");
      return Number(dedupe[0].result_seq);
    }
    if (currentSeq !== expectedSeq) throw new AgenticError("conflict", `Session CAS conflict: expected ${expectedSeq}, actual ${currentSeq}`);
    const rows = preparedDrafts.map(({ draft, eventId, recordedAt, storedPayload }, index) => {
      const base = {
        ...draft, eventId, sessionId, seq: expectedSeq + index + 1, schemaVersion: draft.schemaVersion ?? 1,
        occurredAt: recordedAt, recordedAt, tenantId: context.security.tenantId, actorId: context.security.actorId,
        correlationId: context.security.correlationId, runtimeSnapshotId: context.runtime.id,
        classification: draft.classification ?? "internal" as const,
      };
      const payload = JSON.stringify(storedPayload);
      return {
        payloadChars: payload.length,
        values: [base.eventId, base.tenantId, sessionId, base.seq, base.actorId, base.correlationId, base.runtimeSnapshotId,
          base.type, base.schemaVersion, new Date(base.occurredAt), new Date(base.recordedAt), base.turnId ?? null, base.stepId ?? null,
          base.requestId ?? null, base.callId ?? null, base.attemptId ?? null, base.classification, payload, sha256(base)],
      };
    });
    for (const batch of insertBatches(rows)) {
      await connection.execute(
        `INSERT INTO agentic_session_event(
          event_id, tenant_id, session_id, seq, actor_id, correlation_id, runtime_snapshot_id, type, schema_version,
          occurred_at, recorded_at, turn_id, step_id, request_id, call_id, attempt_id, classification, payload, integrity_hash
        ) VALUES ${batch.map(() => EVENT_ROW_PLACEHOLDERS).join(",")}`,
        batch.flatMap((row) => row.values),
      );
    }
    const newSeq = expectedSeq + preparedDrafts.length;
    await connection.execute(this.stampAppends
      ? "UPDATE agentic_session_stream SET current_seq=?, last_appended_at=UTC_TIMESTAMP(6) WHERE tenant_id=? AND session_id=?"
      : "UPDATE agentic_session_stream SET current_seq=? WHERE tenant_id=? AND session_id=?", [newSeq, context.security.tenantId, sessionId]);
    await connection.execute("INSERT INTO agentic_session_append_dedupe(tenant_id,session_id,idempotency_key,operation_fingerprint,result_seq) VALUES (?,?,?,?,?)", [context.security.tenantId, sessionId, idempotencyKey, operationFingerprint, newSeq]);
    return newSeq;
  }

  assertLease(stream: LockedStream, lease: TurnLease): void {
    if (!stream.leaseValid || stream.activeTurnId !== lease.turnId || stream.leaseOwner !== lease.ownerId || stream.fencingToken !== lease.fencingToken) {
      throw new AgenticError("conflict", `Turn lease lost or expired: ${lease.turnId}`);
    }
  }

  async repairExpiredTurn(connection: PoolConnection, sessionId: string, stream: LockedStream, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<number> {
    if (!stream.activeTurnId || stream.leaseValid) return stream.currentSeq;
    const [requests] = await connection.execute<RowDataPacket[]>(
      `SELECT idempotency_key,turn_id,actor_id,correlation_id,runtime_snapshot_id,status
         FROM agentic_session_turn_request WHERE tenant_id=? AND session_id=? AND idempotency_key=? FOR UPDATE`,
      [context.security.tenantId, sessionId, stream.activeIdempotencyKey],
    );
    const request = requests[0];
    let seq = stream.currentSeq;
    if (request?.status === "running") {
      const [events] = await connection.execute<RowDataPacket[]>(
        `SELECT event_id,tenant_id,type,classification,step_id,call_id,payload FROM agentic_session_event
          WHERE tenant_id=? AND session_id=? AND turn_id=? AND type IN ('tool/intent','tool/state','tool/result') ORDER BY seq`,
        [context.security.tenantId, sessionId, request.turn_id],
      );
      const recovery: ToolRecoveryEvent[] = await Promise.all(events.map(async (event) => ({
        type: String(event.type), ...(event.step_id ? { stepId: String(event.step_id) } : {}), ...(event.call_id ? { callId: String(event.call_id) } : {}),
        payload: await this.decodePayload({ eventId: String(event.event_id), tenantId: String(event.tenant_id), type: String(event.type), classification: event.classification as DataClassification, payload: event.payload as JsonValue }),
      })));
      seq = await this.appendDrafts(connection, sessionId, seq, seq, [
        ...createInterruptedToolResults(recovery, String(request.turn_id)),
        { type: "turn/failed", turnId: String(request.turn_id), payload: { code: "worker-lost", message: "Turn interrupted after its worker lease expired", retryable: false, interrupted: true } },
      ], `turn-recovery:${String(request.turn_id)}`, {
        security: { ...context.security, actorId: String(request.actor_id), correlationId: String(request.correlation_id) },
        runtime: { ...context.runtime, id: String(request.runtime_snapshot_id) },
      });
      await connection.execute(
        "UPDATE agentic_session_turn_request SET status='interrupted',finished_at=UTC_TIMESTAMP(6),result_seq=?,error_code='worker-lost' WHERE tenant_id=? AND session_id=? AND idempotency_key=?",
        [seq, context.security.tenantId, sessionId, request.idempotency_key],
      );
    }
    await connection.execute(
      "UPDATE agentic_session_stream SET lease_owner=NULL,lease_expires_at=NULL,active_turn_id=NULL,active_idempotency_key=NULL,lease_fencing_token=lease_fencing_token+1 WHERE tenant_id=? AND session_id=?",
      [context.security.tenantId, sessionId],
    );
    return seq;
  }
}
