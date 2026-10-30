export interface StepBudgetOptions {
  readonly maxSteps: number | "progressive";
  readonly initialStepBudget: number;
  readonly stepBudgetExtension: number;
  readonly turnTimeoutMs?: number;
}

const STALL_LIMIT = 2;
const REFUSAL_LIMIT = 3;
const EXTENSION_WINDOW = 2;
const MIN_ANSWER_RESERVE_MS = 15_000;

export class StepBudget {
  #granted: number;
  #consecutiveStallingSteps = 0;
  #consecutiveRefusedSteps = 0;
  #longestStepMs = 0;
  #verificationStepGranted = false;
  #finalAnswerStepGranted = false;
  #deadlineAt: number | undefined;

  constructor(private readonly options: StepBudgetOptions, startStepIndex = 1, now = Date.now()) {
    const initial = Math.min(Math.max(1, options.initialStepBudget), this.ceiling);
    this.#granted = Math.min(Math.max(1, startStepIndex) - 1 + initial, this.ceiling);
    this.#deadlineAt = options.turnTimeoutMs === undefined ? undefined : now + options.turnTimeoutMs;
  }

  noteActivity(now = Date.now()): void {
    if (this.options.turnTimeoutMs === undefined) return;
    this.#deadlineAt = now + this.options.turnTimeoutMs;
  }

  get granted(): number { return this.#granted; }

  get ceiling(): number { return this.options.maxSteps === "progressive" ? Infinity : this.options.maxSteps; }

  canApplyInterjection(stepIndex: number, now = Date.now()): boolean {
    return stepIndex < this.ceiling && !this.#outOfTime(now);
  }

  recordInterjection(stepIndex: number): void {
    this.#raise(Math.max(this.#granted + 1, stepIndex + 2));
    this.#consecutiveStallingSteps = 0;
  }

  stopReason(stepIndex: number, now = Date.now()): string {
    if (this.#outOfTime(now)) return "time-limit";
    return stepIndex >= this.ceiling ? "step-limit" : "progress-stalled";
  }

  isFinalStep(stepIndex: number, now = Date.now()): boolean {
    return stepIndex >= this.#granted || this.#outOfTime(now);
  }

  #outOfTime(now: number): boolean {
    if (this.#deadlineAt === undefined) return false;
    const reserve = Math.max(MIN_ANSWER_RESERVE_MS, Math.min(this.#longestStepMs, (this.options.turnTimeoutMs ?? Infinity) / 2));
    return now + reserve >= this.#deadlineAt;
  }

  get progressing(): boolean { return this.#consecutiveStallingSteps < STALL_LIMIT; }

  grantRecoveryStep(stepIndex: number): void { this.#granted = Math.max(this.#granted, stepIndex + 1); }

  remainingAfter(stepIndex: number): number { return Math.max(0, this.#granted - stepIndex); }

  grantClosingStep(stepIndex: number, now = Date.now()): boolean {
    if (this.#verificationStepGranted || this.#outOfTime(now)) return false;
    this.#verificationStepGranted = true;
    this.#raise(stepIndex + 2);
    return this.#granted >= stepIndex + 2;
  }

  reserveClosingStep(stepIndex: number, now = Date.now()): boolean {
    if (this.#outOfTime(now)) return false;
    this.#raise(stepIndex + 1);
    return this.#granted >= stepIndex + 1;
  }

  recordPlanningStep(durationMs?: number, changed = true): void {
    if (durationMs !== undefined && durationMs > this.#longestStepMs) this.#longestStepMs = durationMs;
    if (!changed) { this.#consecutiveStallingSteps += 1; return; }
    this.#raise(this.#granted + 1);
  }

  recordRejectedStep(durationMs?: number): void {
    if (durationMs !== undefined && durationMs > this.#longestStepMs) this.#longestStepMs = durationMs;
    this.#raise(this.#granted + 1);
  }

  recordRefusedStep(durationMs?: number): void {
    this.#consecutiveRefusedSteps += 1;
    if (this.#consecutiveRefusedSteps <= REFUSAL_LIMIT) { this.recordRejectedStep(durationMs); return; }
    if (durationMs !== undefined && durationMs > this.#longestStepMs) this.#longestStepMs = durationMs;
    this.#consecutiveStallingSteps += 1;
  }

  grantFinalAnswerStep(now = Date.now()): boolean {
    if (this.#finalAnswerStepGranted || this.#outOfTime(now)) return false;
    this.#finalAnswerStepGranted = true;
    this.#granted += 1;
    return true;
  }

  grantResponseRecovery(stepIndex: number, finalBudgetStep: boolean, now = Date.now()): boolean {
    if (finalBudgetStep) return this.grantFinalAnswerStep(now);
    if (this.#finalAnswerStepGranted || this.#outOfTime(now)) return false;
    this.#finalAnswerStepGranted = true;
    this.#raise(this.#granted + 1);
    return stepIndex < this.#granted;
  }

  #raise(to: number): void {
    this.#granted = Math.max(this.#granted, Math.min(to, this.ceiling));
  }

  recordStepOutcome(stepIndex: number, progressed: boolean, durationMs?: number): void {
    if (durationMs !== undefined && durationMs > this.#longestStepMs) this.#longestStepMs = durationMs;
    if (!progressed) {
      this.#consecutiveStallingSteps += 1;
      return;
    }
    this.#consecutiveStallingSteps = 0;
    this.#consecutiveRefusedSteps = 0;
    if (this.#granted >= this.ceiling || this.remainingAfter(stepIndex) > EXTENSION_WINDOW) return;
    this.#raise(this.#granted + Math.max(1, this.options.stepBudgetExtension));
  }

  budgetNotice(stepIndex: number): string | undefined {
    const clauses = [this.#stallClause(), this.#allowanceClause(stepIndex)].filter((clause) => clause !== undefined);
    return clauses.length > 0 ? clauses.join(" ") : undefined;
  }

  #stallClause(): string | undefined {
    const stalls = this.#consecutiveStallingSteps;
    if (stalls < 2) return undefined;
    const scope = stalls === 1 ? "The last step returned" : `The last ${stalls} steps returned`;
    return `${scope} only observations this turn already had. Repeating those calls cannot add anything:`
      + " gather something you genuinely do not have yet, or answer now with what you have.";
  }

  #allowanceClause(stepIndex: number): string | undefined {
    const remaining = this.remainingAfter(stepIndex);
    if (remaining > EXTENSION_WINDOW) return undefined;
    const atCeiling = this.#granted >= this.ceiling;
    if (!atCeiling && this.#consecutiveStallingSteps < STALL_LIMIT) return undefined;
    const reason = atCeiling
      ? "this turn has reached its hard step ceiling"
      : "an allowance only grows on steps that observe something new";
    return `You have ${remaining} tool-calling step(s) left for this turn and ${reason}.`
      + " Spend them on the single most valuable remaining call, then answer with what you have and state"
      + " explicitly what is still unverified.";
  }
}
