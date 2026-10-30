import { AgenticError, type AgenticErrorCode, type AgenticErrorOutcome, type AgenticErrorReason } from "@0xsyncroot/contracts";

export interface ClassifiedError {
  readonly code: AgenticErrorCode; readonly retryable: boolean; readonly message: string;
  /** Carried into the journaled tool error, so a policy can tell a refused write from one whose outcome is unknown. */
  readonly outcome?: AgenticErrorOutcome;
  readonly reason?: AgenticErrorReason;
}

/**
 * The same failure, as the error type callers are entitled to act on.
 *
 * Classifying an error for the durable record is only half the job: a raw `DOMException` that
 * propagates to an HTTP boundary is reported as an unclassified 500, so a turn that simply ran
 * out of time reaches the browser as an internal defect and is not retried. Converting at the
 * throw site keeps the cause attached while making the code and the retryability true.
 */
export function agenticError(error: unknown): AgenticError {
  if (error instanceof AgenticError) return error;
  const details = classifyError(error);
  return new AgenticError(details.code, details.message, details.retryable, { cause: error });
}

export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof AgenticError) {
    return { code: error.code, retryable: error.retryable, message: error.message,
      ...(error.outcome ? { outcome: error.outcome } : {}), ...(error.reason ? { reason: error.reason } : {}) };
  }
  if (error instanceof Error && error.name === "AbortError") return { code: "cancelled", retryable: false, message: error.message };
  // `AbortSignal.timeout` aborts with a TimeoutError, not an AbortError. Reading it as an
  // unclassified failure reports a turn that simply ran long as an internal defect, and marks
  // it non-retryable — the two things a caller most needs to be told apart.
  if (error instanceof Error && error.name === "TimeoutError") return { code: "timeout", retryable: true, message: error.message };
  return { code: "permanent", retryable: false, message: error instanceof Error ? error.message : String(error) };
}
