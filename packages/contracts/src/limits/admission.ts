import type { LlmUsage } from "../llm/llm.js";
import type { SecurityContext } from "../security/security-context.js";

export interface TurnAdmissionRequest {
  readonly security: SecurityContext;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly agentProfileId: string;
}

export interface TurnAdmissionSettlement {
  readonly outcome: "completed" | "partial" | "awaiting_approval" | "awaiting_interaction" | "failed";
  readonly usage?: LlmUsage;
}

export interface TurnAdmissionLease {
  readonly admissionId: string;
  readonly revision: string;
  settle(settlement: TurnAdmissionSettlement): Promise<void>;
}

/** Admission is a port: production deployments can back it with a distributed quota service. */
export interface TurnAdmissionController {
  /** True only when acquisition and settlement are coordinated across every production replica. */
  readonly productionSafe: boolean;
  acquire(request: TurnAdmissionRequest, signal?: AbortSignal): Promise<TurnAdmissionLease>;
}
