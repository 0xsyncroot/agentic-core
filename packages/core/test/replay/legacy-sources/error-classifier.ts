import { AgenticError, type AgenticErrorCode, type AgenticErrorOutcome, type AgenticErrorReason } from "@0xsyncroot/contracts";

export interface ClassifiedError {
  readonly code: AgenticErrorCode; readonly retryable: boolean; readonly message: string;
  readonly outcome?: AgenticErrorOutcome;
  readonly reason?: AgenticErrorReason;
}

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
  if (error instanceof Error && error.name === "TimeoutError") return { code: "timeout", retryable: true, message: error.message };
  return { code: "permanent", retryable: false, message: error instanceof Error ? error.message : String(error) };
}
