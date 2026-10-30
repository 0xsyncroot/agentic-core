import { AgenticError, type JsonValue, type LlmStreamEvent, type TurnControlState } from "@0xsyncroot/contracts";
import type { LlmStepResult } from "./llm-step-executor.js";
import { emitNarration } from "./plan-narration.js";
import type { StepOutcome } from "./step-disposition.js";
import { decideStep, readBackStep } from "./step-decision.js";
import { normalizedContentHash, type TurnOutputReview } from "./turn-control.js";
import { closeAfterTurnControl, continueAfterTurnControl, finishWithTurnControlFallback } from "./turn-control-fallback.js";
import { withoutKeptDraft } from "./turn-control-feedback.js";
import { closesTurn, objectionsHeard } from "./turn-end.js";
import { reviewTurnOutput } from "./turn-output-review.js";
import type { StepFrame, TurnLoop } from "./turn-step-loop-input.js";

type FinalLlmEvent = Extract<LlmStreamEvent, { readonly type: "final" }>;
export type ContinueVerdict = Extract<TurnOutputReview, { readonly kind: "continue" }>;
export type CloseVerdict = Extract<TurnOutputReview, { readonly kind: "close" }>;

/** What a step's review works from: the model's own words as the candidate, and the step's usage until it is journaled. */
export interface ReviewedOutput {
  /** The output as review and a kept draft see it: a silent stop's runtime note is no answer. */
  readonly candidateOf: (output: FinalLlmEvent) => FinalLlmEvent;
  readonly usageDraft: { readonly type: "usage/recorded"; readonly turnId: string; readonly stepId: string; readonly requestId: string;
    readonly attemptId: string; readonly payload: Readonly<Record<string, JsonValue>> };
}

/**
 * A step's review and what an objection does: it sends the step back (or, once the objections are spent, ends the turn on
 * the policy's fallback) — retracting the draft the user watched, or leaving it on screen as narration when the policy keeps
 * drafts — or, from the work-remains gate, closes the work so that the next step is its closing step. Each outcome is decided
 * by `decide()` (turn-end.ts).
 */
export interface StepReview {
  review(candidate: FinalLlmEvent, state?: TurnControlState): Promise<TurnOutputReview>;
  /** Sends the step back with the verdict's feedback; returns the turn only when the verdict ends it. */
  sendBack(verdict: ContinueVerdict, final: FinalLlmEvent, usageRecorded?: boolean): Promise<StepOutcome>;
  /** The gate ended the work on a stalled answer: journal it, and let the next step close the work. */
  closeOut(verdict: CloseVerdict, final: FinalLlmEvent, usageRecorded?: boolean): Promise<StepOutcome>;
}

/**
 * The state a terminal answer is reviewed on: before the review reads the plan, the plan closes the steps the model left behind
 * that a settled call shows done (`WorkPlanLedger.closeDoneSteps`, journaled now), so a judge reads the plan the evidence shows,
 * not the model's last mark; the step in progress is the answer's own, judged as the model left it.
 */
export async function answerReviewState(loop: TurnLoop, state: TurnControlState, key: string): Promise<TurnControlState> {
  const { planLedger } = loop.setup;
  const drafts = planLedger.closeDoneSteps();
  if (drafts.length === 0) return state;
  await loop.turn.writer.append(drafts, `plan-evidence:${key}`);
  return { ...state, ...(planLedger.workPlan ? { workPlan: planLedger.workPlan } : {}) };
}

export function stepReview(loop: TurnLoop, frame: StepFrame, step: LlmStepResult, output: ReviewedOutput): StepReview {
  const { turn } = loop;
  const { turnId, writer } = turn;
  const { stepId, stepIndex, answerDraft } = frame;
  // After a closing step (the gate's or a failed step's) every step is final: a step bought to verify would have no tools.
  const closingStep = closesTurn(loop.ledger);
  const answerMoved = loop.answerMoved;
  const review = (candidate: FinalLlmEvent, state = frame.reviewState) => reviewTurnOutput({
    ...(loop.controlPolicy ? { policy: loop.controlPolicy } : {}), state,
    directive: frame.directive, selectedTools: frame.modelTools, candidate: output.candidateOf(candidate), finalBudgetStep: frame.finalBudgetStep,
    ...(closingStep ? { closingStep } : {}),
    objections: objectionsHeard(loop.ledger, loop.step ?? { stepIndex }, { bounds: loop.bounds, countedCalls: loop.setup.coordinator.toolCalls - loop.ledger.toolCalls }),
    signal: turn.signal,
    grantClosingStep: () => !closingStep && readBackStep(loop, stepIndex),
    isPlanningCall: (name: string) => loop.setup.planLedger.isPlanningCall(name), services: loop.services,
    ...(answerMoved ? { answerUnmoved: (content: string | null, objectedAnswer: string) => answerMoved.unmoved(content, objectedAnswer, loop.ledger.toolCalls) } : {}),
  });
  // What a sent-back or closed step hands to the journaling helpers: the draft, its usage, its narration channel.
  const reviewCommand = (phase: ContinueVerdict["phase"], feedback: string, final: FinalLlmEvent, usageRecorded: boolean) => {
    const policy = loop.controlPolicy;
    if (!policy) throw new AgenticError("permanent", "Turn-control continuation requires a policy");
    const draftNarrationId = answerDraft.committedOutputId ?? step.attemptId;
    return {
      policy, input: turn.input, turnId, stepId, stepIndex, requestId: step.requestId, attemptId: step.attemptId, phase,
      feedback, candidate: output.candidateOf(final), ...(usageRecorded ? {} : { usageDraft: output.usageDraft }), usage: loop.usage, writer,
      discardDraftAnswer: () => answerDraft.discardCommitted(), draftNarrationId,
      ...(loop.keptDraft !== undefined ? { lastKeptDraft: loop.keptDraft } : {}),
      narrateDraftAnswer: (text: string) => { loop.keptDraft = text; emitNarration(turn.input, turnId, { narrationId: draftNarrationId, text }, answerDraft, "draft"); },
    };
  };
  const closeOut = async (verdict: CloseVerdict, final: FinalLlmEvent, usageRecorded = false): Promise<StepOutcome> => {
    await closeAfterTurnControl({ ...reviewCommand("terminal", verdict.feedback, final, usageRecorded), reason: verdict.reason,
      ...(verdict.delivered ? { delivered: true } as const : {}) });
    loop.closing = { remaining: verdict.feedback, noticeFollows: verdict.noticeFollows };
    decideStep(loop, stepIndex, { kind: "close" });
    return undefined;
  };
  const sendBack = async (verdict: ContinueVerdict, final: FinalLlmEvent, usageRecorded = false): Promise<StepOutcome> => {
    const policy = loop.controlPolicy!;
    const command = {
      ...reviewCommand(verdict.phase, verdict.feedback, final, usageRecorded), ...(verdict.workRemains ? { workRemains: true } : {}),
      ...(verdict.delivered ? { delivered: true } as const : {}),
      ...(verdict.escalate && verdict.fallback ? { guidance: verdict.fallback } : {}),
    };
    const workRemains = verdict.workRemains === true;
    const answer = verdict.phase === "terminal" ? normalizedContentHash(command.candidate.content) : undefined;
    const objection = { kind: "objection", workRemains, phase: verdict.phase, ...(answer ? { answer } : {}) } as const;
    if (verdict.exhausted && verdict.fallback !== undefined) {
      // Work the gate found unfinished, ended by its own bound: the user decides whether it goes on when `decide()` finds work left.
      const ended = decideStep(loop, stepIndex, { ...objection, ended: true });
      return finishWithTurnControlFallback({ ...command, fallback: verdict.fallback, terminator: turn.terminator,
        ...(ended.kind === "end" && ended.by === "fallback" && ended.ask && loop.continueQuestion ? { question: loop.continueQuestion } : {}) });
    }
    const feedback = await continueAfterTurnControl(command);
    // Only the newest kept draft stays quoted; see `withoutKeptDraft`.
    if (policy.keepDraftsAsNarration) loop.controlFeedback.splice(0, loop.controlFeedback.length, ...loop.controlFeedback.map(withoutKeptDraft));
    loop.controlFeedback.push(feedback);
    decideStep(loop, stepIndex, { ...objection, ended: false });
    if (workRemains && verdict.phase === "terminal") answerMoved?.objected(command.candidate.content, verdict.feedback, loop.ledger.toolCalls, verdict.disputed);
    return undefined;
  };
  return { review, sendBack, closeOut };
}
