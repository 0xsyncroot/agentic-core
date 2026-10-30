import { AgenticError, type ApprovalChallenge, type HumanInteractionChallenge, type HumanInteractionRequest, type LlmUsage, type RunTurnResult, type SecurityContext, type SessionEvent, type SessionReader } from "@0xsyncroot/contracts";
import { snapshotApprovalPresentation } from "./approval-presentation.js";
import type { TurnJournalView } from "./turn-journal-view.js";

function usageForTurn(events: readonly SessionEvent[], turnId: string): LlmUsage | undefined {
  const records = events.filter((event) => event.turnId === turnId && event.type === "usage/recorded");
  if (records.length === 0) return undefined;
  return records.reduce((total, event) => {
    const payload = event.payload as Record<string, unknown>;
    return {
      inputTokens: (total.inputTokens ?? 0) + Number(payload.inputTokens ?? 0),
      outputTokens: (total.outputTokens ?? 0) + Number(payload.outputTokens ?? 0),
      totalTokens: (total.totalTokens ?? 0) + Number(payload.totalTokens ?? 0),
    };
  }, {} as LlmUsage);
}

export function approvalFromEvent(event: SessionEvent): ApprovalChallenge {
  const payload = event.payload as Record<string, unknown>;
  return {
    approvalId: String(payload.approvalId), sessionId: event.sessionId, turnId: event.turnId ?? "",
    callId: String(payload.callId), toolId: String(payload.toolId),
    sideEffect: payload.sideEffect as "none" | "idempotent" | "nonIdempotent",
    actionDigest: String(payload.actionDigest), policyRevision: String(payload.policyRevision),
    runtimeSnapshotId: String(payload.runtimeSnapshotId), runtimeRouteRevision: String(payload.runtimeRouteRevision ?? ""),
    agentProfileId: String(payload.agentProfileId),
    grantRevision: String(payload.grantRevision), expiresAt: String(payload.expiresAt),
    ...(payload.presentation === undefined ? {} : { presentation: snapshotApprovalPresentation(payload.presentation) }),
  };
}

export function interactionFromEvent(event: SessionEvent): HumanInteractionChallenge {
  const payload = event.payload as Record<string, unknown>;
  const request = payload.request as HumanInteractionRequest;
  return {
    ...request,
    interactionId: String(payload.interactionId), sessionId: event.sessionId, turnId: event.turnId ?? "",
    // A question the runtime asked binds no call: no call id, and its requester stands in for the tool.
    callId: String(payload.callId ?? ""), toolId: String(payload.toolId ?? payload.requesterId), requesterId: String(payload.requesterId ?? payload.toolId),
    actionDigest: String(payload.actionDigest), policyRevision: String(payload.policyRevision),
    runtimeSnapshotId: String(payload.runtimeSnapshotId), runtimeRouteRevision: String(payload.runtimeRouteRevision ?? ""),
    agentProfileId: String(payload.agentProfileId),
    grantRevision: String(payload.grantRevision), expiresAt: String(payload.expiresAt),
  };
}

/**
 * A completed turn rebuilt from its journal, exactly as its live result was: this turn's own
 * events, its last answer, its outcome and any pause it ended on. Undefined when the events do not
 * hold the turn's start. A turn that ended failed, or has not ended, is a conflict.
 */
export function replayTurn(events: readonly SessionEvent[], turnId: string): RunTurnResult | undefined {
  const start = events.find((event) => event.type === "turn/start" && event.turnId === turnId);
  if (!start) return undefined;
  const turnEvents = events.filter((event) => event.turnId === turnId);
  const completed = turnEvents.find((event) => event.type === "turn/end");
  if (completed) {
    const status = (completed.payload as Record<string, unknown>).status;
    const assistant = [...turnEvents].reverse().find((event) => event.type === "assistant/message");
    // A turn waiting on the user answered nothing yet, live or replayed: its card carries the words.
    const awaiting = status === "awaiting_approval" || status === "awaiting_interaction";
    const content = !awaiting && assistant && typeof (assistant.payload as Record<string, unknown>).content === "string"
      ? String((assistant.payload as Record<string, unknown>).content)
      : "";
    const approvalEvent = status === "awaiting_approval"
      ? turnEvents.find((event) => event.type === "approval/requested")
      : undefined;
    const approval = approvalEvent ? approvalFromEvent(approvalEvent) : undefined;
    // A partial turn may end on the runtime's question whether to go on, its answer kept beside it.
    const interactionEvent = status === "awaiting_interaction" || status === "partial"
      ? turnEvents.find((event) => event.type === "interaction/requested")
      : undefined;
    const interaction = interactionEvent ? interactionFromEvent(interactionEvent) : undefined;
    const usage = usageForTurn(turnEvents, turnId);
    return {
      content, sessionId: start.sessionId, turnId, events: turnEvents,
      outcome: status === "partial" ? "partial" : status === "awaiting_approval" ? "awaiting_approval" : status === "awaiting_interaction" ? "awaiting_interaction" : "completed",
      ...(approval ? { approval } : {}), ...(interaction ? { interaction } : {}), ...(usage ? { usage } : {}), replayed: true,
    };
  }
  const failed = turnEvents.find((event) => event.type === "turn/failed");
  throw new AgenticError("conflict", failed ? `Previous idempotent turn failed: ${turnId}` : `Idempotent turn is still in progress: ${turnId}`);
}

/**
 * Replays the turn a completed claim named: from the operation's bounded view when the turn is
 * still in it, which it almost always is — a retry follows its request closely — and from the
 * whole session only when that turn has left the window.
 */
export async function replayClaimedTurn(context: {
  readonly view: TurnJournalView;
  readonly store: SessionReader;
  readonly sessionId: string;
  readonly security: SecurityContext;
  readonly turnId: string;
}): Promise<RunTurnResult | undefined> {
  const bounded = replayTurn(await context.view.events(), context.turnId);
  return bounded ?? replayTurn(await context.store.load(context.sessionId, context.security), context.turnId);
}
