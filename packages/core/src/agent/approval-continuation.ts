import { randomUUID } from "node:crypto";
import type {
  ApprovalChallenge,
  EventDraft,
  JsonValue,
  RuntimeSnapshot,
  SecurityContext,
  ToolDefinition,
  ToolPolicyDecision,
} from "@0xsyncroot/contracts";
import { toJsonValue } from "./json-value.js";

export interface StoredToolInteraction {
  readonly interactionId: string;
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: JsonValue;
  readonly continuation?: JsonValue;
}

interface ApprovalContinuationContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly executionId: string;
  readonly arguments: string;
  readonly definition: ToolDefinition;
  readonly policyDecision: ToolPolicyDecision;
  readonly runtime: RuntimeSnapshot;
  readonly runtimeRouteRevision: string;
  readonly security: SecurityContext;
  readonly agentProfileId?: string;
  readonly ttlMs: number;
  /** Present when form/external input changed the action that must be approved. */
  readonly interaction?: StoredToolInteraction;
}

export function createApprovalContinuation(context: ApprovalContinuationContext): {
  readonly challenge: ApprovalChallenge;
  readonly drafts: readonly EventDraft[];
} {
  const approvalId = randomUUID();
  const expiresAt = new Date(Date.now() + context.ttlMs).toISOString();
  const challenge: ApprovalChallenge = Object.freeze({
    approvalId, sessionId: context.sessionId, turnId: context.turnId,
    callId: context.callId, toolId: context.definition.id,
    sideEffect: context.definition.sideEffect,
    actionDigest: context.policyDecision.actionDigest,
    policyRevision: context.policyDecision.policyRevision,
    runtimeSnapshotId: context.runtime.id,
    runtimeRouteRevision: context.runtimeRouteRevision,
    agentProfileId: context.agentProfileId ?? "default",
    grantRevision: context.security.grantRevision ?? "unspecified",
    expiresAt,
    ...(context.policyDecision.approvalPresentation
      ? { presentation: context.policyDecision.approvalPresentation }
      : {}),
  });
  return {
    challenge,
    drafts: [{
      type: "tool/state", turnId: context.turnId, stepId: context.stepId, callId: context.callId,
      payload: { callId: context.callId, executionId: context.executionId, toolId: context.definition.id, state: "awaiting_approval" },
    }, {
      type: "approval/requested", turnId: context.turnId, stepId: context.stepId, callId: context.callId,
      classification: context.interaction ? "confidential" : "internal",
      payload: toJsonValue({
        approvalId, callId: context.callId, executionId: context.executionId, toolId: context.definition.id,
        arguments: context.arguments, sideEffect: challenge.sideEffect,
        actionDigest: context.policyDecision.actionDigest, decisionId: context.policyDecision.decisionId,
        policyRevision: context.policyDecision.policyRevision, runtimeSnapshotId: context.runtime.id,
        runtimeRouteRevision: context.runtimeRouteRevision,
        agentProfileId: context.agentProfileId ?? "default", requestedBy: context.security.actorId,
        grantRevision: context.security.grantRevision ?? "unspecified", expiresAt,
        ...(challenge.presentation ? { presentation: challenge.presentation } : {}),
        ...(context.interaction ? { interaction: context.interaction } : {}),
      }),
    }],
  };
}
