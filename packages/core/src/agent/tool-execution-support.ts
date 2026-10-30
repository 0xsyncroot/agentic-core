import { AgenticError, type JsonValue, type SecurityContext, type ToolDefinition } from "@0xsyncroot/contracts";

/**
 * The coordinator's small, stateless helpers, kept apart so `ToolExecutionCoordinator` stays one
 * readable unit under the source line limit.
 */

/** Freezes plain data only: a frozen AbortSignal.any signal in a call's context makes an abort throw in a timer and exit the process. */
export function freezeJson<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeJson(child);
  return value;
}

export function errorCode(outcome: { readonly error?: JsonValue }): string {
  const error = outcome.error;
  return error !== null && typeof error === "object" && !Array.isArray(error) && typeof error.code === "string" ? error.code : "";
}

export function parseArguments(source: string): JsonValue {
  try { const parsed: unknown = JSON.parse(source); if (parsed === undefined) throw new Error(); return parsed as JsonValue; }
  catch { throw new AgenticError("validation", "Tool arguments must be valid JSON"); }
}

/**
 * The tool's own refusal of arguments it can never accept, before anyone is asked to authorize them.
 *
 * Whatever it throws becomes a validation failure: the call is left not started, nothing is
 * dispatched, no approval card is raised, and the model reads the tool's reason and can correct it.
 */
export async function validateToolArguments(tool: ToolDefinition, args: JsonValue, security: SecurityContext): Promise<void> {
  if (!tool.validateArguments) return;
  try { await tool.validateArguments(args, { security }); }
  catch (error) {
    throw new AgenticError("validation", error instanceof Error ? error.message : String(error), false, { cause: error });
  }
}

export async function withHardTimeout<T>(operation: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(new AgenticError("timeout", `Tool timed out after ${timeoutMs}ms`)); reject(new AgenticError("timeout", `Tool timed out after ${timeoutMs}ms`)); }, timeoutMs);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}
