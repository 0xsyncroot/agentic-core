import { randomUUID } from "node:crypto";
import type { WorkPlan, WorkPlanProposal, WorkPlanState, WorkPlanStep } from "@0xsyncroot/contracts";
import { changedStepIds, markStep, mergeProposal, stepNamedBy } from "./work-plan-merge.js";
import type { TurnTerminalOutcome } from "./turn-terminator.js";

/** A plan the ledger owns: always has the identity fields core sets on every plan it journals. */
export interface LedgerPlan {
  readonly planId: string;
  readonly revision: number;
  readonly state: WorkPlanState;
  readonly goal: string;
  readonly steps: readonly WorkPlanStep[];
  readonly updatedAt: string;
}

/**
 * What the ledger has decided about this operation's plan.
 *
 * `current` is the plan this operation owns: reopened active, continued from a matched dormant
 * plan, or started fresh — once set it never goes back to undefined. `dormant` is the previous
 * task's unfinished plan, kept only until the first proposal either continues it or supersedes it.
 */
export interface LedgerState {
  readonly current?: LedgerPlan;
  readonly dormant?: LedgerPlan;
}

export function toWorkPlan(plan: LedgerPlan): WorkPlan {
  return { planId: plan.planId, revision: plan.revision, state: plan.state, goal: plan.goal, steps: plan.steps, updatedAt: plan.updatedAt };
}

function samePlanSteps(a: readonly WorkPlanStep[], b: readonly WorkPlanStep[]): boolean {
  return a.length === b.length && a.every((step, index) =>
    step.id === b[index]!.id && step.status === b[index]!.status && step.description === b[index]!.description && step.outcome === b[index]!.outcome);
}

export interface AppliedProposal {
  readonly next: LedgerState;
  readonly plan: LedgerPlan;
  readonly changedStepIds: readonly string[];
  readonly notes: readonly string[];
  /** The dormant plan this proposal superseded, closed as `stopped`, when a user turn's first proposal replaces it. */
  readonly closedDormant?: LedgerPlan;
}

/**
 * Lays a proposal over the ledger's state, per §3.3/§10.7: a plan already owned by this operation
 * always merges onto it (an active restore, or an earlier proposal this operation already made); a
 * dormant plan is matched by wording only, and a match continues it; otherwise a new plan starts,
 * closing the dormant one only when this is a user turn (a resume does not retire another task's
 * plan on its own authority).
 *
 * Pure and side-effect free, so both the ledger's real `propose` and its narration `preview` share
 * one rule: preview just never writes the result back.
 */
export function applyProposal(state: LedgerState, proposal: WorkPlanProposal, isUserTurn: boolean): AppliedProposal {
  const now = new Date().toISOString();
  if (state.current) {
    const merged = mergeProposal(state.current.steps, proposal, "active");
    const plan: LedgerPlan = {
      planId: state.current.planId, revision: state.current.revision + 1, state: "active", goal: merged.goal, steps: merged.steps, updatedAt: now,
    };
    return { next: { ...state, current: plan }, plan, changedStepIds: changedStepIds(state.current.steps, merged.steps), notes: merged.notes };
  }
  if (state.dormant) {
    const merged = mergeProposal(state.dormant.steps, proposal, "dormant");
    if (merged.matched > 0) {
      const plan: LedgerPlan = {
        planId: state.dormant.planId, revision: state.dormant.revision + 1, state: "active", goal: merged.goal, steps: merged.steps, updatedAt: now,
      };
      return { next: { current: plan }, plan, changedStepIds: changedStepIds(state.dormant.steps, merged.steps), notes: merged.notes };
    }
    const fresh = mergeProposal(undefined, proposal, "active");
    const plan: LedgerPlan = { planId: randomUUID(), revision: 1, state: "active", goal: fresh.goal, steps: fresh.steps, updatedAt: now };
    const closedDormant: LedgerPlan | undefined = isUserTurn
      ? { ...state.dormant, revision: state.dormant.revision + 1, state: "stopped", updatedAt: now }
      : undefined;
    return {
      next: { current: plan }, plan, changedStepIds: changedStepIds([], fresh.steps), notes: fresh.notes,
      ...(closedDormant ? { closedDormant } : {}),
    };
  }
  const fresh = mergeProposal(undefined, proposal, "active");
  const plan: LedgerPlan = { planId: randomUUID(), revision: 1, state: "active", goal: fresh.goal, steps: fresh.steps, updatedAt: now };
  return { next: { current: plan }, plan, changedStepIds: changedStepIds([], fresh.steps), notes: fresh.notes };
}

/**
 * Lays one step's status and outcome over the plan a proposal would update: the plan this operation owns, else the previous task's
 * unfinished one, which marking one of its steps continues (as a proposal matching it would). `undefined` when there is no
 * such plan or no step of it has the id; the caller refuses the mark then.
 */
export function applyMark(state: LedgerState, mark: Required<Pick<WorkPlanStep, "id" | "status" | "outcome">>): AppliedProposal | undefined {
  const base = state.current ?? state.dormant;
  const target = base ? stepNamedBy(base.steps, mark.id) : undefined;
  if (!base || !target) return undefined;
  const marked = markStep(base.steps, target, mark);
  const plan: LedgerPlan = {
    planId: base.planId, revision: base.revision + 1, state: "active", goal: base.goal, steps: marked.steps, updatedAt: new Date().toISOString(),
  };
  return {
    next: state.current ? { ...state, current: plan } : { current: plan }, plan,
    changedStepIds: changedStepIds(base.steps, marked.steps), notes: marked.notes,
  };
}

/** An in-progress step's outcome says what it starts, not what it found, so completing it leaves no result line. */
function completed(step: WorkPlanStep): WorkPlanStep {
  return step.status === "in_progress" ? { id: step.id, description: step.description, status: "completed" } : { ...step, status: "completed" };
}

/** The open steps `closing` names become completed; every other step keeps its status. */
function closeSteps(steps: readonly WorkPlanStep[], closing: ReadonlySet<string>): readonly WorkPlanStep[] {
  return steps.map((step) => (step.status === "pending" || step.status === "in_progress") && closing.has(step.id) ? completed(step) : step);
}

/**
 * What a terminal answer's review reads: the plan with every step the model left behind (pending, not in progress) that a settled,
 * non-failed call shows done completed, its state kept. The step in progress is the work the answer itself is judged on, so the
 * review reads it as the model left it and only the turn's end closes it. `undefined` when no step changes.
 */
export function closeDone(current: LedgerPlan, evidence: PlanEvidence): LedgerPlan | undefined {
  const done = evidence.doneSteps(toWorkPlan(current));
  const steps = closeSteps(current.steps, new Set(current.steps.filter((step) => step.status === "pending" && done.has(step.id)).map((step) => step.id)));
  return samePlanSteps(steps, current.steps) ? undefined : { ...current, steps, revision: current.revision + 1, updatedAt: new Date().toISOString() };
}

/** What the results attributed to the plan's steps show (`SubGoalLedger`): which steps a settled call shows done, and which had any call. */
export interface PlanEvidence {
  /** Steps a settled, non-failed call attributed to them shows done. */
  doneSteps(plan: WorkPlan): ReadonlySet<string>;
  /** Steps any of the model's calls was attributed to, whatever it did. */
  calledSteps(plan: WorkPlan): ReadonlySet<string>;
}

/**
 * The plan's next state at the turn's terminal, per §3.3: `undefined` when nothing actually
 * changes, so `close()` never writes a redundant revision.
 *
 * An accepted answer closes the steps the results show (`PlanEvidence`), so the model spends no request marking them: first every
 * step a call shows done; then, on a completed answer, every open step no call was attributed to (reading what was in hand,
 * writing the answer): the answer accepted as completed is that work. A step with a call that did not go through, a failed write
 * among them, keeps its status, and a partial answer closes only the first. Closing sets the status only, and a pause for the
 * user closes none.
 */
export function closeForOutcome(current: LedgerPlan, outcome: TurnTerminalOutcome, evidence: PlanEvidence): LedgerPlan | undefined {
  const now = new Date().toISOString();
  const revise = (steps: readonly WorkPlanStep[], state: WorkPlanState): LedgerPlan | undefined =>
    state === current.state && samePlanSteps(steps, current.steps) ? undefined : { ...current, steps, state, revision: current.revision + 1, updatedAt: now };
  // A partial end that asked the runtime's question waits on its answer, as a card does: "continue" reopens the plan.
  if (outcome.kind === "awaiting" || (outcome.kind !== "failed" && outcome.asksUser)) return revise(current.steps, "awaiting_user");
  if (outcome.kind === "fallback") return revise(current.steps, "stopped");
  if (outcome.kind === "failed") return revise(current.steps, "failed");
  const done = closeSteps(current.steps, evidence.doneSteps(toWorkPlan(current)));
  if (outcome.outcome === "partial") return revise(done, "stopped");
  const called = evidence.calledSteps(toWorkPlan(current));
  const steps = closeSteps(done, new Set(done.filter((step) => !called.has(step.id)).map((step) => step.id)));
  return revise(steps, steps.some((step) => step.status === "pending" || step.status === "in_progress") ? "active" : "completed");
}
