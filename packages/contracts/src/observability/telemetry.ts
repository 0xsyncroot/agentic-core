import type { LlmUsage } from "../llm/llm.js";

export type AgentOperation = "run-turn" | "resume-approval" | "resume-interaction";

export type AgentTelemetryEvent =
  | {
      readonly type: "agent.operation.started";
      readonly operation: AgentOperation;
      readonly tenantId: string;
      readonly sessionId: string;
      readonly correlationId: string;
      readonly occurredAt: string;
    }
  | {
      readonly type: "agent.operation.finished";
      readonly operation: AgentOperation;
      readonly tenantId: string;
      readonly sessionId: string;
      readonly correlationId: string;
      readonly outcome: "completed" | "partial" | "awaiting_approval" | "awaiting_interaction" | "failed";
      readonly durationMs: number;
      readonly usage?: LlmUsage;
      readonly occurredAt: string;
    }
  /**
   * A tool result the runtime cut to fit its budget. Counts and sizes only, never rows: this is how an
   * operator learns that an answer was drawn from part of the data, and by how much.
   */
  | {
      readonly type: "agent.tool.truncated";
      readonly tenantId: string;
      readonly sessionId: string;
      readonly correlationId: string;
      readonly turnId: string;
      readonly toolId: string;
      readonly path: string;
      readonly shown: number;
      readonly total: number;
      readonly limitChars: number;
      readonly occurredAt: string;
    }
  /** Why a turn ended, which `outcome` alone does not say: `partial` is budget, model cut-off or policy. */
  | {
      readonly type: "agent.turn.ended";
      readonly tenantId: string;
      readonly sessionId: string;
      readonly correlationId: string;
      readonly turnId: string;
      readonly outcome: "completed" | "partial";
      readonly decision: string;
      readonly reason: string;
      readonly steps: number;
      readonly occurredAt: string;
    };

/** Best-effort observability port. Durable session events remain the source of truth. */
export interface AgentTelemetrySink {
  record(event: AgentTelemetryEvent): void | Promise<void>;
}
