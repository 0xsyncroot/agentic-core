import type { ReplayOptions, RunFacts, StepFacts } from "./step-facts.js";

/**
 * The seam the turn-end replay compares implementations through: recorded step facts in, the decision the turn-end logic
 * makes at each step out. The legacy logic and any replacement implement it; the driver and the fixture stay the same.
 */
export interface TurnEndModel {
  readonly name: string;
  /** Opens one run with the composition's bounds; the session then sees the run's steps in order. */
  start(run: RunFacts, options: ReplayOptions): TurnEndSession;
}

export interface TurnEndSession {
  /** Decides how this step is offered and what follows it, given what the step recorded. */
  step(facts: StepFacts): Promise<StepDecision>;
}

/**
 * What the turn-end logic made of one step.
 *
 * `mode`: whether the step could call tools or had to answer (a final step), with the stop cause a final step carries.
 * `review`: the verdict on the step's output when the policy reviewed it. `next`: what the step leads to.
 */
export interface StepDecision {
  readonly step: number;
  readonly mode: "tools" | "final" | "none";
  readonly reason?: string;
  readonly review?: ReviewVerdict;
  readonly next: Next;
  readonly ledger: Ledger;
}

/** The verdict as the journal would record it: the decision, plus the reason a core-written accept or close carries. */
export interface ReviewVerdict {
  readonly decision: "accept" | "continue" | "close" | "fallback" | "stop" | "unknown";
  readonly reason?: string;
}

export type Next =
  | { readonly kind: "continue" }
  /** The work-remains gate closed the work: the next step is a final step with that cause. */
  | { readonly kind: "close"; readonly reason: string }
  | { readonly kind: "pause" }
  | { readonly kind: "end"; readonly status: string; readonly reason?: string; readonly decision?: string }
  | { readonly kind: "failed"; readonly code: string };

/** The model's own accounting after the step, for reading a divergence; never compared. */
export interface Ledger {
  readonly granted: number;
  readonly progressing: boolean;
  readonly toolCalls: number;
  readonly toolCallCeiling: number;
}
