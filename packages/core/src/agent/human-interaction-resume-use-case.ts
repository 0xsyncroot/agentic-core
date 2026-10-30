import { randomUUID } from "node:crypto";
import {
  AgenticError,
  isRuntimeQuestion,
  RUNTIME_REQUESTER_ID,
  type EventDraft,
  type HumanInteractionRequest,
  type JsonValue,
  type ResumeHumanInteractionInput,
  type RunTurnResult,
  type SessionStore,
  type ToolCall,
  type ToolExecutionPolicy,
} from "@0xsyncroot/contracts";
import { UnlimitedTurnAdmissionController } from "../admission/turn-admission.js";
import { sha256 } from "../hash.js";
import type { RuntimeProvider } from "../runtime-provider.js";
import { PermissionToolExecutionPolicy } from "../security/permission-tool-execution-policy.js";
import type { AgentRuntimeDependencies, AgentRuntimeOptions } from "./agent-options.js";
import { runAgentOperation, type AgentOperationContext } from "./agent-operation.js";
import { createApprovalContinuation, type StoredToolInteraction } from "./approval-continuation.js";
import type { ClaimedTurn } from "./claimed-turn.js";
import type { PauseRecord } from "./continuation-binding.js";
import { continueResumedTurn, dispatchResumedCall, resumedCallContext, runResume } from "./continuation-resume.js";
import { HumanInteractionValidator } from "./human-interaction-validator.js";
import { toJsonValue } from "./json-value.js";
import { report } from "./operation-observers.js";
import { snapshotRunTurnInput } from "./run-turn-input-policy.js";
import { continueChoice } from "./runtime-question.js";
import { prepareTurnSetup, type TurnSetup } from "./turn-setup.js";
import { TurnStepLoop } from "./turn-step-loop.js";
import { JudgmentMemo } from "./judgment-memo.js";
import { FirstEventModel } from "./first-event-model.js";

function snapshotContent(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error();
    return JSON.parse(serialized) as JsonValue;
  } catch { throw new AgenticError("validation", "Interaction content must be JSON serializable"); }
}

export class HumanInteractionResumeUseCase {
  readonly #policy: ToolExecutionPolicy;
  readonly #operation: AgentOperationContext;
  readonly #stepLoop: TurnStepLoop;
  readonly #validator = new HumanInteractionValidator();

  constructor(
    runtimeProvider: RuntimeProvider,
    private readonly sessions: SessionStore,
    private readonly options: AgentRuntimeOptions,
    private readonly dependencies: AgentRuntimeDependencies,
    private readonly runtimeOwnerId: string,
    /** The judge's verdicts, shared by the loop's three operations so a resume reuses what its turn asked. */
    judgments = new JudgmentMemo(),
    /** What the runtime has learned of its models' first events, shared by the three operations (`FirstEventModel`). */
    firstEvents = new FirstEventModel(),
  ) {
    this.#policy = dependencies.toolExecutionPolicy ?? new PermissionToolExecutionPolicy();
    this.#operation = {
      operation: "resume-interaction", runtimeProvider, telemetry: dependencies.telemetry,
      admission: dependencies.admissionController ?? new UnlimitedTurnAdmissionController(),
    };
    this.#stepLoop = new TurnStepLoop(options, dependencies, judgments, firstEvents);
  }

  async execute(input: ResumeHumanInteractionInput): Promise<RunTurnResult> {
    if (input.action !== "accept" && input.action !== "decline" && input.action !== "cancel") throw new AgenticError("validation", "Interaction action is invalid");
    const { content: _content, ...inputWithoutContent } = input;
    const safeContent = snapshotContent(input.content);
    const safeInput: ResumeHumanInteractionInput = Object.freeze({ ...inputWithoutContent, ...(safeContent === undefined ? {} : { content: safeContent }) });
    const interactionId = input.interactionId.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(interactionId)) throw new AgenticError("validation", "interactionId is invalid");
    const command = snapshotRunTurnInput({
      sessionId: input.sessionId, content: "[human interaction continuation]", security: input.security,
      idempotencyKey: input.idempotencyKey, ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}),
      ...(input.interjections ? { interjections: input.interjections } : {}),
      ...(input.signal ? { signal: input.signal } : {}), ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      ...(input.onOutput ? { onOutput: input.onOutput } : {}), ...(input.onNarration ? { onNarration: input.onNarration } : {}),
      ...(input.onReasoning ? { onReasoning: input.onReasoning } : {}),
    });
    return runAgentOperation(this.#operation, command, (acquire) => runResume({
      sessions: this.sessions, options: this.options, runtimeOwnerId: this.runtimeOwnerId, operation: "resume-interaction",
      ...(this.dependencies.telemetry ? { telemetry: this.dependencies.telemetry } : {}),
      ...(this.dependencies.turnControlPolicy ? { turnControlPolicy: this.dependencies.turnControlPolicy } : {}),
      ...(this.dependencies.continueQuestion ? { continueQuestion: this.dependencies.continueQuestion } : {}),
      command, acquire, submission: { interactionId, action: safeInput.action, contentDigest: sha256(safeInput.content ?? null) },
      pause: {
        kind: "interaction", pauseId: interactionId, security: command.security, agentProfileId: command.agentProfileId ?? "default",
        // The answer is checked against the question's own schema before the claim, so an invalid
        // submission is refused with nothing written.
        verifySubmission: (record) => {
          const request = record.payload.request as HumanInteractionRequest;
          this.#validator.validateRequest(request);
          this.#validator.validateResponse(request, safeInput.action, safeInput.content);
        },
      },
    }, (turn, record) => this.#resume(turn, record, safeInput)));
  }

  async #resume(turn: ClaimedTurn, record: PauseRecord, answer: ResumeHumanInteractionInput): Promise<RunTurnResult> {
    const setup = await prepareTurnSetup(turn, {
      options: this.options, toolPolicy: this.#policy,
      ...(this.dependencies.toolExecutionBroker ? { toolExecutionBroker: this.dependencies.toolExecutionBroker } : {}),
      ...(this.dependencies.toolResultSpool ? { toolResultSpool: this.dependencies.toolResultSpool } : {}),
      ...(this.dependencies.toolGroups ? { toolGroups: this.dependencies.toolGroups } : {}),
      ...(this.dependencies.standingApproval ? { standingApproval: this.dependencies.standingApproval } : {}),
    });
    const { input, turnId, writer } = turn;
    const payload = record.payload;
    const stepId = randomUUID();
    await writer.append([{ type: "step/start", turnId, stepId, payload: { index: 1 } }], `step-start:${stepId}`);
    if (isRuntimeQuestion(payload)) return this.#answerRuntimeQuestion(turn, setup, record, answer, stepId);
    const call: ToolCall = { id: String(payload.callId), name: String(payload.toolId), arguments: String(payload.arguments) };
    const executionContext = resumedCallContext(turn, stepId, record);
    const basePreparation = await setup.coordinator.prepareResumed(call, executionContext);
    if (basePreparation.kind === "terminal") throw new AgenticError("denied", "Interaction tool no longer passes invocation policy");
    if ((basePreparation.kind === "approval") !== (payload.authorizationOutcome === "require_approval")) {
      throw new AgenticError("denied", "Interaction authorization outcome changed after the request");
    }
    if (basePreparation.execution.policyDecision.actionDigest !== payload.actionDigest ||
        basePreparation.execution.policyDecision.policyRevision !== payload.policyRevision) {
      throw new AgenticError("denied", "Interaction action does not match the durable action binding");
    }
    const storedInteraction: StoredToolInteraction = {
      interactionId: record.pauseId, action: answer.action, ...(answer.content === undefined ? {} : { content: answer.content }),
      ...(payload.continuation === undefined ? {} : { continuation: payload.continuation as JsonValue }),
    };
    const preparation = await setup.coordinator.prepareResumed(call, executionContext, {
      action: answer.action, ...(answer.content === undefined ? {} : { content: answer.content }),
      continuationDigest: sha256(payload.continuation ?? null),
    });
    if (preparation.kind === "terminal") throw new AgenticError("denied", "Interaction response does not pass invocation policy");
    const execution = preparation.execution;
    // What the user answered, by the titles they saw, so history can show it; it is their data.
    const echo = this.#validator.echo(payload.request as HumanInteractionRequest, answer.action, answer.content);
    const resolved: EventDraft = { type: "interaction/resolved", turnId, ...(echo ? { classification: "confidential" as const } : {}), payload: toJsonValue({
      interactionId: record.pauseId, action: answer.action, actionDigest: execution.policyDecision.actionDigest,
      responseDigest: sha256(answer.content ?? null), resolvedBy: input.security.actorId, resolvedAt: new Date().toISOString(),
      ...(echo ? { echo } : {}),
    }) };
    const needsApproval = preparation.kind === "approval" &&
      (payload.authorizationOutcome !== "require_approval" || execution.policyDecision.actionDigest !== payload.actionDigest);
    if (needsApproval) {
      // The answer changed the action itself, so the changed action is what the user approves.
      const pending = createApprovalContinuation({
        sessionId: input.sessionId, turnId, stepId, callId: call.id, executionId: execution.executionId,
        arguments: call.arguments, definition: execution.definition, policyDecision: execution.policyDecision,
        runtime: turn.runtimeLease.snapshot, runtimeRouteRevision: turn.runtimeLease.binding.routeRevision,
        security: input.security, ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}),
        ttlMs: this.options.approvalTtlMs, interaction: storedInteraction,
      });
      await writer.append([resolved, { type: "tool/policy-decision", turnId, stepId, callId: call.id, payload: toJsonValue({
        callId: call.id, executionId: execution.executionId, toolId: call.name, ...execution.policyDecision,
      }) }, ...pending.drafts], `interaction-approval:${record.pauseId}`);
      report(input, { type: "approval-requested", turnId, step: 1, approval: pending.challenge });
      return turn.terminator.finishAwaiting({
        stepId, stepIndex: 1, reason: "interaction-response-approval-required",
        pending: { kind: "awaiting_approval", approval: pending.challenge },
      });
    }
    return dispatchResumedCall({
      stepLoop: this.#stepLoop, turn, setup, stepId, prepared: execution, leadingDrafts: [resolved], interaction: storedInteraction,
      authorizationOutcome: preparation.kind === "approval" ? "require_approval" : "allow", stepEndReason: "interaction-tool-result",
    });
  }

  /**
   * The answer to the runtime's own question. No call was paused, so nothing is prepared again: the
   * binding was verified around the claim, and the question itself is checked against its digest.
   * "Continue" runs the loop on in this same task — the model reads the choice as the runtime's note,
   * never as words the user typed. "Stop", a skip or a dismissal ends the turn at once, without the model.
   */
  async #answerRuntimeQuestion(turn: ClaimedTurn, setup: TurnSetup, record: PauseRecord, answer: ResumeHumanInteractionInput, stepId: string): Promise<RunTurnResult> {
    const { input, turnId, writer } = turn;
    const request = record.payload.request as HumanInteractionRequest;
    if (record.payload.actionDigest !== sha256(request)) throw new AgenticError("denied", "Runtime question does not match its durable digest");
    const choice = continueChoice(answer.action, answer.content);
    const echo = this.#validator.echo(request, answer.action, answer.content);
    const resolved: EventDraft = { type: "interaction/resolved", turnId, ...(echo ? { classification: "confidential" as const } : {}), payload: toJsonValue({
      interactionId: record.pauseId, action: answer.action, actionDigest: record.payload.actionDigest, responseDigest: sha256(answer.content ?? null),
      resolvedBy: input.security.actorId, resolvedAt: new Date().toISOString(), requesterId: RUNTIME_REQUESTER_ID, choice, ...(echo ? { echo } : {}),
    }) };
    if (choice === "continue") {
      await writer.append([resolved, { type: "step/end", turnId, stepId, payload: { status: "completed", reason: "runtime-question-continue" } }], `runtime-question:${record.pauseId}`);
      report(input, { type: "step-completed", turnId, step: 1 });
      return continueResumedTurn(this.#stepLoop, turn, setup);
    }
    // The product's sentence, journaled as the turn's answer so history and the next request read it too.
    const stopped = this.dependencies.continueQuestion?.stopped ?? "";
    await writer.append([resolved, ...(stopped ? [{
      type: "assistant/message", turnId, stepId, requestId: `runtime-question:${stepId}`, attemptId: `runtime-question:${stepId}`,
      payload: { content: stopped, toolCalls: [], finishReason: "user-stopped", usage: {} },
    }] : [])], `runtime-question:${record.pauseId}`);
    return turn.terminator.finishAnswer({
      stepId, stepIndex: 1, content: stopped, finishReason: "user-stopped", outcome: "partial", decision: "partial",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
  }
}
