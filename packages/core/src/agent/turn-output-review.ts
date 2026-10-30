import type { LlmResponseStatus, ToolDefinition, TurnControlPolicy, TurnControlServices, TurnControlState, TurnModelDirective } from "@0xsyncroot/contracts";
import { choiceViolationFallback, toolChoiceViolation } from "./choice-violation.js";
import { validateTerminalDecision, type TurnOutputReview } from "./turn-control.js";
import type { Objections } from "./turn-end-facts.js";
import { workRemainsReview } from "./work-remains-gate.js";

/** Why a closing step's answer stands although the policy still objected to it: the runtime ended the step, not the policy. */
export const CLOSING_STEP_OBJECTION = "closing-step-objection";

/**
 * How the loop answers an objection, counted with every other objection since the runtime last brought new evidence itself
 * (`objectionsHeard`, turn-end.ts).
 *
 * First time: the objection, with the withheld answer quoted. Second time: the same, plus the policy's fallback as guidance —
 * the model writes the conservative answer itself, in context. Third time, or when no further step can be bought, the
 * fallback is delivered as is: the model has now ignored explicit guidance, and another lap would only spend budget. One
 * objection used to be enough to end the turn, and the accountant then read a canned "could not complete" under a trace of
 * work that had gone perfectly well up to that point.
 */
function objectionOutcome(input: {
  readonly objections: Objections; readonly finalBudgetStep: boolean; readonly grantClosingStep?: () => boolean;
}): { readonly escalate: boolean; readonly exhausted: boolean } {
  // Running out of allowance is not automatically the end: the first objection may still buy a
  // closing step, so the extra step is never spent on a model already ignoring guidance.
  const heard = input.objections.heard;
  const exhausted = input.objections.fallbackDue || input.finalBudgetStep && (heard >= 1 || input.grantClosingStep?.() !== true);
  return { escalate: heard === 1 && !exhausted, exhausted };
}

export async function reviewTurnOutput(input: {
  readonly policy?: TurnControlPolicy;
  readonly state: TurnControlState;
  readonly directive: TurnModelDirective;
  readonly selectedTools: readonly ToolDefinition[];
  readonly candidate: { readonly content: string | null; readonly finishReason: string; readonly status?: LlmResponseStatus;
    readonly toolCalls: readonly { readonly id: string; readonly name: string; readonly arguments: string }[] };
  readonly finalBudgetStep: boolean;
  /**
   * The step closes the turn and every step after it would too (the work-remains gate closed it, or a step failed twice):
   * no step can be bought to act on an objection. Its answer stands, as partial, with the policy's fallback as the notice.
   * A verification step granted here would have no tools: the review would send the closing answer back, and the policy's
   * fallback would then replace it.
   */
  readonly closingStep?: boolean;
  /**
   * Buys one extra tool-calling step from the loop's budget, at most once in the turn.
   *
   * Only the terminal phase reaches for it, because that is where the policy can be asking for
   * a read-after-write: the write has already happened, so ending the turn here reports that
   * the data may or may not have changed — worse for the reader than either answer. Returns
   * false when no write succeeded in the turn or the budget will not extend, and the fallback
   * answer stands as before.
   */
  readonly grantClosingStep?: () => boolean;
  /** The turn's objections so far, which this one is weighed against (`objectionsHeard`). */
  readonly objections: Objections;
  /** Names the work-plan tool, which may accompany any required call without violating the choice. */
  readonly isPlanningCall?: (name: string) => boolean;
  readonly signal: AbortSignal;
  /** Lent to the policy for this review only (the turn's judge); never part of the journaled state. */
  readonly services?: TurnControlServices;
  /**
   * The judged "same answer" (`AnswerMovedCheck.unmoved`), asked only where the work-remains gate compares the content hash: a
   * terminal answer under a "work remains" objection with no new result and no work call since the objected one. True ends the work like a repeat.
   */
  readonly answerUnmoved?: (content: string | null, objectedAnswer: string) => Promise<boolean>;
}): Promise<TurnOutputReview> {
  const violation = toolChoiceViolation(input.directive, input.selectedTools, input.candidate.toolCalls, input.isPlanningCall);
  if (violation) {
    // No policy text accompanies a choice violation, so without a fallback a model that keeps
    // disobeying the directive would loop until the loop itself fails. The fallback is always
    // set — empty when the product supplies no sentence — so the turn does end, as partial.
    const fallback = choiceViolationFallback(input.policy, input.state);
    const outcome = objectionOutcome({ objections: input.objections, finalBudgetStep: input.finalBudgetStep });
    return { kind: "continue", phase: "choice-violation", feedback: violation, fallback,
      ...(outcome.escalate ? { escalate: true } : {}), ...(outcome.exhausted ? { exhausted: true } : {}) };
  }
  if (!input.policy) return { kind: "proceed" };
  if (input.candidate.toolCalls.length > 0) {
    if (!input.policy.reviewToolCalls) return { kind: "proceed" };
    const toolDecision = validateTerminalDecision(await input.policy.reviewToolCalls({
      ...input.state,
      directive: input.directive,
      toolCalls: input.candidate.toolCalls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
    }, input.signal, input.services ?? {}));
    if (toolDecision.decision !== "continue") return { kind: "proceed" };
    if (toolDecision.workRemains) return workRemainsReview("tool-call", toolDecision, input.objections, input.finalBudgetStep, input.candidate.content);
    const outcome = objectionOutcome({ objections: input.objections, finalBudgetStep: input.finalBudgetStep });
    return { kind: "continue", phase: "tool-call", feedback: toolDecision.feedback,
      ...(toolDecision.fallback ? { fallback: toolDecision.fallback } : {}),
      ...(outcome.escalate ? { escalate: true } : {}), ...(outcome.exhausted ? { exhausted: true } : {}) };
  }
  const terminalDecision = validateTerminalDecision(await input.policy.reviewTerminal({
    ...input.state,
    directive: input.directive,
    candidate: {
      content: input.candidate.content, finishReason: input.candidate.finishReason,
      ...(input.candidate.status ? { status: input.candidate.status } : {}),
    },
  }, input.signal, input.services ?? {}));
  if (terminalDecision.decision !== "continue") return { kind: "proceed", terminalDecision };
  if (terminalDecision.workRemains) {
    const { objectedAnswer } = input.objections;
    const judgedUnmoved = objectedAnswer !== undefined && input.answerUnmoved ? await input.answerUnmoved(input.candidate.content, objectedAnswer) : false;
    return workRemainsReview("terminal", terminalDecision, input.objections, input.finalBudgetStep, input.candidate.content, judgedUnmoved);
  }
  if (input.closingStep) {
    return { kind: "proceed", terminalDecision: Object.freeze({ decision: "accept", outcome: "partial", reason: CLOSING_STEP_OBJECTION,
      ...(terminalDecision.fallback ? { notice: terminalDecision.fallback } : {}) }) };
  }
  const outcome = objectionOutcome({
    objections: input.objections, finalBudgetStep: input.finalBudgetStep, ...(input.grantClosingStep ? { grantClosingStep: input.grantClosingStep } : {}),
  });
  return { kind: "continue", phase: "terminal", feedback: terminalDecision.feedback,
    ...(terminalDecision.fallback ? { fallback: terminalDecision.fallback } : {}),
    ...(outcome.escalate ? { escalate: true } : {}), ...(outcome.exhausted ? { exhausted: true } : {}) };
}
