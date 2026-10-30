import { AgenticError, type LlmStreamEvent, type RunTurnResult } from "@0xsyncroot/contracts";
import { classifyError } from "./error-classifier.js";
import { toJsonValue } from "../../../src/agent/json-value.js";
import { budgetFinal } from "./llm-finish-policy.js";
import type { LlmStepResult } from "../../../src/agent/llm-step-executor.js";
import { failStep, finishStep, type AcceptedDecision } from "./step-answer.js";
import { addUsage, normalizedUsage } from "../../../src/agent/llm-usage.js";
import { report } from "../../../src/agent/operation-observers.js";
import { decideNarration, emitNarration, emitNarrationSuperseded, type NarrationDecision } from "../../../src/agent/plan-narration.js";
import type { ToolBatchResult } from "./tool-batch-executor.js";
import { acceptedAnswerDraft, withNotice } from "../../../src/agent/turn-answer.js";
import { terminalCandidateHash, turnControlDecisionDraft, type TurnOutputReview } from "./turn-control.js";
import { reviewTurnOutput } from "./turn-output-review.js";
import { closeAfterTurnControl, continueAfterTurnControl, finishWithTurnControlFallback } from "../../../src/agent/turn-control-fallback.js";
import { withoutKeptDraft } from "./turn-control-feedback.js";
import { STEP_INSTRUCTION_PROVENANCE } from "../../../src/agent/step-instruction.js";
import type { StepFrame, TurnLoop } from "../../../src/agent/turn-step-loop-input.js";
import { recordInterjections } from "../../../src/agent/turn-interjections.js";

type FinalLlmEvent = Extract<LlmStreamEvent, { readonly type: "final" }>;
type ContinueVerdict = Extract<TurnOutputReview, { readonly kind: "continue" }>;
type CloseVerdict = Extract<TurnOutputReview, { readonly kind: "close" }>;

export type StepOutcome = RunTurnResult | undefined;

export async function disposeStepOutput(loop: TurnLoop, frame: StepFrame, step: LlmStepResult): Promise<StepOutcome> {
  const { turn, budget } = loop;
  const { turnId, writer } = turn;
  const { stepId, stepIndex, answerDraft } = frame;
  loop.reasoningDraft.endAll("completed");
  const offered = new Set(frame.modelTools.map((tool) => tool.id));
  const suppressedToolCalls = frame.finalBudgetStep && step.final.toolCalls.some((call) => !offered.has(call.name)) ? step.final.toolCalls : [];
  const budgetStop = suppressedToolCalls.length > 0 ? budgetFinal(step.final) : undefined;
  let final = budgetStop?.final ?? step.final;
  const candidateOf = (output: FinalLlmEvent): FinalLlmEvent => budgetStop?.silent ? { ...output, content: null } : output;
  const stepUsage = normalizedUsage(final.usage);
  loop.usage = addUsage(loop.usage, stepUsage);
  const usageDraft = {
    type: "usage/recorded", turnId, stepId, requestId: step.requestId, attemptId: step.attemptId,
    payload: { providerId: loop.route.providerId, model: loop.route.modelId, routeRevision: loop.route.routeRevision, ...stepUsage, reported: final.usage !== undefined },
  } as const;
  if (budget.canApplyInterjection(stepIndex) && await recordInterjections(turn, stepIndex + 1, "after-model") > 0) {
    answerDraft.discardCommitted();
    budget.recordInterjection(stepIndex);
    await writer.append([usageDraft, {
      type: "step/end", turnId, stepId, payload: { status: "completed", reason: "interjection" },
    }], `interjected-step:${step.attemptId}`);
    report(turn.input, { type: "step-completed", turnId, step: stepIndex });
    return undefined;
  }
  const isPlanningCall = (name: string) => loop.setup.planLedger.isPlanningCall(name);
  const closingStep = loop.closing !== undefined || loop.failure !== undefined;
  const review = (candidate: FinalLlmEvent, state = frame.reviewState) => reviewTurnOutput({
    ...(loop.controlPolicy ? { policy: loop.controlPolicy } : {}), state,
    directive: frame.directive, selectedTools: frame.modelTools, candidate: candidateOf(candidate), finalBudgetStep: frame.finalBudgetStep,
    ...(closingStep ? { closingStep } : {}),
    controlFeedback: loop.controlFeedback, signal: turn.signal, grantClosingStep: () => !closingStep && budget.grantClosingStep(stepIndex),
    reserveWorkClosingStep: () => budget.reserveClosingStep(stepIndex), isPlanningCall, services: loop.services,
  });
  const reviewCommand = (phase: ContinueVerdict["phase"], feedback: string, usageRecorded: boolean) => {
    const policy = loop.controlPolicy;
    if (!policy) throw new AgenticError("permanent", "Turn-control continuation requires a policy");
    const draftNarrationId = answerDraft.committedOutputId ?? step.attemptId;
    return {
      policy, input: turn.input, turnId, stepId, stepIndex, requestId: step.requestId, attemptId: step.attemptId, phase,
      feedback, candidate: candidateOf(final), ...(usageRecorded ? {} : { usageDraft }), usage: loop.usage, writer,
      discardDraftAnswer: () => answerDraft.discardCommitted(), draftNarrationId,
      ...(loop.keptDraft !== undefined ? { lastKeptDraft: loop.keptDraft } : {}),
      narrateDraftAnswer: (text: string) => { loop.keptDraft = text; emitNarration(turn.input, turnId, { narrationId: draftNarrationId, text }, answerDraft, "draft"); },
    };
  };
  const closeOut = async (verdict: CloseVerdict, usageRecorded = false): Promise<StepOutcome> => {
    await closeAfterTurnControl({ ...reviewCommand("terminal", verdict.feedback, usageRecorded), reason: verdict.reason });
    loop.closing = { remaining: verdict.feedback, noticeFollows: verdict.noticeFollows };
    return undefined;
  };
  const sendBack = async (verdict: ContinueVerdict, usageRecorded = false): Promise<StepOutcome> => {
    const policy = loop.controlPolicy!;
    const command = {
      ...reviewCommand(verdict.phase, verdict.feedback, usageRecorded), ...(verdict.workRemains ? { workRemains: true } : {}),
      ...(verdict.escalate && verdict.fallback ? { guidance: verdict.fallback } : {}),
    };
    if (verdict.deduplicated && verdict.fallback !== undefined) {
      return finishWithTurnControlFallback({ ...command, fallback: verdict.fallback, terminator: turn.terminator,
        ...(verdict.workRemains && loop.continueQuestion ? { question: loop.continueQuestion } : {}) });
    }
    const feedback = await continueAfterTurnControl(command);
    if (policy.keepDraftsAsNarration) loop.controlFeedback.splice(0, loop.controlFeedback.length, ...loop.controlFeedback.map(withoutKeptDraft));
    loop.controlFeedback.push(feedback);
    budget.recordRejectedStep(Date.now() - frame.startedAt);
    return undefined;
  };
  let narration: NarrationDecision = { narrate: false };
  let planningAnswer = false;
  let accepted: AcceptedDecision;
  try {
    const outputReview = await review(final);
    if (outputReview.kind === "continue") return await sendBack(outputReview);
    if (outputReview.kind === "close") return await closeOut(outputReview);
    accepted = outputReview.terminalDecision;
    const controlDecision = loop.controlPolicy && outputReview.terminalDecision ? [
      turnControlDecisionDraft(loop.controlPolicy, turnId, stepId, "terminal", "accept", {
        candidateHash: terminalCandidateHash(final), ...(outputReview.terminalDecision.reason ? { reason: outputReview.terminalDecision.reason } : {}),
      }),
    ] : [];
    final = withNotice(final, outputReview.terminalDecision?.notice, answerDraft);
    narration = decideNarration({
      planLedger: loop.setup.planLedger, toolCalls: final.toolCalls, content: final.content,
      modelDispatchedWork: loop.modelDispatchedWork, alreadyNarrated: loop.narratedText !== undefined,
      outputId: answerDraft.committedOutputId, attemptId: step.attemptId,
    });
    planningAnswer = !narration.narrate && final.toolCalls.length > 0 && Boolean(final.content?.trim()) &&
      final.toolCalls.every((call) => isPlanningCall(call.name));
    const narrationDrafts = narration.narrate
      ? [{ type: "assistant/narration", turnId, stepId, payload: { narrationId: narration.narrationId!, audience: "user" as const, content: narration.text! } }]
      : [];
    await writer.append([{
      type: "assistant/message", turnId, stepId, requestId: step.requestId, attemptId: step.attemptId,
      classification: final.providerState?.classification ?? "internal",
      payload: toJsonValue({
        content: planningAnswer ? null : final.content, toolCalls: final.toolCalls, finishReason: final.finishReason, usage: final.usage ?? {},
        providerRequestId: final.providerRequestId ?? null, providerState: final.providerState ?? null,
        ...(suppressedToolCalls.length > 0 ? { suppressedToolCalls } : {}),
      }),
    }, usageDraft, ...controlDecision, ...narrationDrafts], `assistant-message:${step.attemptId}`);
    if (narration.narrate) loop.narrationChain.narrated(narration.narrationId!, narration.announcement !== true);
  } catch (error) {
    await failStep(loop, frame, error);
  }
  frame.messages.push({ role: "assistant", content: final.content, ...(final.toolCalls.length > 0 ? { toolCalls: final.toolCalls } : {}), ...(final.providerState ? { providerState: final.providerState } : {}) });
  const suggestion = loop.controlFeedback.findIndex((message) => message.context?.provenance === STEP_INSTRUCTION_PROVENANCE.skill);
  if (suggestion >= 0) {
    loop.controlFeedback.splice(suggestion, 1);
    if (loop.answeredFeedback > suggestion) loop.answeredFeedback -= 1;
  }
  if (final.toolCalls.length > 0) {
    if (final.content?.trim()) loop.workNotes.push(final.content.trim());
    if (narration.narrate) {
      emitNarration(turn.input, turnId, { narrationId: narration.narrationId!, text: narration.text! }, answerDraft);
      if (!loop.modelDispatchedWork) loop.narratedText ??= narration.text;
    } else if (!planningAnswer) {
      answerDraft.discardCommitted();
      loop.withheldText = final.content?.trim() ? final.content : loop.withheldText;
    }
    if (final.toolCalls.some((call) => !isPlanningCall(call.name))) loop.answeredFeedback = loop.controlFeedback.length;
    const batch = await runToolBatch(loop, frame, final, step.requestId);
    if (batch.kind === "awaiting_approval" || batch.kind === "awaiting_interaction") {
      return turn.terminator.finishAwaiting({ stepId, stepIndex, usage: loop.usage, pending: batch });
    }
    const recordedProgress = !batch.planningOnly && !batch.unavailableOnly && !batch.refusedOnly;
    if (batch.planningOnly) budget.recordPlanningStep(Date.now() - frame.startedAt, batch.planChanged);
    else if (batch.unavailableOnly || batch.refusedOnly) budget.recordRefusedStep(Date.now() - frame.startedAt);
    else budget.recordStepOutcome(stepIndex, batch.progressed, Date.now() - frame.startedAt);
    const superseded = loop.narrationChain.settle(recordedProgress && batch.progressed);
    loop.modelDispatchedWork = loop.modelDispatchedWork || final.toolCalls.some((call) => !isPlanningCall(call.name));
    if (narration.narrate || !planningAnswer) {
      await writer.append([
        ...(superseded ? [{ type: "assistant/narration-superseded", turnId, stepId, payload: superseded }] : []),
        { type: "step/end", turnId, stepId, payload: { status: "completed", reason: narration.narrate ? "narration" : "tool-results" } },
      ], `step-end:${stepId}`);
      if (superseded) emitNarrationSuperseded(turn.input, turnId, superseded);
      report(turn.input, { type: "step-completed", turnId, step: stepIndex });
      return undefined;
    }
    const verdict = await review({ ...final, toolCalls: [] }, {
      ...frame.reviewState, context: await turn.view.evidence(),
      ...(loop.setup.planLedger.workPlan ? { workPlan: loop.setup.planLedger.workPlan } : {}),
    });
    if (verdict.kind === "continue") return sendBack(verdict, true);
    if (verdict.kind === "close") return closeOut(verdict, true);
    accepted = verdict.terminalDecision;
    const candidateHash = terminalCandidateHash({ ...final, toolCalls: [] });
    const notice = verdict.terminalDecision?.notice;
    final = withNotice(final, notice, answerDraft);
    await writer.append([
      ...(loop.controlPolicy && verdict.terminalDecision ? [turnControlDecisionDraft(loop.controlPolicy, turnId, stepId, "terminal", "accept", {
        candidateHash, ...(verdict.terminalDecision.reason ? { reason: verdict.terminalDecision.reason } : {}),
      })] : []),
      acceptedAnswerDraft(final, notice, { turnId, stepId, requestId: step.requestId, attemptId: step.attemptId, classification: final.providerState?.classification }),
    ], `turn-control:terminal:${stepId}`);
  }
  return finishStep(loop, frame, step, final, budgetStop, accepted);
}

async function runToolBatch(loop: TurnLoop, frame: StepFrame, final: FinalLlmEvent, requestId: string): Promise<ToolBatchResult> {
  try {
    return await loop.setup.toolBatch.execute(final.toolCalls, {
      ...loop.setup.batchContext(frame.stepId, frame.stepIndex), selectedToolIds: new Set(frame.modelTools.map((tool) => tool.id)),
      ...(loop.reviewResult ? { reviewResult: loop.reviewResult } : {}),
      ...(loop.stepClaims ? { stepClaims: loop.stepClaims } : {}),
    }, frame.messages, loop.turn.signal, requestId);
  } catch (error) {
    await loop.turn.writer.append([{ type: "step/end", turnId: loop.turn.turnId, stepId: frame.stepId, payload: { status: "failed", ...classifyError(error) } }], `step-end:${frame.stepId}`);
    throw error;
  }
}
