import type { LlmStreamEvent } from "@0xsyncroot/contracts";
import { classifyError } from "./error-classifier.js";
import type { LlmStepResult } from "./llm-step-executor.js";
import { report } from "./operation-observers.js";
import { emitNarration, emitNarrationSuperseded, type NarrationDecision } from "./plan-narration.js";
import type { AcceptedDecision } from "./step-answer.js";
import { decideStep, recordBatch } from "./step-decision.js";
import type { StepOutcome } from "./step-disposition.js";
import { answerReviewState, type StepReview } from "./step-review.js";
import type { ToolBatchResult } from "./tool-batch-executor.js";
import { acceptedAnswerDraft, withNotice } from "./turn-answer.js";
import { terminalCandidateHash, turnControlDecisionDraft } from "./turn-control.js";
import type { StepFrame, TurnLoop } from "./turn-step-loop-input.js";

type FinalLlmEvent = Extract<LlmStreamEvent, { readonly type: "final" }>;

/** How the accepted output was journaled: whether it narrates the work, and whether its text is an answer sent beside the plan. */
export interface JournaledOutput {
  readonly narration: NarrationDecision;
  readonly planningAnswer: boolean;
}

/** A tool step either ends here (the turn's result, or `undefined` for the next step), or leaves the answer beside the plan. */
export type ToolStepEnd =
  | { readonly kind: "done"; readonly outcome: StepOutcome }
  | { readonly kind: "answer"; readonly final: FinalLlmEvent; readonly accepted: AcceptedDecision };

/**
 * Carries out the accepted calls of a step: they run as a batch, which may pause the turn for the user; otherwise the step
 * ends with what the batch did, decided by `decide()` (turn-end.ts). An answer sent together with the plan update is the
 * answer: once the plan is published it is reviewed exactly as an answer on its own would be.
 */
export async function disposeToolCalls(
  loop: TurnLoop, frame: StepFrame, step: LlmStepResult, final: FinalLlmEvent, journaled: JournaledOutput, review: StepReview,
): Promise<ToolStepEnd> {
  const { turn } = loop;
  const { turnId, writer } = turn;
  const { stepId, stepIndex, answerDraft } = frame;
  const { narration, planningAnswer } = journaled;
  const isPlanningCall = (name: string) => loop.setup.planLedger.isPlanningCall(name);
  if (final.content?.trim()) loop.workNotes.push(final.content.trim());
  if (narration.narrate) {
    // Delivered as narration already; the same draft is never quoted back as "withheld".
    emitNarration(turn.input, turnId, { narrationId: narration.narrationId!, text: narration.text! }, answerDraft);
    // Remember the opening announcement so later planning text is not announced twice.
    if (!loop.modelDispatchedWork) loop.narratedText ??= narration.text;
  } else if (!planningAnswer) {
    // Text beside a real tool call otherwise stays withheld; kept for response recovery,
    // which quotes it back to a model that believes it was delivered.
    answerDraft.discardCommitted();
    loop.withheldText = final.content?.trim() ? final.content : loop.withheldText;
  }
  // A real tool call acts on the objections raised so far: from here they are history, not the newest word.
  if (final.toolCalls.some((call) => !isPlanningCall(call.name))) loop.answeredFeedback = loop.controlFeedback.length;
  const batch = await runToolBatch(loop, frame, final, step.requestId);
  if (batch.kind === "awaiting_approval" || batch.kind === "awaiting_interaction") {
    return { kind: "done", outcome: await turn.terminator.finishAwaiting({ stepId, stepIndex, usage: loop.usage, pending: batch }) };
  }
  recordBatch(loop, stepIndex, {
    progressed: batch.progressed, planningOnly: batch.planningOnly, planChanged: batch.planChanged, unavailableOnly: batch.unavailableOnly,
    refusedOnly: batch.refusedOnly, workDispatched: batch.workDispatched,
  });
  // Decided on the outcome, never on the words: a step without progress supersedes the stuck sentence before its own.
  const superseded = loop.narrationChain.settle(batch.progressed);
  // Only the model's own, non-planning calls close the narration window for later steps (specs/agentic-core-architecture.md §10).
  loop.modelDispatchedWork = loop.modelDispatchedWork || final.toolCalls.some((call) => !isPlanningCall(call.name));
  if (narration.narrate || !planningAnswer) {
    decideStep(loop, stepIndex, { kind: "tools" });
    // A superseding step always told a narration, so its end is journaled here, in the same append as the supersede.
    await writer.append([
      ...(superseded ? [{ type: "assistant/narration-superseded", turnId, stepId, payload: superseded }] : []),
      { type: "step/end", turnId, stepId, payload: { status: "completed", reason: narration.narrate ? "narration" : "tool-results" } },
    ], `step-end:${stepId}`);
    if (superseded) emitNarrationSuperseded(turn.input, turnId, superseded);
    report(turn.input, { type: "step-completed", turnId, step: stepIndex });
    return { kind: "done", outcome: undefined };
  }
  // The plan is published; the text is now reviewed exactly as an answer on its own would be.
  const verdict = await review.review({ ...final, toolCalls: [] }, await answerReviewState(loop, {
    ...frame.reviewState, context: await turn.view.evidence(),
    ...(loop.setup.planLedger.workPlan ? { workPlan: loop.setup.planLedger.workPlan } : {}),
  }, stepId));
  if (verdict.kind === "continue") return { kind: "done", outcome: await review.sendBack(verdict, final, true) };
  if (verdict.kind === "close") return { kind: "done", outcome: await review.closeOut(verdict, final, true) };
  const candidateHash = terminalCandidateHash({ ...final, toolCalls: [] });
  const notice = verdict.terminalDecision?.notice;
  const noticed = withNotice(final, notice, answerDraft);
  await writer.append([
    ...(loop.controlPolicy && verdict.terminalDecision ? [turnControlDecisionDraft(loop.controlPolicy, turnId, stepId, "terminal", "accept", {
      candidateHash, ...(verdict.terminalDecision.reason ? { reason: verdict.terminalDecision.reason } : {}),
      ...(verdict.delivered ? { delivered: true } : {}),
    })] : []),
    acceptedAnswerDraft(noticed, notice, { turnId, stepId, requestId: step.requestId, attemptId: step.attemptId, classification: noticed.providerState?.classification }),
  ], `turn-control:terminal:${stepId}`);
  return { kind: "answer", final: noticed, accepted: verdict.terminalDecision };
}

/** Runs the step's calls; a batch that fails ends the step as failed before the turn fails. */
async function runToolBatch(loop: TurnLoop, frame: StepFrame, final: FinalLlmEvent, requestId: string): Promise<ToolBatchResult> {
  try {
    return await loop.setup.toolBatch.execute(final.toolCalls, {
      ...loop.setup.batchContext(frame.stepId, frame.stepIndex), selectedToolIds: new Set(frame.modelTools.map((tool) => tool.id)),
      ...(loop.reviewResult ? { reviewResult: loop.reviewResult } : {}),
      ...(loop.stepClaims ? { stepClaims: loop.stepClaims } : {}), ...(loop.groupLoad ? { groupLoad: loop.groupLoad } : {}),
    }, frame.messages, loop.turn.signal, requestId);
  } catch (error) {
    await loop.turn.writer.append([{ type: "step/end", turnId: loop.turn.turnId, stepId: frame.stepId, payload: { status: "failed", ...classifyError(error) } }], `step-end:${frame.stepId}`);
    throw error;
  }
}
