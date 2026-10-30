import { AgenticError, type ChatMessage, type LlmToolChoice, type ToolDefinition } from "@0xsyncroot/contracts";
import type { AgentOutputChannel } from "./agent-output-channel.js";
import { classifyError } from "./error-classifier.js";
import type { TurnProgress } from "./final-step-instruction.js";
import type { LlmStepExecutor, LlmStepResult } from "./llm-step-executor.js";
import { resolveLlmModel } from "./llm-model-context.js";
import { modelToolSchema } from "./model-tool-schema.js";
import { report } from "./operation-observers.js";
import { watchInterjections } from "./step-interruption.js";
import type { TurnLoop } from "./turn-step-loop-input.js";

export interface ModelStepInput {
  readonly stepId: string;
  readonly stepIndex: number;
  readonly finalBudgetStep: boolean;
  /** Ask the model without private reasoning (`LlmStepCommand.plain`). */
  readonly plain?: boolean;
  readonly modelTools: readonly ToolDefinition[];
  readonly toolChoice?: LlmToolChoice;
  readonly durableTurnContext: readonly ChatMessage[];
  readonly budgetNotice?: string;
  /** The turn's own record so far, for the final step's instruction. */
  readonly progress?: TurnProgress;
  readonly answerDraft: AgentOutputChannel;
}

/**
 * Prepares the step's context and runs its model call, streaming drafts as they arrive. Input the user adds while the call runs
 * cuts it (`watchInterjections`): the result is then `undefined`, the drafts discarded, and the step is the caller's to end as
 * interjected.
 *
 * A provider that rejects the request as too large gets one bounded compact-and-retry. When the
 * step fails anyway, its drafts are discarded, the step is ended as failed, and the error goes on
 * to end the turn.
 */
export async function runModelStep(
  llmStep: LlmStepExecutor, loop: TurnLoop, step: ModelStepInput,
): Promise<{ readonly result: LlmStepResult | undefined; readonly messages: ChatMessage[] }> {
  const { input, turnId, writer, signal } = loop.turn;
  const { stepId, stepIndex, answerDraft } = step;
  const prepare = (trigger?: "context-overflow") => loop.contextPreparer.prepare({
    model: loop.route,
    finalBudgetStep: step.finalBudgetStep, tools: step.modelTools.map(modelToolSchema),
    // Objections the model has acted on are not sent again: kept, they would be hoisted into the system prompt, change its
    // cached prefix every lap and stand there as standing rules.
    durableTurnContext: step.durableTurnContext, controlFeedback: [],
    currentFeedback: loop.controlFeedback.slice(loop.answeredFeedback),
    ...(step.budgetNotice ? { budgetNotice: step.budgetNotice } : {}), ...(step.progress ? { progress: step.progress } : {}),
    ...(trigger ? { trigger } : {}),
  });
  const interruption = watchInterjections(loop, stepIndex);
  try {
    // The skills in effect now, the ones loaded in this turn's earlier steps included: their lines close the request.
    const closingLines = loop.skillClosings(await loop.turn.view.events());
    let prepared = await prepare();
    let maxContextChars = prepared.assessment.maxContextChars;
    let sentChars = 0;
    for (let overflowRecovery = 0; overflowRecovery < 2; overflowRecovery += 1) {
      // Input that came while the step read before its model, or while an overflow was recovered from: no call is made for
      // an answer that would be thrown away.
      if (interruption.cut()) throw interruption.signal.reason;
      try {
        const result = await llmStep.execute({
          turnId, stepId, runtimeSnapshotId: loop.turn.runtimeLease.snapshot.id, messages: prepared.messages, llm: loop.llm,
          resolvedModel: loop.route, tools: step.modelTools, ...(step.toolChoice ? { toolChoice: step.toolChoice } : {}), finalStep: step.finalBudgetStep,
          ...(step.plain ? { plain: true } : {}), writer, signal, interrupt: interruption.signal, maxContextChars, onRequestSized: (chars) => { sentChars = chars; }, ...(closingLines.length ? { closingLines } : {}),
          onAttemptStarted: (attemptId) => report(input, { type: "model-attempt-started", turnId, step: stepIndex, attemptId }),
          onReasoningStarted: (attemptId, id) => loop.reasoningDraft.start(id, stepIndex, attemptId),
          // A model that is still streaming is working: its tokens restart the turn's silence clock, so a long reasoning step is
          // never cut as a hung turn while it is still writing.
          onReasoningDelta: (delta, _attemptId, id) => { loop.turn.noteProgress(); loop.reasoningDraft.delta(id, delta); },
          onReasoningEnded: (_attemptId, id, status) => loop.reasoningDraft.end(id, status),
          onOutputStarted: (attemptId, itemId) => {
            report(input, { type: "output-item-started", turnId, step: stepIndex, attemptId, itemId });
            report(input, { type: "content-started", turnId, step: stepIndex, attemptId });
            answerDraft.start(itemId);
          },
          onTextDelta: (delta, attemptId, itemId) => {
            loop.turn.noteProgress();
            report(input, { type: "output-item-delta", turnId, step: stepIndex, attemptId, itemId, delta });
            report(input, { type: "content-delta", turnId, step: stepIndex, attemptId, delta });
            answerDraft.delta(itemId, delta);
          },
          onOutputCompleted: (attemptId, itemId) => report(input, { type: "output-item-completed", turnId, step: stepIndex, attemptId, itemId }),
          onAttemptCommitted: (attemptId, itemId) => {
            answerDraft.commit(itemId);
            report(input, { type: "model-attempt-committed", turnId, step: stepIndex, attemptId, ...(itemId ? { itemId } : {}) });
          },
          onAttemptDiscarded: (attemptId, code, willRetry, itemId) => {
            answerDraft.end(itemId, "discarded");
            report(input, { type: "model-attempt-discarded", turnId, step: stepIndex, attemptId, code, willRetry, ...(itemId ? { itemId } : {}) });
          },
        });
        loop.route = loop.calibration.learn(loop.route, result.requestChars, result.final.usage?.inputTokens);
        return { result, messages: prepared.messages };
      } catch (error) {
        if (overflowRecovery > 0 || classifyError(error).code !== "context-overflow") throw error;
        // The refusal can teach the adapter a smaller real window. Use it for this
        // recovery and subsequent steps, rather than the route cached at turn start.
        const previousWindow = loop.route.contextWindowTokens;
        loop.route = loop.calibration.learn(loop.calibration.apply(await resolveLlmModel(loop.llm, signal)), sentChars,
          error instanceof AgenticError ? error.inputTokens : undefined);
        const learnedSmallerWindow = loop.route.contextWindowTokens !== undefined &&
          (previousWindow === undefined || loop.route.contextWindowTokens < previousWindow);
        await writer.append([{ type: "model/route-selected", turnId, payload: {
          ...loop.route, contextWindowTokens: loop.route.contextWindowTokens ?? null,
          maxOutputTokens: loop.route.maxOutputTokens ?? null, tokenizerId: loop.route.tokenizerId ?? null,
        } }], `model-route-recovery:${stepId}`);
        prepared = await prepare("context-overflow");
        // targetContextChars budgets retained conversation only. Passing it as the total
        // budget leaves a negative allowance once tool schemas are subtracted, which fails
        // as "budget-exceeded" and makes this recovery path unreachable.
        // A newly stated real window is the hard bound. The smaller summary target
        // need not fit required instructions and progress, even when the window does.
        maxContextChars = learnedSmallerWindow ? prepared.assessment.maxContextChars
          : Math.min(prepared.assessment.maxContextChars, prepared.assessment.targetContextChars + prepared.toolChars);
      }
    }
    throw new AgenticError("context-overflow", "Context overflow recovery did not produce a model response");
  } catch (error) {
    answerDraft.discardAll();
    loop.reasoningDraft.endAll("discarded");
    if (interruption.cut(error)) return { result: undefined, messages: [] };
    await writer.append([{ type: "step/end", turnId, stepId, payload: { status: "failed", ...classifyError(error) } }], `step-end:${stepId}`);
    throw error;
  } finally {
    interruption.dispose();
  }
}
