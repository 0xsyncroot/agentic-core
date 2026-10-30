import { AgenticError, DEPENDENCY_FAILURE_REASON, type ToolDefinition } from "@0xsyncroot/contracts";
import { SdkError, SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const DISCONNECTED_CODES: ReadonlySet<string> = new Set([SdkErrorCode.ConnectionClosed, SdkErrorCode.NotConnected]);

/** SDK negotiation wraps errors in data.cause, while native fetch uses Error.cause. */
export function mcpTransportError(error: unknown): unknown {
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof AgenticError) return current;
    if (current instanceof SdkHttpError) {
      if ([408, 429, 502, 503, 504].includes(current.status)) return unavailable(error, `HTTP ${current.status}`);
      if ([401, 403].includes(current.status)) return new AgenticError("denied", `MCP HTTP ${current.status}`, false, { cause: error });
      return error;
    }
    if (current instanceof SdkError && DISCONNECTED_CODES.has(current.code)) {
      return unavailable(error, current.code);
    }
    if (current instanceof SdkError && current.code === SdkErrorCode.RequestTimeout) {
      return new AgenticError("timeout", "MCP request timed out", true, { cause: error });
    }
    const detail = current as { code?: unknown; cause?: unknown; data?: { cause?: unknown }; errors?: unknown[] };
    if (typeof detail.code === "string" && NETWORK_CODES.has(detail.code)) return unavailable(error, detail.code);
    if (current instanceof Error && (current.name === "AbortError" || current.name === "TimeoutError")) return current;
    if (current instanceof AggregateError) {
      for (const cause of current.errors) {
        const classified = mcpTransportError(cause);
        if (classified instanceof AgenticError && classified.reason === DEPENDENCY_FAILURE_REASON.UNAVAILABLE) return classified;
      }
    }
    current = detail.cause ?? detail.data?.cause;
  }
  return error;
}

function unavailable(cause: unknown, detail: string): AgenticError {
  return new AgenticError("transient", `MCP connection unavailable (${detail})`, true,
    { cause, reason: DEPENDENCY_FAILURE_REASON.UNAVAILABLE });
}

export async function mcpOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw mcpTransportError(error); }
}

/** A disconnected write may already have applied; never make it look safe to replay. */
export function mcpToolFailure(error: unknown, sideEffect: ToolDefinition["sideEffect"]): unknown {
  const classified = mcpTransportError(error);
  return sideEffect !== "none" && classified instanceof AgenticError && classified.reason === DEPENDENCY_FAILURE_REASON.UNAVAILABLE
    ? new AgenticError("unknown-outcome", classified.message, false, { cause: classified, reason: classified.reason }) : classified;
}
