import type { JsonValue } from "../shared/json.js";

/**
 * What the agent has tried, in any tool, as the runtime counts it.
 *
 * A failed call is recorded against the target it aimed at — the tool and its arguments without the
 * fields that change on every try (a screen revision, a cursor, a page size) — so "the same thing
 * again" is recognised even when the model changes a number. Harnesses that keep agents at a task
 * (OpenHands, browser-use, DeepSeek Harness) count exactly this: a repeat is answered with a
 * reminder to change approach, and "cannot be done" is accepted only after several different
 * approaches failed on the same blocker. The record rides on each `tool/result`, so every reader
 * of the journal counts the same way.
 */
export interface ToolAttempt {
  /** Tool id and arguments without volatile fields: the target of the call. */
  readonly signature: string;
  /** Why it failed (the tool's reason code or error code); absent on success. */
  readonly failure?: string;
  /** Failures recorded against this signature in the turn, this one included. */
  readonly failures: number;
}

/** Statuses a structured result uses to say the call did not do what it was asked. */
const FAILED_STATUSES: ReadonlySet<string> = new Set(["failed", "stale", "rejected", "unsupported", "unavailable", "error", "expired", "not_found"]);
/** Argument fields that change on every try without changing what is aimed at. */
const VOLATILE = /revision|cursor|offset|limit|count|page|max|token|idempotency|timeout|wait/iu;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return typeof value === "number" ? "#" : value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !VOLATILE.test(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
}

export function attemptSignature(toolId: string, args: unknown): string {
  let parsed = args;
  if (typeof args === "string") { try { parsed = JSON.parse(args); } catch { parsed = args; } }
  return `${toolId} ${JSON.stringify(canonical(parsed) ?? null)}`.slice(0, 400);
}

/** The reason a tool outcome failed, or undefined when it did what it was asked. */
export function attemptFailure(outcome: { readonly state: string; readonly result?: JsonValue; readonly error?: JsonValue }): string | undefined {
  const record = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (outcome.state !== "succeeded") return String(record(outcome.error).code ?? outcome.state);
  const result = record(outcome.result);
  if (result.type === "tool_error") return String(result.code ?? "tool_error");
  const status = typeof result.status === "string" ? result.status : undefined;
  if (status && FAILED_STATUSES.has(status)) return String(result.reasonCode ?? status);
  return undefined;
}

/** The attempts a task's `tool/result` events recorded: distinct targets that failed, and the reasons. */
export function recordedAttempts(events: readonly { readonly type: string; readonly turnId?: string; readonly payload: JsonValue }[], turnIds: ReadonlySet<string>): {
  readonly failedTargets: number; readonly failures: readonly { readonly signature: string; readonly failure: string; readonly failures: number }[];
} {
  const last = new Map<string, { signature: string; failure: string; failures: number }>();
  for (const event of events) {
    if (event.type !== "tool/result" || !turnIds.has(event.turnId ?? "")) continue;
    const attempt = (event.payload as Record<string, unknown> | null)?.attempt as Partial<ToolAttempt> | undefined;
    if (!attempt?.signature || !attempt.failure) continue;
    last.set(attempt.signature, { signature: attempt.signature, failure: attempt.failure, failures: attempt.failures ?? 1 });
  }
  return { failedTargets: last.size, failures: [...last.values()] };
}
