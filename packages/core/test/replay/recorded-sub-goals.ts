import type { PlanFacts, RunFacts, StepFacts } from "./step-facts.js";

/** Plan states an operation reopens as its own plan (work-plan-restore.ts `isOpen`). */
const OPEN = new Set(["active", "awaiting_user"]);

/**
 * The sub-goal ledger (`SubGoalLedger`) rebuilt from a run's plan facts, answering `undone` as the loop asks it before each
 * `decide()`: whether the plan the operation owns holds a step its attributed results do not show done.
 *
 * The plan the operation owns: a resumed run reopens its task's open plan (`planAtStart`); a new request's earlier plan is
 * the previous task's, dormant until one of the run's plan writes continues or replaces it. A step's facts are the model's
 * attributed calls (`workStep`), never a policy's reads: one that succeeded (`credited`) and did what it was asked (not
 * `failure`) shows the step done; a step with no attributed call is shown by the rule the plan closes on (in progress or
 * claimed done, and nothing pending). recorded-sub-goals.test.ts holds this rule equal to the runtime's, case by case.
 *
 * What the fixture cannot hold, and so the replay does not see (each is named in docs/incidents/2026-10-20-core-turn-end-s5-ledger.md):
 * - the later failure of a step's write after an earlier success is not seen (the side effect of a failed call is not recorded);
 * - step ids are per-run ordinals, so a new plan reusing an id within one run inherits that id's facts;
 * - the task's earlier turns contribute no facts: the recorded journals predate `work/step-progress`, so the loop restoring
 *   them would find none either.
 */
export class RecordedSubGoals {
  #plan: PlanFacts | undefined;
  readonly #attributed = new Set<number>();
  readonly #done = new Set<number>();

  constructor(run: RunFacts) {
    const start = run.planAtStart;
    this.#plan = start && run.resume !== "none" && OPEN.has(start.state) ? start : undefined;
  }

  /** The step's model calls ran: each attributed call is a fact of its step; then the plan stands as the step's writes left it. */
  ran(step: StepFacts): void {
    for (const call of step.calls ?? []) {
      if (call.plan || call.workStep === undefined) continue;
      this.#attributed.add(call.workStep);
      if (call.credited && !call.failure) this.#done.add(call.workStep);
    }
    if (step.plan) this.#plan = step.plan;
  }

  /** `SubGoalLedger.undone`: `undefined` without a plan. */
  undone(): boolean | undefined {
    const steps = this.#plan?.steps ?? [];
    if (steps.length === 0) return undefined;
    const pendingRemain = steps.some((step) => step.status === "pending");
    return steps.some((step) => !(this.#attributed.has(step.id)
      ? this.#done.has(step.id)
      : (step.status === "in_progress" || step.status === "completed") && !pendingRemain));
  }
}
