import { setTimeout as delay } from "node:timers/promises";
import { AgenticError, DEPENDENCY_FAILURE_REASON } from "@0xsyncroot/contracts";
import { mcpTransportError } from "./transport-error.js";

export const MCP_READ_RECOVERY_DELAYS_MS = [500, 1_500] as const;

/** The failure a read is retried for: the connector did not answer. Anything it answered (401, a refusal, a bad request) is not. */
export function isUnreachable(error: unknown): boolean {
  const classified = mcpTransportError(error);
  return classified instanceof AgenticError && classified.retryable && classified.reason === DEPENDENCY_FAILURE_REASON.UNAVAILABLE;
}

/**
 * Retry only trusted read-only operations, with the caller's original deadline and arguments.
 * `retry: false` makes the one attempt and no more: for a caller that already knows the connector is down, where the
 * delays (2 s in all) are time spent on an answer it has just seen (discovery, `contextual-plugin.ts`).
 */
export async function recoverMcpRead<T>(operation: () => Promise<T>, signal: AbortSignal, readOnly: boolean, retry = true): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      if (signal.aborted) throw signal.reason;
      const classified = mcpTransportError(error);
      const wait = MCP_READ_RECOVERY_DELAYS_MS[attempt];
      if (!readOnly || !retry || wait === undefined || !isUnreachable(classified)) throw classified;
      await delay(wait, undefined, { signal }).catch(() => { throw signal.reason; });
    }
  }
}
