import { AgenticError } from "@0xsyncroot/contracts";

/**
 * A product's own words for a classified failure. This package ships no product's business copy
 * of its own — only these generic English fallbacks — so a product supplies its own sentences
 * (in whatever language its users read) through `byCode`/`byReason`/`generic`, mapped from the
 * same classification a product-owned error-mapping module would otherwise hardcode.
 */
export interface BusinessMessages {
  readonly byCode?: Partial<Record<AgenticError["code"], string>>;
  readonly byReason?: Partial<Record<NonNullable<AgenticError["reason"]>, string>>;
  readonly generic?: string;
  /**
   * What the user reads when a turn ended with no answer of its own — nothing said, no card, no
   * UI. `stopped` is for a turn that was cut short before it finished (its budget ran out while
   * it was still working); `completed` for one that simply ended empty. The runtime writes no
   * user-facing copy, so without these the client is left to fill the gap with a default of its
   * own, in whatever language that happens to be.
   */
  readonly emptyAnswer?: { readonly completed?: string; readonly stopped?: string };
}

const GENERIC_MESSAGE = "A technical problem prevented this request from completing. Please try again shortly.";

const DEFAULT_BY_CODE: Partial<Record<AgenticError["code"], string>> = Object.freeze({
  validation: "The request was not valid, so it could not be processed. Please check the input and try again.",
  denied: "This account is not authorized to perform this action.",
  conflict: "The underlying data changed elsewhere. Please reload and try again.",
  "budget-exceeded": "This request exceeded a single turn's processing limit. Please split it into smaller requests.",
  timeout: "The system took too long to respond. Please try again in a few minutes.",
  cancelled: "Processing was stopped as requested.",
  "approval-required": "This action requires confirmation before it can proceed.",
  "unknown-outcome": "The outcome of the last action could not be confirmed. Please check the system of record before retrying.",
});

export interface PublicApiError {
  readonly code: string;
  readonly message: string;
  readonly reason?: AgenticError["reason"];
  /** The runtime's own technical message; a client shows this nowhere a business user reads. */
  readonly detail?: string;
}

/** The sentence a caller reads for a classified failure — never the runtime's own words. */
export function publicMessage(messages: BusinessMessages | undefined, code: string, reason?: AgenticError["reason"]): string {
  const byReason = reason && messages?.byReason?.[reason];
  if (byReason) return byReason;
  return messages?.byCode?.[code as AgenticError["code"]] ?? DEFAULT_BY_CODE[code as AgenticError["code"]] ?? messages?.generic ?? GENERIC_MESSAGE;
}

/** Maps any thrown value to the wire error shape, keeping the runtime's own message out of it by default. */
export function publicApiError(messages: BusinessMessages | undefined, error: unknown, includeDetail: boolean): PublicApiError {
  if (!(error instanceof AgenticError)) {
    return { code: "internal", message: messages?.generic ?? GENERIC_MESSAGE, ...(includeDetail && error instanceof Error ? { detail: error.message } : {}) };
  }
  return {
    code: error.code, message: publicMessage(messages, error.code, error.reason),
    ...(error.reason ? { reason: error.reason } : {}),
    ...(includeDetail ? { detail: error.message } : {}),
  };
}

/** HTTP status for a classified failure — unchanged from apps/web's existing mapping. */
export function publicStatus(error: unknown): number {
  if (!(error instanceof AgenticError)) return 500;
  if (error.code === "validation") return 400;
  if (error.code === "denied") return 403;
  if (error.code === "conflict") return 409;
  if (error.code === "timeout") return 504;
  return 502;
}
