import { askReadBack, decide, recordedBatch, stepRan } from "./turn-end.js";
import type { TurnControlState } from "@0xsyncroot/contracts";
import type { BatchFacts, StepOutcomeFacts, TurnNext } from "./turn-end-facts.js";
import type { PolicyReads } from "./turn-observations.js";
import type { TurnLoop } from "./turn-step-loop-input.js";

/**
 * The loop's side of `turn-end.ts`: it records what the step under way did, and keeps each answer of `decide()` on the
 * loop. Every rule stays in `turn-end.ts`.
 */

/** The policy's reads before the model: a new result among them is the runtime's own evidence, which the step's `decide()` counts. */
export function recordReads(loop: TurnLoop, reads: PolicyReads): TurnControlState {
  if (reads.progressed) loop.step = { ...(loop.step ?? { stepIndex: reads.state.stepIndex }), runtimeEvidence: true };
  return reads.state;
}

/** The step's completed batch; its `decide()` counts it. */
export function recordBatch(loop: TurnLoop, stepIndex: number, batch: BatchFacts): void {
  loop.step = recordedBatch(loop.step ?? { stepIndex }, batch);
}

/** A review asks for the read-back step mid-way: answered now, and recorded so the step's `decide()` applies the same ask. */
export function readBackStep(loop: TurnLoop, stepIndex: number): boolean {
  const asked = askReadBack(loop.ledger, loop.step ?? { stepIndex }, loop.bounds);
  if (!asked) return false;
  loop.step = asked.record;
  return asked.granted;
}

/**
 * Asks `decide()` what follows the step, with what it did and what the tool coordinator counted while it ran; keeps the new
 * ledger and the answer on the loop.
 */
export function decideStep(loop: TurnLoop, stepIndex: number, outcome: StepOutcomeFacts): TurnNext {
  const { coordinator, subGoals, planLedger } = loop.setup;
  const undone = subGoals.undone(planLedger.currentPlan);
  const { ledger, next } = decide(loop.ledger, {
    ...(loop.step ?? { stepIndex }), outcome, countedCalls: coordinator.toolCalls - loop.ledger.toolCalls, wrote: coordinator.wrote,
    ...(undone !== undefined ? { subGoalsUndone: undone } : {}),
  }, loop.bounds);
  loop.ledger = ledger;
  loop.next = next;
  loop.step = undefined;
  return next;
}

/** The step returned without ending the turn: every write it made is done, and `stepRan()` clears the run of failures. */
export function stepEnded(loop: TurnLoop): void {
  loop.ledger = stepRan(loop.ledger);
}
