import type { SecurityContext } from "../security/security-context.js";
import type { AgentNarrationEvent, AgentOutputEvent, AgentProgressEvent, AgentReasoningEvent, TurnInterjections } from "../agent/agent.js";

export const APPROVAL_DECISION = Object.freeze({ APPROVE: "approve", DENY: "deny" } as const);
export type ApprovalDecision = typeof APPROVAL_DECISION[keyof typeof APPROVAL_DECISION];
export const APPROVAL_EVENT = Object.freeze({ REQUESTED: "approval/requested", RESOLVED: "approval/resolved" } as const);

export interface ApprovalPresentationField {
  readonly label: string;
  readonly value: string | number | boolean;
}

/** Bounded, user-safe explanation of the exact action being approved. */
export interface ApprovalPresentation {
  readonly summary: string;
  readonly action: string;
  readonly target: string;
  readonly impact: string;
  readonly fields?: readonly ApprovalPresentationField[];
}

/**
 * Fields a card may carry.
 *
 * Part of the contract rather than of the runtime that enforces it: the product builds the
 * card and the core refuses it over the cap, so both have to agree on the number, and a card
 * refused for being one line too informative denies an approval the accountant was entitled to make.
 */
export const MAX_APPROVAL_PRESENTATION_FIELDS = 8;

export interface ApprovalChallenge {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly toolId: string;
  readonly sideEffect: "none" | "idempotent" | "nonIdempotent";
  readonly actionDigest: string;
  readonly policyRevision: string;
  readonly runtimeSnapshotId: string;
  readonly runtimeRouteRevision: string;
  readonly agentProfileId: string;
  readonly grantRevision: string;
  readonly expiresAt: string;
  readonly presentation?: ApprovalPresentation;
}

export interface ResumeTurnInput {
  readonly sessionId: string;
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
  readonly security: SecurityContext;
  readonly idempotencyKey: string;
  readonly agentProfileId?: string;
  readonly signal?: AbortSignal;
  /** What the user said while this resumed turn was running. See {@link TurnInterjections}. */
  readonly interjections?: TurnInterjections;
  readonly onProgress?: (progress: AgentProgressEvent) => void;
  readonly onOutput?: (output: AgentOutputEvent) => void;
  readonly onNarration?: (narration: AgentNarrationEvent) => void;
  readonly onReasoning?: (reasoning: AgentReasoningEvent) => void;
}
