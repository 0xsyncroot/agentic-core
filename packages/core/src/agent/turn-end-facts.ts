import type { StepAllowance, StepBudgetOptions } from "./step-budget.js";

/**
 * What `turn-end.ts` decides on and answers with: the composition's bounds, the ledger a turn carries from step to step, what
 * a step did, and what follows it.
 */

/**
 * The composition's bounds: the step allowance with its numeric ceiling, and the tool-call ceiling — one fixed number the
 * tool coordinator also enforces inside a step as it counts the calls.
 */
export type TurnEndBounds = StepBudgetOptions & { readonly maxToolCalls: number };

/** What the turn has spent, carried from step to step. */
export interface TurnLedger {
  readonly allowance: StepAllowance;
  /**
   * The cause every later step closes the turn with: the work-remains gate closed the work, or a step failed again after its
   * retry (`step-failure:<code>`, which replaces the gate's cause).
   */
  readonly closing?: string;
  /** Failed steps since the last step that ran to its end. */
  readonly failures: number;
  /** Calls the tool coordinator counted against the tool-call ceiling. */
  readonly toolCalls: number;
  /** A call whose tool declares a side effect has succeeded in this turn, the resumed call included. */
  readonly wrote: boolean;
  /** A review asked for the read-back step (`askReadBack`): once per turn. */
  readonly readBack: boolean;
  /** An answer was asked again (`decide()`, kind `answer`): once per turn. */
  readonly reasked: boolean;
  /**
   * Objections the runtime sent back since it last brought new evidence itself: a read the policy asked for returned a new
   * result. The model's own new results never reset it: they prove nothing about an answer converging, and resetting on them
   * sent complete answers back 9 to 12 times (docs/incidents/2026-10-11-core-reconciliation-laps.md).
   */
  readonly objections: number;
  /**
   * The answer (content hash) the last "work remains" objection to a terminal answer was raised against, until any new result
   * or any work call that reached its tool after it.
   */
  readonly objectedAnswer?: string;
}

/** A completed batch of the model's calls, as the batch executor classified it. */
export interface BatchFacts {
  readonly progressed: boolean;
  readonly planningOnly: boolean;
  readonly planChanged: boolean;
  readonly unavailableOnly: boolean;
  readonly refusedOnly: boolean;
  /** A work call reached its tool, succeeded or failed. */
  readonly workDispatched: boolean;
}

/** What a step did before its outcome. Kept while the step runs, so a step that fails part-way still counts it. */
export interface StepRecord {
  readonly stepIndex: number;
  /** The step was a closing step (no tools but the ask tools), and why. */
  readonly finalReason?: string;
  readonly batch?: BatchFacts;
  /** A review asked for the read-back step while the step ran (`askReadBack`). */
  readonly readBack?: true;
  /** A read the policy asked for before the model returned a new result: the runtime's own evidence. */
  readonly runtimeEvidence?: true;
}

export type StepOutcomeFacts =
  /** The user's interjection arrived while the model ran: the step gave way to it. */
  | { readonly kind: "interjected" }
  /** The step's calls ran and the step ended. */
  | { readonly kind: "tools" }
  /**
   * The policy objected. `ended`: its review found the objections spent and ended on its fallback. `answer`: the objected
   * terminal answer's content hash.
   */
  | {
      readonly kind: "objection"; readonly ended: boolean; readonly workRemains: boolean;
      readonly phase: "terminal" | "tool-call" | "choice-violation"; readonly answer?: string;
    }
  /** The work-remains gate closed the work: the next step is its closing step. */
  | { readonly kind: "close" }
  /**
   * An accepted answer, or a final step that said nothing or reached for a tool. `completed`: the model finished its reply
   * (not cut short, blocked or of unknown status).
   */
  | {
      readonly kind: "answer"; readonly silent: boolean; readonly calledATool: boolean; readonly completed: boolean;
      readonly accepted?: { readonly outcome?: string; readonly reason?: string };
    }
  /** The step threw. `recoverable`: neither a decision (cancel, denial, conflict) nor an aborted turn. */
  | { readonly kind: "failed"; readonly code: string; readonly recoverable: boolean };

export interface StepFacts extends StepRecord {
  readonly outcome: StepOutcomeFacts;
  /** Calls the tool coordinator counted against the ceiling while the step ran: the policy's reads and the model's batch. */
  readonly countedCalls: number;
  /** A call whose tool declares a side effect has succeeded in this turn, as the coordinator knows at the step's end. */
  readonly wrote: boolean;
  /**
   * The plan this operation owns holds a sub-goal its attributed results do not show done (`SubGoalLedger.undone`), as the
   * step leaves it; absent when the operation owns no plan.
   */
  readonly subGoalsUndone?: boolean;
}

export type TurnNext =
  /** The next step may call tools. */
  | { readonly kind: "continue" }
  /** The next step is a closing step: it may only answer or ask the user, and its answer ends the turn as partial. */
  | { readonly kind: "closing"; readonly reason: string }
  | TurnEnd;

export type TurnEnd =
  /** The step's answer ends the turn. `ask`: it ended partial with work left (`turn-end.ts`), so the user is asked whether to go on. */
  | {
      readonly kind: "end"; readonly by: "answer"; readonly outcome: "completed" | "partial";
      readonly decision: "finish" | "partial" | "budget-reached"; readonly reason?: string; readonly ask: boolean;
    }
  /** The runtime's own sentence ends it: the policy's fallback after ignored objections, or the product's after a failed retry. */
  | { readonly kind: "end"; readonly by: "fallback"; readonly outcome: "partial"; readonly reason: string; readonly ask: boolean }
  /** The turn fails: a failure no retry may answer, or no step left and no outcome. */
  | { readonly kind: "end"; readonly by: "failure"; readonly outcome: "failed"; readonly reason: string };

export interface TurnDecision {
  readonly ledger: TurnLedger;
  readonly next: TurnNext;
}

/** Where the turn stands on objections when a review hears one, after what the step under way brought so far. */
export interface Objections {
  /** Objections sent back since the runtime last brought new evidence itself. */
  readonly heard: number;
  /** A policy's own objection ends on its fallback now: the last one sent back already carried it as guidance. */
  readonly fallbackDue: boolean;
  /** As many as the runtime sends back: a "work remains" objection ends the work now, on the gate's closing step. */
  readonly spent: boolean;
  /** The answer the last "work remains" objection to a terminal answer was raised against, while no new result has come since. */
  readonly objectedAnswer?: string;
  /** Sent back now, the step would be followed by none that may call tools (the allowance edge, the tool-call ceiling, a closing order). */
  readonly noToolStepAfter?: true;
}
