import { randomUUID } from "node:crypto";
import { AgenticError, inPromptOrder, type RunTurnResult, type TurnControlState, type TurnModelDirective } from "@0xsyncroot/contracts";
import { JUDGMENT_CAPABILITY, LLM_CAPABILITY, MEMORY_CAPABILITY, SYSTEM_PROMPT_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import { ContextCalibration } from "../../../src/agent/context-calibration.js";
import type { AgentRuntimeDependencies, AgentRuntimeOptions } from "../../../src/agent/agent-options.js";
import { AgentReasoningChannel } from "../../../src/agent/agent-reasoning-channel.js";
import { AgentOutputChannel } from "../../../src/agent/agent-output-channel.js";
import { LlmStepExecutor } from "../../../src/agent/llm-step-executor.js";
import { FirstEventModel } from "../../../src/agent/first-event-model.js";
import { runModelStep } from "../../../src/agent/model-step.js";
import { ModelContextPreparer } from "../../../src/agent/model-context-preparer.js";
import { report } from "../../../src/agent/operation-observers.js";
import { ExponentialRetryPolicy } from "../../../src/agent/retry-policy.js";
import { StepBudget } from "./step-budget.js";
import { disposeStepOutput, type StepOutcome } from "./step-disposition.js";
import { prepareDurableTurnContext } from "../../../src/agent/turn-context-preparer.js";
import { recordInterjections } from "../../../src/agent/turn-interjections.js";
import { resolveTurnDirective, turnControlDecisionDraft, validateTurnControlPolicy } from "./turn-control.js";
import { createTurnJudge } from "../../../src/agent/turn-judge.js";
import { JudgmentLatency } from "../../../src/agent/judgment-latency.js";
import { openWaits } from "../../../src/agent/turn-open-waits.js";
import { createResultReviewer } from "../../../src/agent/observation-review.js";
import { StepClaimReview } from "../../../src/agent/step-claim-review.js";
import { skillSuggestionText, skillSummaries, visibleSkillLoads } from "../../../src/agent/skill-relevance.js";
import { STEP_INSTRUCTION_PROVENANCE, stepInstruction } from "../../../src/agent/step-instruction.js";
import { createResultRelevance } from "../../../src/agent/result-relevance.js";
import { observeBeforeModel } from "../../../src/agent/turn-observations.js";
import { classifyError } from "./error-classifier.js";
import { failureFallback, recoverable, STEP_RETRIES } from "./step-failure-recovery.js";
import { continueQuestionRequest } from "../../../src/agent/runtime-question.js";
import { JudgmentMemo } from "../../../src/agent/judgment-memo.js";
import { WORK_REMAINS_CLOSING } from "./step-answer.js";
import { attachmentsReadability, withAttachmentFacts } from "../../../src/agent/attachment-manifest.js";
import { skillClosingLines } from "../../../src/agent/skill-closing.js";
import { NarrationChain } from "../../../src/agent/narration-chain.js";
import type { TurnLoop, TurnStepLoopInput } from "../../../src/agent/turn-step-loop-input.js";

const TOOL_CALL_EXTENSION = 16;
const TOOL_CALL_HARD_FACTOR = 4;

function isDefaultDirective(directive: TurnModelDirective): boolean {
  return directive.allowedToolIds === undefined && (directive.toolChoice === undefined || directive.toolChoice === "auto") &&
    (directive.observations?.length ?? 0) === 0 && !directive.stop;
}

export class TurnStepLoop {
  readonly #llmStep: LlmStepExecutor;
  readonly #calibration = new ContextCalibration();
  readonly #latency = new JudgmentLatency();

  constructor(
    private readonly options: AgentRuntimeOptions,
    private readonly dependencies: AgentRuntimeDependencies,
    private readonly judgments = new JudgmentMemo(), firstEvents = new FirstEventModel(),
  ) {
    this.#llmStep = new LlmStepExecutor(
      options.maxContextChars,
      new ExponentialRetryPolicy(options.maxLlmAttempts, options.retryBaseDelayMs),
      options.llmAttemptTimeoutMs,
      dependencies.modelInstructions,
      options.llmHedgeAfterMs, options.maxAnswerChars, firstEvents,
    );
  }

  async execute(command: TurnStepLoopInput): Promise<RunTurnResult> {
    const startStep = command.startStepIndex ?? 1;
    const loop = await this.#open(command, startStep);
    let failures = 0;
    try {
      for (let stepIndex = startStep; stepIndex <= loop.budget.granted; stepIndex += 1) {
        try {
          const outcome = await this.#step(loop, stepIndex);
          if (outcome) return outcome;
          if (loop.failure === undefined) failures = 0;
        } catch (error) {
          if (!recoverable(error, loop.turn.signal)) throw error;
          failures += 1;
          const code = classifyError(error).code;
          if (failures > STEP_RETRIES + 1) return failureFallback(loop, stepIndex + 1, code);
          if (failures > STEP_RETRIES) loop.failure = code;
          loop.budget.grantRecoveryStep(stepIndex);
        }
      }
      throw new AgenticError("permanent", "Agent loop finalization did not produce a terminal outcome");
    } finally {
      loop.stepClaims?.close();
    }
  }

  async #open(command: TurnStepLoopInput, startStep: number): Promise<TurnLoop> {
    const { turn, setup } = command;
    const { input, turnId, writer, view, signal } = turn;
    const capabilities = turn.runtimeLease.capabilities;
    const llm = capabilities.require(LLM_CAPABILITY);
    const memory = capabilities.optional(MEMORY_CAPABILITY);
    const prompts = inPromptOrder(capabilities.all(SYSTEM_PROMPT_CAPABILITY));
    const judge = createTurnJudge(capabilities.optional(JUDGMENT_CAPABILITY), writer, turnId, this.#latency);
    const recentRequests = (await view.events()).filter((event) => event.type === "user/input")
      .map((event) => String((event.payload as { content?: unknown }).content ?? "")).slice(-3).join("\n");
    const loader = prompts.find((prompt) => prompt.skillLoader)?.skillLoader;
    const pinnedToolIds = new Set(setup.tools.filter((tool) => tool.pinnedResult).map((tool) => tool.id));
    const loadedSkills = loader ? visibleSkillLoads(await view.context(), (await view.evidence()).events, loader, pinnedToolIds) : new Set<string>();
    const memo = { verdicts: this.judgments, scope: `${input.security.tenantId}:${input.sessionId}` };
    const offeredToolIds = new Set(setup.tools.map((tool) => tool.id));
    const memoryQuery = command.skipMemoryContext ? undefined : this.dependencies.memoryContextPolicy?.createQuery({
      text: input.content, sessionId: input.sessionId, security: input.security,
    });
    const { skipped, suggested, systemText, memoryContext, memoryDraft, route: resolved } = await openWaits({
      llm, memory, memoryQuery, judge, skillSeam: this.dependencies.judgmentSeams?.skillRelevance, prompts, request: recentRequests || input.content,
      loader, loadedSkills, memo, offeredToolIds, security: input.security, signal, writer, turnId, memoryTimeoutMs: this.options.memoryContextTimeoutMs,
      ...(this.dependencies.judgmentFallbackModel ? { fallbackModel: this.dependencies.judgmentFallbackModel } : {}),
    });
    if (memoryDraft) await writer.append([memoryDraft], `memory-context:${turnId}`);
    const route = this.#calibration.apply(resolved);
    await writer.append([{
      type: "model/route-selected", turnId,
      payload: {
        providerId: route.providerId, adapterId: route.adapterId, modelId: route.modelId,
        routeRevision: route.routeRevision, metadataSource: route.metadataSource,
        contextWindowTokens: route.contextWindowTokens ?? null,
        maxOutputTokens: route.maxOutputTokens ?? null,
        tokenizerId: route.tokenizerId ?? null,
      },
    }], `model-route:${turnId}:${route.routeRevision}`);
    const resultRelevance = createResultRelevance(judge, this.dependencies.judgmentSeams?.resultRelevance, recentRequests || input.content, signal, pinnedToolIds,
      new Set(setup.tools.filter((tool) => tool.restoresResult).map((tool) => tool.id)), this.judgments);
    const attachments = attachmentsReadability(setup.attachmentReaders, await view.events(), setup.taskTurnIds);
    const contextPreparer = new ModelContextPreparer({
      llm, model: route, writer, view, security: input.security, turnId, systemText, taskTurnIds: setup.taskTurnIds,
      ...(memoryContext?.contextText ? { memoryContextText: memoryContext.contextText } : {}),
      maxContextChars: this.options.maxContextChars,
      ...(this.dependencies.conversationCompactor ? { conversationCompactor: this.dependencies.conversationCompactor } : {}),
      ...(this.dependencies.contextCompactionPolicy ? { contextCompactionPolicy: this.dependencies.contextCompactionPolicy } : {}),
      ...(resultRelevance ? { resultRelevance } : {}),
      pinnedToolIds,
      ...(attachments ? { attachments } : {}),
      signal,
    });
    const controlPolicy = this.dependencies.turnControlPolicy;
    if (controlPolicy) validateTurnControlPolicy(controlPolicy);
    return {
      turn, setup, llm, route, calibration: this.#calibration, controlPolicy, contextPreparer, services: Object.freeze(judge ? { judge } : {}),
      reviewResult: createResultReviewer(judge, this.dependencies.judgmentSeams?.observationReview, recentRequests || input.content, signal, this.dependencies.judgmentSeams?.observationState),
      stepClaims: judge && (this.dependencies.judgmentSeams?.stepClaim ?? "off") !== "off"
        ? new StepClaimReview(judge, this.dependencies.judgmentSeams!.stepClaim as "shadow" | "on", recentRequests || input.content, signal) : undefined,
      controlTools: Object.freeze(setup.tools.map(({ id, version, sideEffect, computes }) => Object.freeze({ id, version, sideEffect, ...(computes ? { computes } : {}) }))),
      controlSkills: Object.freeze(skillSummaries(prompts)),
      budget: new StepBudget(this.options, startStep),
      unavailable: withAttachmentFacts(setup.unavailable, attachments),
      skillClosings: (events) => skillClosingLines(prompts, { ...(skipped.size ? { skippedSkills: skipped } : {}), offeredToolIds }, events, setup.taskTurnIds),
      taskTurnIds: setup.taskTurnIds,
      controlFeedback: suggested.length && loader ? [stepInstruction(skillSuggestionText(suggested, loader.toolId), STEP_INSTRUCTION_PROVENANCE.skill)] : [], answeredFeedback: 0,
      reasoningDraft: new AgentReasoningChannel(input, turnId),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      withheldText: null,
      workNotes: [],
      modelDispatchedWork: false,
      narratedText: undefined,
      keptDraft: undefined,
      narrationChain: new NarrationChain(),
      closing: undefined,
      failure: undefined,
      continueQuestion: this.dependencies.continueQuestion ? continueQuestionRequest(this.dependencies.continueQuestion) : undefined,
    };
  }

  async #step(loop: TurnLoop, stepIndex: number): Promise<StepOutcome> {
    const { turn, setup, budget, controlPolicy } = loop;
    const { input, turnId, writer, view, signal } = turn;
    if (signal.aborted) throw signal.reason;
    turn.noteProgress();
    budget.noteActivity();
    await recordInterjections(turn, stepIndex);
    const toolBudgetReached = setup.coordinator.budgetExhausted
      && !(budget.progressing && setup.coordinator.extendToolCalls(TOOL_CALL_EXTENSION, this.options.maxToolCalls * TOOL_CALL_HARD_FACTOR));
    const finalBudgetStep = toolBudgetReached || budget.isFinalStep(stepIndex) || loop.closing !== undefined || loop.failure !== undefined;
    const stopReason = !finalBudgetStep ? undefined : loop.failure ? `step-failure (${loop.failure})` : toolBudgetReached ? "tool-call-limit"
      : loop.closing ? WORK_REMAINS_CLOSING : budget.stopReason(stepIndex);
    let durableTurnContext = await prepareDurableTurnContext({
      ...(this.dependencies.turnContextProvider ? { provider: this.dependencies.turnContextProvider } : {}),
      operation: turn.operation, command: input, turnId, writer, view, taskTurnIds: loop.taskTurnIds, signal,
      ...(this.dependencies.modelInstructions?.contextStateLabel ? { contextStateLabel: this.dependencies.modelInstructions.contextStateLabel } : {}),
    });
    const stepId = randomUUID();
    const startedAt = Date.now();
    await writer.append([{ type: "step/start", turnId, stepId, payload: { index: stepIndex } }], `step-start:${stepId}`);
    report(input, { type: "step-started", turnId, step: stepIndex });
    const controlState: TurnControlState = Object.freeze({
      sessionId: input.sessionId, turnId, stepIndex, maxSteps: budget.granted, security: input.security,
      runtime: turn.runtimeLease.snapshot, context: await view.evidence(), availableTools: loop.controlTools, taskTurnIds: loop.taskTurnIds,
      ...(loop.controlSkills.length ? { availableSkills: loop.controlSkills } : {}),
      ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}),
      ...(input.applicationContext ? { applicationContext: input.applicationContext } : {}),
      ...(setup.planLedger.workPlan ? { workPlan: setup.planLedger.workPlan } : {}),
      ...(stopReason ? { finalStep: Object.freeze({ reason: stopReason }) } : {}),
      ...(loop.unavailable ? { unavailable: loop.unavailable } : {}),
    });
    const askTools = Object.freeze(setup.tools.filter((tool) => tool.asksUser === true));
    const askToolIds = Object.freeze(askTools.map((tool) => tool.id));
    const effective = finalBudgetStep
      ? { directive: Object.freeze<TurnModelDirective>({ allowedToolIds: askToolIds, toolChoice: askTools.length ? "auto" : "none" }), tools: askTools }
      : await resolveTurnDirective(controlPolicy, controlState, setup.tools, signal, loop.services);
    if (effective.directive.stop) return this.#stop(loop, stepId, stepIndex, effective.directive.stop);
    if (controlPolicy && !finalBudgetStep && !isDefaultDirective(effective.directive)) {
      await writer.append([turnControlDecisionDraft(controlPolicy, turnId, stepId, "before-model", "apply", {
        allowedToolIds: effective.tools.map((tool) => tool.id),
        toolChoice: effective.directive.toolChoice ?? "auto",
        ...(effective.directive.observations ? { observations: effective.directive.observations.map((observation) => observation.toolId) } : {}),
      })], `turn-control:before-model:${stepId}`);
    }
    let reviewState = controlPolicy && !finalBudgetStep
      ? await observeBeforeModel({
          policy: controlPolicy, directive: effective.directive, state: controlState, toolBatch: setup.toolBatch, view, stepId,
          runtimeRouteRevision: turn.runtimeLease.binding.routeRevision, signal,
        })
      : controlState;
    for (let round = 2; controlPolicy && !finalBudgetStep && (effective.directive.observations?.length ?? 0) > 0 &&
      round <= this.options.maxObservationRounds && !setup.coordinator.budgetExhausted; round += 1) {
      const next = await resolveTurnDirective(controlPolicy, reviewState, setup.tools, signal, loop.services);
      if (next.directive.stop) return this.#stop(loop, stepId, stepIndex, next.directive.stop);
      if ((next.directive.observations?.length ?? 0) === 0) break;
      await writer.append([turnControlDecisionDraft(controlPolicy, turnId, stepId, "before-model", "apply", {
        observations: next.directive.observations!.map((observation) => observation.toolId), round,
      })], `turn-control:before-model:${stepId}:${round}`);
      reviewState = await observeBeforeModel({
        policy: controlPolicy, directive: next.directive, state: reviewState, toolBatch: setup.toolBatch, view, stepId, round,
        runtimeRouteRevision: turn.runtimeLease.binding.routeRevision, signal,
      });
    }
    if ((effective.directive.observations?.length ?? 0) > 0) {
      durableTurnContext = await prepareDurableTurnContext({
        ...(this.dependencies.turnContextProvider ? { provider: this.dependencies.turnContextProvider } : {}),
        operation: turn.operation, command: input, turnId, writer, view, taskTurnIds: loop.taskTurnIds, signal,
        ...(this.dependencies.modelInstructions?.contextStateLabel ? { contextStateLabel: this.dependencies.modelInstructions.contextStateLabel } : {}),
      });
      const failed = reviewState.context.events.some(event => event.stepId === stepId && event.type === "tool/result" &&
        (event.payload as { state?: string }).state !== "succeeded");
      if (failed && controlPolicy) {
        const checked = await resolveTurnDirective(controlPolicy, reviewState, setup.tools, signal, loop.services);
        if (checked.directive.stop) return this.#stop(loop, stepId, stepIndex, checked.directive.stop);
      }
    }
    const answerDraft = new AgentOutputChannel(input, turnId);
    const budgetNotice = budget.budgetNotice(stepIndex);
    const model = await runModelStep(this.#llmStep, loop, {
      stepId, stepIndex, finalBudgetStep, modelTools: effective.tools, durableTurnContext, answerDraft,
      ...(effective.directive.toolChoice ? { toolChoice: effective.directive.toolChoice } : {}),
      ...(budgetNotice ? { budgetNotice } : {}),
      ...(stopReason ? { progress: {
        notes: loop.workNotes, stopReason, ...(setup.planLedger.workPlan ? { plan: setup.planLedger.workPlan } : {}), ...(askTools.length ? { askTools: askToolIds } : {}),
        ...(loop.closing ? { closing: { ...loop.closing, ...(askTools.length ? { askTools: askToolIds } : {}) } } : {}),
      } } : {}),
    });
    return disposeStepOutput(loop, {
      stepId, stepIndex, startedAt, finalBudgetStep, directive: effective.directive, modelTools: effective.tools,
      ...(stopReason ? { stopReason } : {}),
      reviewState, messages: model.messages, answerDraft,
    }, model.result);
  }

  #stop(loop: TurnLoop, stepId: string, stepIndex: number, stop: NonNullable<TurnModelDirective["stop"]>): Promise<RunTurnResult> {
    const { turn } = loop;
    return turn.terminator.finishFallback({ stepId, stepIndex, content: stop.content, reason: stop.reason, usage: loop.usage,
      drafts: [turnControlDecisionDraft(loop.controlPolicy!, turn.turnId, stepId, "before-model", "stop", { reason: stop.reason }),
        { type: "assistant/message", turnId: turn.turnId, stepId, requestId: `policy-stop:${stepId}`, attemptId: `policy-stop:${stepId}`,
          payload: { content: stop.content, toolCalls: [], finishReason: stop.reason, usage: {} } }],
    });
  }
}
