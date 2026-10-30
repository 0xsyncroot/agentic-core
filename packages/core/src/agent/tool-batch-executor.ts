import {
  AgenticError,
  interactionTtlMs,
  type AgentProgressEvent,
  type ChatMessage,
  type EventDraft,
  type JsonValue, type ToolAttempt, type ToolCall,
} from "@0xsyncroot/contracts";
import { toJsonValue } from "./json-value.js";
import { dispatchPlanningCall } from "./plan-call-execution.js";
import type { PreparedToolExecution, ToolExecutionCoordinator, ToolExecutionResult } from "./tool-execution-coordinator.js";
import type { TurnEventWriter } from "./turn-event-writer.js";
import type { WorkPlanLedger } from "./work-plan-ledger.js";
import type { WorkStateTracker } from "./work-state-tracker.js";
import { createInteractionContinuation, interactionOutcomeNote } from "./interaction-continuation.js";
import { createApprovalContinuation } from "./approval-continuation.js";
import { toolResultContent, type TruncationMark } from "./tool-result-bounds.js";
import { bestEffortSkip, dispatchingDraft, intentDraft, notStartedBehindDrafts, policyDraft, resultDraft, type ToolBatchContext } from "./tool-call-drafts.js";
import { supersessionOf } from "./observation-supersession.js";
import { ToolAttemptLedger } from "./tool-attempts.js";
import { newlyCompleted } from "./step-claim-review.js";
import { unofferedPreparation } from "./unoffered-call.js";
import { StepFailureStop } from "./step-failure-stop.js";
import type { SubGoalLedger } from "./sub-goal-ledger.js";
import { PlanCompletionGate } from "./plan-completion-gate.js";
export type { ToolBatchContext } from "./tool-call-drafts.js";
export type { AuthorizedCall, AuthorizedCallResult, PauseTtls, ToolBatchResult } from "./tool-batch-types.js";
import { planShape, settledOutcome, skippedForPause, type AuthorizedCall, type AuthorizedCallResult, type DispatchOptions, type Paused, type PauseTtls, type Settled, type ToolBatchResult } from "./tool-batch-types.js";

/**
 * Journals, runs and reports tool calls — the model's batch, a policy's reads, and a call the user
 * resumed — through one path, so a resumed call is dispatched, recorded and counted exactly like
 * any other and the next step reads its result the same way.
 */
/** Refusals of one target that still count as feedback rather than circling: the ledger's third failure says change approach. */
const REFUSALS_HEARD = 3;

export class ToolBatchExecutor {
  /** Failed calls per target in this turn: the second, third and fifth failure say to change approach. */
  readonly #attempts = new ToolAttemptLedger();
  /** The model batch under way: where its work calls are attributed and which completions wait for them. */
  #gate: PlanCompletionGate | undefined;

  constructor(
    private readonly coordinator: ToolExecutionCoordinator,
    private readonly workState: WorkStateTracker,
    private readonly planLedger: WorkPlanLedger,
    private readonly writer: TurnEventWriter,
    private readonly report: (event: AgentProgressEvent) => void,
    private readonly ttls: PauseTtls,
    /** Told of every list the runtime cut, so an operator can see what an answer was drawn from. */
    private readonly onTruncated?: (call: ToolCall, mark: TruncationMark, context: ToolBatchContext) => void,
    /** A call started or finished. Restarts the turn's silence clock; a hung call does not. */
    private readonly onActivity?: () => void,
    /** Records what each sub-goal's results show; the model's steps are journaled after their calls, a policy's reads never. */
    private readonly subGoals?: SubGoalLedger,
  ) {}
  async execute(calls: readonly ToolCall[], context: ToolBatchContext, messages: ChatMessage[], signal: AbortSignal, requestId: string): Promise<ToolBatchResult> {
    const outer = this.#gate;
    try {
      const result = await this.#execute(calls, context, messages, signal, requestId);
      if (!context.initiator) await this.subGoals?.journal(this.planLedger.currentPlan, context, this.writer, context.stepId);
      return result;
    } finally { this.#gate = outer; }
  }

  /** The plan and step a work call counts toward (`PlanCompletionGate.attribution`); outside a batch, the plan's live step. */
  #attribution(context: ToolBatchContext) { return (this.#gate ?? new PlanCompletionGate([], this.planLedger)).attribution(context); }

  async #execute(calls: readonly ToolCall[], context: ToolBatchContext, messages: ChatMessage[], signal: AbortSignal, requestId: string): Promise<ToolBatchResult> {
    await this.writer.append(calls.map((call) =>
      intentDraft(call, context, this.coordinator.executionId(call, context), this.coordinator.definition(call))), `tool-intents:${requestId}`);
    // Execution order only — the intents above stay in the model's own order, so the transcript
    // still reads as it asked; §10.2 governs dispatch and the not-started bookkeeping that follows.
    const gate = this.#gate = new PlanCompletionGate(calls, this.planLedger);
    const ordered = gate.ordered;
    const planBefore = planShape(this.planLedger.workPlan);
    let progressed = false, workDispatched = false;
    let dispatchedCalls = 0, planningCalls = 0, unavailableCalls = 0, workCalls = 0, refusedCalls = 0;
    // A policy's own reads are not the model's plan: nothing in them stops behind a failure.
    const stop = context.initiator ? undefined : new StepFailureStop(calls);
    for (const [index, call] of ordered.entries()) {
      const available = !context.selectedToolIds || context.selectedToolIds.has(call.name);
      // A call the step was not offered is refused with why, as before: it runs nothing either way. Once the user stopped the
      // turn, a later call goes the way it always has: prepared, then closed as cancelled, except one that needs approval,
      // which still pauses for its card (known gap, older than this stop).
      // A completion whose step's work did not go through is held back the same way, before anything is prepared.
      const held = available && stop?.stops(this.coordinator.definition(call)) && !signal.aborted
        ? stop.notStarted(call, context, this.coordinator.executionId(call, context)) : gate.withheld(call, context, this.coordinator.executionId(call, context));
      if (held) {
        gate.observe(context, call, { state: "not_started" });
        await this.writer.append([held.draft], `tool-result:${context.stepId}:${index}:${call.id}`);
        messages.push({ role: "tool", toolCallId: call.id, content: held.content });
        continue;
      }
      if (!available) unavailableCalls += 1;
      const preparation = available ? await this.coordinator.prepare(call, context) : unofferedPreparation(this.coordinator, call, context);
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
        if (!context.bestEffort) return this.#pauseForApproval(call, context, preparation.execution, remaining);
        const { executionId, policyDecision } = preparation.execution;
        settled = await this.#settle(call, context, skippedForPause(executionId, "approval-required", "The call needs the user's approval, which a best-effort read never waits for"),
          { started: false, position: index, leading: [policyDraft(call, context, executionId, policyDecision)] });
      } else if (signal.aborted) {
        settled = await this.#settle(call, context, await this.coordinator.run(preparation.execution, signal), { started: false, position: index, leading: [] });
      } else {
        // A call the actor's standing approval allowed is one the policy asked about: a question it asks resumes as such.
        const authorizationOutcome = preparation.execution.policyDecision.standingApproval ? "require_approval" : "allow";
        const dispatched = await this.#dispatch(call, context, preparation.execution, {
          leading: [], remaining, authorizationOutcome, position: index, signal,
        });
        if (dispatched.kind === "awaiting_interaction") return dispatched;
        settled = dispatched;
      }
      const { outcome, observation } = settled;
      // A call to a tool the step lacked is work refused with a reason, like a mislabelled click.
      if (!isPlanning) { workCalls += 1; if (settled.refused) refusedCalls += 1; if (outcome.dispatched) workDispatched = true; stop?.observe(call, outcome); gate.observe(context, call, outcome); }
      if (outcome.dispatched && outcome.state === "succeeded") {
        dispatchedCalls += 1;
        // A plan update is the agent restating its intent, not an observation of the world, and
        // only the latter buys more steps.
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
    // Plan-only means nothing but the plan was asked for: refunded as planning beside a refused or failed call, a model
    // that pairs a changing plan with a tool it lacks would run to the 4x tool-call cap.
    return { kind: "completed", progressed, planningOnly: dispatchedCalls > 0 && planningCalls === dispatchedCalls && workCalls === 0,
      planChanged: planShape(this.planLedger.workPlan) !== planBefore,
      unavailableOnly: calls.length > 0 && unavailableCalls === calls.length, refusedOnly: !progressed && workCalls > 0 && refusedCalls === workCalls, workDispatched };
  }

  /**
   * Runs a call a user resumed. Its intent is written again under the resuming turn, with the
   * execution id the pause recorded, in the same append as the resolution and the dispatch
   * boundary — so a lost worker always leaves a call recovery can balance, never a resolved pause
   * with nothing after it. Its result joins the turn's observations like any other call's.
   */
  async executeAuthorized(command: AuthorizedCall): Promise<AuthorizedCallResult> {
    const { prepared, context } = command;
    const outcome = await this.#dispatch(prepared.call, context, prepared, {
      leading: [...command.leadingDrafts, intentDraft(prepared.call, context, prepared.executionId, prepared.definition)],
      remaining: [], authorizationOutcome: command.authorizationOutcome, position: 0, signal: command.signal,
      ...(command.interaction ? { interaction: command.interaction } : {}),
    });
    await this.subGoals?.journal(this.planLedger.currentPlan, context, this.writer, `${context.stepId}:${prepared.call.id}`);
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
    // A best-effort read is the runtime's, not work under the plan step in progress: it is never stamped with it or credits it.
    const workStepId = this.#attribution(context).stepId;
    // How the call was approved, said on its start and again on its end.
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
    if (outcome.state === "awaiting_interaction" && context.bestEffort) {
      return this.#settle(call, context, skippedForPause(outcome.executionId, "interaction-required", "The call asked the user for input, which a best-effort read never waits for"),
        { started: true, position: options.position, leading: [], arguments: execution.arguments });
    }
    if (outcome.state === "awaiting_interaction") return this.#pauseForInteraction(call, context, execution, outcome, options);
    // The tool's own result stands; a skipped or dismissed question adds what the model should do about it.
    const note = interactionOutcomeNote(options.interaction?.action);
    return this.#settle(call, context, outcome, {
      started: true, position: options.position, leading: [], arguments: execution.arguments, ...(note ? { note } : {}), ...approval,
    });
  }

  /** Journals a call's outcome with the facts the turn learned from it, then reports it. */
  async #settle(call: ToolCall, context: ToolBatchContext, result: ToolExecutionResult, options: {
    /** `arguments`: what the call ran with, so its ending can be described the way its start was. */
    readonly started: boolean; readonly position: number; readonly leading: readonly EventDraft[]; readonly note?: string; readonly arguments?: JsonValue;
    /** What `tool-started` said of the call's approval, repeated on its ending. */
    readonly approvalReused?: true; readonly approvalStanding?: true;
  }): Promise<Settled> {
    this.onActivity?.();
    const outcome = settledOutcome(result);
    // A skipped best-effort read never reached the model, so the model's own identical read is not a repeat of it.
    const fingerprinted = bestEffortSkip(context, outcome) ? "new" : this.workState.observe(outcome, this.coordinator.definition(call)?.observationKey);
    const reviewed = await context.reviewResult?.(call, this.coordinator.definition(call), outcome, fingerprinted);
    const observation = reviewed?.informationGain ?? fingerprinted;
    // A refused plan is fixed by writing the plan again, never a target to "route around".
    // A best-effort read failing says nothing about the target the model will aim at: it stays out of the model's failure ledger.
    const tried: { readonly attempt: ToolAttempt; readonly note?: string } = this.planLedger.isPlanningCall(call.name) || context.bestEffort
      ? { attempt: { signature: call.name, failures: 0 } } : this.#attempts.record(call, outcome);
    context.stepClaims?.observe(call, outcome);
    const note = [options.note, reviewed?.note, tried.note].filter(Boolean).join("\n");
    const { plan: workPlan, stepId: workStepId } = this.#attribution(context);
    if (!context.initiator && !this.planLedger.isPlanningCall(call.name)) {
      this.subGoals?.observe(workPlan, workStepId, call, this.coordinator.definition(call), outcome);
    }
    if (outcome.dispatched) this.planLedger.noteNonPlanningDispatch();
    await this.writer.append([
      ...options.leading,
      resultDraft(call, context, outcome, {
        informationGain: observation, ...(workStepId ? { workStepId } : {}), ...(note ? { note } : {}), ...supersessionOf(this.coordinator.definition(call), outcome.result),
        attempt: tried.attempt,
      }),
    ], `tool-result:${context.stepId}:${options.position}:${call.id}`);
    this.#stateProgress(call, context, outcome.executionId, outcome.state);
    // Every call reported as started is reported as finished, with the state it finished in.
    if (options.started) {
      this.report({
        type: "tool-completed", turnId: context.turnId, step: context.stepIndex, callId: call.id, toolId: call.name, status: outcome.state,
        ...(context.initiator ? { initiator: "policy" as const } : {}), ...(workStepId ? { workStepId } : {}),
        ...(options.arguments !== undefined ? { arguments: options.arguments } : {}), ...(outcome.result !== undefined ? { result: outcome.result } : {}), ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(options.approvalReused ? { approvalReused: true as const } : {}), ...(options.approvalStanding ? { approvalStanding: true as const } : {}),
      });
    }
    // A refusal names what to change; the same target refused a third time is circling, not feedback.
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

  #stateProgress(call: ToolCall, context: ToolBatchContext, executionId: string, state: ToolExecutionResult["state"] | "awaiting_approval" | "dispatching"): void {
    this.report({
      type: "tool-state-changed", turnId: context.turnId, step: context.stepIndex,
      callId: call.id, toolId: call.name, executionId, state,
    });
  }
}
