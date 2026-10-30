import { AgenticError } from "@0xsyncroot/contracts";
import { recoverable } from "./legacy-sources/step-failure-recovery.js";
import { LegacyTurnEndModel, type LegacyVariant } from "./legacy-turn-end-model.js";
import { replayRun, type Explain } from "./replay-report.js";
import type { CallFacts } from "./step-facts.js";

/**
 * Named causes for a run whose decisions first differ from the journal at step k. Each cause is checked, never assumed: a
 * rule the turn-end code changed after the run started (the run's `codeAge` says it ran older code, and the older rule
 * gets past step k), or a fact the journal does not hold. A divergence no cause covers stays "unexplained from step k"; an
 * older rule that gets past k but diverges again at k' is reported with k' (`later`).
 */
type Explanation = Explain;

/**
 * Rank of a turn-end commit counted back from the replicated one (583c295 is 1): a run whose `codeAge` reaches the rank
 * started before that commit, so it ran the rules the commit replaced.
 */
const RANK = { c3e7697: 11, c9eec11: 12 } as const;

/** The work-remains gate's bound on objections without new evidence (work-remains-gate.ts:17 @583c295, replica). */
const MAX_STALLED_WORK_LAPS = 3;

const succeeded = (call: CallFacts) => call.dispatched === true && call.state === "succeeded";

/**
 * Batch accounting before c9eec11 (REPLICA of step-disposition.ts and tool-batch-executor.ts at c9eec11~1): a step whose
 * dispatched calls were all plan updates was refunded whatever else it called; a step of unoffered calls was refunded without
 * bound; a refused call was an ordinary step without progress.
 */
const beforeC9eec11: LegacyVariant = {
  recordBatch: (budget, stepIndex, batch, calls, durationMs) => {
    const dispatched = calls.filter((call) => !call.skipped && succeeded(call));
    if (dispatched.length > 0 && dispatched.every((call) => call.plan)) budget.recordPlanningStep(durationMs, true);
    else if (batch.unavailableOnly) budget.recordRejectedStep(durationMs);
    else budget.recordStepOutcome(stepIndex, batch.progressed, durationMs);
  },
};

/** Batch accounting from c9eec11 to c3e7697 (REPLICA at c9eec11): as before, plus refused steps refunded three in a row. */
const beforeC3e7697: LegacyVariant = {
  recordBatch: (budget, stepIndex, batch, calls, durationMs) => {
    const dispatched = calls.filter((call) => !call.skipped && succeeded(call));
    if (dispatched.length > 0 && dispatched.every((call) => call.plan)) budget.recordPlanningStep(durationMs, true);
    else if (batch.unavailableOnly) budget.recordRejectedStep(durationMs);
    else if (batch.refusedOnly) budget.recordRefusedStep(durationMs);
    else budget.recordStepOutcome(stepIndex, batch.progressed, durationMs);
  },
};

/** The run ran older batch accounting, and replayed with it the run gets past step k. */
const olderAccounting: Explanation = async (run, verdict, fixture) => {
  const era = run.codeAge >= RANK.c9eec11 ? { variant: beforeC9eec11, cause: "batch-accounting-before-c9eec11" }
    : run.codeAge >= RANK.c3e7697 ? { variant: beforeC3e7697, cause: "batch-accounting-before-c3e7697" } : undefined;
  if (!era) return undefined;
  const older = await replayRun(new LegacyTurnEndModel(era.variant), run, fixture);
  if (older.outcome === "reproduced") return { cause: era.cause };
  return (older.k ?? 0) > (verdict.k ?? 0) ? { cause: era.cause, later: { k: older.k!, differs: older.differs ?? [] } } : undefined;
};

/** Before c3e7697 the gate's closing step ended the turn as `budget-reached`; it is `partial` since. */
const workClosingDecision: Explanation = async (run, verdict) => {
  const recorded = verdict.recorded?.next;
  const decided = verdict.decided?.next;
  return run.codeAge >= RANK.c3e7697 && recorded?.kind === "end" && decided?.kind === "end" && recorded.reason === "work-remains-unmoved"
    && recorded.decision === "budget-reached" && decided.decision === "partial" && verdict.differs?.join() === "next"
    ? { cause: "work-closing-decision-before-c3e7697" } : undefined;
};

/**
 * Before c9eec11 the gate counted only objections since any new evidence; since, three objections with no new evidence from
 * the runtime's own reads also end the work. Checked on the facts: at least three such objections came before step k.
 */
const objectionBound: Explanation = async (run, verdict) => {
  if (run.codeAge < RANK.c9eec11 || verdict.recorded?.review?.decision !== "continue" || verdict.decided?.review?.decision !== "close") return undefined;
  let objections = 0;
  for (const step of run.steps) {
    if (step.i >= (verdict.k ?? 0)) break;
    if ((step.reads ?? []).some((read) => succeeded(read) && read.gain === "new")) objections = 0;
    objections += (step.reviews ?? []).filter((review) => review.phase === "terminal" && review.decision === "continue" && review.workRemains).length;
  }
  return objections >= MAX_STALLED_WORK_LAPS ? { cause: "objection-bound-before-c9eec11" } : undefined;
};

/**
 * A step failed with a code the loop retries, yet the turn failed: the loop does that only when the turn's signal was aborted,
 * and the journal does not record the signal.
 */
const abortedSignal: Explanation = async (_run, verdict) => {
  const recorded = verdict.recorded?.next;
  if (recorded?.kind !== "failed" || verdict.decided?.next.kind !== "continue") return undefined;
  return recoverable(new AgenticError(recorded.code as never, "replayed"), new AbortController().signal) ? { cause: "turn-signal-not-journaled" } : undefined;
};

/** The step's output broke the policy's tool choice: the directive that decides it is not journaled. */
const directiveNotJournaled: Explanation = async (run, verdict) =>
  run.steps.some((step) => step.i === verdict.k && (step.reviews ?? []).some((review) => review.phase === "choice-violation"))
    ? { cause: "directive-not-journaled" } : undefined;

export const LEGACY_EXPLANATIONS: readonly Explanation[] = [directiveNotJournaled, workClosingDecision, objectionBound, abortedSignal, olderAccounting];

/**
 * The current rules' numeric step ceiling made the step final where the recorded code's allowance had no ceiling and still
 * offered tools: the decided step is final with `step-limit` where the journal shows a tool step.
 */
const stepCeiling: Explanation = async (_run, verdict) => verdict.recorded?.mode === "tools" && verdict.decided?.mode === "final"
  && verdict.decided.reason === "step-limit" ? { cause: "numeric-step-ceiling" } : undefined;

/** The causes for the current rules' report: a bound they add, then every cause of the legacy rules. */
export const CURRENT_EXPLANATIONS: readonly Explanation[] = [stepCeiling, ...LEGACY_EXPLANATIONS];
