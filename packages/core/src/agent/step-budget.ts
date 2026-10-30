/**
 * Progress-aware step budget for the agent loop.
 *
 * A fixed step count cuts the agent off mid-task while it still makes measurable progress, and
 * lets a stuck agent burn the whole budget repeating itself. The budget therefore starts small
 * and is re-granted only while the turn keeps producing new observations, with `maxSteps` a hard
 * safety ceiling rather than the working plan length. It never decides *what* the agent does
 * next, only whether another model step is still justified by evidence of progress.
 *
 * Only `turn-end.ts` uses it: it restores the allowance from the turn's ledger, applies one step,
 * and keeps the new state. It counts steps only: how long a turn may stay silent is the silence
 * watch's bound (`claimed-turn.ts`), never a reason for a step to be final.
 */
export interface StepBudgetOptions {
  /** Hard step ceiling: no step runs past it, however much the turn progresses. */
  readonly maxSteps: number;
  /** Steps granted up front, before any progress has been observed. */
  readonly initialStepBudget: number;
  /** Steps re-granted each time the agent proves it is still making progress. */
  readonly stepBudgetExtension: number;
}

/** The allowance between two steps, as the turn's ledger carries it. */
export interface StepAllowance {
  /** The last step index the turn may run. */
  readonly granted: number;
  /** Steps in a row that brought no new observation; steps in a row whose every call was refused with a reason. */
  readonly stalls: number;
  readonly refusals: number;
}

/** Length of a run of observation-free steps after which the model is told it is circling. */
const STALL_LIMIT = 2;
/** Steps in a row whose calls were all refused with a reason, refunded before they count as stalls. */
const REFUSAL_LIMIT = 3;
/** Steps of headroom kept before the allowance runs out, so one stall cannot end the turn. */
export const EXTENSION_WINDOW = 2;

export class StepBudget {
  #granted: number;
  #consecutiveStallingSteps = 0;
  #consecutiveRefusedSteps = 0;

  constructor(private readonly options: StepBudgetOptions, startStepIndex = 1) {
    const initial = Math.min(Math.max(1, options.initialStepBudget), this.ceiling);
    // `granted` is an absolute step index, and a resumed turn starts partway through one.
    // Granting from the resume point keeps the allowance a count of remaining work.
    this.#granted = Math.min(Math.max(1, startStepIndex) - 1 + initial, this.ceiling);
  }

  /** The budget as it stood after an earlier step. */
  static restore(options: StepBudgetOptions, state: StepAllowance): StepBudget {
    const budget = new StepBudget(options);
    budget.#granted = state.granted;
    budget.#consecutiveStallingSteps = state.stalls;
    budget.#consecutiveRefusedSteps = state.refusals;
    return budget;
  }

  get state(): StepAllowance {
    return Object.freeze({ granted: this.#granted, stalls: this.#consecutiveStallingSteps, refusals: this.#consecutiveRefusedSteps });
  }

  /** Steps the agent may currently use, always bounded by the hard ceiling. */
  get granted(): number { return this.#granted; }

  get ceiling(): number { return this.options.maxSteps; }

  /** Steps in a row that brought no new observation. */
  get stalls(): number { return this.#consecutiveStallingSteps; }

  /** Leave input queued at the edge when there is no model step left to apply it. */
  canApplyInterjection(stepIndex: number): boolean {
    return stepIndex < this.ceiling;
  }

  recordInterjection(stepIndex: number): void {
    this.grant(Math.max(this.#granted + 1, stepIndex + 2));
    this.#consecutiveStallingSteps = 0;
  }

  /** Why a step at the allowance edge is the last one. */
  limitReason(stepIndex: number): string {
    return stepIndex >= this.ceiling ? "step-limit" : "progress-stalled";
  }

  /** The last steps still brought something new. */
  get progressing(): boolean { return this.#consecutiveStallingSteps < STALL_LIMIT; }

  /** Steps still available after the given one, from the agent's point of view. */
  remainingAfter(stepIndex: number): number { return Math.max(0, this.#granted - stepIndex); }

  /**
   * A step that did nothing but publish the work plan, which costs the turn nothing: the loop asks
   * for the plan before the first action and after every step, and charging for it would shorten
   * every turn that complies. The hard ceiling still applies. A plan restated unchanged is circling,
   * though: refunded, a model that only ever sends the same plan runs to the tool-call ceiling. It stalls.
   */
  recordPlanningStep(changed = true): void {
    if (!changed) { this.#consecutiveStallingSteps += 1; return; }
    // A refund, not a grant: the step that just ran is given back, so the allowance measures
    // work rather than round trips. `max(granted, index + 1)` would only refund at the edge.
    this.grant(this.#granted + 1);
  }

  /**
   * A step the runtime sent back — a rejected answer — which the model never got to spend on the task.
   * Charged, it shortened the turn twice over: a lost lap, then a final step with no tools mid-task.
   * The stall run is left alone — being sent back is not circling — and the hard ceiling still applies.
   */
  recordRejectedStep(): void {
    this.grant(this.#granted + 1);
  }

  /**
   * A step whose every call was refused with a reason the model can act on — a label echoed wrong, a handle gone stale, a
   * tool the step was not offered. The refusal is feedback, not circling: counted as a stall, a no-op click followed by one
   * mislabelled click would end a turn that its next step would have finished. Refunded like a sent-back step, the stall
   * run untouched, three in a row at most; then they are stalls. Calls to a tool the step lacked share that bound: refunded
   * without it, such a model runs to the tool-call ceiling.
   */
  recordRefusedStep(): void {
    this.#consecutiveRefusedSteps += 1;
    if (this.#consecutiveRefusedSteps <= REFUSAL_LIMIT) { this.recordRejectedStep(); return; }
    this.#consecutiveStallingSteps += 1;
  }

  /**
   * Raises the allowance to step `to`, bounded by the ceiling, and never lowers it. `pastCeiling` lifts the bound for a step
   * that can only retry a failed one or answer (`turn-end.ts`): refused there, the turn that used every step — the one that
   * most needs another try — ends with nothing. A plain `min(…, maxSteps)` taken on such a step would pull the allowance back
   * below the step being run.
   */
  grant(to: number, pastCeiling = false): void {
    this.#granted = Math.max(this.#granted, pastCeiling ? to : Math.min(to, this.ceiling));
  }

  /**
   * Records the outcome of one completed tool step.
   *
   * `progressed` means at least one dispatched tool returned an observation the turn had not
   * seen before. A single repeated observation is normal — a read can legitimately confirm
   * what is already known — so only a run of them stops the allowance growing, and a step
   * that does learn something clears the run. The extension is a latency and cost measure,
   * not a safety one: fresh-looking results alone cannot prove completion. The step ceiling and
   * the tool-call ceiling bound execution independently of this allowance.
   */
  recordStepOutcome(stepIndex: number, progressed: boolean): void {
    if (!progressed) { this.#consecutiveStallingSteps += 1; return; }
    this.#consecutiveStallingSteps = 0;
    this.#consecutiveRefusedSteps = 0;
    if (this.#granted >= this.ceiling || this.remainingAfter(stepIndex) > EXTENSION_WINDOW) return;
    this.grant(this.#granted + Math.max(1, this.options.stepBudgetExtension));
  }
}
