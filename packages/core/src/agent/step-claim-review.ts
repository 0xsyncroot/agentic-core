import type { JsonValue, JudgmentQuestion, ToolCall, TurnJudge, WorkPlan } from "@0xsyncroot/contracts";
import type { JudgmentSeamMode } from "./observation-review.js";

/**
 * Whether the evidence shows a plan step done when the agent marks it completed — for any tool.
 *
 * An agent that marks a step completed before it has seen the outcome reports work that did not
 * happen — a deletion reported while its confirmation dialog still waits — and the next step is
 * planned on it. The judge reads the step and the turn's latest results and places the
 * evidence on three ordered levels; the runtime notes, beside the plan update, a step whose
 * outcome the evidence clearly does not show. The note asks for a check; nothing is refused.
 *
 * The rule "the top level at most 0.05" separates unshown steps from shown ones; a yes/no (noul)
 * question also flags shown steps that the middle level keeps as uncertain
 * (docs/incidents/2026-10-10-core-step-claim-review.md).
 */
export const STEP_CLAIM_QUESTION: JudgmentQuestion = Object.freeze({
  type: "score",
  instructions: "In the state, how directly does the evidence show that the step was done?",
  criteria: [
    "The evidence does not show the step done: it shows another state, an error, an unfinished action or nothing about it.",
    "The evidence suggests the step but does not show its outcome.",
    "The evidence shows the outcome of the step.",
  ],
}) as JudgmentQuestion;

const SHOWN_AT_MOST = 0.05;
const EVIDENCE = 6;
const RESULT_CHARS = 4_000;
const STEPS = 3;

const text = (value: JsonValue | undefined): string => value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);

/** Steps a plan update turns completed that were not completed before it. */
export function newlyCompleted(before: WorkPlan | undefined, after: WorkPlan | undefined): readonly { readonly id: string; readonly description: string }[] {
  const was = new Map((before?.steps ?? []).map((step) => [step.id, step.status]));
  return (after?.steps ?? []).filter((step) => step.status === "completed" && was.get(step.id) !== "completed")
    .map((step) => ({ id: step.id, description: step.description }));
}

export class StepClaimReview {
  readonly #recent: { readonly tool: string; readonly state: string; readonly result: string }[] = [];
  // Truly private: the batch context that carries this object is frozen as data, and a frozen abort signal crashes the process.
  readonly #judge: TurnJudge;
  readonly #mode: Exclude<JudgmentSeamMode, "off">;
  readonly #request: string;
  readonly #signal: AbortSignal;
  /** Ends the shadow judgments still out when the turn's steps are over (`close`). */
  readonly #closed = new AbortController();

  constructor(judge: TurnJudge, mode: Exclude<JudgmentSeamMode, "off">, request: string, signal: AbortSignal) {
    this.#judge = judge; this.#mode = mode; this.#request = request; this.#signal = AbortSignal.any([signal, this.#closed.signal]);
  }

  /** The turn's steps are over: a shadow judgment still out is cancelled, never left to outlive the turn. */
  close(): void { this.#closed.abort(); }

  /** A non-planning call's outcome: the evidence the next completed step is read against. */
  observe(call: ToolCall, outcome: { readonly state: string; readonly dispatched: boolean; readonly result?: JsonValue; readonly error?: JsonValue }): void {
    if (!outcome.dispatched) return;
    this.#recent.push({ tool: call.name, state: outcome.state, result: text(outcome.result ?? outcome.error).slice(0, RESULT_CHARS) });
    if (this.#recent.length > EVIDENCE) this.#recent.shift();
  }

  /** The note for steps the evidence clearly does not show done; undefined in shadow or when all are shown. */
  async review(steps: readonly { readonly description: string }[]): Promise<string | undefined> {
    if (steps.length === 0 || this.#recent.length === 0) return undefined;
    const evidence = [...this.#recent].reverse();
    const asked = steps.slice(0, STEPS);
    const judging = Promise.all(asked.map((step) =>
      this.#judge("step-claim", { state: { request: this.#request, step: step.description, evidence } as unknown as JsonValue, questions: { shown: STEP_CLAIM_QUESTION } }, this.#signal)));
    // In shadow the verdict changes nothing, so the plan update does not wait for it: it is journaled when it comes, and a
    // failure is only lost data. Awaited, every completed step would pay a judgment round trip for a result thrown away.
    if (this.#mode !== "on") { judging.catch(() => undefined); return undefined; }
    const judged = await judging;
    const top = (STEP_CLAIM_QUESTION as { criteria: readonly string[] }).criteria.at(-1);
    const unshown = asked.filter((_step, index) => {
      const answer = judged[index]?.answers.shown;
      if (answer?.type !== "score") return false;
      // Levels are named by the provider's legend; the top one is found by its text, not by a key's spelling.
      const key = Object.entries(answer.legend).find(([, level]) => level === top)?.[0];
      return key !== undefined && (answer.probabilities[key] ?? 1) <= SHOWN_AT_MOST;
    });
    if (unshown.length === 0) return undefined;
    return `Runtime check: the evidence does not show ${unshown.map((step) => `"${step.description}"`).join(", ")} done yet. `
      + "Check it before relying on it — read the current state or the stored result, or finish the action (a dialog may still wait for confirmation, pages may remain to read) — and keep the step in progress until the evidence shows it.";
  }
}
