import { randomUUID } from "node:crypto";
import { AgenticError, inPromptOrder, type RunTurnResult, type TurnControlState, type TurnModelDirective } from "@0xsyncroot/contracts";
import { JUDGMENT_CAPABILITY, LLM_CAPABILITY, MEMORY_CAPABILITY, SYSTEM_PROMPT_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import { ContextCalibration } from "./context-calibration.js";
import type { AgentRuntimeDependencies, AgentRuntimeOptions } from "./agent-options.js";
import { AgentReasoningChannel } from "./agent-reasoning-channel.js";
import { AgentOutputChannel } from "./agent-output-channel.js";
import { LlmStepExecutor } from "./llm-step-executor.js";
import { FirstEventModel } from "./first-event-model.js";
import { runModelStep } from "./model-step.js";
import { ModelContextPreparer } from "./model-context-preparer.js";
import { report } from "./operation-observers.js";
import { ExponentialRetryPolicy } from "./retry-policy.js";
import { disposeStepOutput, type StepOutcome } from "./step-disposition.js";
import { prepareDurableTurnContext } from "./turn-context-preparer.js";
import { recordInterjections } from "./turn-interjections.js";
import { isDefaultDirective, resolveTurnDirective, turnControlDecisionDraft, validateTurnControlPolicy } from "./turn-control.js";
import { createTurnJudge } from "./turn-judge.js";
import { JudgmentLatency } from "./judgment-latency.js";
import { openWaits } from "./turn-open-waits.js";
import { createResultReviewer } from "./observation-review.js";
import { StepClaimReview } from "./step-claim-review.js";
import { AnswerMovedCheck } from "./answer-moved.js";
import { skillSuggestionText, skillSummaries, visibleSkillLoads } from "./skill-relevance.js";
import { RuntimeCalls } from "./runtime-calls.js";
import { STEP_INSTRUCTION_PROVENANCE, stepInstruction } from "./step-instruction.js";
import { createResultRelevance } from "./result-relevance.js";
import { observeBeforeModel } from "./turn-observations.js";
import { classifyError } from "./error-classifier.js";
import { failureFallback, recoverable } from "./step-failure-recovery.js";
import { continueQuestionRequest } from "./runtime-question.js";
import { JudgmentMemo } from "./judgment-memo.js";
import { budgetNotice, openTurn } from "./turn-end.js";
import type { TurnNext } from "./turn-end-facts.js";
import { decideStep, recordReads, stepEnded } from "./step-decision.js";
import { attachmentsReadability, withAttachmentFacts } from "./attachment-manifest.js";
import { skillClosingLines } from "./skill-closing.js";
import { NarrationChain } from "./narration-chain.js";
import { openToolSelection, stepToolOffer } from "./tool-selection.js";
import type { TurnLoop, TurnStepLoopInput } from "./turn-step-loop-input.js";

/** The model steps of one turn: prepare each step, run the model, dispose of what it produced. */
export class TurnStepLoop {
  readonly #llmStep: LlmStepExecutor;
  readonly #calibration = new ContextCalibration();
  /** How fast the judgment provider answers and whether its advisory seams are asked, kept across turns like the calibration. */
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
    // Every step ends in `decide()` (turn-end.ts): a step carries out an end it decided and returns the turn's result; otherwise
    // the next step starts from what it decided. A step that throws is decided as failed: retried, closed, or ended. Only a
    // step that returned ran to its end and clears the run of failures; one whose last write throws after `decide()` failed.
    try {
      for (let stepIndex = startStep; ; stepIndex += 1) {
        const next = loop.next;
        if (next.kind === "end") throw new AgenticError("permanent", "Agent loop finalization did not produce a terminal outcome");
        try {
          const outcome = await this.#step(loop, stepIndex, next);
          if (outcome) return outcome;
          stepEnded(loop);
        } catch (error) {
          const code = classifyError(error).code;
          const failed = decideStep(loop, stepIndex, { kind: "failed", code, recoverable: recoverable(error, loop.turn.signal) });
          if (failed.kind !== "end") continue;
          if (failed.by === "fallback") return failureFallback(loop, stepIndex + 1, failed.reason);
          throw error;
        }
      }
    } finally {
      loop.stepClaims?.close();
      loop.answerMoved?.close();
    }
  }

  /** Everything the turn's steps share: the model route, the prompt, memory, and the policy. */
  async #open(command: TurnStepLoopInput, startStep: number): Promise<TurnLoop> {
    const { turn, setup } = command;
    const { input, turnId, writer, view, signal } = turn;
    const capabilities = turn.runtimeLease.capabilities;
    const llm = capabilities.require(LLM_CAPABILITY);
    const memory = capabilities.optional(MEMORY_CAPABILITY);
    const prompts = inPromptOrder(capabilities.all(SYSTEM_PROMPT_CAPABILITY));
    // A judgment provider is optional: without one every seam takes the path that does not ask.
    const judge = createTurnJudge(capabilities.optional(JUDGMENT_CAPABILITY), writer, turnId, this.#latency);
    const recentRequests = (await view.events()).filter((event) => event.type === "user/input")
      .map((event) => String((event.payload as { content?: unknown }).content ?? "")).slice(-3).join("\n");
    const loader = prompts.find((prompt) => prompt.skillLoader)?.skillLoader;
    const pinnedToolIds = new Set(setup.tools.filter((tool) => tool.pinnedResult).map((tool) => tool.id));
    const loadedSkills = loader ? visibleSkillLoads(await view.context(), (await view.evidence()).events, loader, pinnedToolIds) : new Set<string>();
    const memo = { verdicts: this.judgments, scope: `${input.security.tenantId}:${input.sessionId}` };
    // Tool groups are judged beside the skills; with no catalog, judge or loader the turn offers its whole surface.
    const selection = openToolSelection(this.dependencies.toolGroups, {
      tools: setup.tools, mode: this.dependencies.judgmentSeams?.toolRelevance, judge, operation: turn.operation, content: input.content, events: await view.events(),
      turnId, ...(setup.workPlanning ? { planning: setup.workPlanning } : {}), ...(loader ? { skillLoaderId: loader.toolId } : {}),
    });
    const memoryQuery = command.skipMemoryContext ? undefined : this.dependencies.memoryContextPolicy?.createQuery({
      text: input.content, sessionId: input.sessionId, security: input.security,
    });
    const { skipped, suggested, offeredToolIds, systemText, memoryContext, memoryDraft, route: resolved } = await openWaits({
      llm, memory, memoryQuery, judge, skillSeam: this.dependencies.judgmentSeams?.skillRelevance, prompts, request: recentRequests || input.content,
      loader, loadedSkills, memo, offeredToolIds: new Set(setup.tools.map((tool) => tool.id)), security: input.security, signal, writer, turnId,
      memoryTimeoutMs: this.options.memoryContextTimeoutMs, advisoryBudgetMs: this.options.advisorySetupBudgetMs, ...(selection ? { tools: selection } : {}), ...(setup.planLedger.workPlan ? { plan: setup.planLedger.workPlan } : {}),
      ...(this.dependencies.judgmentFallbackModel ? { fallbackModel: this.dependencies.judgmentFallbackModel } : {}),
    });
    if (memoryDraft) await writer.append([memoryDraft], `memory-context:${turnId}`);
    const opening = selection?.openingDraft(turnId);
    if (opening) await writer.append([opening], `tool-selection:${turnId}`);
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
    // What the conversation's files are this turn: their manifests say it, and a policy reads the task's as `unavailable.attachments`.
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
    // The judge alone naming one skill decides it: the runtime loads it before the first model call (`RuntimeCalls`), when the
    // loader's result is instructions the model reads as such (`pinnedResult`); otherwise the note names it, as before.
    const note = suggested.length && loader ? stepInstruction(skillSuggestionText(suggested, loader.toolId), STEP_INSTRUCTION_PROVENANCE.skill) : undefined;
    const skill = note && suggested.length === 1 && suggested[0]!.by === "judge" && offeredToolIds.has(loader!.toolId) && pinnedToolIds.has(loader!.toolId) ? suggested[0]! : undefined;
    return {
      turn, setup, llm, route, calibration: this.#calibration, controlPolicy, contextPreparer, services: Object.freeze(judge ? { judge } : {}),
      reviewResult: createResultReviewer(judge, this.dependencies.judgmentSeams?.observationReview, recentRequests || input.content, signal, this.dependencies.judgmentSeams?.observationState),
      stepClaims: judge && (this.dependencies.judgmentSeams?.stepClaim ?? "off") !== "off"
        ? new StepClaimReview(judge, this.dependencies.judgmentSeams!.stepClaim as "shadow" | "on", recentRequests || input.content, signal) : undefined,
      answerMoved: judge && (this.dependencies.judgmentSeams?.answerMoved ?? "off") !== "off"
        ? new AnswerMovedCheck(judge, this.dependencies.judgmentSeams!.answerMoved as "shadow" | "on", recentRequests || input.content, signal) : undefined,
      offerTools: stepToolOffer(selection, setup.tools, { events: () => view.events(), writer, turnId, prompts, skippedSkills: skipped }),
      ...(selection ? { groupLoad: (toolId: string) => selection.loadFor(toolId) } : {}),
      controlTools: Object.freeze(setup.tools.map(({ id, version, sideEffect, computes }) => Object.freeze({ id, version, sideEffect, ...(computes ? { computes } : {}) }))),
      controlSkills: Object.freeze(skillSummaries(prompts)),
      bounds: this.options, ...openTurn(this.options, startStep, { toolCalls: setup.coordinator.toolCalls, wrote: setup.coordinator.wrote }), step: undefined,
      unavailable: withAttachmentFacts(setup.unavailable, attachments),
      skillClosings: (events) => skillClosingLines(prompts, { ...(skipped.size ? { skippedSkills: skipped } : {}), offeredToolIds }, events, setup.taskTurnIds),
      taskTurnIds: setup.taskTurnIds,
      controlFeedback: note && !skill ? [note] : [], answeredFeedback: 0,
      runtimeCalls: new RuntimeCalls({ judge, nextCall: this.dependencies.judgmentSeams?.nextCall, sources: this.dependencies.nextCallSources,
        ...(skill ? { skillLoad: { ...loader!, skill, note: note! } } : {}), excluded: (toolId) => toolId === loader?.toolId || toolId === this.dependencies.toolGroups?.loader.toolId }),
      reasoningDraft: new AgentReasoningChannel(input, turnId),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, withheldText: null,
      workNotes: [], modelDispatchedWork: false,
      narratedText: undefined, keptDraft: undefined,
      narrationChain: new NarrationChain(),
      closing: undefined,
      continueQuestion: this.dependencies.continueQuestion ? continueQuestionRequest(this.dependencies.continueQuestion) : undefined,
    };
  }

  async #step(loop: TurnLoop, stepIndex: number, next: Extract<TurnNext, { kind: "continue" | "closing" }>): Promise<StepOutcome> {
    const { turn, setup, controlPolicy } = loop;
    const { input, turnId, writer, view, signal } = turn;
    if (signal.aborted) throw signal.reason;
    // A step is progress. Restarting here is what lets a long read outlive the silence window
    // instead of being cut because the turn, added up, crossed it.
    turn.noteProgress();
    // Before anything this step reads: the user may have corrected course while the last step ran.
    await recordInterjections(turn, stepIndex);
    // One cause per step, the one `decide()` closed it with: the final-step instruction, the journal and the review state say it.
    const stopReason = next.kind === "closing" ? next.reason : undefined;
    const finalBudgetStep = stopReason !== undefined;
    loop.step = { stepIndex, ...(stopReason ? { finalReason: stopReason } : {}) };
    let durableTurnContext = await prepareDurableTurnContext({
      ...(this.dependencies.turnContextProvider ? { provider: this.dependencies.turnContextProvider } : {}),
      operation: turn.operation, command: input, turnId, writer, view, taskTurnIds: loop.taskTurnIds, signal,
      ...(this.dependencies.modelInstructions?.contextStateLabel ? { contextStateLabel: this.dependencies.modelInstructions.contextStateLabel } : {}),
    });
    const stepId = randomUUID();
    await writer.append([{ type: "step/start", turnId, stepId, payload: { index: stepIndex } }], `step-start:${stepId}`);
    report(input, { type: "step-started", turnId, step: stepIndex });
    await loop.runtimeCalls.loadSkill(loop, stepId, stepIndex);
    const offered = await loop.offerTools(stepId);
    const controlState: TurnControlState = Object.freeze({
      sessionId: input.sessionId, turnId, stepIndex, maxSteps: loop.ledger.allowance.granted, security: input.security,
      runtime: turn.runtimeLease.snapshot, context: await view.evidence(), availableTools: loop.controlTools, taskTurnIds: loop.taskTurnIds,
      ...(loop.controlSkills.length ? { availableSkills: loop.controlSkills } : {}),
      ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}),
      ...(input.applicationContext ? { applicationContext: input.applicationContext } : {}),
      ...(setup.planLedger.workPlan ? { workPlan: setup.planLedger.workPlan } : {}),
      ...(stopReason ? { finalStep: Object.freeze({ reason: stopReason }) } : {}),
      ...(loop.unavailable ? { unavailable: loop.unavailable } : {}),
    });
    // Any last step may still ask the user: a fact only they hold is asked as a form, not as a sentence — also past the
    // tool-call ceiling, which asking does not count against. Otherwise a turn stopped by its allowance ends on
    // questions in prose with nothing to click.
    const askTools = Object.freeze(setup.tools.filter((tool) => tool.asksUser === true));
    const askToolIds = Object.freeze(askTools.map((tool) => tool.id));
    const effective = finalBudgetStep
      ? { directive: Object.freeze<TurnModelDirective>({ allowedToolIds: askToolIds, toolChoice: askTools.length ? "auto" : "none" }), tools: askTools }
      : await resolveTurnDirective(controlPolicy, controlState, setup.tools, signal, loop.services, offered);
    if (effective.directive.stop) return this.#stop(loop, stepId, stepIndex, effective.directive.stop);
    if (controlPolicy && !finalBudgetStep && !isDefaultDirective(effective.directive)) {
      await writer.append([turnControlDecisionDraft(controlPolicy, turnId, stepId, "before-model", "apply", {
        allowedToolIds: effective.tools.map((tool) => tool.id),
        toolChoice: effective.directive.toolChoice ?? "auto",
        ...(effective.directive.observations ? { observations: effective.directive.observations.map((observation) => observation.toolId) } : {}),
      })], `turn-control:before-model:${stepId}`);
    }
    // The policy's own reads run first, and its reviews then see them: the state it was handed predates them.
    let reviewState = controlPolicy && !finalBudgetStep
      ? recordReads(loop, await observeBeforeModel({
          policy: controlPolicy, directive: effective.directive, state: controlState, toolBatch: setup.toolBatch, view, stepId,
          runtimeRouteRevision: turn.runtimeLease.binding.routeRevision, signal,
        }))
      : controlState;
    // A policy paging through a source may ask for the next page once it has seen this one. Each
    // further round is the policy's decision on what the journal now holds, bounded per step and by
    // the turn's tool-call cap; the default of one round is the behaviour every product had.
    for (let round = 2; controlPolicy && !finalBudgetStep && (effective.directive.observations?.length ?? 0) > 0 &&
      round <= this.options.maxObservationRounds && !setup.coordinator.budgetExhausted; round += 1) {
      const next = await resolveTurnDirective(controlPolicy, reviewState, setup.tools, signal, loop.services, offered);
      if (next.directive.stop) return this.#stop(loop, stepId, stepIndex, next.directive.stop);
      if ((next.directive.observations?.length ?? 0) === 0) break;
      await writer.append([turnControlDecisionDraft(controlPolicy, turnId, stepId, "before-model", "apply", {
        observations: next.directive.observations!.map((observation) => observation.toolId), round,
      })], `turn-control:before-model:${stepId}:${round}`);
      reviewState = recordReads(loop, await observeBeforeModel({
        policy: controlPolicy, directive: next.directive, state: reviewState, toolBatch: setup.toolBatch, view, stepId, round,
        runtimeRouteRevision: turn.runtimeLease.binding.routeRevision, signal,
      }));
    }
    if ((effective.directive.observations?.length ?? 0) > 0) {
      durableTurnContext = await prepareDurableTurnContext({
        ...(this.dependencies.turnContextProvider ? { provider: this.dependencies.turnContextProvider } : {}),
        operation: turn.operation, command: input, turnId, writer, view, taskTurnIds: loop.taskTurnIds, signal,
        ...(this.dependencies.modelInstructions?.contextStateLabel ? { contextStateLabel: this.dependencies.modelInstructions.contextStateLabel } : {}),
      });
      // An observation may have established an outage. Recheck only for a stop; any next
      // observations still belong to the next step, so this never forms a hidden tool loop.
      const failed = reviewState.context.events.some(event => event.stepId === stepId && event.type === "tool/result" &&
        (event.payload as { state?: string }).state !== "succeeded");
      if (failed && controlPolicy) {
        const checked = await resolveTurnDirective(controlPolicy, reviewState, setup.tools, signal, loop.services, offered);
        if (checked.directive.stop) return this.#stop(loop, stepId, stepIndex, checked.directive.stop);
      }
    }
    if (!finalBudgetStep) reviewState = recordReads(loop, await loop.runtimeCalls.followUp(loop, stepId, stepIndex, effective.tools, reviewState));
    const answerDraft = new AgentOutputChannel(input, turnId);
    const notice = budgetNotice(loop.ledger, loop.bounds, stepIndex);
    const model = await runModelStep(this.#llmStep, loop, {
      stepId, stepIndex, finalBudgetStep, plain: finalBudgetStep && this.options.closingStepReasoning !== "keep", modelTools: effective.tools, durableTurnContext, answerDraft,
      ...(effective.directive.toolChoice ? { toolChoice: effective.directive.toolChoice } : {}),
      ...(notice ? { budgetNotice: notice } : {}),
      ...(stopReason ? { progress: {
        notes: loop.workNotes, stopReason, ...(askTools.length ? { askTools: askToolIds } : {}),
        ...(setup.planLedger.workPlan ? { plan: { plan: setup.planLedger.workPlan, shown: setup.subGoals.shownSteps(setup.planLedger.workPlan) } } : {}),
        ...(loop.closing ? { closing: { ...loop.closing, ...(askTools.length ? { askTools: askToolIds } : {}) } } : {}),
      } } : {}),
    });
    return disposeStepOutput(loop, {
      stepId, stepIndex, finalBudgetStep, directive: effective.directive, modelTools: effective.tools,
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
