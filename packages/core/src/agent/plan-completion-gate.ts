import { attemptFailure, type EventDraft, type JsonValue, type ToolCall, type WorkPlan } from "@0xsyncroot/contracts";
import type { ToolBatchContext } from "./tool-call-drafts.js";
import { toolResultContent } from "./tool-result-bounds.js";
import type { WorkPlanLedger } from "./work-plan-ledger.js";

/** Steps a planning call moves to completed or blocked: the statuses the user reads as the step's result. */
function settledSteps(before: WorkPlan | undefined, after: WorkPlan | undefined): readonly string[] {
  const was = new Map((before?.steps ?? []).map((step) => [step.id, step.status]));
  return (after?.steps ?? []).filter((step) => (step.status === "completed" || step.status === "blocked") && was.get(step.id) !== step.status)
    .map((step) => step.id);
}

/**
 * Orders a step's planning calls around its work, and applies a step's completion only once the step's work went through.
 *
 * A planning call is applied directly, before anything is dispatched, so a plan sent beside its first work call is the plan
 * that work is attributed to, and a call that pauses never holds the plan back. A call that moves a step to completed or
 * blocked is different: applied first, the user reads the step's result while work sent beside it has not run yet, and that
 * work may be what produces the result. In a step that also has work calls, such a call (previewed in order, on the plan the
 * calls applied first produce, and continuing that plan) runs after the work, in the model's order, and is applied only when
 * every work call of this step succeeded: none failed, none was not started, none changed the scope it was chosen for
 * (`halt`). Otherwise it is not started, the plan keeps its statuses, no plan change is journaled or streamed, and its result
 * says the completion waits for the step's work. Attribution does not move: the work is attributed to the step in progress
 * once all the step's planning calls apply, as when they all ran first. A step of planning calls alone is applied in order.
 */
export class PlanCompletionGate {
  /** The step's calls in execution order: planning calls applied first, the work, then the planning calls that wait for it. */
  readonly ordered: readonly ToolCall[];
  readonly #deferred: readonly ToolCall[];
  /** The step's first work call that did not go through, with its place in the model's order. */
  #unfinished?: { readonly toolId: string; readonly order: number; readonly cause: string };

  /** `calls`: the step's calls as the model sent them, the order its messages count in. */
  constructor(private readonly calls: readonly ToolCall[], private readonly ledger: WorkPlanLedger) {
    const planning = calls.filter((call) => ledger.isPlanningCall(call.name));
    const work = calls.filter((call) => !ledger.isPlanningCall(call.name));
    const first: ToolCall[] = [];
    const deferred: ToolCall[] = [];
    for (const call of planning) {
      const previewed = ledger.previewProposals(first);
      const before = previewed ?? ledger.workPlan;
      const after = ledger.previewProposals([...first, call]);
      // A call that starts a new plan has no plan to wait on: the work beside it is attributed to that plan's steps.
      const continues = before !== undefined && (previewed !== undefined || after?.planId === before.planId);
      (work.length > 0 && continues && settledSteps(before, after).length > 0 ? deferred : first).push(call);
    }
    this.ordered = [...first, ...work, ...deferred];
    this.#deferred = deferred;
  }

  /**
   * The plan and step a model's work call is attributed to: the step in progress once the step's planning calls apply, on the
   * plan they continue. A best-effort read is the runtime's, under no step.
   */
  attribution(context: ToolBatchContext): { readonly plan: WorkPlan | undefined; readonly stepId: string | undefined } {
    const preview = this.#deferred.length > 0 && !context.bestEffort ? this.ledger.previewProposals(this.#deferred) : undefined;
    if (!preview) return { plan: this.ledger.currentPlan, stepId: context.bestEffort ? undefined : this.ledger.currentStepId() };
    return { plan: this.ledger.workPlan, stepId: preview.steps.find((step) => step.status === "in_progress")?.id };
  }

  /** A model's work call's outcome: the first that did not go through holds back the step's completions. */
  observe(context: ToolBatchContext, call: ToolCall, outcome: { readonly state: string; readonly result?: JsonValue; readonly error?: JsonValue; readonly halt?: "state-changed" }): void {
    if (context.bestEffort || this.#unfinished || this.ledger.isPlanningCall(call.name)) return;
    const cause = outcome.state === "not_started" ? "was not started"
      : attemptFailure(outcome) !== undefined ? "did not succeed"
        : outcome.halt === "state-changed" ? "changed the scope it was chosen for" : undefined;
    if (cause) this.#unfinished = { toolId: call.name, order: this.calls.indexOf(call) + 1, cause };
  }

  /** The not-started result of a planning call that waited for the step's work, when that work did not go through. */
  withheld(call: ToolCall, context: ToolBatchContext, executionId: string): { readonly draft: EventDraft; readonly content: string } | undefined {
    const work = this.#unfinished;
    if (!work || !this.#deferred.includes(call)) return undefined;
    const error = {
      type: "tool_error", code: "not-started", retryable: true,
      message: `Not applied: the plan kept its statuses, because a step is completed or blocked only after the work sent beside the mark, and ${work.toolId} (call ${work.order} of this step, in your order) ${work.cause}; mark it once a result shows its outcome.`,
    };
    return {
      draft: {
        type: "tool/result", turnId: context.turnId, stepId: context.stepId, callId: call.id,
        payload: { callId: call.id, executionId, toolId: call.name, state: "not_started", dispatched: false, error },
      },
      content: toolResultContent({ error }),
    };
  }
}
