import {
  attemptFailure, stepProgressToolId,
  type EventDraft, type SessionEvent, type SubGoalCall, type SubGoalProgress, type ToolCall, type ToolDefinition,
  type WorkPlan, type WorkStepProgressPayload,
} from "@0xsyncroot/contracts";
import { toJsonValue } from "./json-value.js";
import type { ToolBatchContext } from "./tool-call-drafts.js";
import type { SettledOutcome } from "./tool-batch-types.js";
import type { TurnEventWriter } from "./turn-event-writer.js";

/** What the results attributed to one sub-goal showed over the task. */
interface SubGoalFacts {
  /** A call attributed to it did what it was asked. */
  done: boolean;
  /** A state-changing call attributed to it did what it was asked. */
  wrote: boolean;
  /** Its latest state-changing call did not do what it was asked. */
  writeFailed: boolean;
}

const changesState = (sideEffect: string): boolean => sideEffect === "idempotent" || sideEffect === "nonIdempotent";
const settled = (facts: SubGoalFacts): boolean => facts.done && !facts.writeFailed;
/** A sub-goal's identity: its plan and its step id. A step id names the same sub-goal only within one plan. */
const subGoalKey = (planId: string, stepId: string): string => JSON.stringify([planId, stepId]);

/**
 * The runtime's record of each sub-goal, which is one step of the work plan: the model names, orders and claims the steps
 * (`work-plan-ledger.ts`), and this ledger keeps what the results attributed to each step show. Only the model's own calls
 * count, attributed to the step in progress when they settled (`workStepId`); a planning call, or a runtime policy's read, is
 * no evidence of the work.
 *
 * A step is shown done when one of its calls did what it was asked (`attemptFailure`) and its latest state-changing call did
 * not fail; a partial write reports itself failed and so shows nothing. A step with no call is shown when it is in progress
 * or claimed done and no step of the plan is left pending.
 *
 * A sub-goal is a step id within one plan (`planId`). Within a plan, a step keeps its id only while the plan merge reads it
 * as the same step (`work-plan-merge.ts`, `continued`), so its evidence carries across the plan's revisions; a new plan
 * starts with none, even where it reuses an id. Earlier turns are read back only within the task.
 *
 * The record is journaled after each model step's calls as `work/step-progress`, ids, statuses and flags only, and the facts
 * of the task's earlier turns are read back from those records. A turn's end reads it (`undone`): a partial end asks the
 * user whether to go on only while a sub-goal is not shown done. An answer's end closes the steps a call shows done
 * (`doneSteps`) and, on a completed answer, the steps no call was attributed to (`calledSteps`): the work plan's close
 * (`closeForOutcome`). A step shown done never returns the batch to the model early.
 */
export class SubGoalLedger {
  readonly #facts = new Map<string, SubGoalFacts>();
  /** The calls of the model step under way, per sub-goal they were attributed to. */
  #calls = new Map<string, SubGoalCall[]>();

  /**
   * The facts of the task's earlier turns, replayed from their `work/step-progress` records in journal order, each call under
   * the plan its record names. A turn journaled before these records shows nothing for its steps.
   */
  static restore(events: readonly SessionEvent[], taskTurnIds: readonly string[]): SubGoalLedger {
    const ledger = new SubGoalLedger();
    const scope = new Set(taskTurnIds);
    for (const event of events) {
      if (event.type !== "work/step-progress" || !event.turnId || !scope.has(event.turnId)) continue;
      const record = event.payload as unknown as WorkStepProgressPayload;
      for (const subGoal of record.subGoals) {
        for (const call of subGoal.calls) ledger.#note(subGoalKey(record.planId, subGoal.id), call.sideEffect, call.failed === true);
      }
    }
    return ledger;
  }

  /** A model's work call settled under `workStepId`, the step of `plan` in progress then; nothing is attributed without both. */
  observe(plan: WorkPlan | undefined, workStepId: string | undefined, call: ToolCall, definition: ToolDefinition | undefined, outcome: SettledOutcome): void {
    if (!workStepId || !plan?.planId) return;
    const key = subGoalKey(plan.planId, workStepId);
    const failed = attemptFailure(outcome) !== undefined;
    const sideEffect = definition?.sideEffect ?? "unknown";
    this.#note(key, sideEffect, failed);
    const calls = this.#calls.get(key) ?? [];
    calls.push({
      callId: call.id, toolId: stepProgressToolId(call.name), state: outcome.state, sideEffect,
      ...(failed ? { failed: true as const } : {}), ...(!failed && outcome.halt === "state-changed" ? { halted: true as const } : {}),
    });
    this.#calls.set(key, calls);
  }

  /**
   * Journals the model step's record (`work/step-progress`): every sub-goal of `plan`, claimed beside shown, with the step's
   * calls attributed to each. Nothing without a plan this operation owns.
   */
  async journal(plan: WorkPlan | undefined, context: ToolBatchContext, writer: TurnEventWriter, key: string): Promise<void> {
    const draft = this.draft(plan, context);
    if (draft) await writer.append([draft], `step-progress:${key}`);
  }

  /** The record `journal` writes, or `undefined` without a plan; clears the step's calls. */
  draft(plan: WorkPlan | undefined, context: ToolBatchContext): EventDraft | undefined {
    const calls = this.#calls;
    this.#calls = new Map();
    if (!plan?.planId || plan.revision === undefined) return undefined;
    const planId = plan.planId;
    const shown = this.shownSteps(plan);
    const subGoals = plan.steps.map((step): SubGoalProgress => ({
      id: step.id, claimed: step.status, shown: shown.has(step.id), wrote: this.#facts.get(subGoalKey(planId, step.id))?.wrote ?? false,
      calls: calls.get(subGoalKey(planId, step.id)) ?? [],
    }));
    const payload: WorkStepProgressPayload = { planId: plan.planId, revision: plan.revision, subGoals };
    return { type: "work/step-progress", turnId: context.turnId, stepId: context.stepId, payload: toJsonValue(payload) };
  }

  /** The ids of the steps of `plan` the results show done; none without a plan identity. */
  shownSteps(plan: WorkPlan | undefined): ReadonlySet<string> {
    if (!plan?.planId) return new Set();
    const planId = plan.planId;
    const pendingRemain = plan.steps.some((step) => step.status === "pending");
    return new Set(plan.steps.filter((step) => {
      const facts = this.#facts.get(subGoalKey(planId, step.id));
      return facts ? settled(facts) : (step.status === "in_progress" || step.status === "completed") && !pendingRemain;
    }).map((step) => step.id));
  }

  /**
   * The ids of the steps of `plan` a settled call attributed to them shows done: one did what it was asked and the latest
   * write did not fail. A step with no call is never among them, whatever its status.
   */
  doneSteps(plan: WorkPlan): ReadonlySet<string> {
    const planId = plan.planId;
    if (!planId) return new Set();
    return new Set(plan.steps.filter((step) => {
      const facts = this.#facts.get(subGoalKey(planId, step.id));
      return facts !== undefined && settled(facts);
    }).map((step) => step.id));
  }

  /** The ids of the steps of `plan` any of the model's calls was attributed to, whatever it did; none without a plan identity. */
  calledSteps(plan: WorkPlan): ReadonlySet<string> {
    const planId = plan.planId;
    if (!planId) return new Set();
    return new Set(plan.steps.filter((step) => this.#facts.has(subGoalKey(planId, step.id))).map((step) => step.id));
  }

  /**
   * Whether `plan` holds a sub-goal the results do not show done: work left that another lap could still do. `undefined`
   * without a plan, where the ledger knows no sub-goal at all.
   */
  undone(plan: WorkPlan | undefined): boolean | undefined {
    if (!plan?.planId || plan.steps.length === 0) return undefined;
    const shown = this.shownSteps(plan);
    return plan.steps.some((step) => !shown.has(step.id));
  }

  #note(key: string, sideEffect: string, failed: boolean): void {
    const facts = this.#facts.get(key) ?? { done: false, wrote: false, writeFailed: false };
    if (!failed) facts.done = true;
    if (changesState(sideEffect)) {
      facts.writeFailed = failed;
      if (!failed) facts.wrote = true;
    }
    this.#facts.set(key, facts);
  }
}
