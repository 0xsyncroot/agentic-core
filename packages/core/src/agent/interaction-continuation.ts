import { randomUUID } from "node:crypto";
import type {
  EventDraft,
  HumanInteractionAction,
  HumanInteractionChallenge,
  HumanInteractionRequest,
  JsonValue,
  RuntimeSnapshot,
  SecurityContext,
  ToolDefinition,
  ToolPolicyDecision,
} from "@0xsyncroot/contracts";
import { toJsonValue } from "./json-value.js";

export interface InteractionContinuationContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly executionId: string;
  readonly arguments: string;
  readonly definition: ToolDefinition;
  readonly request: HumanInteractionRequest;
  readonly continuation?: JsonValue;
  readonly policyDecision: ToolPolicyDecision;
  readonly authorizationOutcome: "allow" | "require_approval";
  readonly runtime: RuntimeSnapshot;
  readonly runtimeRouteRevision: string;
  readonly security: SecurityContext;
  readonly agentProfileId?: string;
  readonly ttlMs: number;
}

/**
 * What the model is told beside the tool's own result when the user answered a question by not
 * answering it. A bare "declined" came back as a tool result the model read as a failure to retry,
 * and it asked the same question again. Model-facing, so English; closures carry their own message.
 */
const OUTCOME_NOTES: Readonly<Partial<Record<HumanInteractionAction, string>>> = Object.freeze({
  decline: "The user chose to skip this question. Do not ask it again in this task; "
    + "continue with what you have, or ask in chat only if it is essential.",
  cancel: "The user dismissed this question without answering. Do not ask it again in this task; "
    + "continue with what you have, or ask in chat only if it is essential.",
});

/** The note for a question the user skipped or dismissed; none for an answer. */
export function interactionOutcomeNote(action: HumanInteractionAction | undefined): string | undefined {
  return action ? OUTCOME_NOTES[action] : undefined;
}

export function createInteractionContinuation(context: InteractionContinuationContext): {
  readonly challenge: HumanInteractionChallenge;
  readonly drafts: readonly EventDraft[];
} {
  const interactionId = randomUUID();
  const expiresAt = new Date(Date.now() + context.ttlMs).toISOString();
  const challenge: HumanInteractionChallenge = Object.freeze({
    ...context.request,
    interactionId, sessionId: context.sessionId, turnId: context.turnId,
    callId: context.callId, toolId: context.definition.id,
    requesterId: context.definition.origin?.sourceId ?? context.definition.id,
    actionDigest: context.policyDecision.actionDigest,
    policyRevision: context.policyDecision.policyRevision,
    runtimeSnapshotId: context.runtime.id,
    runtimeRouteRevision: context.runtimeRouteRevision,
    agentProfileId: context.agentProfileId ?? "default",
    grantRevision: context.security.grantRevision ?? "unspecified",
    expiresAt,
  });
  return {
    challenge,
    drafts: [{
      type: "tool/state", turnId: context.turnId, stepId: context.stepId, callId: context.callId,
      payload: { callId: context.callId, executionId: context.executionId, toolId: context.definition.id, state: "awaiting_interaction" },
    }, {
      type: "interaction/requested", turnId: context.turnId, stepId: context.stepId, callId: context.callId,
      classification: "confidential",
      payload: toJsonValue({
        interactionId, callId: context.callId, executionId: context.executionId, toolId: context.definition.id,
        requesterId: challenge.requesterId,
        arguments: context.arguments, request: context.request,
        ...(context.continuation === undefined ? {} : { continuation: context.continuation }),
        actionDigest: context.policyDecision.actionDigest,
        decisionId: context.policyDecision.decisionId,
        policyRevision: context.policyDecision.policyRevision,
        authorizationOutcome: context.authorizationOutcome,
        runtimeSnapshotId: context.runtime.id, runtimeRouteRevision: context.runtimeRouteRevision,
        agentProfileId: context.agentProfileId ?? "default",
        requestedBy: context.security.actorId, grantRevision: context.security.grantRevision ?? "unspecified",
        expiresAt,
      }),
    }],
  };
}
