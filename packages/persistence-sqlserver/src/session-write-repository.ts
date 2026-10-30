import { randomUUID } from "node:crypto";
import {
  AgenticError, createInterruptedToolResults, isProtectedDataEnvelope, snapshotEventDraft,
  type DataClassification, type EventDraft, type JsonValue, type PayloadProtector, type ProtectedDataEnvelope, type RuntimeSnapshot,
  type SecurityContext, type ToolRecoveryEvent, type TurnLease,
} from "@0xsyncroot/contracts";
import type { Transaction } from "mssql";
import { sha256 } from "./hash.js";
import { bigInteger, dateTime, integer, longText, request, text } from "./sql-request.js";

export interface LockedStream {
  readonly currentSeq: number; readonly ownerActorId: string | null; readonly leaseOwner: string | null;
  readonly agentProfileId: string | null;
  readonly fencingToken: string; readonly leaseExpiresAt: string | null; readonly leaseValid: boolean;
  readonly activeTurnId: string | null; readonly activeIdempotencyKey: string | null;
}

export interface PreparedSessionDraft {
  readonly draft: EventDraft;
  readonly eventId: string;
  readonly recordedAt: Date;
  readonly storedPayload: JsonValue | ProtectedDataEnvelope;
}

export function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class SqlServerSessionWriteRepository {
  constructor(private readonly payloadProtector?: PayloadProtector) {}

  async decodePayload(input: { readonly eventId: string; readonly tenantId: string; readonly type: string; readonly classification: DataClassification; readonly payload: JsonValue }): Promise<JsonValue> {
    if (!isProtectedDataEnvelope(input.payload)) return input.payload;
    if (!this.payloadProtector) throw new AgenticError("permanent", `Session event ${input.eventId} is protected but no payload protector is configured`);
    return this.payloadProtector.unprotect(input.payload, {
      tenantId: input.tenantId, recordId: input.eventId, purpose: `session-event:${input.type}`, classification: input.classification,
    });
  }

  async ensureStream(transaction: Transaction, sessionId: string, security: SecurityContext, agentProfileId?: string): Promise<void> {
    const input = text(text(request(transaction), "tenant_id", security.tenantId), "session_id", sessionId);
    text(input, "actor_id", security.actorId);
    text(input, "agent_profile_id", agentProfileId ?? null);
    await input.query(`IF NOT EXISTS (
      SELECT 1 FROM agentic.session_stream WITH (UPDLOCK,HOLDLOCK) WHERE tenant_id=@tenant_id AND session_id=@session_id
    ) INSERT INTO agentic.session_stream(tenant_id,session_id,owner_actor_id,agent_profile_id) VALUES (@tenant_id,@session_id,@actor_id,@agent_profile_id);`);
  }

  async prepareDrafts(
    drafts: readonly EventDraft[],
    context: { security: SecurityContext; runtime: RuntimeSnapshot },
  ): Promise<readonly PreparedSessionDraft[]> {
    const safeDrafts = drafts.map(snapshotEventDraft);
    const tenantId = context.security.tenantId;
    const recordedAt = new Date();
    return Promise.all(safeDrafts.map(async (draft) => {
      const eventId = randomUUID();
      const classification = draft.classification ?? "internal";
      const storedPayload = this.payloadProtector ? await this.payloadProtector.protect(draft.payload, {
        tenantId, recordId: eventId,
        purpose: `session-event:${draft.type}`, classification,
      }) : draft.payload;
      return { draft, eventId, recordedAt, storedPayload };
    }));
  }

  async lockStream(transaction: Transaction, sessionId: string, security: SecurityContext): Promise<LockedStream> {
    const input = text(text(text(request(transaction), "tenant_id", security.tenantId), "session_id", sessionId), "actor_id", security.actorId);
    const result = await input.query<Record<string, unknown>>(`SELECT current_seq,owner_actor_id,agent_profile_id,lease_owner,lease_fencing_token,lease_expires_at,
      CASE WHEN lease_expires_at IS NOT NULL AND lease_expires_at>SYSUTCDATETIME() THEN 1 ELSE 0 END AS lease_valid,
      active_turn_id,active_idempotency_key FROM agentic.session_stream WITH (UPDLOCK,HOLDLOCK)
      WHERE tenant_id=@tenant_id AND session_id=@session_id AND (owner_actor_id IS NULL OR owner_actor_id=@actor_id);`);
    const row = result.recordset[0];
    if (!row) throw new AgenticError("denied", "Session identifier unavailable or owner boundary violation");
    return {
      currentSeq: Number(row.current_seq), ownerActorId: row.owner_actor_id as string | null,
      agentProfileId: row.agent_profile_id as string | null,
      leaseOwner: row.lease_owner as string | null, fencingToken: String(row.lease_fencing_token),
      leaseExpiresAt: row.lease_expires_at ? isoTimestamp(row.lease_expires_at as Date | string) : null,
      leaseValid: Boolean(row.lease_valid), activeTurnId: row.active_turn_id as string | null,
      activeIdempotencyKey: row.active_idempotency_key as string | null,
    };
  }

  async appendDrafts(transaction: Transaction, sessionId: string, expectedSeq: number, drafts: readonly EventDraft[], idempotencyKey: string, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<number> {
    return this.appendPreparedDrafts(transaction, sessionId, expectedSeq, await this.prepareDrafts(drafts, context), idempotencyKey, context);
  }

  async appendPreparedDrafts(transaction: Transaction, sessionId: string, expectedSeq: number, preparedDrafts: readonly PreparedSessionDraft[], idempotencyKey: string, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<number> {
    const operationFingerprint = sha256({
      expectedSeq, drafts: preparedDrafts.map(({ draft }) => draft), tenantId: context.security.tenantId,
      actorId: context.security.actorId, runtimeSnapshotId: context.runtime.id,
    });
    let input = request(transaction);
    input = text(text(text(input, "tenant_id", context.security.tenantId), "session_id", sessionId), "idempotency_key", idempotencyKey);
    const dedupe = await input.query<{ result_seq: string | number; operation_fingerprint: string | null }>(`SELECT result_seq,operation_fingerprint FROM agentic.session_append_dedupe
      WHERE tenant_id=@tenant_id AND session_id=@session_id AND idempotency_key=@idempotency_key;`);
    if (dedupe.recordset[0]) {
      if (dedupe.recordset[0].operation_fingerprint === null) throw new AgenticError("conflict", "Legacy idempotency key has no operation binding");
      if (dedupe.recordset[0].operation_fingerprint !== operationFingerprint) throw new AgenticError("conflict", "Idempotency key was reused with a different append operation");
      return Number(dedupe.recordset[0].result_seq);
    }
    input = text(text(request(transaction), "tenant_id", context.security.tenantId), "session_id", sessionId);
    const streams = await input.query<{ current_seq: string | number }>(`SELECT current_seq FROM agentic.session_stream WITH (UPDLOCK,HOLDLOCK)
      WHERE tenant_id=@tenant_id AND session_id=@session_id;`);
    const currentSeq = Number(streams.recordset[0]?.current_seq ?? -1);
    if (currentSeq !== expectedSeq) throw new AgenticError("conflict", `Session CAS conflict: expected ${expectedSeq}, actual ${currentSeq}`);
    for (const [index, prepared] of preparedDrafts.entries()) {
      await this.#insertDraft(transaction, sessionId, expectedSeq + index + 1, prepared, context);
    }
    const newSeq = expectedSeq + preparedDrafts.length;
    input = text(text(request(transaction), "tenant_id", context.security.tenantId), "session_id", sessionId);
    bigInteger(input, "new_seq", newSeq);
    await input.query("UPDATE agentic.session_stream SET current_seq=@new_seq WHERE tenant_id=@tenant_id AND session_id=@session_id;");
    input = text(text(text(request(transaction), "tenant_id", context.security.tenantId), "session_id", sessionId), "idempotency_key", idempotencyKey);
    text(input, "operation_fingerprint", operationFingerprint, 64);
    bigInteger(input, "result_seq", newSeq);
    await input.query(`INSERT INTO agentic.session_append_dedupe(tenant_id,session_id,idempotency_key,operation_fingerprint,result_seq)
      VALUES (@tenant_id,@session_id,@idempotency_key,@operation_fingerprint,@result_seq);`);
    return newSeq;
  }

  assertLease(stream: LockedStream, lease: TurnLease): void {
    if (!stream.leaseValid || stream.activeTurnId !== lease.turnId || stream.leaseOwner !== lease.ownerId || stream.fencingToken !== lease.fencingToken) {
      throw new AgenticError("conflict", `Turn lease lost or expired: ${lease.turnId}`);
    }
  }

  async repairExpiredTurn(transaction: Transaction, sessionId: string, stream: LockedStream, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<number> {
    if (!stream.activeTurnId || stream.leaseValid) return stream.currentSeq;
    let input = text(text(text(request(transaction), "tenant_id", context.security.tenantId), "session_id", sessionId), "idempotency_key", stream.activeIdempotencyKey);
    const requests = await input.query<Record<string, unknown>>(`SELECT idempotency_key,turn_id,actor_id,correlation_id,runtime_snapshot_id,status
      FROM agentic.session_turn_request WITH (UPDLOCK,HOLDLOCK)
      WHERE tenant_id=@tenant_id AND session_id=@session_id AND idempotency_key=@idempotency_key;`);
    const prior = requests.recordset[0];
    let seq = stream.currentSeq;
    if (prior?.status === "running") {
      input = text(text(text(request(transaction), "tenant_id", context.security.tenantId), "session_id", sessionId), "turn_id", String(prior.turn_id));
      const events = await input.query<Record<string, unknown>>(`SELECT event_id,tenant_id,type,classification,step_id,call_id,payload
        FROM agentic.session_event WHERE tenant_id=@tenant_id AND session_id=@session_id AND turn_id=@turn_id
        AND type IN ('tool/intent','tool/state','tool/result') ORDER BY seq;`);
      const recovery: ToolRecoveryEvent[] = await Promise.all(events.recordset.map(async (event) => ({
        type: String(event.type), ...(event.step_id ? { stepId: String(event.step_id) } : {}), ...(event.call_id ? { callId: String(event.call_id) } : {}),
        payload: await this.decodePayload({ eventId: String(event.event_id), tenantId: String(event.tenant_id), type: String(event.type), classification: event.classification as DataClassification, payload: JSON.parse(String(event.payload)) as JsonValue }),
      })));
      seq = await this.appendDrafts(transaction, sessionId, seq, [
        ...createInterruptedToolResults(recovery, String(prior.turn_id)),
        { type: "turn/failed", turnId: String(prior.turn_id), payload: { code: "worker-lost", message: "Turn interrupted after its worker lease expired", retryable: false, interrupted: true } },
      ], `turn-recovery:${String(prior.turn_id)}`, {
        security: { ...context.security, actorId: String(prior.actor_id), correlationId: String(prior.correlation_id) },
        runtime: { ...context.runtime, id: String(prior.runtime_snapshot_id) },
      });
      input = text(text(text(request(transaction), "tenant_id", context.security.tenantId), "session_id", sessionId), "idempotency_key", String(prior.idempotency_key));
      bigInteger(input, "result_seq", seq);
      await input.query(`UPDATE agentic.session_turn_request SET status='interrupted',finished_at=SYSUTCDATETIME(),result_seq=@result_seq,error_code='worker-lost'
        WHERE tenant_id=@tenant_id AND session_id=@session_id AND idempotency_key=@idempotency_key;`);
    }
    input = text(text(request(transaction), "tenant_id", context.security.tenantId), "session_id", sessionId);
    await input.query(`UPDATE agentic.session_stream SET lease_owner=NULL,lease_expires_at=NULL,active_turn_id=NULL,
      active_idempotency_key=NULL,lease_fencing_token=lease_fencing_token+1 WHERE tenant_id=@tenant_id AND session_id=@session_id;`);
    return seq;
  }

  async #insertDraft(transaction: Transaction, sessionId: string, seq: number, prepared: PreparedSessionDraft, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<void> {
    const { draft, eventId, recordedAt, storedPayload } = prepared;
    const base = {
      ...draft, eventId, sessionId, seq, schemaVersion: draft.schemaVersion ?? 1,
      occurredAt: recordedAt.toISOString(), recordedAt: recordedAt.toISOString(), tenantId: context.security.tenantId,
      actorId: context.security.actorId, correlationId: context.security.correlationId, runtimeSnapshotId: context.runtime.id,
      classification: draft.classification ?? "internal" as const,
    };
    let input = request(transaction);
    input = text(text(text(text(text(input, "event_id", base.eventId), "tenant_id", base.tenantId), "session_id", sessionId), "actor_id", base.actorId), "correlation_id", base.correlationId);
    input = text(text(text(input, "runtime_snapshot_id", base.runtimeSnapshotId), "type", base.type), "classification", base.classification, 32);
    input = text(text(text(text(text(text(input, "turn_id", base.turnId ?? null), "step_id", base.stepId ?? null), "request_id", base.requestId ?? null), "call_id", base.callId ?? null), "attempt_id", base.attemptId ?? null), "integrity_hash", sha256(base), 64);
    bigInteger(input, "seq", seq); integer(input, "schema_version", base.schemaVersion);
    dateTime(input, "occurred_at", recordedAt); dateTime(input, "recorded_at", recordedAt);
    longText(input, "payload", JSON.stringify(storedPayload));
    await input.query(`INSERT INTO agentic.session_event(event_id,tenant_id,session_id,seq,actor_id,correlation_id,runtime_snapshot_id,type,
      schema_version,occurred_at,recorded_at,turn_id,step_id,request_id,call_id,attempt_id,classification,payload,integrity_hash)
      VALUES (@event_id,@tenant_id,@session_id,@seq,@actor_id,@correlation_id,@runtime_snapshot_id,@type,@schema_version,@occurred_at,
      @recorded_at,@turn_id,@step_id,@request_id,@call_id,@attempt_id,@classification,@payload,@integrity_hash);`);
  }
}
