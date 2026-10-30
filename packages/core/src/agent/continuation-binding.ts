import {
  AgenticError,
  type EventDraft,
  type PauseKind,
  type SecurityContext,
  type SessionEvent,
  type TurnApplicationContext,
  type TurnContinuation,
} from "@0xsyncroot/contracts";
import type { RuntimeViewLease } from "../runtime-provider.js";
import { applicationContextForTurn } from "./application-context.js";
import { toJsonValue } from "./json-value.js";
import { turnContinuation } from "./task-turns.js";

/** The durable request a resume answers: an `approval/requested` or `interaction/requested` event. */
export interface PauseRecord {
  readonly kind: PauseKind;
  readonly pauseId: string;
  readonly event: SessionEvent;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Who is resuming which pause, and what they sent with it. */
export interface ContinuationRequest {
  readonly kind: PauseKind;
  readonly pauseId: string;
  readonly security: SecurityContext;
  readonly agentProfileId: string;
  /** What the user submitted, checked against the stored request (an interaction's response schema). */
  readonly verifySubmission?: (record: PauseRecord) => void;
}

const LABEL: Readonly<Record<PauseKind, string>> = { approval: "Approval", interaction: "Interaction" };
const ID_KEY: Readonly<Record<PauseKind, string>> = { approval: "approvalId", interaction: "interactionId" };

function pauseId(event: SessionEvent, kind: PauseKind): unknown {
  return (event.payload as Record<string, unknown> | null)?.[ID_KEY[kind]];
}

/**
 * Why a resolved pause cannot be answered again. Only a runtime closure records a `reason` — the
 * contract refuses one on a user's answer — so it, not the resolver's name, tells the two apart.
 */
function resolvedConflict(label: string, resolution: SessionEvent): AgenticError {
  const closedAs = (resolution.payload as Record<string, unknown> | null)?.reason;
  if (closedAs === "superseded" || closedAs === "expired") {
    return new AgenticError("conflict", `${label} challenge was withdrawn by the runtime (${closedAs})`, false, { reason: closedAs });
  }
  return new AgenticError("conflict", `${label} challenge has already been resolved`, false, { reason: "already-resolved" });
}

/**
 * The pause a resume answers, found in the raw tail — a checkpoint may already cover its turn.
 * A request that has left the bounded window is a thousand rows old: long past any deadline it
 * had, so it is refused as expired. Needs no runtime: a resume finds its pause before it leases one.
 */
export function findPause(request: Pick<ContinuationRequest, "kind" | "pauseId">, events: readonly SessionEvent[]): PauseRecord {
  const { kind, pauseId: id } = request;
  const event = events.find((candidate) => candidate.type === `${kind}/requested` && pauseId(candidate, kind) === id);
  if (!event) throw new AgenticError("conflict", `${LABEL[kind]} challenge is no longer available`, false, { reason: "expired" });
  return { kind, pauseId: id, event, payload: event.payload as Readonly<Record<string, unknown>> };
}

/**
 * The route revision the pause was raised under, which its resume asks the provider to serve again. Absent when the
 * record holds none; the resume then leases the live route, and the binding check decides.
 */
export function routePin(record: PauseRecord): string | undefined {
  const revision = record.payload.runtimeRouteRevision;
  return typeof revision === "string" && revision.length > 0 ? revision : undefined;
}

/**
 * What a resume must prove before it may run a paused call, read from the journal alone.
 *
 * Both resumes — an approval and an answered question — check the same binding: the pause exists
 * and is still open, has not expired, is answered by the person it asked, under the grants, runtime
 * snapshot, route, policy and profile it was raised under, and with a submission its request
 * accepts. The checks run twice: before the claim on the operation's seeded view, where a refusal
 * writes nothing at all, and again after it on the view extended with what the claim wrote, where a
 * pause resolved in between is caught for certain (a claim cannot be released, so that late
 * refusal still ends the new turn as failed). The codes live here, so there is one place to say why
 * a resume was refused.
 */
export class ContinuationBinding {
  constructor(private readonly request: ContinuationRequest, private readonly runtimeLease: RuntimeViewLease) {}

  /**
   * Every check, with no write. Returns the pause it verified.
   *
   * A pause that can no longer be answered is a `conflict` with the reason the caller shows the
   * user: closed by the runtime (`superseded` or `expired`, as its closure recorded), answered
   * already (`already-resolved`), past its deadline (`expired`), or raised under a runtime that has
   * since changed (`stale-binding`). Someone who may not answer it at all is `denied`.
   */
  verify(events: readonly SessionEvent[], now = Date.now()): PauseRecord {
    const record = findPause(this.request, events);
    const { kind, security } = this.request;
    const label = LABEL[kind];
    const resolution = events.find((event) => event.type === `${kind}/resolved` && pauseId(event, kind) === record.pauseId);
    if (resolution) throw resolvedConflict(label, resolution);
    const payload = record.payload;
    if (Date.parse(String(payload.expiresAt)) <= now) throw new AgenticError("conflict", `${label} challenge expired`, false, { reason: "expired" });
    if (payload.requestedBy !== security.actorId) throw new AgenticError("denied", `${label} actor does not match the requester`);
    if (payload.grantRevision !== (security.grantRevision ?? "unspecified")) throw new AgenticError("denied", `${label} grants changed after the request`);
    if (payload.runtimeSnapshotId !== this.runtimeLease.snapshot.id ||
        payload.runtimeRouteRevision !== this.runtimeLease.binding.routeRevision ||
        payload.policyRevision !== this.runtimeLease.snapshot.policyRevision) {
      throw new AgenticError("conflict", `${label} binding is stale for the active runtime policy`, false, { reason: "stale-binding" });
    }
    if (payload.agentProfileId !== this.request.agentProfileId) throw new AgenticError("denied", `${label} agent profile does not match`);
    this.request.verifySubmission?.(record);
    return record;
  }

  /** The link from the resume turn to the paused turn, and to the user turn that began the task. */
  continuation(record: PauseRecord, events: readonly SessionEvent[]): TurnContinuation {
    const fromTurnId = record.event.turnId ?? "";
    const rootTurnId = turnContinuation(events, fromTurnId)?.rootTurnId ?? fromTurnId;
    return { pauseKind: record.kind, pauseId: record.pauseId, fromTurnId, rootTurnId };
  }

  /**
   * The host context of the task the pause belongs to. A resume turn written by this runtime holds
   * a copy of its root's; a pause raised in an older resume turn that holds none falls back to the
   * root turn's own.
   */
  applicationContext(record: PauseRecord, events: readonly SessionEvent[]): TurnApplicationContext | undefined {
    return applicationContextForTurn(events, record.event.turnId) ??
      applicationContextForTurn(events, this.continuation(record, events).rootTurnId);
  }

  /** The resume claim's start events: the continuation link, and the task's context copied in. */
  startEvents(
    turnId: string, inputIdempotencyKey: string, record: PauseRecord, events: readonly SessionEvent[],
  ): readonly EventDraft[] {
    const context = this.applicationContext(record, events);
    return [
      { type: "turn/start", turnId, payload: toJsonValue({
        inputIdempotencyKey, runtimeBinding: this.runtimeLease.binding, continuation: this.continuation(record, events),
      }) },
      ...(context ? [{ type: "application/context", turnId, classification: "confidential" as const, payload: toJsonValue(context) }] : []),
    ];
  }
}

/** Whether a request with this idempotency key already started a turn the view can see — a replay, not a new resume. */
export function startedTurnFor(events: readonly SessionEvent[], idempotencyKey: string): string | undefined {
  return events.find((event) => event.type === "turn/start" &&
    (event.payload as Record<string, unknown> | null)?.inputIdempotencyKey === idempotencyKey)?.turnId;
}
