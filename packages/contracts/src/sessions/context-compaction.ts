import type { SecurityContext } from "../security/security-context.js";
import type { DataClassification } from "../shared/json.js";
import type { SessionEvent } from "./session.js";

export interface SessionContextView {
  readonly checkpoint?: SessionEvent;
  readonly events: readonly SessionEvent[];
  /** First retained sequence when an oversized tail was bounded; earlier tail events were intentionally omitted. */
  readonly truncatedBeforeSeq?: number;
}

export interface ConversationCompaction {
  readonly summary: string;
  readonly coveredThroughSeq: number;
  readonly revision: string;
  readonly classification: DataClassification;
}

export interface ContextCompactionBudget {
  readonly trigger: "pressure" | "context-overflow" | "manual";
  readonly providerId: string;
  readonly modelId: string;
  readonly measuredContextChars: number;
  readonly maxContextChars: number;
  readonly targetContextChars: number;
}

export interface ContextCompactionAssessment extends ContextCompactionBudget {
  readonly shouldCompact: boolean;
  readonly policyRevision: string;
  readonly measuredContextTokens?: number;
  readonly maxContextTokens?: number;
  readonly measurementRevision?: string;
}

/** Provider-neutral policy. Deployment config maps provider/model routes to budgets. */
export interface ContextCompactionPolicy {
  assess(input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly measuredContextChars: number;
    readonly fallbackMaxContextChars: number;
    readonly measuredContextTokens?: number;
    readonly contextWindowTokens?: number;
    readonly estimatedCharsPerToken?: number;
    readonly measurementRevision?: string;
    readonly trigger: ContextCompactionBudget["trigger"];
  }): ContextCompactionAssessment;
}

export interface ConversationCompactor {
  compact(input: {
    readonly events: readonly SessionEvent[];
    readonly priorCheckpoint?: SessionEvent;
    readonly budget: ContextCompactionBudget;
    readonly security: SecurityContext;
  }): Promise<ConversationCompaction | undefined>;
}
