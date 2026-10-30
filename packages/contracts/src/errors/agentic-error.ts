export type AgenticErrorCode = "validation" | "denied" | "approval-required" | "transient" | "permanent" | "timeout" | "cancelled" | "conflict" | "unknown-outcome"
  | "budget-exceeded" | "context-overflow" | "cycle-detected";
/**
 * What a failed operation is known to have done. `not-applied`: the system it called answered and
 * refused it, so nothing changed. Absent means unknown — the default for anything that failed
 * after it was sent, because only the system that received a write can say it applied nothing.
 */
export type AgenticErrorOutcome = "not-applied";
/**
 * Why a `conflict` happened, when the caller can act on it differently from a plain race.
 *
 * A pause the user answers can be gone for four distinct reasons, and each needs its own
 * sentence: the runtime withdrew it because a newer message arrived (`superseded`), it ran out of
 * time (`expired`), someone already answered it (`already-resolved`), or the deployment changed
 * under it (`stale-binding`). The product maps the reason to its own words; the code stays neutral.
 */
/**
 * A model output limit. `reasoning-limit` may be recovered with the adapter's explicit plain parameters; `output-limit` is an
 * attempt whose streamed text looped or ran past the runtime's bound, recovered by generating the step again.
 */
export const MODEL_LIMIT_REASON = { REASONING: "reasoning-limit", OUTPUT: "output-limit" } as const;
/** A connector could not reach its dependency; distinct from a tool refusing its arguments. */
export const DEPENDENCY_FAILURE_REASON = { UNAVAILABLE: "dependency-unavailable" } as const;
export type AgenticErrorReason = "expired" | "superseded" | "already-resolved" | "stale-binding" | typeof MODEL_LIMIT_REASON.REASONING
  | typeof MODEL_LIMIT_REASON.OUTPUT | typeof DEPENDENCY_FAILURE_REASON.UNAVAILABLE;
export interface AgenticErrorOptions extends ErrorOptions {
  readonly outcome?: AgenticErrorOutcome;
  readonly reason?: AgenticErrorReason;
  /** For `context-overflow`: the request's size as the provider counted it, when its refusal said. */
  readonly inputTokens?: number;
}
export class AgenticError extends Error {
  readonly outcome?: AgenticErrorOutcome;
  readonly reason?: AgenticErrorReason;
  readonly inputTokens?: number;
  constructor(readonly code: AgenticErrorCode, message: string, readonly retryable = false, options?: AgenticErrorOptions) {
    super(message, options); this.name = "AgenticError";
    if (options?.outcome) this.outcome = options.outcome;
    if (options?.reason) this.reason = options.reason;
    if (options?.inputTokens !== undefined) this.inputTokens = options.inputTokens;
  }
}
