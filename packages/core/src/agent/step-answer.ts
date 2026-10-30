import { AgenticError, type LlmStreamEvent, type RunTurnResult, type TurnTerminalDecision } from "@0xsyncroot/contracts";
import { classifyError } from "./error-classifier.js";
import { budgetFinal, classifyLlmTerminal } from "./llm-finish-policy.js";
import type { LlmStepResult } from "./llm-step-executor.js";
import { requestModelResponseRecovery } from "./model-response-recovery.js";
import { noticedAnswerDraft } from "./turn-answer.js";
import { decideStep } from "./step-decision.js";
import type { StepFrame, TurnLoop } from "./turn-step-loop-input.js";

type FinalLlmEvent = Extract<LlmStreamEvent, { readonly type: "final" }>;
export type AcceptedDecision = Extract<TurnTerminalDecision, { readonly decision: "accept" }> | undefined;

/**
 * Ends the turn on the step's answer — or asks once more when the model said nothing — as `decide()` (turn-end.ts) says.
 *
 * Kept apart from `disposeStepOutput` only to keep both under the source line limit: this is the
 * last thing a step that produced an accepted answer does.
 */
export async function finishStep(
  loop: TurnLoop, frame: StepFrame, step: LlmStepResult, final: FinalLlmEvent, budgetStop: ReturnType<typeof budgetFinal> | undefined,
  accepted: AcceptedDecision,
): Promise<RunTurnResult | undefined> {
  const { turn } = loop;
  const { stepId, stepIndex, answerDraft } = frame;
  // Calls reach this point only beside an accepted answer to the plan update: that text is the answer.
  const terminal = final.toolCalls.length > 0 ? "completed" : classifyLlmTerminal(final);
  if (terminal === "failed") {
    answerDraft.discardCommitted();
    throw new AgenticError("permanent", `LLM response failed: ${final.finishReason}`);
  }
  // Silent either way: the budget took its tools away, or it simply said nothing at all.
  const silent = budgetStop?.silent ?? !final.content?.trim();
  // On the step that must answer, a reply that reached for a tool is no answer, whatever text came
  // with it: the text is the model narrating its next move ("Added NV902, scrolling on"), and
  // delivering it ended a 32-step turn on a progress note. It is kept as a note for the re-ask.
  const calledATool = budgetStop !== undefined;
  if (calledATool && !budgetStop.silent && final.content?.trim()) loop.workNotes.push(final.content.trim());
  const next = decideStep(loop, stepIndex, {
    kind: "answer", silent, calledATool, completed: terminal === "completed",
    ...(accepted ? { accepted: { ...(accepted.outcome ? { outcome: accepted.outcome } : {}), ...(accepted.reason ? { reason: accepted.reason } : {}) } } : {}),
  });
  if (next.kind !== "end" || next.by !== "answer") {
    await requestModelResponseRecovery({
      input: turn.input, turnId: turn.turnId, stepId, stepIndex, attemptId: step.attemptId, writer: turn.writer,
      controlFeedback: loop.controlFeedback, discardDraftAnswer: () => answerDraft.discardCommitted(), calledATool,
      finalBudgetStep: frame.finalBudgetStep,
      // A model that reached for a tool was working, not answering: its last withheld text is a
      // progress note, already in the final step's digest, and quoted as "your answer, send it
      // again" it would come back as the answer. Only a model that went quiet is quoted.
      ...(!calledATool && loop.withheldText ? { withheldAnswer: loop.withheldText } : {}),
    });
    return undefined;
  }
  if (calledATool) answerDraft.discardCommitted();
  else answerDraft.completeCommitted(final.content);
  // The step that had to answer reached for a tool: its words were a working note and went, but
  // what the policy found still open is the user's to read — on screen now, and as the turn's last
  // message for history. It rode on the discarded draft; without this it went with it.
  const stopNotice = calledATool ? accepted?.notice : undefined;
  if (stopNotice) {
    const noticeId = `notice:${stepId}`;
    answerDraft.start(noticeId);
    answerDraft.delta(noticeId, stopNotice);
    answerDraft.end(noticeId, "completed");
    await turn.writer.append(noticedAnswerDraft({ content: stopNotice }, stopNotice, {
      turnId: turn.turnId, stepId, requestId: step.requestId, attemptId: step.attemptId, classification: final.providerState?.classification,
    }), `stop-notice:${stepId}`);
  }
  // Empty when the budget stopped a step with no prose: the user's wording is the product's.
  return turn.terminator.finishAnswer({
    stepId, stepIndex, content: calledATool ? stopNotice ?? "" : final.content ?? "", finishReason: final.finishReason,
    outcome: next.outcome, decision: next.decision, usage: loop.usage, ...(next.ask && loop.continueQuestion ? { question: loop.continueQuestion } : {}),
    ...(next.reason !== undefined ? { reason: next.reason } : {}),
  });
}

/** A step whose output could not be journaled: its drafts are withdrawn and the step ends failed. */
export async function failStep(loop: TurnLoop, frame: StepFrame, error: unknown): Promise<never> {
  frame.answerDraft.discardAll();
  loop.reasoningDraft.endAll("discarded");
  await loop.turn.writer.append([{ type: "step/end", turnId: loop.turn.turnId, stepId: frame.stepId, payload: { status: "failed", ...classifyError(error) } }], `step-end:${frame.stepId}`);
  throw error;
}
