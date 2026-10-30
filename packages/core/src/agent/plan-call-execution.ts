import type { AgentProgressEvent, EventDraft, JsonValue, ToolCall, ToolTerminalExecutionState, WorkPlan, WorkPlanCause } from "@0xsyncroot/contracts";
import { toJsonValue } from "./json-value.js";
import { dispatchingDraft, policyDraft, resultDraft, type ToolBatchContext } from "./tool-call-drafts.js";
import type { PreparedToolExecution } from "./tool-execution-coordinator.js";
import type { TurnEventWriter } from "./turn-event-writer.js";
import type { WorkPlanLedger } from "./work-plan-ledger.js";

export interface PlanCallOutcome {
  readonly succeeded: boolean;
  readonly result?: JsonValue;
  readonly error?: JsonValue;
  readonly drafts: readonly EventDraft[];
  readonly progress: readonly AgentProgressEvent[];
}

function planDraft(context: ToolBatchContext, call: ToolCall, plan: WorkPlan, cause: WorkPlanCause, changed?: readonly string[]): EventDraft {
  return {
    type: "work/plan-updated", turnId: context.turnId, stepId: context.stepId, callId: call.id,
    payload: toJsonValue({ ...plan, cause, ...(changed && changed.length > 0 ? { changedStepIds: changed } : {}) }),
  };
}

function planProgress(context: ToolBatchContext, call: ToolCall, plan: WorkPlan, cause: WorkPlanCause, changed?: readonly string[]): AgentProgressEvent {
  return {
    type: "plan-updated", turnId: context.turnId, step: context.stepIndex, callId: call.id, plan, cause,
    ...(changed && changed.length > 0 ? { changedStepIds: changed } : {}),
  };
}

function refused(call: ToolCall, context: ToolBatchContext, executionId: string, message: string): PlanCallOutcome {
  const error: JsonValue = { type: "tool_error", code: "validation", retryable: false, message };
  return { succeeded: false, error, drafts: [resultDraft(call, context, { executionId, state: "failed", dispatched: true, error }, {})], progress: [] };
}

/**
 * Applies a planning call directly, in place of dispatching it to the broker — §10.1: the runtime
 * owns the plan, so the call never reaches a tool implementation. Builds the same journal shape a
 * dispatched tool would (a `tool/result`) plus the plan's own `work/plan-updated`, and a second one
 * when the proposal replaced a dormant plan from the previous task. A step mark is journaled the same way, as a proposal.
 */
export function applyPlanningCall(args: {
  readonly call: ToolCall; readonly context: ToolBatchContext; readonly executionId: string; readonly ledger: WorkPlanLedger;
  /** Runtime guidance read beside the plan the update produced (a step the evidence does not show done). */
  readonly note?: string;
}): PlanCallOutcome {
  const { call, context, executionId, ledger } = args;
  let parsed: JsonValue;
  try { parsed = JSON.parse(call.arguments) as JsonValue; }
  catch { return refused(call, context, executionId, "Plan arguments must be valid JSON"); }
  const outcome = ledger.isMarkCall(call.name) ? ledger.mark(parsed) : ledger.propose(parsed);
  if (!outcome.ok) return refused(call, context, executionId, outcome.message);
  const result = toJsonValue({ ...outcome.plan, normalized: outcome.notes });
  // The retired dormant plan's own closing row goes first: written last, it would become the
  // journal's newest plan-updated row and a later restore (§10.7, raw-tail `latestPlanEvent`) would
  // read a closed plan and restore nothing, losing this proposal's still-open plan entirely. Clients
  // see the retirement before the new plan for the same reason — never the other way round.
  const drafts: EventDraft[] = [
    resultDraft(call, context, { executionId, state: "succeeded", dispatched: true, result }, args.note ? { note: args.note } : {}),
    ...(outcome.closedDormant ? [planDraft(context, call, outcome.closedDormant, "terminal")] : []),
    planDraft(context, call, outcome.plan, "proposal", outcome.changedStepIds),
  ];
  const progress: AgentProgressEvent[] = [
    ...(outcome.closedDormant ? [planProgress(context, call, outcome.closedDormant, "terminal")] : []),
    planProgress(context, call, outcome.plan, "proposal", outcome.changedStepIds),
  ];
  return { succeeded: true, result, drafts, progress };
}

export interface DispatchedPlanningCall {
  readonly executionId: string;
  readonly state: ToolTerminalExecutionState;
  readonly dispatched: true;
  readonly result?: JsonValue;
  readonly error?: JsonValue;
}

/**
 * Journals and reports a planning call end to end — the dispatch boundary, `applyPlanningCall`'s
 * drafts, and the matching `tool-started`/`tool-completed`/`plan-updated` progress — and reduces it
 * to the same outcome shape a dispatched tool leaves behind, so its caller need not know the
 * difference. Kept out of `ToolBatchExecutor` only to keep that file under its line budget.
 */
export async function dispatchPlanningCall(args: {
  readonly call: ToolCall; readonly context: ToolBatchContext; readonly execution: PreparedToolExecution; readonly position: number;
  readonly ledger: WorkPlanLedger; readonly writer: TurnEventWriter; readonly report: (event: AgentProgressEvent) => void; readonly note?: string;
}): Promise<DispatchedPlanningCall> {
  const { call, context, execution, position, ledger, writer, report } = args;
  await writer.append([
    policyDraft(call, context, execution.executionId, execution.policyDecision),
    dispatchingDraft(call, context, execution.executionId),
  ], `tool-dispatch:${context.stepId}:${position}:${call.id}`);
  report({ type: "tool-state-changed", turnId: context.turnId, step: context.stepIndex, callId: call.id, toolId: call.name, executionId: execution.executionId, state: "dispatching" });
  report({ type: "tool-started", turnId: context.turnId, step: context.stepIndex, callId: call.id, toolId: call.name });
  const applied = applyPlanningCall({ call, context, executionId: execution.executionId, ledger, ...(args.note ? { note: args.note } : {}) });
  await writer.append(applied.drafts, `tool-result:${context.stepId}:${position}:${call.id}`);
  const state: ToolTerminalExecutionState = applied.succeeded ? "succeeded" : "failed";
  report({ type: "tool-state-changed", turnId: context.turnId, step: context.stepIndex, callId: call.id, toolId: call.name, executionId: execution.executionId, state });
  report({ type: "tool-completed", turnId: context.turnId, step: context.stepIndex, callId: call.id, toolId: call.name, status: state });
  for (const progress of applied.progress) report(progress);
  return {
    executionId: execution.executionId, state, dispatched: true,
    ...(applied.result !== undefined ? { result: applied.result } : {}), ...(applied.error !== undefined ? { error: applied.error } : {}),
  };
}
