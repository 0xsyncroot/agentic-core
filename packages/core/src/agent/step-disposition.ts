import type { LlmStreamEvent, RunTurnResult, TurnTerminalDecision } from "@0xsyncroot/contracts";
import { toJsonValue } from "./json-value.js";
import { budgetFinal } from "./llm-finish-policy.js";
import type { LlmStepResult } from "./llm-step-executor.js";
import { failStep, finishStep, type AcceptedDecision } from "./step-answer.js";
import { addUsage, normalizedUsage } from "./llm-usage.js";
import { report } from "./operation-observers.js";
import { decideNarration } from "./plan-narration.js";
import { answerReviewState, stepReview, type ReviewedOutput } from "./step-review.js";
import { disposeToolCalls, type JournaledOutput } from "./step-tools.js";
import { withNotice } from "./turn-answer.js";
import { terminalCandidateHash, turnControlDecisionDraft } from "./turn-control.js";
import { STEP_INSTRUCTION_PROVENANCE } from "./step-instruction.js";
import type { StepFrame, TurnLoop } from "./turn-step-loop-input.js";
import { recordInterjections } from "./turn-interjections.js";
import { interjectionFits } from "./turn-end.js";
import { decideStep } from "./step-decision.js";

type FinalLlmEvent = Extract<LlmStreamEvent, { readonly type: "final" }>;

/** How one step's output ends: the turn's result, or `undefined` for the loop to take another step. */
export type StepOutcome = RunTurnResult | undefined;

/** The model's output as the step disposes of it: on a final step, calls it was not offered are suppressed (`budgetFinal`). */
interface StepOutput extends ReviewedOutput {
  readonly final: FinalLlmEvent;
  readonly budgetStop: ReturnType<typeof budgetFinal> | undefined;
  readonly suppressedToolCalls: FinalLlmEvent["toolCalls"];
}

/**
 * Decides what a model step's output is and carries it out.
 *
 * A step's output is reviewed first; an objection sends it back (or, once the objections are spent, ends the turn on the
 * policy's fallback), or the work-remains gate closes the work (`stepReview`). Accepted, it is journaled — together with the
 * plan announcement when this step earns one (specs/agentic-core-architecture.md §3.3, §10) — and then it is one of four
 * things: tool calls, which run as a batch and may pause the turn for the user; the plan announcement, which does not end
 * the turn on its own; an answer sent together with the plan update, which is the answer (`disposeToolCalls`); or a
 * terminal answer (`finishStep`). A silent model gets one recovery attempt; narration never proves the work finished. A step
 * whose model call was cut for the user's input (`step` undefined, `watchInterjections`) ends as interjected.
 */
export async function disposeStepOutput(loop: TurnLoop, frame: StepFrame, step: LlmStepResult | undefined): Promise<StepOutcome> {
  if (!step) {
    await recordInterjections(loop.turn, frame.stepIndex + 1, "model-cut");
    await endInterjected(loop, frame, [], `interjected-step:${frame.stepId}`);
    return undefined;
  }
  loop.reasoningDraft.endAll("completed");
  const output = stepOutput(loop, frame, step);
  if (await interjected(loop, frame, step, output, "after-model")) return undefined;
  const review = stepReview(loop, frame, step, output);
  let final = output.final;
  let accepted: AcceptedDecision;
  let journaled: JournaledOutput = { narration: { narrate: false }, planningAnswer: false };
  try {
    const verdict = await review.review(final, final.toolCalls.length === 0 ? await answerReviewState(loop, frame.reviewState, frame.stepId) : frame.reviewState);
    if (verdict.kind === "continue") return await review.sendBack(verdict, final);
    if (verdict.kind === "close") return await review.closeOut(verdict, final);
    // The review may take a while: input that came meanwhile is read before an answer ends the turn or a write runs.
    if (endsOrWrites(frame, final) && await interjected(loop, frame, step, output, "after-review")) return undefined;
    accepted = verdict.terminalDecision;
    ({ final, ...journaled } = await journalAccepted(loop, frame, step, output, accepted, verdict.delivered));
  } catch (error) {
    await failStep(loop, frame, error);
  }
  remember(loop, frame, final);
  if (final.toolCalls.length > 0) {
    const tools = await disposeToolCalls(loop, frame, step, final, journaled, review);
    if (tools.kind === "done") return tools.outcome;
    ({ final, accepted } = tools);
  }
  return finishStep(loop, frame, step, final, output.budgetStop, accepted);
}

/** The step's output, its usage counted: on a final step only the tools it offered may run — none on a budget stop, the ask-the-user form on a closing step. */
function stepOutput(loop: TurnLoop, frame: StepFrame, step: LlmStepResult): StepOutput {
  const offered = new Set(frame.modelTools.map((tool) => tool.id));
  const suppressedToolCalls = frame.finalBudgetStep && step.final.toolCalls.some((call) => !offered.has(call.name)) ? step.final.toolCalls : [];
  const budgetStop = suppressedToolCalls.length > 0 ? budgetFinal(step.final) : undefined;
  const final = budgetStop?.final ?? step.final;
  const stepUsage = normalizedUsage(final.usage);
  loop.usage = addUsage(loop.usage, stepUsage);
  return {
    final, budgetStop, suppressedToolCalls,
    // What review and a kept draft see: the model's own words. A silent stop's transcript note is the runtime's English; as
    // the candidate it would be reviewed and shown to the user as a draft, so it is reviewed as no answer.
    candidateOf: (candidate) => budgetStop?.silent ? { ...candidate, content: null } : candidate,
    usageDraft: {
      type: "usage/recorded", turnId: loop.turn.turnId, stepId: frame.stepId, requestId: step.requestId, attemptId: step.attemptId,
      payload: { providerId: loop.route.providerId, model: loop.route.modelId, routeRevision: loop.route.routeRevision, ...stepUsage, reported: final.usage !== undefined },
    },
  };
}

/**
 * Re-read after the model, and after its review when the output would end the turn or write: a correction may invalidate both
 * its answer and its proposed calls. If there is no step left to apply it, it stays queued for the delivery edge's close
 * operation.
 */
async function interjected(loop: TurnLoop, frame: StepFrame, step: LlmStepResult, output: StepOutput, boundary: string): Promise<boolean> {
  if (!interjectionFits(loop.ledger, loop.bounds, frame.stepIndex) || await recordInterjections(loop.turn, frame.stepIndex + 1, boundary) === 0) return false;
  await endInterjected(loop, frame, [output.usageDraft], `interjected-step:${step.attemptId}`);
  return true;
}

/** Ends the step for the input it took in: its answer is not the user's to read, and the next step starts from their words. */
async function endInterjected(loop: TurnLoop, frame: StepFrame, drafts: readonly StepOutput["usageDraft"][], key: string): Promise<void> {
  const { turn } = loop;
  frame.answerDraft.discardCommitted();
  decideStep(loop, frame.stepIndex, { kind: "interjected" });
  await turn.writer.append([...drafts, {
    type: "step/end", turnId: turn.turnId, stepId: frame.stepId, payload: { status: "completed", reason: "interjection" },
  }], key);
  report(turn.input, { type: "step-completed", turnId: turn.turnId, step: frame.stepIndex });
}

/** An answer that would end the turn, a call to a tool that changes something, or a question that would pause it. */
function endsOrWrites(frame: StepFrame, final: FinalLlmEvent): boolean {
  const writes = new Set(frame.modelTools.filter((tool) => tool.sideEffect !== "none" || tool.asksUser === true).map((tool) => tool.id));
  return final.toolCalls.length === 0 || final.toolCalls.some((call) => writes.has(call.name));
}

/** Journals the accepted output with its usage and the policy's accept, and the plan announcement when this step earns one. */
async function journalAccepted(
  loop: TurnLoop, frame: StepFrame, step: LlmStepResult, output: StepOutput,
  accepted: Extract<TurnTerminalDecision, { readonly decision: "accept" }> | undefined, delivered: true | undefined,
): Promise<JournaledOutput & { readonly final: FinalLlmEvent }> {
  const { turnId, writer } = loop.turn;
  const { stepId, answerDraft } = frame;
  const controlDecision = loop.controlPolicy && accepted ? [
    turnControlDecisionDraft(loop.controlPolicy, turnId, stepId, "terminal", "accept", {
      candidateHash: terminalCandidateHash(output.final), ...(accepted.reason ? { reason: accepted.reason } : {}),
      ...(delivered ? { delivered: true } : {}),
    }),
  ] : [];
  const final = withNotice(output.final, accepted?.notice, answerDraft);
  // Decided before the batch runs, against the preview of this step's own proposal (§3.3), so
  // the narration frames can precede the plan-updated/tool-started ones the batch produces.
  const narration = decideNarration({
    planLedger: loop.setup.planLedger, toolCalls: final.toolCalls, content: final.content,
    modelDispatchedWork: loop.modelDispatchedWork, alreadyNarrated: loop.narratedText !== undefined,
    outputId: answerDraft.committedOutputId, attemptId: step.attemptId,
  });
  // An answer sent together with the plan update is the answer. That is how the model is told
  // to stop and ask — mark the step it is asking in, and ask — and it used to be discarded like
  // any text beside a tool call; the next step then found the question already in the
  // transcript, had nothing to add, and the turn ended with nothing for the user.
  const planningAnswer = !narration.narrate && final.toolCalls.length > 0 && Boolean(final.content?.trim()) &&
    final.toolCalls.every((call) => loop.setup.planLedger.isPlanningCall(call.name));
  const narrationDrafts = narration.narrate
    ? [{ type: "assistant/narration", turnId, stepId, payload: { narrationId: narration.narrationId!, audience: "user" as const, content: narration.text! } }]
    : [];
  await writer.append([{
    type: "assistant/message", turnId, stepId, requestId: step.requestId, attemptId: step.attemptId,
    classification: final.providerState?.classification ?? "internal",
    // A planning answer is still to be reviewed: journaled with it, a sent-back one would stay in the transcript while its
    // objection tells the model it is "not in the conversation". It is journaled once accepted.
    payload: toJsonValue({
      content: planningAnswer ? null : final.content, toolCalls: final.toolCalls, finishReason: final.finishReason, usage: final.usage ?? {},
      providerRequestId: final.providerRequestId ?? null, providerState: final.providerState ?? null,
      ...(output.suppressedToolCalls.length > 0 ? { suppressedToolCalls: output.suppressedToolCalls } : {}),
    }),
  }, output.usageDraft, ...controlDecision, ...narrationDrafts], `assistant-message:${step.attemptId}`);
  // Journaled: this step's outcome decides whether it supersedes the narration before it (`NarrationChain`).
  if (narration.narrate) loop.narrationChain.narrated(narration.narrationId!, narration.announcement !== true);
  return { final, narration, planningAnswer };
}

/** The step's output joins the transcript; the skill suggestion, spoken to the first step, leaves it. */
function remember(loop: TurnLoop, frame: StepFrame, final: FinalLlmEvent): void {
  frame.messages.push({ role: "assistant", content: final.content, ...(final.toolCalls.length > 0 ? { toolCalls: final.toolCalls } : {}), ...(final.providerState ? { providerState: final.providerState } : {}) });
  // Loading is the model's call, made on the first step. Kept on, the suggestion would tell later steps "not loaded" after
  // the skill had loaded.
  const suggestion = loop.controlFeedback.findIndex((message) => message.context?.provenance === STEP_INSTRUCTION_PROVENANCE.skill);
  if (suggestion >= 0) {
    loop.controlFeedback.splice(suggestion, 1);
    if (loop.answeredFeedback > suggestion) loop.answeredFeedback -= 1;
  }
}
