import {
  AgenticError,
  type ApprovalChallenge,
  type EventDraft, type HumanInteractionChallenge,
  type ToolCall, type ToolTerminalExecutionState, type WorkPlan,
} from "@0xsyncroot/contracts";
import type { PreparedToolExecution, ToolExecutionResult } from "./tool-execution-coordinator.js";
import type { WorkPlanLedger } from "./work-plan-ledger.js";
import type { StoredToolInteraction } from "./approval-continuation.js";
import type { ToolBatchContext } from "./tool-call-drafts.js";

export type ToolBatchResult =
  /**
   * `progressed` is true when a dispatched tool returned an observation the turn had not seen.
   *
   * `planningOnly` marks a step that did nothing but publish the work plan. It is neither: the
   * agent learned nothing, so it has not earned more allowance, and it is not circling either,
   * so it must not be counted as a stall. The loop asks the agent to publish its plan before
   * the work and to update it after every step, and a budget that charged for that would be
   * taxing the behaviour the prompt just asked for.
   */
  | { readonly kind: "completed"; readonly progressed: boolean; readonly planningOnly: boolean;
      /** The step's plan updates changed what the plan says; restating it unchanged is no work (`recordPlanningStep`). */
      readonly planChanged: boolean;
      /** Every call named a tool the step was not offered: the model spent the step on nothing it could use. */
      readonly unavailableOnly: boolean;
      /**
       * Every work call came back refused with a reason the model can act on (a wrong label, a stale handle, a tool the step
       * was not offered), each target fewer than three times.
       */
      readonly refusedOnly: boolean;
      /** A work call reached its tool, whatever it returned: the model acted on what it was told (`objectionsHeard`). */
      readonly workDispatched: boolean }
  | { readonly kind: "awaiting_approval"; readonly approval: ApprovalChallenge }
  | { readonly kind: "awaiting_interaction"; readonly interaction: HumanInteractionChallenge };
/** A call the user has let run — the approved write, or the tool whose question they answered. */
export interface AuthorizedCall {
  readonly prepared: PreparedToolExecution;
  /** The resolution the call runs under; journaled in the same append as its dispatch boundary. */
  readonly leadingDrafts: readonly EventDraft[];
  readonly interaction?: StoredToolInteraction;
  /** How the call was authorized, recorded on a question the call raises in turn. */
  readonly authorizationOutcome: "allow" | "require_approval";
  readonly context: ToolBatchContext;
  readonly signal: AbortSignal;
}
export type AuthorizedCallResult =
  | { readonly kind: "completed"; readonly state: ToolTerminalExecutionState; readonly dispatched: boolean }
  | { readonly kind: "awaiting_interaction"; readonly interaction: HumanInteractionChallenge };
export type SettledOutcome = ToolExecutionResult & { readonly state: ToolTerminalExecutionState };
export type Settled = { readonly kind: "settled"; readonly outcome: SettledOutcome; readonly observation: "new" | "repeated"; readonly refused?: boolean };
export type Paused = { readonly kind: "awaiting_interaction"; readonly interaction: HumanInteractionChallenge };
/** Planning calls run first, per §10.2: applied directly, they must never wait behind a call that pauses. */
export function planningFirst(calls: readonly ToolCall[], ledger: WorkPlanLedger): readonly ToolCall[] {
  const planning = calls.filter((call) => ledger.isPlanningCall(call.name));
  if (planning.length === 0) return calls;
  return [...planning, ...calls.filter((call) => !ledger.isPlanningCall(call.name))];
}

/** How long each kind of pause stays answerable. */
export interface PauseTtls {
  readonly approvalTtlMs: number;
  readonly interactionTtlMs: number;
}

export interface DispatchOptions {
  /** Journaled with the dispatch boundary, ahead of the policy decision. */
  readonly leading: readonly EventDraft[];
  /** Calls after this one in its batch: not started if this one pauses. */
  readonly remaining: readonly ToolCall[];
  readonly interaction?: StoredToolInteraction;
  readonly authorizationOutcome: "allow" | "require_approval";
  readonly position: number;
  readonly signal: AbortSignal;
}

/** What a plan says — its goal and steps — without the revision and time every update stamps on it. */
export const planShape = (plan: WorkPlan | undefined): string => plan ? JSON.stringify({ goal: plan.goal, steps: plan.steps }) : "";

/** The result of a best-effort call that would have paused the turn: it did not run, and nothing of it is shown to the model. */
export function skippedForPause(executionId: string, code: "approval-required" | "interaction-required", message: string): ToolExecutionResult {
  return { executionId, state: "not_started", dispatched: false, error: { type: "tool_error", code, retryable: false, message } };
}

export function settledOutcome(outcome: ToolExecutionResult): SettledOutcome {
  if (outcome.state === "awaiting_interaction") throw new AgenticError("permanent", "A tool asked for input without a request to show");
  return outcome as SettledOutcome;
}
