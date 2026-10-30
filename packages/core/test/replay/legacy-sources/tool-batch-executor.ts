import {
  AgenticError,
  interactionTtlMs,
  type AgentProgressEvent,
  type ChatMessage,
  type EventDraft,
  type JsonValue, type ToolAttempt, type ToolCall, type WorkPlan,
} from "@0xsyncroot/contracts";
import { toJsonValue } from "../../../src/agent/json-value.js";
import { dispatchPlanningCall } from "../../../src/agent/plan-call-execution.js";
import type { PreparedToolExecution, ToolExecutionCoordinator, ToolExecutionResult, ToolPreparation } from "./tool-execution-coordinator.js";
import type { TurnEventWriter } from "../../../src/agent/turn-event-writer.js";
import type { WorkPlanLedger } from "../../../src/agent/work-plan-ledger.js";
import type { WorkStateTracker } from "../../../src/agent/work-state-tracker.js";
import { createInteractionContinuation, interactionOutcomeNote } from "../../../src/agent/interaction-continuation.js";
import { createApprovalContinuation } from "../../../src/agent/approval-continuation.js";
import { toolResultContent, type TruncationMark } from "../../../src/agent/tool-result-bounds.js";
import { dispatchingDraft, intentDraft, notStartedBehindDrafts, policyDraft, resultDraft, type ToolBatchContext } from "../../../src/agent/tool-call-drafts.js";
import { supersessionOf } from "../../../src/agent/observation-supersession.js";
import { ToolAttemptLedger } from "../../../src/agent/tool-attempts.js";
import { newlyCompleted } from "../../../src/agent/step-claim-review.js";
import { unofferedCallRefusal } from "../../../src/agent/unoffered-call.js";
import { StepFailureStop } from "../../../src/agent/step-failure-stop.js";
export type { ToolBatchContext } from "../../../src/agent/tool-call-drafts.js";
export type { AuthorizedCall, AuthorizedCallResult, PauseTtls, ToolBatchResult } from "../../../src/agent/tool-batch-types.js";
import { planningFirst, settledOutcome, type AuthorizedCall, type AuthorizedCallResult, type DispatchOptions, type Paused, type PauseTtls, type Settled, type ToolBatchResult } from "../../../src/agent/tool-batch-types.js";

const REFUSALS_HEARD = 3;

const planShape = (plan: WorkPlan | undefined): string => plan ? JSON.stringify({ goal: plan.goal, steps: plan.steps }) : "";

export class ToolBatchExecutor {
  readonly #attempts = new ToolAttemptLedger();

  constructor(
    private readonly coordinator: ToolExecutionCoordinator,
    private readonly workState: WorkStateTracker,
    private readonly planLedger: WorkPlanLedger,
    private readonly writer: TurnEventWriter,
    private readonly report: (event: AgentProgressEvent) => void,
    private readonly ttls: PauseTtls,
    private readonly onTruncated?: (call: ToolCall, mark: TruncationMark, context: ToolBatchContext) => void,
    private readonly onActivity?: () => void,
  ) {}
  async execute(
    calls: readonly ToolCall[], context: ToolBatchContext, messages: ChatMessage[],
    signal: AbortSignal, requestId: string,
  ): Promise<ToolBatchResult> {
    await this.writer.append(calls.map((call) =>
      intentDraft(call, context, this.coordinator.executionId(call, context), this.coordinator.definition(call))), `tool-intents:${requestId}`);
    const ordered = planningFirst(calls, this.planLedger);
    const planBefore = planShape(this.planLedger.workPlan);
    let progressed = false;
    let dispatchedCalls = 0;
    let planningCalls = 0;
    let unavailableCalls = 0;
    let workCalls = 0;
    let refusedCalls = 0;
    const stop = context.initiator ? undefined : new StepFailureStop(calls);
    for (const [index, call] of ordered.entries()) {
      const available = !context.selectedToolIds || context.selectedToolIds.has(call.name);
      if (available && stop?.stops(this.coordinator.definition(call)) && !signal.aborted) {
        const { draft, content } = stop.notStarted(call, context, this.coordinator.executionId(call, context));
        await this.writer.append([draft], `tool-result:${context.stepId}:${index}:${call.id}`);
        messages.push({ role: "tool", toolCallId: call.id, content });
        continue;
      }
      if (!available) unavailableCalls += 1;
      const preparation = available ? await this.coordinator.prepare(call, context) : this.unavailable(call, context);
      const remaining = ordered.slice(index + 1);
      const isPlanning = this.planLedger.isPlanningCall(call.name);
      let settled: Settled;
      if (isPlanning && preparation.kind === "ready") {
        const claimed = context.stepClaims ? newlyCompleted(this.planLedger.workPlan, this.planLedger.previewProposals([call])) : [];
        const note = claimed.length ? await context.stepClaims!.review(claimed) : undefined;
        const outcome = await dispatchPlanningCall({
          call, context, execution: preparation.execution, position: index, ledger: this.planLedger, writer: this.writer, report: this.report, ...(note ? { note } : {}),
        });
        settled = { kind: "settled", outcome, observation: "repeated" };
      } else if (preparation.kind === "terminal") {
        const decision = preparation.outcome.policyDecision;
        const leading = decision ? [policyDraft(call, context, preparation.outcome.executionId, decision)] : [];
        settled = await this.#settle(call, context, preparation.outcome, { started: false, position: index, leading });
      } else if (preparation.kind === "approval") {
        return this.#pauseForApproval(call, context, preparation.execution, remaining);
      } else if (signal.aborted) {
        settled = await this.#settle(call, context, await this.coordinator.run(preparation.execution, signal), { started: false, position: index, leading: [] });
      } else {
        const authorizationOutcome = preparation.execution.policyDecision.standingApproval ? "require_approval" : "allow";
        const dispatched = await this.#dispatch(call, context, preparation.execution, {
          leading: [], remaining, authorizationOutcome, position: index, signal,
        });
        if (dispatched.kind === "awaiting_interaction") return dispatched;
        settled = dispatched;
      }
      const { outcome, observation } = settled;
      if (!isPlanning) { workCalls += 1; if (settled.refused) refusedCalls += 1; stop?.observe(call, outcome); }
      if (outcome.dispatched && outcome.state === "succeeded") {
        dispatchedCalls += 1;
        if (isPlanning) planningCalls += 1;
        else if (observation === "new") progressed = true;
      }
      for (const mark of outcome.truncation ?? []) this.onTruncated?.(call, mark, context);
      messages.push({ role: "tool", toolCallId: call.id, ...(outcome.images?.length ? { images: outcome.images } : {}), content: toolResultContent({
        ...(outcome.result !== undefined ? { result: outcome.result } : {}), ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(outcome.truncation ? { truncated: toJsonValue(outcome.truncation) } : {}),
        ...(outcome.resultId ? { resultId: outcome.resultId } : {}),
      }) });
    }
    return { kind: "completed", progressed, planningOnly: dispatchedCalls > 0 && planningCalls === dispatchedCalls && workCalls === 0,
      planChanged: planShape(this.planLedger.workPlan) !== planBefore,
      unavailableOnly: calls.length > 0 && unavailableCalls === calls.length, refusedOnly: !progressed && workCalls > 0 && refusedCalls === workCalls };
  }

  async executeAuthorized(command: AuthorizedCall): Promise<AuthorizedCallResult> {
    const { prepared, context } = command;
    const outcome = await this.#dispatch(prepared.call, context, prepared, {
      leading: [...command.leadingDrafts, intentDraft(prepared.call, context, prepared.executionId, prepared.definition)],
      remaining: [], authorizationOutcome: command.authorizationOutcome, position: 0, signal: command.signal,
      ...(command.interaction ? { interaction: command.interaction } : {}),
    });
    if (outcome.kind === "awaiting_interaction") return outcome;
    return { kind: "completed", state: outcome.outcome.state, dispatched: outcome.outcome.dispatched };
  }

  async #dispatch(call: ToolCall, context: ToolBatchContext, execution: PreparedToolExecution, options: DispatchOptions): Promise<Settled | Paused> {
    await this.writer.append([
      ...options.leading,
      policyDraft(call, context, execution.executionId, execution.policyDecision),
      dispatchingDraft(call, context, execution.executionId),
    ], `tool-dispatch:${context.stepId}:${options.position}:${call.id}`);
    this.#stateProgress(call, context, execution.executionId, "dispatching");
    const workStepId = this.planLedger.currentStepId();
    const approval = {
      ...(execution.policyDecision.coveredBy ? { approvalReused: true as const } : {}),
      ...(execution.policyDecision.standingApproval ? { approvalStanding: true as const } : {}),
    };
    this.report({
      type: "tool-started", turnId: context.turnId, step: context.stepIndex, callId: call.id, toolId: call.name,
      ...(context.initiator ? { initiator: "policy" as const } : {}), ...(workStepId ? { workStepId } : {}), arguments: execution.arguments,
      ...approval,
    });
    this.onActivity?.();
    const outcome = await this.coordinator.run(execution, options.signal, options.interaction);
    if (outcome.state === "awaiting_interaction") return this.#pauseForInteraction(call, context, execution, outcome, options);
    const note = interactionOutcomeNote(options.interaction?.action);
    return this.#settle(call, context, outcome, {
      started: true, position: options.position, leading: [], arguments: execution.arguments, ...(note ? { note } : {}), ...approval,
    });
  }

  async #settle(call: ToolCall, context: ToolBatchContext, result: ToolExecutionResult, options: {
    readonly started: boolean; readonly position: number; readonly leading: readonly EventDraft[]; readonly note?: string; readonly arguments?: JsonValue;
    readonly approvalReused?: true; readonly approvalStanding?: true;
  }): Promise<Settled> {
    this.onActivity?.();
    const outcome = settledOutcome(result);
    const fingerprinted = this.workState.observe(outcome, this.coordinator.definition(call)?.observationKey);
    const reviewed = await context.reviewResult?.(call, this.coordinator.definition(call), outcome, fingerprinted);
    const observation = reviewed?.informationGain ?? fingerprinted;
    const tried: { readonly attempt: ToolAttempt; readonly note?: string } = this.planLedger.isPlanningCall(call.name)
      ? { attempt: { signature: call.name, failures: 0 } } : this.#attempts.record(call, outcome);
    context.stepClaims?.observe(call, outcome);
    const note = [options.note, reviewed?.note, tried.note].filter(Boolean).join("\n");
    const workStepId = this.planLedger.currentStepId();
    if (outcome.dispatched) {
      this.planLedger.noteNonPlanningDispatch();
      if (outcome.state === "succeeded" && workStepId) this.planLedger.noteStepResult(workStepId);
    }
    await this.writer.append([
      ...options.leading,
      resultDraft(call, context, outcome, {
        informationGain: observation, ...(workStepId ? { workStepId } : {}), ...(note ? { note } : {}), ...supersessionOf(this.coordinator.definition(call), outcome.result),
        attempt: tried.attempt,
      }),
    ], `tool-result:${context.stepId}:${options.position}:${call.id}`);
    this.#stateProgress(call, context, outcome.executionId, outcome.state);
    if (options.started) {
      this.report({
        type: "tool-completed", turnId: context.turnId, step: context.stepIndex, callId: call.id, toolId: call.name, status: outcome.state,
        ...(context.initiator ? { initiator: "policy" as const } : {}), ...(workStepId ? { workStepId } : {}),
        ...(options.arguments !== undefined ? { arguments: options.arguments } : {}), ...(outcome.result !== undefined ? { result: outcome.result } : {}), ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(options.approvalReused ? { approvalReused: true as const } : {}), ...(options.approvalStanding ? { approvalStanding: true as const } : {}),
      });
    }
    return { kind: "settled", outcome, observation, refused: tried.attempt.failure !== undefined && tried.attempt.failures < REFUSALS_HEARD };
  }

  async #pauseForApproval(call: ToolCall, context: ToolBatchContext, execution: PreparedToolExecution, remaining: readonly ToolCall[]): Promise<ToolBatchResult> {
    const pending = createApprovalContinuation({
      sessionId: context.sessionId, turnId: context.turnId, stepId: context.stepId,
      callId: call.id, executionId: execution.executionId, arguments: call.arguments,
      definition: execution.definition, policyDecision: execution.policyDecision,
      runtime: context.runtime, runtimeRouteRevision: context.runtimeRouteRevision, security: context.security,
      ...(context.agentProfileId ? { agentProfileId: context.agentProfileId } : {}), ttlMs: this.ttls.approvalTtlMs,
    });
    await this.writer.append([
      policyDraft(call, context, execution.executionId, execution.policyDecision),
      ...pending.drafts,
      ...notStartedBehindDrafts(remaining, context, call, "approval", (other) => this.coordinator.executionId(other, context)),
    ], `approval-requested:${context.stepId}:${call.id}`);
    this.#stateProgress(call, context, execution.executionId, "awaiting_approval");
    this.report({ type: "approval-requested", turnId: context.turnId, step: context.stepIndex, approval: pending.challenge });
    return { kind: "awaiting_approval", approval: pending.challenge };
  }

  async #pauseForInteraction(
    call: ToolCall, context: ToolBatchContext, execution: PreparedToolExecution, outcome: ToolExecutionResult, options: DispatchOptions,
  ): Promise<Paused> {
    if (!outcome.interaction) throw new AgenticError("permanent", "A tool asked for input without a request to show");
    const pending = createInteractionContinuation({
      sessionId: context.sessionId, turnId: context.turnId, stepId: context.stepId,
      callId: call.id, executionId: outcome.executionId, arguments: call.arguments,
      definition: execution.definition, request: outcome.interaction,
      ...(outcome.continuation === undefined ? {} : { continuation: outcome.continuation }),
      policyDecision: execution.policyDecision, authorizationOutcome: options.authorizationOutcome,
      runtime: context.runtime, runtimeRouteRevision: context.runtimeRouteRevision, security: context.security,
      ...(context.agentProfileId ? { agentProfileId: context.agentProfileId } : {}),
      ttlMs: interactionTtlMs(outcome.interaction, this.ttls.interactionTtlMs),
    });
    await this.writer.append([
      ...pending.drafts,
      ...notStartedBehindDrafts(options.remaining, context, call, "input", (other) => this.coordinator.executionId(other, context)),
    ], `interaction-requested:${context.stepId}:${call.id}`);
    this.#stateProgress(call, context, outcome.executionId, "awaiting_interaction");
    this.report({ type: "interaction-requested", turnId: context.turnId, step: context.stepIndex, interaction: pending.challenge });
    return { kind: "awaiting_interaction", interaction: pending.challenge };
  }

  private unavailable(call: ToolCall, context: ToolBatchContext): ToolPreparation {
    const refusal = unofferedCallRefusal(call, {
      offeredToolIds: [...(context.selectedToolIds ?? [])], inCatalogue: this.coordinator.definition(call) !== undefined,
      ...(context.unavailable ? { unavailable: context.unavailable } : {}),
    });
    return {
      kind: "terminal",
      outcome: this.coordinator.refuseUnoffered(call, {
        executionId: this.coordinator.executionId(call, context), state: "not_started", dispatched: false,
        error: { type: "tool_error", code: "validation", retryable: false, message: refusal.message },
        ...(refusal.unavailable ? { unavailable: refusal.unavailable } : {}),
      }),
    };
  }

  #stateProgress(call: ToolCall, context: ToolBatchContext, executionId: string, state: ToolExecutionResult["state"] | "awaiting_approval" | "dispatching"): void {
    this.report({
      type: "tool-state-changed", turnId: context.turnId, step: context.stepIndex,
      callId: call.id, toolId: call.name, executionId, state,
    });
  }
}
