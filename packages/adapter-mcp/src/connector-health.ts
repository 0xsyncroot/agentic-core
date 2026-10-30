import { mcpTransportError } from "./transport-error.js";

const MAX_MESSAGE_CHARS = 300;

/** The error as a log line may carry it: a code and a bounded message, with anything credential-shaped taken out. */
function errorSummary(error: unknown): { readonly code?: string; readonly message: string } {
  const classified = mcpTransportError(error);
  const code = (classified as { code?: unknown } | null)?.code;
  const message = (classified instanceof Error ? classified.message : String(classified))
    .replace(/bearer\s+\S+/giu, "Bearer [redacted]")
    // Userinfo and query strings are where a URL carries a secret; the origin and path say which endpoint failed.
    .replace(/(\w+:\/\/)[^\s/@]*@/gu, "$1").replace(/(\w+:\/\/[^\s?#]*)[?#]\S*/gu, "$1")
    .slice(0, MAX_MESSAGE_CHARS);
  return { ...(typeof code === "string" ? { code } : {}), message };
}

/**
 * One log line when a connector stops answering discovery, and one when it answers again — never one per turn.
 *
 * A connector configured to be omitted on failure degrades to an empty catalogue; without these lines nothing in the log
 * says it is down, and the turn's trace shows only a model calling a tool that does not exist. A connector starts out
 * healthy, so its first failure is logged. The line names
 * the server and the error's code and message, never its configuration or credentials.
 */
export function connectorHealthLog(serverId: string): { failed(error: unknown): void; recovered(): void } {
  let failing = false;
  return {
    failed(error) {
      if (failing) return;
      failing = true;
      console.warn(JSON.stringify({ event: "mcp.connector.unavailable", serverId, ...errorSummary(error) }));
    },
    recovered() {
      if (!failing) return;
      failing = false;
      console.warn(JSON.stringify({ event: "mcp.connector.recovered", serverId }));
    },
  };
}
