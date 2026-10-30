import { AgenticError, type LlmStreamEvent, type RunTurnResult, type TurnTerminalDecision } from "@0xsyncroot/contracts";
import { classifyError } from "./error-classifier.js";
import { budgetFinal, classifyLlmTerminal } from "./llm-finish-policy.js";
import type { LlmStepResult } from "../../../src/agent/llm-step-executor.js";
import { requestModelResponseRecovery } from "../../../src/agent/model-response-recovery.js";
import { noticedAnswerDraft } from "../../../src/agent/turn-answer.js";
import { CLOSING_STEP_OBJECTION } from "./turn-output-review.js";
import type { StepFrame, TurnLoop } from "../../../src/agent/turn-step-loop-input.js";

type FinalLlmEvent = Extract<LlmStreamEvent, { readonly type: "final" }>;
export type AcceptedDecision = Extract<TurnTerminalDecision, { readonly decision: "accept" }> | undefined;

export const WORK_REMAINS_CLOSING = "work-remains-unmoved";

export async function finishStep(
  loop: TurnLoop, frame: StepFrame, step: LlmStepResult, final: FinalLlmEvent, budgetStop: ReturnType<typeof budgetFinal> | undefined,
  accepted: AcceptedDecision,
): Promise<RunTurnResult | undefined> {
  const { turn, budget } = loop;
  const { stepId, stepIndex, answerDraft } = frame;
  const terminal = final.toolCalls.length > 0 ? "completed" : classifyLlmTerminal(final);
  if (terminal === "failed") {
    answerDraft.discardCommitted();
    throw new AgenticError("permanent", `LLM response failed: ${final.finishReason}`);
  }
  const silent = budgetStop?.silent ?? !final.content?.trim();
  const calledATool = budgetStop !== undefined;
  if (calledATool && !budgetStop.silent && final.content?.trim()) loop.workNotes.push(final.content.trim());
  if ((silent || calledATool) && budget.grantResponseRecovery(stepIndex, frame.finalBudgetStep)) {
    await requestModelResponseRecovery({
      input: turn.input, turnId: turn.turnId, stepId, stepIndex, attemptId: step.attemptId, writer: turn.writer,
      controlFeedback: loop.controlFeedback, discardDraftAnswer: () => answerDraft.discardCommitted(), calledATool,
      finalBudgetStep: frame.finalBudgetStep,
      ...(!calledATool && loop.withheldText ? { withheldAnswer: loop.withheldText } : {}),
    });
    return undefined;
  }
  if (calledATool) answerDraft.discardCommitted();
  else answerDraft.completeCommitted(final.content);
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
  const resourceStop = frame.finalBudgetStep || budgetStop !== undefined;
  const outcome = resourceStop || terminal !== "completed" || accepted?.outcome === "partial" ? "partial" : "completed";
  const workClosing = frame.stopReason === WORK_REMAINS_CLOSING;
  const decision = resourceStop && !workClosing ? "budget-reached" : outcome === "partial" ? "partial" : "finish";
  const gateEnded = accepted?.reason?.startsWith("work-remains-") === true;
  const limited = workClosing ? gateEnded || accepted?.reason === CLOSING_STEP_OBJECTION : resourceStop || (!silent && gateEnded);
  return turn.terminator.finishAnswer({
    stepId, stepIndex, content: calledATool ? stopNotice ?? "" : final.content ?? "", finishReason: final.finishReason,
    outcome, decision, usage: loop.usage, ...(outcome === "partial" && limited && loop.continueQuestion ? { question: loop.continueQuestion } : {}),
    ...(resourceStop ? { reason: frame.stopReason ?? budget.stopReason(stepIndex) } : silent ? { reason: "empty-response" } : {}),
  });
}

export async function failStep(loop: TurnLoop, frame: StepFrame, error: unknown): Promise<never> {
  frame.answerDraft.discardAll();
  loop.reasoningDraft.endAll("discarded");
  await loop.turn.writer.append([{ type: "step/end", turnId: loop.turn.turnId, stepId: frame.stepId, payload: { status: "failed", ...classifyError(error) } }], `step-end:${frame.stepId}`);
  throw error;
}
