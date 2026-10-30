import { attemptFailure, type BestEffortRead, type EventDraft, type JsonValue, type RuntimeSnapshot, type SecurityContext, type ToolAttempt, type ToolCall, type ToolDefinition, type ToolPolicyDecision, type TurnApplicationContext, type UnavailableCapabilities } from "@0xsyncroot/contracts";
import { toJsonValue } from "./json-value.js";
import type { ResultReviewer } from "./observation-review.js";
import type { StepClaimReview } from "./step-claim-review.js";
import type { GroupLoad } from "./tool-selection.js";
import type { ToolExecutionResult } from "./tool-execution-coordinator.js";

/** Where a batch of calls runs: its turn and step, under whose authority, for which runtime. */
export interface ToolBatchContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly security: SecurityContext;
  readonly runtime: RuntimeSnapshot;
  readonly runtimeRouteRevision: string;
  readonly agentProfileId?: string;
  /** The turn's host context, handed to each tool with its call. */
  readonly applicationContext?: TurnApplicationContext;
  /**
   * The tools this step was offered. A call to any other tool is refused with a result that
   * names these — nothing runs — so the model learns what it can use and carries on. Omitted
   * means the coordinator's own catalogue is the boundary.
   */
  readonly selectedToolIds?: ReadonlySet<string>;
  /** What the turn knows it lacks: a refused call to one of these is told why, and that calling again will not help. */
  readonly unavailable?: UnavailableCapabilities;
  /** The calls are a policy's best-effort reads (`TurnObservationRequest.bestEffort`): bounded in time, and never shown to the model unless they succeed. */
  readonly bestEffort?: BestEffortRead;
  /** Set when the calls are a turn-control policy's own reads, not the model's: journaled and traced as such. */
  readonly initiator?: { readonly policyId: string; readonly reason: string };
  /** The turn's fast look at each result as it arrives (observation review): a note beside it, or a repeat counted as such. */
  readonly reviewResult?: ResultReviewer;
  /** Reads a step the agent marks completed against the turn's latest results (`step-claim`). */
  readonly stepClaims?: StepClaimReview;
  /** For a call to a tool of a group the turn's selection left out: the group and the loader call that offers it. */
  readonly groupLoad?: (toolId: string) => GroupLoad | undefined;
}

/** What the journal holds for a call before it is prepared: the model's call, as asked. */
export function intentDraft(call: ToolCall, context: ToolBatchContext, executionId: string, definition: ToolDefinition | undefined): EventDraft {
  return {
    type: "tool/intent", turnId: context.turnId, stepId: context.stepId, callId: call.id,
    payload: toJsonValue({
      callId: call.id, executionId, toolId: call.name, arguments: call.arguments,
      sideEffect: definition?.sideEffect ?? "unknown",
      ...(definition?.origin ? { origin: definition.origin } : {}),
      ...(context.initiator ? { initiator: "policy", policyId: context.initiator.policyId, reason: context.initiator.reason } : {}),
      ...(context.bestEffort ? { bestEffort: true } : {}),
      state: "prepared",
    }),
  };
}

export function policyDraft(call: ToolCall, context: ToolBatchContext, executionId: string, decision: ToolPolicyDecision): EventDraft {
  return {
    type: "tool/policy-decision", turnId: context.turnId, stepId: context.stepId, callId: call.id,
    payload: toJsonValue({ callId: call.id, executionId, toolId: call.name, ...decision }),
  };
}

/**
 * The dispatch boundary. Once it is journaled, a lost worker's call is `outcome_unknown` rather
 * than `not_started`: the tool may have acted. There is no separate "running" row — nothing reads
 * one, and the boundary alone decides how recovery closes the call.
 */
export function dispatchingDraft(call: ToolCall, context: ToolBatchContext, executionId: string): EventDraft {
  return {
    type: "tool/state", turnId: context.turnId, stepId: context.stepId, callId: call.id,
    payload: { callId: call.id, executionId, toolId: call.name, state: "dispatching" },
  };
}

/** Why a best-effort read is left out of the model's view; `undefined` for a call that is not one, or one the model is shown. */
export function bestEffortSkip(context: ToolBatchContext, outcome: ToolExecutionResult): "approval-required" | "interaction-required" | "timeout" | "failed" | undefined {
  if (!context.bestEffort) return undefined;
  const code = (outcome.error as { readonly code?: unknown } | null | undefined)?.code;
  if (code === "approval-required" || code === "interaction-required") return code;
  if (code === "timeout") return "timeout";
  // A call that ran but whose result says it did not do what was asked (`attemptFailure`) left nothing worth showing either.
  return attemptFailure(outcome) !== undefined ? "failed" : undefined;
}

/** A call's outcome as the journal keeps it: what the model reads now and on every replay. */
export function resultDraft(call: ToolCall, context: ToolBatchContext, outcome: ToolExecutionResult, facts: {
  readonly informationGain?: "new" | "repeated";
  readonly workStepId?: string;
  /** What the model reads when a newer observation of the same channel replaces this one. */
  readonly supersession?: { readonly channel: string; readonly condensed: JsonValue };
  /** Runtime guidance read beside the tool's own result, which it never replaces. */
  readonly note?: string;
  /** The target this call aimed at and whether it failed there (`ToolAttempt`). */
  readonly attempt?: ToolAttempt;
}): EventDraft {
  // A skipped best-effort read keeps why and nothing of what it returned: no reader of the journal finds a body to act on.
  const skipped = bestEffortSkip(context, outcome);
  return {
    type: "tool/result", turnId: context.turnId, stepId: context.stepId, callId: call.id,
    payload: toJsonValue({
      callId: call.id, toolId: call.name, executionId: outcome.executionId,
      state: outcome.state, dispatched: outcome.dispatched, executed: outcome.dispatched,
      ...(context.initiator ? { initiator: "policy" } : {}),
      ...(context.bestEffort ? { bestEffort: true, ...(skipped ? { skipped } : {}) } : {}),
      ...(outcome.result !== undefined && !skipped ? { result: outcome.result } : {}),
      ...(outcome.images?.length && !skipped ? { images: outcome.images } : {}),
      ...(outcome.resultId && !skipped ? { resultId: outcome.resultId } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(outcome.unavailable ? { unavailable: outcome.unavailable } : {}),
      ...(outcome.truncation && !skipped ? { truncated: outcome.truncation } : {}),
      ...(outcome.halt && !skipped ? { halt: outcome.halt } : {}),
      ...(outcome.nextCall && !skipped ? { nextCall: outcome.nextCall } : {}),
      ...(facts.informationGain && !skipped ? { informationGain: facts.informationGain } : {}),
      ...(facts.workStepId ? { workStepId: facts.workStepId } : {}),
      ...(facts.supersession && !skipped ? { supersession: facts.supersession } : {}),
      ...(facts.note ? { note: facts.note } : {}),
      ...(facts.attempt ? { attempt: facts.attempt } : {}),
    }),
  };
}

/**
 * Why a call placed after a paused one did not run, in words the model can act on.
 *
 * "Batch paused for approval" under a read-only call read as that call needing approval, and
 * nothing said it had not run or what to do about it: a model resumed after the approval sent
 * the whole step again, the write included, and the user was asked to approve it a second time.
 */
function pausedBehind(toolId: string, awaiting: "approval" | "input"): string {
  return `Not run: this step stopped at ${toolId}, which waits for the user's ${awaiting}. `
    + `This call was not the one waiting. ${toolId} runs once the ${awaiting} is given and its result arrives on its own, so do not send it again; call this one again afterwards only if it is still needed.`;
}

/** Results for the calls a pause left behind it in the batch: each not started, and why. */
export function notStartedBehindDrafts(
  remaining: readonly ToolCall[], context: ToolBatchContext, paused: ToolCall, awaiting: "approval" | "input",
  executionId: (call: ToolCall) => string,
): readonly EventDraft[] {
  const code = awaiting === "approval" ? "approval-required" : "interaction-required";
  return remaining.map((call): EventDraft => ({
    type: "tool/result", turnId: context.turnId, stepId: context.stepId, callId: call.id,
    payload: {
      callId: call.id, executionId: executionId(call), toolId: call.name, state: "not_started", dispatched: false,
      error: { type: "tool_error", code, retryable: false, message: pausedBehind(paused.name, awaiting) },
    },
  }));
}
