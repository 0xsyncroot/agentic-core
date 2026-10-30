import type { JsonValue } from "../shared/json.js";
import type { EventDraft } from "./session.js";

export interface ToolRecoveryEvent {
  readonly type: string;
  readonly stepId?: string;
  readonly callId?: string;
  readonly payload: JsonValue;
}

function payloadString(event: ToolRecoveryEvent, key: string): string | undefined {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return undefined;
  const value = event.payload[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Balances tool calls left open by a lost worker. A call that crossed the
 * durable dispatch boundary is conservatively unknown; only undispatched
 * calls are classified as not started.
 *
 * Intents and results are joined by execution, not by call id: a call resumed after an approval
 * is recorded again under the resuming turn with the same execution, and provider call ids can
 * repeat across turns, so a call id alone can close the wrong call. Rows written before results
 * carried an execution fall back to the call id. Each open execution is closed once.
 */
export function createInterruptedToolResults(events: readonly ToolRecoveryEvent[], turnId: string): readonly EventDraft[] {
  const closedExecutions = new Set<string>();
  const closedCalls = new Set<string>();
  const latestState = new Map<string, string>();
  for (const event of events) {
    const executionId = payloadString(event, "executionId");
    if (event.type === "tool/result") {
      if (executionId) closedExecutions.add(executionId);
      else if (event.callId) closedCalls.add(event.callId);
    }
    const state = payloadString(event, "state");
    const key = executionId ?? event.callId;
    if (event.type === "tool/state" && key && state) latestState.set(key, state);
  }
  return events.flatMap((event): EventDraft[] => {
    if (event.type !== "tool/intent" || !event.callId || !event.stepId || closedCalls.has(event.callId)) return [];
    const toolId = payloadString(event, "toolId");
    const executionId = payloadString(event, "executionId");
    if (!toolId || !executionId || closedExecutions.has(executionId)) return [];
    closedExecutions.add(executionId);
    const crossedDispatchBoundary = ["dispatching", "running"].includes(latestState.get(executionId) ?? latestState.get(event.callId) ?? "");
    const state = crossedDispatchBoundary ? "outcome_unknown" : "not_started";
    return [{
      type: "tool/result", turnId, stepId: event.stepId, callId: event.callId,
      payload: {
        callId: event.callId, executionId, toolId, state,
        dispatched: crossedDispatchBoundary,
        error: {
          type: "tool_error",
          code: crossedDispatchBoundary ? "unknown-outcome" : "cancelled",
          message: crossedDispatchBoundary
            ? "Worker was lost after the tool crossed the dispatch boundary"
            : "Worker was lost before the tool was dispatched",
          retryable: false,
        },
      },
    }];
  });
}
