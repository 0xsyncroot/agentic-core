import { randomUUID } from "node:crypto";
import {
  AgenticError,
  APPROVAL_DECISION, APPROVAL_EVENT,
  type ApprovalDecision, type CoreEventDraft,
  type ResumeTurnInput,
  type RunTurnResult,
  type SessionStore,
  type ToolCall,
  type ToolExecutionPolicy,
} from "@0xsyncroot/contracts";
import { sha256 } from "../hash.js";
import type { RuntimeProvider } from "../runtime-provider.js";
import { PermissionToolExecutionPolicy } from "../security/permission-tool-execution-policy.js";
import { UnlimitedTurnAdmissionController } from "../admission/turn-admission.js";
import type { AgentRuntimeDependencies, AgentRuntimeOptions } from "./agent-options.js";
import { runAgentOperation, type AgentOperationContext } from "./agent-operation.js";
import type { StoredToolInteraction } from "./approval-continuation.js";
import { snapshotApprovalPresentation } from "./approval-presentation.js";
import type { ClaimedTurn } from "./claimed-turn.js";
import type { PauseRecord } from "./continuation-binding.js";
import { continueResumedTurn, dispatchResumedCall, resumedCallContext, runResume } from "./continuation-resume.js";
import { report } from "./operation-observers.js";
import { snapshotRunTurnInput } from "./run-turn-input-policy.js";
import { prepareTurnSetup } from "./turn-setup.js";
import { TurnStepLoop } from "./turn-step-loop.js";
import { JudgmentMemo } from "./judgment-memo.js";
import { FirstEventModel } from "./first-event-model.js";

function storedInteraction(value: unknown): StoredToolInteraction | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgenticError("denied", "Approved interaction binding is invalid");
  const item = value as unknown as StoredToolInteraction;
  if (typeof item.interactionId !== "string" || !["accept", "decline", "cancel"].includes(item.action)) {
    throw new AgenticError("denied", "Approved interaction binding is invalid");
  }
  return item;
}

export class ApprovalResumeUseCase {
  readonly #policy: ToolExecutionPolicy;
  readonly #operation: AgentOperationContext;
  readonly #stepLoop: TurnStepLoop;

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
      operation: "resume-approval", runtimeProvider, telemetry: dependencies.telemetry,
      admission: dependencies.admissionController ?? new UnlimitedTurnAdmissionController(),
    };
    this.#stepLoop = new TurnStepLoop(options, dependencies, judgments, firstEvents);
  }

  async execute(input: ResumeTurnInput): Promise<RunTurnResult> {
    if (input.decision !== APPROVAL_DECISION.APPROVE && input.decision !== APPROVAL_DECISION.DENY) throw new AgenticError("validation", "Approval decision is invalid");
    const command = snapshotRunTurnInput({
      sessionId: input.sessionId, content: "[approval continuation]", security: input.security,
      idempotencyKey: input.idempotencyKey, ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}),
      ...(input.interjections ? { interjections: input.interjections } : {}),
      ...(input.signal ? { signal: input.signal } : {}), ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      ...(input.onOutput ? { onOutput: input.onOutput } : {}),
      ...(input.onNarration ? { onNarration: input.onNarration } : {}),
      ...(input.onReasoning ? { onReasoning: input.onReasoning } : {}),
    });
    const approvalId = input.approvalId.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(approvalId)) throw new AgenticError("validation", "approvalId is invalid");
    return runAgentOperation(this.#operation, command, (acquire) => runResume({
      sessions: this.sessions, options: this.options, runtimeOwnerId: this.runtimeOwnerId, operation: "resume-approval",
      ...(this.dependencies.telemetry ? { telemetry: this.dependencies.telemetry } : {}),
      ...(this.dependencies.turnControlPolicy ? { turnControlPolicy: this.dependencies.turnControlPolicy } : {}),
      ...(this.dependencies.continueQuestion ? { continueQuestion: this.dependencies.continueQuestion } : {}),
      command, acquire, submission: { approvalId, decision: input.decision },
      pause: {
        kind: "approval", pauseId: approvalId, security: command.security, agentProfileId: command.agentProfileId ?? "default",
      },
    }, (turn, record) => this.#resume(turn, record, input.decision)));
  }

  async #resume(turn: ClaimedTurn, record: PauseRecord, decision: ApprovalDecision): Promise<RunTurnResult> {
    const setup = await prepareTurnSetup(turn, {
      options: this.options, toolPolicy: this.#policy,
      ...(this.dependencies.toolExecutionBroker ? { toolExecutionBroker: this.dependencies.toolExecutionBroker } : {}),
      ...(this.dependencies.toolResultSpool ? { toolResultSpool: this.dependencies.toolResultSpool } : {}),
      ...(this.dependencies.toolGroups ? { toolGroups: this.dependencies.toolGroups } : {}),
      // The resumed call keeps its own path (prepareResumed); the calls after it in this turn are new ones.
      ...(this.dependencies.standingApproval ? { standingApproval: this.dependencies.standingApproval } : {}),
    });
    const { input, turnId, writer } = turn;
    const payload = record.payload;
    const stepId = randomUUID();
    const resolved = { type: APPROVAL_EVENT.RESOLVED, turnId, payload: {
      approvalId: record.pauseId, decision, actionDigest: String(payload.actionDigest),
      resolvedBy: input.security.actorId, resolvedAt: new Date().toISOString(),
    } } satisfies CoreEventDraft<typeof APPROVAL_EVENT.RESOLVED>;
    await writer.append([{ type: "step/start", turnId, stepId, payload: { index: 1 } }], `step-start:${stepId}`);
    if (decision === APPROVAL_DECISION.DENY) {
      // A refusal is an answer to the model, not the end of the conversation: journaled as the
      // tool's outcome, and the loop goes on so the model replies in the conversation's language.
      await writer.append([resolved, {
        type: "tool/result", turnId, stepId, callId: String(payload.callId), payload: {
          callId: String(payload.callId), executionId: String(payload.executionId), toolId: String(payload.toolId),
          state: "denied", dispatched: false,
          error: { type: "tool_error", code: "denied", retryable: false,
            message: "The user declined this action; nothing was changed. Ask what should be adjusted, or continue without it." },
        },
      }, { type: "step/end", turnId, stepId, payload: { status: "completed", reason: "approval-denied" } }], `approval-denied:${record.pauseId}`);
      report(input, { type: "tool-state-changed", turnId, step: 1, callId: String(payload.callId), toolId: String(payload.toolId), executionId: String(payload.executionId), state: "denied" });
      return continueResumedTurn(this.#stepLoop, turn, setup);
    }
    const call: ToolCall = { id: String(payload.callId), name: String(payload.toolId), arguments: String(payload.arguments) };
    const interaction = storedInteraction(payload.interaction);
    const preparation = await setup.coordinator.prepareResumed(call, resumedCallContext(turn, stepId, record), interaction ? {
      action: interaction.action, ...(interaction.content === undefined ? {} : { content: interaction.content }),
      continuationDigest: sha256(interaction.continuation ?? null),
    } : undefined);
    if (preparation.kind === "terminal") throw new AgenticError("denied", "Approved action no longer passes invocation policy");
    const execution = preparation.execution;
    if (execution.policyDecision.actionDigest !== payload.actionDigest || execution.policyDecision.policyRevision !== payload.policyRevision) {
      throw new AgenticError("denied", "Approved action does not match the durable action binding");
    }
    const storedPresentation = payload.presentation === undefined ? undefined : snapshotApprovalPresentation(payload.presentation);
    if (sha256(storedPresentation ?? null) !== sha256(execution.policyDecision.approvalPresentation ?? null)) {
      throw new AgenticError("denied", "Approved presentation does not match the durable action binding");
    }
    return dispatchResumedCall({
      stepLoop: this.#stepLoop, turn, setup, stepId, prepared: execution, leadingDrafts: [resolved],
      authorizationOutcome: "require_approval", stepEndReason: "approved-tool-result",
      ...(interaction ? { interaction } : {}),
    });
  }
}
