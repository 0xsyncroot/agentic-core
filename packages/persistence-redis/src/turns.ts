import type { EventDraft, SecurityContext, SessionEvent, TurnClaimCommand, TurnClaimResult, TurnLease } from "@0xsyncroot/contracts";
import { AgenticError, createInterruptedToolResults } from "@0xsyncroot/contracts";
import { appendFailure, buildBatch, num, parseEvent, R, type Batch, type StoreCore, type WriteContext } from "./core.js";
import { indexSession } from "./directory.js";
import { sessionKeys, type SessionKeys } from "./keys.js";
import { LEASED } from "./lua-append.js";
import { CLAIM, RENEW, REPAIR } from "./lua-turns.js";

const MAX_ATTEMPTS = 8;

function keyList(keys: SessionKeys): string[] { return [keys.meta, keys.events, keys.idem, keys.turns, keys.ckpt]; }

interface TurnRequestRecord { turnId: string; actorId: string; correlationId: string; runtimeSnapshotId: string }

export async function claimTurn(core: StoreCore, command: TurnClaimCommand, context: WriteContext): Promise<TurnClaimResult> {
  if (!Number.isInteger(command.leaseTtlMs) || command.leaseTtlMs <= 0) throw new AgenticError("validation", "leaseTtlMs must be a positive integer");
  const { security } = context;
  const keys = sessionKeys(core.options.prefix, security.tenantId, command.sessionId);
  const { sessionTtl, idemTtl } = core.options;
  let head = num((await core.client.hGet(keys.meta, "head")) ?? 0);
  // The head is read before the script, so another writer can move it in between. The script
  // then answers with the real head and the events are rebuilt for it.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const batch = buildBatch(command.sessionId, head, command.startEvents, context);
    const reply = await core.run(CLAIM, keyList(keys), [
      security.actorId, String(sessionTtl), String(idemTtl), String(head), batch.fingerprint, command.turnId, command.ownerId,
      command.idempotencyKey, command.requestFingerprint, command.agentProfileId ?? "default", String(command.leaseTtlMs),
      batch.checkpoint, batch.created, batch.input, context.runtime.id, security.correlationId, ...batch.events,
    ]);
    const code = num(reply[0]);
    switch (code) {
      case R.ok: {
        if (reply[4]) await indexSession(core, security, command.sessionId, String(reply[4]));
        const lease: TurnLease = {
          sessionId: command.sessionId, turnId: command.turnId, ownerId: command.ownerId,
          fencingToken: String(reply[2]), expiresAt: new Date(num(reply[3])).toISOString(),
        };
        return { kind: "acquired", lease, seq: num(reply[1]) };
      }
      case R.cas: head = num(reply[1]); continue;
      case R.repair:
        await repairExpired(core, keys, command.sessionId, String(reply[1]), JSON.parse(String(reply[2])) as TurnRequestRecord, context);
        head = num((await core.client.hGet(keys.meta, "head")) ?? 0);
        continue;
      case R.completed: return { kind: "completed", turnId: String(reply[1]), seq: num(reply[2]) };
      case R.inProgress: return { kind: "in-progress", turnId: String(reply[1]), retryAfterMs: num(reply[2]) };
      case R.failed: return { kind: "failed", turnId: String(reply[1]), code: String(reply[2]) };
      default: throw appendFailure(code, head, reply[1], command.turnId);
    }
  }
  throw new AgenticError("transient", "Turn claim kept losing the session head to other writers", true);
}

/** Appends the interrupted-tool results and `turn/failed` for a turn whose worker lease expired. */
async function repairExpired(
  core: StoreCore, keys: SessionKeys, sessionId: string, staleToken: string, request: TurnRequestRecord, context: WriteContext,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const events = (await core.client.lRange(keys.events, 0, -1)).map(parseEvent);
    const drafts: EventDraft[] = [
      ...createInterruptedToolResults(events.filter((event: SessionEvent) => event.turnId === request.turnId), request.turnId),
      { type: "turn/failed", turnId: request.turnId, payload: { code: "worker-lost", message: "Turn interrupted after its worker lease expired", retryable: false, interrupted: true } },
    ];
    const repairContext: WriteContext = {
      security: { ...context.security, actorId: request.actorId, correlationId: request.correlationId },
      runtime: { ...context.runtime, id: request.runtimeSnapshotId },
    };
    const batch = buildBatch(sessionId, events.length, drafts, repairContext);
    const reply = await core.run(REPAIR, keyList(keys), [
      context.security.actorId, String(core.options.sessionTtl), String(core.options.idemTtl), String(events.length),
      batch.fingerprint, `turn-recovery:${request.turnId}`, staleToken, ...batch.events,
    ]);
    const code = num(reply[0]);
    if (code === R.ok || code === R.stale) return;
    if (code !== R.cas) throw appendFailure(code, events.length, reply[1], request.turnId);
  }
  throw new AgenticError("transient", "Turn recovery kept losing the session head to other writers", true);
}

export interface LeasedWrite {
  readonly mode: "append" | "finish";
  readonly lease: TurnLease;
  readonly expectedSeq: number;
  readonly drafts: readonly EventDraft[];
  readonly idempotencyKey: string;
  readonly context: WriteContext;
  readonly terminal?: { readonly valid: boolean; readonly status: "completed" | "failed"; readonly errorCode: string };
}

export async function writeLeased(core: StoreCore, write: LeasedWrite): Promise<number> {
  const { lease, context } = write;
  const keys = sessionKeys(core.options.prefix, context.security.tenantId, lease.sessionId);
  const batch: Batch = buildBatch(lease.sessionId, write.expectedSeq, write.drafts, context);
  const reply = await core.run(LEASED, keyList(keys), [
    context.security.actorId, String(core.options.sessionTtl), String(core.options.idemTtl), String(write.expectedSeq),
    batch.fingerprint, write.idempotencyKey, batch.checkpoint, batch.created, batch.input, write.mode, lease.turnId,
    lease.ownerId, lease.fencingToken, write.terminal?.valid === false ? "0" : "1", write.terminal?.status ?? "",
    write.terminal?.errorCode ?? "", ...batch.events,
  ]);
  const code = num(reply[0]);
  if (code !== R.ok) throw appendFailure(code, write.expectedSeq, reply[1], lease.turnId);
  if (reply[2]) await indexSession(core, context.security, lease.sessionId, String(reply[2]));
  return num(reply[1]);
}

export async function renewTurn(core: StoreCore, lease: TurnLease, ttlMs: number, security: SecurityContext): Promise<TurnLease> {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new AgenticError("validation", "ttlMs must be a positive integer");
  const keys = sessionKeys(core.options.prefix, security.tenantId, lease.sessionId);
  const reply = await core.run(RENEW, keyList(keys), [
    security.actorId, String(core.options.sessionTtl), String(ttlMs), lease.turnId, lease.ownerId, lease.fencingToken,
  ]);
  const code = num(reply[0]);
  if (code !== R.ok) throw appendFailure(code, 0, 0, lease.turnId);
  return { ...lease, expiresAt: new Date(num(reply[1])).toISOString() };
}
