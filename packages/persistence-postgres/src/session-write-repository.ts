import { randomUUID } from "node:crypto";
import { AgenticError, createInterruptedToolResults, isProtectedDataEnvelope, snapshotEventDraft, type DataClassification, type EventDraft, type JsonValue, type PayloadProtector, type ProtectedDataEnvelope, type RuntimeSnapshot, type SecurityContext, type ToolRecoveryEvent, type TurnLease } from "@0xsyncroot/contracts";
import type { PoolClient } from "pg";
import { sha256 } from "./hash.js";

export interface LockedStream {
  readonly currentSeq: number;
  readonly ownerActorId: string | null;
  readonly agentProfileId: string | null;
  readonly leaseOwner: string | null;
  readonly fencingToken: string;
  readonly leaseExpiresAt: string | null;
  readonly leaseValid: boolean;
  readonly activeTurnId: string | null;
  readonly activeIdempotencyKey: string | null;
}

export interface PreparedSessionDraft {
  readonly draft: EventDraft;
  readonly eventId: string;
  readonly recordedAt: string;
  readonly storedPayload: JsonValue | ProtectedDataEnvelope;
}

export function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class SessionWriteRepository {
  constructor(private readonly payloadProtector?: PayloadProtector) {}

  async decodePayload(input: {
    readonly eventId: string; readonly tenantId: string; readonly type: string;
    readonly classification: DataClassification; readonly payload: JsonValue;
  }): Promise<JsonValue> {
    if (!isProtectedDataEnvelope(input.payload)) return input.payload;
    if (!this.payloadProtector) throw new AgenticError("permanent", `Session event ${input.eventId} is protected but no payload protector is configured`);
    return this.payloadProtector.unprotect(input.payload, {
      tenantId: input.tenantId, recordId: input.eventId,
      purpose: `session-event:${input.type}`, classification: input.classification,
    });
  }

  async ensureStream(client: PoolClient, sessionId: string, security: SecurityContext, agentProfileId?: string): Promise<void> {
    try {
      await client.query(
        "INSERT INTO agentic.session_stream(session_id, tenant_id, owner_actor_id, agent_profile_id) VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, session_id) DO NOTHING",
        [sessionId, security.tenantId, security.actorId, agentProfileId ?? null],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505" || (error as { code?: string }).code === "42501") {
        throw new AgenticError("denied", "Session identifier unavailable or owner boundary violation");
      }
      throw error;
    }
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
      const storedPayload = this.payloadProtector
        ? await this.payloadProtector.protect(draft.payload, {
          tenantId, recordId: eventId,
          purpose: `session-event:${draft.type}`, classification,
        })
        : draft.payload;
      return { draft, eventId, recordedAt, storedPayload };
    }));
  }

  async lockStream(client: PoolClient, sessionId: string): Promise<LockedStream> {
    const result = await client.query<{
      current_seq: string; owner_actor_id: string | null; agent_profile_id: string | null; lease_owner: string | null;
      lease_fencing_token: string; lease_expires_at: Date | string | null; lease_valid: boolean;
      active_turn_id: string | null; active_idempotency_key: string | null;
    }>(
      `SELECT current_seq, owner_actor_id, agent_profile_id, lease_owner, lease_fencing_token, lease_expires_at,
              coalesce(lease_expires_at > clock_timestamp(), false) AS lease_valid,
              active_turn_id, active_idempotency_key
       FROM agentic.session_stream WHERE session_id = $1 FOR UPDATE`,
      [sessionId],
    );
    const row = result.rows[0];
    if (!row) throw new AgenticError("denied", "Session identifier unavailable or owner boundary violation");
    return {
      currentSeq: Number(row.current_seq), ownerActorId: row.owner_actor_id, agentProfileId: row.agent_profile_id,
      leaseOwner: row.lease_owner,
      fencingToken: row.lease_fencing_token,
      leaseExpiresAt: row.lease_expires_at === null ? null : isoTimestamp(row.lease_expires_at),
      leaseValid: row.lease_valid, activeTurnId: row.active_turn_id, activeIdempotencyKey: row.active_idempotency_key,
    };
  }

  async appendDrafts(
    client: PoolClient, sessionId: string, expectedSeq: number, drafts: readonly EventDraft[], idempotencyKey: string,
    context: { security: SecurityContext; runtime: RuntimeSnapshot },
  ): Promise<number> {
    return this.appendPreparedDrafts(client, sessionId, expectedSeq, await this.prepareDrafts(drafts, context), idempotencyKey, context);
  }

  async appendPreparedDrafts(
    client: PoolClient, sessionId: string, expectedSeq: number, preparedDrafts: readonly PreparedSessionDraft[], idempotencyKey: string,
    context: { security: SecurityContext; runtime: RuntimeSnapshot },
  ): Promise<number> {
    const operationFingerprint = sha256({
      expectedSeq, drafts: preparedDrafts.map(({ draft }) => draft), tenantId: context.security.tenantId,
      actorId: context.security.actorId, runtimeSnapshotId: context.runtime.id,
    });
    const duplicate = await client.query<{ result_seq: string; operation_fingerprint: string | null }>(
      "SELECT result_seq, operation_fingerprint FROM agentic.session_append_dedupe WHERE session_id = $1 AND idempotency_key = $2",
      [sessionId, idempotencyKey],
    );
    if (duplicate.rows[0]) {
      if (duplicate.rows[0].operation_fingerprint === null) throw new AgenticError("conflict", "Legacy idempotency key has no operation binding");
      if (duplicate.rows[0].operation_fingerprint !== operationFingerprint) throw new AgenticError("conflict", "Idempotency key was reused with a different append operation");
      return Number(duplicate.rows[0].result_seq);
    }
    const stream = await client.query<{ current_seq: string }>(
      "SELECT current_seq FROM agentic.session_stream WHERE session_id = $1", [sessionId],
    );
    const currentSeq = Number(stream.rows[0]?.current_seq ?? -1);
    if (currentSeq !== expectedSeq) throw new AgenticError("conflict", `Session CAS conflict: expected ${expectedSeq}, actual ${currentSeq}`);
    for (const [index, prepared] of preparedDrafts.entries()) {
      const { draft, eventId, recordedAt, storedPayload } = prepared;
      const base = {
        ...draft, eventId, sessionId, seq: expectedSeq + index + 1,
        schemaVersion: draft.schemaVersion ?? 1, occurredAt: recordedAt, recordedAt,
        tenantId: context.security.tenantId, actorId: context.security.actorId,
        correlationId: context.security.correlationId, runtimeSnapshotId: context.runtime.id,
        classification: draft.classification ?? "internal",
      };
      await client.query(
        `INSERT INTO agentic.session_event(
           event_id, session_id, seq, tenant_id, actor_id, correlation_id, runtime_snapshot_id,
           type, schema_version, occurred_at, recorded_at, turn_id, step_id, request_id,
           call_id, attempt_id, classification, payload, integrity_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [base.eventId, sessionId, base.seq, base.tenantId, base.actorId, base.correlationId,
          base.runtimeSnapshotId, base.type, base.schemaVersion, base.occurredAt, base.recordedAt,
          base.turnId ?? null, base.stepId ?? null, base.requestId ?? null, base.callId ?? null,
          base.attemptId ?? null, base.classification, JSON.stringify(storedPayload), sha256(base)],
      );
    }
    const newSeq = expectedSeq + preparedDrafts.length;
    await client.query("UPDATE agentic.session_stream SET current_seq = $2 WHERE session_id = $1", [sessionId, newSeq]);
    await client.query(
      "INSERT INTO agentic.session_append_dedupe(session_id, tenant_id, idempotency_key, operation_fingerprint, result_seq) VALUES ($1,$2,$3,$4,$5)",
      [sessionId, context.security.tenantId, idempotencyKey, operationFingerprint, newSeq],
    );
    return newSeq;
  }

  assertLease(stream: LockedStream, lease: TurnLease): void {
    if (!stream.leaseValid || stream.activeTurnId !== lease.turnId || stream.leaseOwner !== lease.ownerId || stream.fencingToken !== lease.fencingToken) {
      throw new AgenticError("conflict", `Turn lease lost or expired: ${lease.turnId}`);
    }
  }

  async repairExpiredTurn(
    client: PoolClient, sessionId: string, stream: LockedStream,
    context: { security: SecurityContext; runtime: RuntimeSnapshot },
  ): Promise<number> {
    if (!stream.activeTurnId || stream.leaseValid) return stream.currentSeq;
    const request = await client.query<{
      idempotency_key: string; turn_id: string; actor_id: string; correlation_id: string;
      runtime_snapshot_id: string; status: string;
    }>(
      `SELECT idempotency_key, turn_id, actor_id, correlation_id, runtime_snapshot_id, status
       FROM agentic.session_turn_request WHERE session_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [sessionId, stream.activeIdempotencyKey],
    );
    const row = request.rows[0];
    let seq = stream.currentSeq;
    if (row?.status === "running") {
      const toolEvents = await client.query<{
        event_id: string; tenant_id: string; type: string; classification: DataClassification;
        step_id: string | null; call_id: string | null; payload: JsonValue;
      }>(
        `SELECT event_id, tenant_id, type, classification, step_id, call_id, payload
           FROM agentic.session_event
          WHERE session_id = $1 AND turn_id = $2
            AND type IN ('tool/intent', 'tool/state', 'tool/result')
          ORDER BY seq`,
        [sessionId, row.turn_id],
      );
      const recoveryEvents: ToolRecoveryEvent[] = await Promise.all(toolEvents.rows.map(async (event) => ({
        type: event.type,
        ...(event.step_id ? { stepId: event.step_id } : {}),
        ...(event.call_id ? { callId: event.call_id } : {}),
        payload: await this.decodePayload({
          eventId: event.event_id, tenantId: event.tenant_id, type: event.type,
          classification: event.classification, payload: event.payload,
        }),
      })));
      seq = await this.appendDrafts(client, sessionId, seq, [
        ...createInterruptedToolResults(recoveryEvents, row.turn_id),
        {
          type: "turn/failed", turnId: row.turn_id,
          payload: { code: "worker-lost", message: "Turn interrupted after its worker lease expired", retryable: false, interrupted: true },
        },
      ], `turn-recovery:${row.turn_id}`, {
        security: { ...context.security, actorId: row.actor_id, correlationId: row.correlation_id },
        runtime: { ...context.runtime, id: row.runtime_snapshot_id },
      });
      await client.query(
        `UPDATE agentic.session_turn_request
         SET status = 'interrupted', finished_at = clock_timestamp(), result_seq = $3, error_code = 'worker-lost'
         WHERE session_id = $1 AND idempotency_key = $2`, [sessionId, row.idempotency_key, seq],
      );
    }
    await client.query(
      `UPDATE agentic.session_stream
       SET lease_owner = NULL, lease_expires_at = NULL, active_turn_id = NULL, active_idempotency_key = NULL,
           lease_fencing_token = lease_fencing_token + 1 WHERE session_id = $1`, [sessionId],
    );
    return seq;
  }
}
