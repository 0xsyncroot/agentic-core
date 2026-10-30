import { AgenticError } from "@0xsyncroot/contracts";
import { StepBudget } from "./step-budget.js";
import { stepBudgetNotice } from "./step-budget-notice.js";
import { STEP_RETRIES } from "./step-failure-recovery.js";
import { CLOSING_STEP_OBJECTION } from "./turn-output-review.js";
import type {
  BatchFacts, Objections, StepFacts, StepOutcomeFacts, StepRecord, TurnDecision, TurnEnd, TurnEndBounds, TurnLedger, TurnNext,
} from "./turn-end-facts.js";

/**
 * How a turn ends: one owner for every rule that decides whether another model step runs, whether it may call tools, and
 * how the turn ends. Pure: no clock, no I/O. Time never makes a step final: how long a turn may stay silent is the
 * silence watch's bound (`claimed-turn.ts`), which ends the turn from outside the loop.
 *
 * The loop asks `decide()` once per step, when the step is done, with what the step did; it returns the turn's next
 * ledger and what follows: a step that may call tools, a closing step, or the end. A closing step is the turn's one way to
 * stop on purpose: it offers only the tools that ask the user, and its answer is the turn's partial answer. A review that
 * asks mid-way for the read-back step (`askReadBack`) gets the answer `decide()` reaches for the same step; one that hears an
 * objection weighs it against the turn's objections so far (`objectionsHeard`), which `decide()` counts.
 */

/** The stop cause of a closing step the work-remains gate asked for. */
export const WORK_REMAINS_CLOSING = "work-remains-unmoved";
/** Why a turn with no step left and no outcome fails. */
export const NO_TERMINAL_OUTCOME = "no-terminal-outcome";

/**
 * Objections the runtime sends back with no new evidence of its own between them; the next one ends the work. After one
 * objection the next lap mostly brings something new, so one reminder is always worth it
 * (docs/incidents/2026-10-08-core-work-remains-bound.md); three is the bound Claude Code's Stop hook uses for the same question
 * (three blocks in a row, then a forced stop).
 */
const MAX_OBJECTIONS = 3;
/**
 * Of those, how many a policy's own objection may follow before it ends on its fallback: the second objection hands the model
 * that fallback as guidance, so the third has already been answered with the way out. The work-remains gate never hands it
 * over, and its objections take the full bound.
 */
const OBJECTIONS_BEFORE_FALLBACK = 2;

/** The one spelling of a failed step's cause: on the closing step it orders, and on the product's sentence after it. */
const stepFailure = (code: string): string => `step-failure:${code}`;

/**
 * The ledger a turn (or a resumed turn) starts with, and how its first step is offered. `spent`: what the tool coordinator
 * counted before the first step, where a resumed turn ran the call it resumed.
 */
export function openTurn(bounds: TurnEndBounds, startStepIndex: number, spent: { readonly toolCalls: number; readonly wrote: boolean }): TurnDecision {
  const budget = new StepBudget(bounds, startStepIndex);
  const ledger: TurnLedger = {
    allowance: budget.state, failures: 0, toolCalls: spent.toolCalls, wrote: spent.wrote, readBack: false, reasked: false, objections: 0,
  };
  return { ledger, next: offer(budget, startStepIndex, ledger, bounds) };
}

/**
 * What follows a step, given what it did. Every end of the turn is decided here, and every change to the ledger but the one
 * `stepRan()` makes once the step is over.
 */
export function decide(ledger: TurnLedger, facts: StepFacts, bounds: TurnEndBounds): TurnDecision {
  const budget = settled(ledger, facts, bounds);
  const step = facts.stepIndex;
  const outcome = facts.outcome;
  let { closing, failures, reasked } = ledger;
  let { heard: objections, objectedAnswer } = objectionsHeard(ledger, facts);
  const decided = (next?: TurnNext): TurnDecision => {
    const after: TurnLedger = { allowance: budget.state, ...(closing !== undefined ? { closing } : {}), failures, reasked, objections,
      ...(objectedAnswer !== undefined ? { objectedAnswer } : {}), toolCalls: ledger.toolCalls + facts.countedCalls,
      wrote: ledger.wrote || facts.wrote, readBack: ledger.readBack || facts.readBack === true };
    return { ledger: after, next: next ?? offer(budget, step + 1, after, bounds) };
  };
  switch (outcome.kind) {
    case "interjected": budget.recordInterjection(step); break;
    case "tools": break;
    case "objection":
      if (outcome.ended) {
        return decided({ kind: "end", by: "fallback", outcome: "partial", reason: "turn-control-fallback", ask: outcome.workRemains && workLeft(facts, false) });
      }
      budget.recordRejectedStep();
      objections += 1;
      if (outcome.workRemains && outcome.phase === "terminal") objectedAnswer = outcome.answer;
      break;
    // The gate reviews only a step that may call tools, and `offer()` leaves such a step a step after it: its closing step
    // needs no room of its own.
    case "close": closing ??= WORK_REMAINS_CLOSING; break;
    case "answer":
      // Asked once more, once per turn: a silent answer, or a closing step's answer that reached for a tool. A closing step's
      // re-ask is a closing step again, past the ceiling if need be; any other is an ordinary step.
      if ((outcome.silent || outcome.calledATool) && !reasked) {
        reasked = true;
        budget.grant(budget.granted + 1, facts.finalReason !== undefined);
        if (facts.finalReason !== undefined || step < budget.granted) break;
      }
      return decided(answerEnd(facts, outcome));
    case "failed":
      // A failed step is retried once, then the next step closes the turn with what was done, then the product's sentence ends
      // it. The retry and the closing step run past the allowance and its ceiling if need be.
      if (!outcome.recoverable) return decided({ kind: "end", by: "failure", outcome: "failed", reason: outcome.code });
      failures += 1;
      if (failures > STEP_RETRIES + 1) return decided({ kind: "end", by: "fallback", outcome: "partial", reason: stepFailure(outcome.code), ask: false });
      if (failures > STEP_RETRIES) closing = stepFailure(outcome.code);
      budget.grant(step + 1, true);
      break;
  }
  return decided();
}

/**
 * A step that ran to its end clears the run of failures: two failures thirty steps apart must not end a turn that recovered
 * from the first. Applied once the step is over, not when `decide()` answers it: a step whose last write fails after that
 * answer failed, and counts as the next failure of the run. A run long enough to order a closing step stays: its next
 * failure ends the turn.
 */
export function stepRan(ledger: TurnLedger): TurnLedger {
  return ledger.failures > 0 && ledger.failures <= STEP_RETRIES ? { ...ledger, failures: 0 } : ledger;
}

/**
 * The step's record with its completed batch. `decide()` counts the batch before the read-back step a review asked for, the
 * order the loop runs them in; a review that asked before the batch was answered on an allowance `decide()` would not reach,
 * so that order fails the step instead of deciding it on two different ledgers.
 */
export function recordedBatch(record: StepRecord, batch: BatchFacts): StepRecord {
  if (record.readBack) throw new AgenticError("permanent", "A step's batch completed after a review asked for a step");
  return { ...record, batch };
}

/**
 * The read-back step: one more tool-calling step, once per turn, to confirm a write that has already succeeded. Out of
 * allowance, a turn answers with what it has — right for work in progress, wrong when the write is done and only the read-back
 * is missing: "your data may or may not have changed" is worse than either answer. With no write there is nothing to confirm,
 * and nothing is asked. The allowance edge moves past the bought step and the closing step after it, bounded by the ceiling.
 * Returns the record carrying the ask, which `decide()` applies, and whether the bought step can call a tool. Once per turn
 * holds within a step too: a second ask in the step that already asked buys nothing.
 */
export function askReadBack(ledger: TurnLedger, record: StepRecord, bounds: TurnEndBounds): { readonly record: StepRecord; readonly granted: boolean } | undefined {
  if (ledger.readBack || record.readBack || !ledger.wrote) return undefined;
  const asked: StepRecord = { ...record, readBack: true };
  return { record: asked, granted: settled(ledger, asked, bounds).granted >= record.stepIndex + 2 };
}

/**
 * The objections a review weighs a new one against. A step's own new results count from the moment they arrive: the policy's
 * reads before the model, then the step's batch for an answer reviewed after it. Only the runtime's evidence resets the
 * count; any new result, the model's included, means the objected answer may now change. So does a work call that reached its
 * tool and failed: the model acted on the objection, and the failure is evidence the next answer may use, so that answer is
 * reviewed afresh instead of closing the work as unmoved; the count still bounds the laps.
 */
export function objectionsHeard(ledger: TurnLedger, record: StepRecord, after?: { readonly bounds: TurnEndBounds; readonly countedCalls: number }): Objections {
  const heard = record.runtimeEvidence ? 0 : ledger.objections;
  const objectedAnswer = record.runtimeEvidence || record.batch?.progressed || record.batch?.workDispatched ? undefined : ledger.objectedAnswer;
  return { heard, fallbackDue: heard >= OBJECTIONS_BEFORE_FALLBACK, spent: heard >= MAX_OBJECTIONS, ...(objectedAnswer !== undefined ? { objectedAnswer } : {}),
    ...(after && sentBackToNoTools(ledger, record, after.bounds, after.countedCalls) ? { noToolStepAfter: true as const } : {}) };
}

/** Whether the step `decide()` offers after an objection to this one may not call tools: a closing step, or none at all. */
function sentBackToNoTools(ledger: TurnLedger, record: StepRecord, bounds: TurnEndBounds, countedCalls: number): boolean {
  const budget = settled(ledger, record, bounds);
  budget.recordRejectedStep();
  return offer(budget, record.stepIndex + 1, { ...ledger, toolCalls: ledger.toolCalls + countedCalls }, bounds).kind !== "continue";
}

/** Whether an interjection that arrived while the model ran can still have a step of its own; otherwise it stays queued. */
export function interjectionFits(ledger: TurnLedger, bounds: TurnEndBounds, stepIndex: number): boolean {
  return StepBudget.restore(bounds, ledger.allowance).canApplyInterjection(stepIndex);
}

/** The step closes the turn, and so would every step after it: no step can be bought to act on an objection. */
export function closesTurn(ledger: TurnLedger): boolean { return ledger.closing !== undefined; }

/** The note telling the model it is circling or short of steps, when either holds. */
export function budgetNotice(ledger: TurnLedger, bounds: TurnEndBounds, stepIndex: number): string | undefined {
  return stepBudgetNotice(StepBudget.restore(bounds, ledger.allowance), stepIndex);
}

/** The allowance after what the step did before its outcome: its batch, then the read-back step a review asked for. */
function settled(ledger: TurnLedger, record: StepRecord, bounds: TurnEndBounds): StepBudget {
  const budget = StepBudget.restore(bounds, ledger.allowance);
  const batch = record.batch;
  if (batch?.planningOnly) budget.recordPlanningStep(batch.planChanged);
  // A call to a tool the step lacked is refused like a mislabelled one: refunded three times in a row, then a stall.
  else if (batch && (batch.unavailableOnly || batch.refusedOnly)) budget.recordRefusedStep();
  else if (batch) budget.recordStepOutcome(record.stepIndex, batch.progressed);
  // The step after this one must be able to call a tool, and a step at the allowance edge may not. Hence two, not one.
  if (record.readBack) budget.grant(record.stepIndex + 2);
  return budget;
}

/**
 * How the next step is offered. A closing step keeps the cause that ordered it; otherwise the tool-call ceiling — reached, it
 * binds whether or not the work still progresses — then the allowance edge make the step a closing step.
 */
function offer(budget: StepBudget, next: number, ledger: TurnLedger, bounds: TurnEndBounds): TurnNext {
  // Bounded by the granted allowance, not the ceiling: a rejected turn must not spend its remaining steps on toolless final steps.
  if (next > budget.granted) return { kind: "end", by: "failure", outcome: "failed", reason: NO_TERMINAL_OUTCOME };
  if (ledger.closing !== undefined) return { kind: "closing", reason: ledger.closing };
  if (ledger.toolCalls >= bounds.maxToolCalls) return { kind: "closing", reason: "tool-call-limit" };
  if (next >= budget.granted) return { kind: "closing", reason: budget.limitReason(next) };
  return { kind: "continue" };
}

/**
 * How an answer ends the turn. The step that had to answer, or reached for a tool there, is a resource stop. A partial end
 * asks whether to go on only when work is left (`workLeft`), and never on a partial the policy accepted on its own reason:
 * that is the policy's proof the rest cannot go on in this turn (a proven blocker, a connection that is gone), and its
 * notice says so. How many objections came before the end does not decide it: a turn whose every sub-goal the results show
 * done ends without the question, however its last answer was reviewed.
 */
function answerEnd(facts: StepFacts, answer: Extract<StepOutcomeFacts, { kind: "answer" }>): TurnEnd {
  const finalReason = facts.finalReason;
  const resourceStop = finalReason !== undefined || answer.calledATool;
  const outcome = resourceStop || !answer.completed || answer.accepted?.outcome === "partial" ? "partial" : "completed";
  // Work the gate found stalled is closed on its own step, but no safety limit stopped it: it ends as the plain `partial`.
  const workClosing = finalReason === WORK_REMAINS_CLOSING;
  const decision = resourceStop && !workClosing ? "budget-reached" : outcome === "partial" ? "partial" : "finish";
  const reason = resourceStop ? finalReason : answer.silent ? "empty-response" : undefined;
  const ask = outcome === "partial" && !policyPartial(answer.accepted) && workLeft(facts, decision === "budget-reached");
  return { kind: "end", by: "answer", outcome, decision, ask, ...(reason !== undefined ? { reason } : {}) };
}

/**
 * Whether work is left that the user can send on with "continue". With a plan, that is a sub-goal its attributed results do
 * not show done (`subGoalsUndone`, the sub-goal ledger), which outweighs every other sign. Without one the ledger shows
 * nothing either way, and only a runtime bound is evidence of work left (`endShowsWork`): the allowance, the tool-call
 * ceiling, a stalled lap, the closing step a failed step ordered, or the final step reaching for a tool cut the work. A work-remains objection is no such evidence:
 * a product may send a figure-only finding as "work remains", so the gate's own end (its closing step, its accept, the
 * fallback after spent objections) asks only through an undone sub-goal. A silent or cut-short answer is a partial end like
 * any other: it asks when a sub-goal is undone, and without a plan only when a bound cut it.
 */
function workLeft(facts: StepFacts, endShowsWork: boolean): boolean {
  return facts.subGoalsUndone ?? endShowsWork;
}

/** The policy accepted a partial answer on a reason of its own, not one the runtime writes when it ends the work itself. */
function policyPartial(accepted: Extract<StepOutcomeFacts, { kind: "answer" }>["accepted"]): boolean {
  const runtimeEnded = accepted?.reason?.startsWith("work-remains-") === true || accepted?.reason === CLOSING_STEP_OBJECTION;
  return accepted?.outcome === "partial" && !runtimeEnded;
}
