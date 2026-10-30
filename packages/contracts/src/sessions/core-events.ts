import type { HumanInteractionAction, HumanInteractionEcho } from "../interactions/interaction.js";
import type { JudgmentVerdict } from "../judgment/judgment.js";
import type { JsonValue } from "../shared/json.js";
import type { ToolExecutionState, ToolNextCall } from "../tools/tool.js";
import type { ToolSelectionPayload } from "../tools/tool-groups.js";
import type { WorkPlan, WorkPlanCause } from "../work/work-plan.js";
import type { WorkStepProgressPayload } from "../work/step-progress.js";
import type { EventDraft } from "./session.js";
import { APPROVAL_EVENT, type ApprovalDecision } from "../approvals/approval.js";

/** The two ways a turn can stop and wait for the user. */
export type PauseKind = "approval" | "interaction";

/**
 * Why the runtime, not the user, closed a pause: a newer message arrived first (`superseded`),
 * or nobody answered before it expired (`expired`).
 */
export type PauseClosureReason = "superseded" | "expired";

/** Links a resume turn to the paused turn it continues and to the user turn that began the task. */
export type TurnContinuation = {
  readonly pauseKind: PauseKind;
  readonly pauseId: string;
  readonly fromTurnId: string;
  readonly rootTurnId: string;
};

/** Marks the cancelled result the runtime wrote for a paused call it closed; the envelope keeps the paused call's ids. */
export type ToolResultClosure = {
  readonly pauseKind: PauseKind;
  readonly pauseId: string;
  readonly closedByTurnId: string;
};

export type TurnEndStatus = "completed" | "partial" | "awaiting_approval" | "awaiting_interaction";
/** How the loop judged the answer it ended on; absent on turns journaled before it was recorded. */
export type TurnEndDecision = "finish" | "partial" | "budget-reached";

/** `work/plan-updated`: the plan as the runtime normalized it, plus why and which steps changed. */
export type WorkPlanUpdatedPayload = WorkPlan & {
  readonly cause?: WorkPlanCause;
  readonly changedStepIds?: readonly string[];
};

/**
 * A model attempt whose first call stayed silent for `afterMs` and was sent once more, identically, under its own attempt id.
 * `winner` is the call whose stream the step used; "none" when neither spoke before the first-event bound. The call not used
 * is closed by an `llm/attempt-discarded` row carrying the same record (code "hedge-lost" when the other one spoke).
 */
export type LlmAttemptHedge = {
  readonly primaryAttemptId: string; readonly hedgeAttemptId: string; readonly afterMs: number;
  readonly winner: "primary" | "hedge" | "none";
};

export interface CoreEventPayloadMap {
  readonly "turn/start": {
    readonly inputIdempotencyKey: string;
    readonly runtimeBinding?: { readonly tenantId: string; readonly agentProfileId: string;
      readonly routeRevision: string; readonly runtimeSnapshotId: string };
    /** Present on a resume turn only. */
    readonly continuation?: TurnContinuation;
  };
  readonly "turn/end": { readonly status: TurnEndStatus; readonly reason?: string; readonly steps?: number; readonly decision?: TurnEndDecision };
  readonly "turn/failed": { readonly code: string; readonly message: string; readonly retryable: boolean; readonly interrupted?: boolean };
  readonly "step/start": { readonly index: number };
  readonly "step/end": { readonly status: string; readonly reason?: string; readonly code?: string; readonly message?: string; readonly retryable?: boolean };
  readonly "user/input": { readonly content: string; readonly source: string; readonly attachments?: JsonValue };
  readonly "application/context": { readonly trusted?: Readonly<Record<string, JsonValue>>; readonly untrusted?: JsonValue };
  readonly "assistant/message": { readonly content: string | null; readonly toolCalls?: JsonValue; readonly finishReason?: string; readonly providerState?: JsonValue };
  /**
   * Narration delivered to the user while the agent kept working. Core writes it in the same
   * append as the assistant/message whose text it announced (the text beside the first plan
   * proposal); it is never inferred later from an assistant/message.
   * `opening`: the runtime's acknowledgement of the request, told before the first step, with no step of its own; it is
   * never part of the model's context and never counts as the turn's narration.
   */
  readonly "assistant/narration": { readonly narrationId: string; readonly audience: "user"; readonly content: string; readonly draft?: true; readonly opening?: true };
  /**
   * The narration `narrationId` left the chat for `by`, the narration of the step this is journaled in: that step ended
   * without progress, and no step since `narrationId` was told made any. Written in the same append as the step's end, so
   * a reload shows what the live stream showed. A draft and the plan announcement are never named.
   */
  readonly "assistant/narration-superseded": { readonly narrationId: string; readonly by: string };
  readonly "request/prepared": Readonly<Record<string, JsonValue>>;
  readonly "llm/attempt-failed": { readonly code: string; readonly message: string; readonly retryable: boolean; readonly willRetry: boolean; readonly attempt: number };
  /** `firstEventMs`: from the attempt's first call to the first stream event of the call it used. */
  readonly "llm/attempt-committed": { readonly itemId?: string; readonly hadPublicOutput: boolean; readonly toolChoiceRejected?: string;
    readonly firstEventMs?: number; readonly hedge?: LlmAttemptHedge;
    /** The call was made without private reasoning (`LlmAdapter.plainParameters`): a closing step, or a reasoning-limit recovery. */
    readonly plain?: true };
  readonly "llm/attempt-discarded": { readonly itemId?: string; readonly hadPublicOutput: boolean; readonly code: string; readonly willRetry: boolean;
    readonly hedge?: LlmAttemptHedge };
  readonly "usage/recorded": { readonly providerId: string; readonly model: string; readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number; readonly reported: boolean };
  readonly "memory/context-selected": { readonly records: JsonValue; readonly contextHash: string };
  /** The turn opened without its memory recall: `reason` timeout = the search outlived the bound; `code` is the rejection's own string code (at most 64 characters), `message` at most 300 and may be empty. */
  readonly "memory/context-unavailable": { readonly reason: "error" | "timeout"; readonly code?: string; readonly message: string };
  readonly "model/route-selected": {
    readonly providerId: string; readonly adapterId: string; readonly modelId: string; readonly routeRevision: string; readonly metadataSource: string;
    readonly contextWindowTokens: number | null; readonly maxOutputTokens: number | null; readonly tokenizerId: string | null;
  };
  /** `omittedMessages` left the model's view altogether; `clearedResults` kept their call and lost their body. */
  readonly "context/trimmed": { readonly omittedMessages: number; readonly clearedResults?: number };
  readonly "context/checkpoint": {
    readonly summary: string; readonly summaryHash: string; readonly coveredFromSeq: number; readonly coveredThroughSeq: number; readonly formatVersion: number;
    readonly projectorRevision: string; readonly compactorRevision: string; readonly inputDigest: string;
  } & Readonly<Record<string, JsonValue>>;
  readonly "tool/intent": { readonly callId: string; readonly executionId: string; readonly toolId: string; readonly arguments: string; readonly state: "prepared"; readonly sideEffect: string; readonly initiator?: "policy"; readonly policyId?: string; readonly reason?: string;
    /** The call is a policy's best-effort read (`TurnObservationRequest.bestEffort`). */
    readonly bestEffort?: true };
  readonly "tool/policy-decision": { readonly callId: string; readonly executionId: string; readonly toolId: string; readonly decisionId: string; readonly outcome: string; readonly policyRevision: string; readonly reason: string; readonly actionDigest: string; readonly coveredBy?: string;
    /** The actor's standing approval the call ran under, with the card it replaced (`ToolPolicyDecision.standingApproval`). */
    readonly standingApproval?: { readonly revision: string; readonly since: string; readonly presentation?: JsonValue } };
  readonly "tool/state": { readonly callId: string; readonly executionId: string; readonly toolId: string; readonly state: ToolExecutionState };
  readonly "tool/result": {
    readonly callId: string; readonly executionId: string; readonly toolId: string; readonly state: ToolExecutionState; readonly dispatched: boolean;
    /** The plan step the call was made under. */
    readonly workStepId?: string;
    readonly informationGain?: "new" | "repeated";
    /** The call succeeded and changed the scope the step's later calls were chosen against (`ToolCompletedResponse.halt`). */
    readonly halt?: "state-changed";
    /** The read the tool says this result calls for next (`ToolCompletedResponse.nextCall`), kept as the tool gave it. */
    readonly nextCall?: ToolNextCall;
    /** Present only on the cancelled result the runtime wrote when it closed a pause. */
    readonly closure?: ToolResultClosure;
    /** A best-effort read of a policy (`TurnObservationRequest.bestEffort`); when it did not succeed, `skipped` says why and the model is never shown it. */
    readonly bestEffort?: true;
    readonly skipped?: "approval-required" | "interaction-required" | "timeout" | "failed";
  } & { readonly [key: string]: JsonValue };
  readonly [APPROVAL_EVENT.REQUESTED]: { readonly approvalId: string; readonly callId: string; readonly executionId: string; readonly toolId: string; readonly arguments: string; readonly sideEffect: string; readonly actionDigest: string; readonly decisionId: string; readonly policyRevision: string; readonly runtimeSnapshotId: string; readonly runtimeRouteRevision: string; readonly agentProfileId: string; readonly requestedBy: string; readonly grantRevision: string; readonly expiresAt: string; readonly presentation?: JsonValue; readonly interaction?: JsonValue };
  readonly [APPROVAL_EVENT.RESOLVED]: {
    readonly approvalId: string; readonly decision: ApprovalDecision | PauseClosureReason; readonly actionDigest: string;
    /** The resolving actor, or "runtime" when the runtime closed the pause. */
    readonly resolvedBy: string; readonly resolvedAt: string;
    /** Present only when the runtime closed the pause; equals the decision. */
    readonly reason?: PauseClosureReason;
  };
  /** A tool's question binds its call; one the runtime asks (`requesterId` "runtime") binds none, so the call fields are absent. */
  readonly "interaction/requested": {
    readonly interactionId: string; readonly callId?: string; readonly executionId?: string; readonly toolId?: string; readonly requesterId: string;
    readonly arguments?: string; readonly request: JsonValue; readonly continuation?: JsonValue;
    readonly actionDigest?: string; readonly decisionId?: string; readonly policyRevision: string;
    readonly authorizationOutcome?: "allow" | "require_approval"; readonly runtimeSnapshotId: string; readonly runtimeRouteRevision: string;
    readonly agentProfileId: string; readonly requestedBy: string; readonly grantRevision: string; readonly expiresAt: string;
  };
  readonly "interaction/resolved": {
    readonly interactionId: string; readonly action: HumanInteractionAction; readonly actionDigest: string; readonly responseDigest?: string;
    /** The resolving actor, or "runtime" when the runtime closed the pause (then action is "cancel"). */
    readonly resolvedBy: string; readonly resolvedAt: string;
    readonly reason?: PauseClosureReason;
    readonly echo?: HumanInteractionEcho;
    /** Present only on the user's answer to a question the runtime asked: "runtime", with the way they chose. */
    readonly requesterId?: string;
    readonly choice?: "continue" | "stop";
  };
  readonly "work/plan-updated": WorkPlanUpdatedPayload;
  /** Each sub-goal of the plan after a model step's calls: claimed beside shown (`WorkStepProgressPayload`). */
  readonly "work/step-progress": WorkStepProgressPayload;
  readonly "work/decision": { readonly decision: string; readonly currentAction?: string; readonly nextAction?: string; readonly informationGain?: string };
  /**
   * `delivered`: the policy's decision this row records marked the objected answer as delivering a result
   * (`TurnTerminalDecision` continue `delivered`), on every row the work-remains gate writes from it; the turn-end replay reads it.
   */
  readonly "turn/control-decision": { readonly policyId: string; readonly policyRevision: string;
    readonly phase: "before-model" | "tool-call" | "terminal" | "choice-violation"; readonly decision: string; readonly delivered?: true }
    & Readonly<Record<string, JsonValue>>;
  /**
   * One judgment asked inside the turn, at the point of the loop named by `seam`. Probabilities are
   * rounded to four decimals before they are journaled and before the caller sees them, so a
   * decision rests on exactly these values. `failed` carries the reason instead of answers.
   */
  readonly "judgment/classified": JudgmentClassifiedPayload;
  /** Which tool groups a turn offers and why, at its open and whenever a load during the turn adds one. */
  readonly "tool/selection": ToolSelectionPayload;
}

export type JudgmentClassifiedPayload = {
  readonly seam: string; readonly providerId: string; readonly modelId: string;
  readonly outcome: "answered" | "failed"; readonly elapsedMs: number;
  /** Per question id: the probability of "true" (noul), of the chosen label (choice), or the score. */
  readonly answers?: Readonly<Record<string, { readonly type: string; readonly value: number; readonly choice?: string }>>;
  readonly reason?: string;
  /** The asking seam's conclusion from these answers, on an answered row only. */
  readonly verdict?: JudgmentVerdict;
};
export type CoreEventType = keyof CoreEventPayloadMap;
export type CoreEventDraft<T extends CoreEventType = CoreEventType> = T extends CoreEventType
  ? Omit<EventDraft, "type" | "payload"> & { readonly type: T; readonly payload: CoreEventPayloadMap[T] }
  : never;
interface CoreEventRegistration { readonly step: boolean; readonly request: boolean; readonly call: boolean }
function registration(value: CoreEventRegistration): CoreEventRegistration { return Object.freeze(value); }
/** One exhaustive registry drives ownership and structural envelope validation for core events. */
export const CORE_EVENT_REGISTRY = Object.freeze({
  "turn/start": registration({ step: false, request: false, call: false }),
  "turn/end": registration({ step: false, request: false, call: false }),
  "turn/failed": registration({ step: false, request: false, call: false }),
  "step/start": registration({ step: true, request: false, call: false }),
  "step/end": registration({ step: true, request: false, call: false }),
  "user/input": registration({ step: false, request: false, call: false }),
  "application/context": registration({ step: false, request: false, call: false }),
  "assistant/message": registration({ step: true, request: true, call: false }),
  "assistant/narration": registration({ step: false, request: false, call: false }),
  "assistant/narration-superseded": registration({ step: true, request: false, call: false }),
  "request/prepared": registration({ step: true, request: true, call: false }),
  "llm/attempt-failed": registration({ step: true, request: true, call: false }),
  "llm/attempt-committed": registration({ step: true, request: true, call: false }),
  "llm/attempt-discarded": registration({ step: true, request: true, call: false }),
  "usage/recorded": registration({ step: true, request: true, call: false }),
  "memory/context-selected": registration({ step: false, request: false, call: false }),
  "memory/context-unavailable": registration({ step: false, request: false, call: false }),
  "model/route-selected": registration({ step: false, request: false, call: false }),
  "context/trimmed": registration({ step: true, request: false, call: false }),
  "context/checkpoint": registration({ step: false, request: false, call: false }),
  "tool/intent": registration({ step: true, request: false, call: true }),
  "tool/policy-decision": registration({ step: true, request: false, call: true }),
  "tool/state": registration({ step: true, request: false, call: true }),
  "tool/result": registration({ step: true, request: false, call: true }),
  [APPROVAL_EVENT.REQUESTED]: registration({ step: false, request: false, call: false }),
  [APPROVAL_EVENT.RESOLVED]: registration({ step: false, request: false, call: false }),
  "interaction/requested": registration({ step: false, request: false, call: false }),
  "interaction/resolved": registration({ step: false, request: false, call: false }),
  // The runtime closes a plan at the turn's terminal, which is not always inside a model step.
  "work/plan-updated": registration({ step: false, request: false, call: false }),
  "work/step-progress": registration({ step: true, request: false, call: false }),
  "work/decision": registration({ step: true, request: false, call: false }),
  "turn/control-decision": registration({ step: true, request: false, call: false }),
  // A judgment may be asked before any model step, as a policy's directive is.
  "judgment/classified": registration({ step: false, request: false, call: false }),
  "tool/selection": registration({ step: false, request: false, call: false }),
} satisfies Record<CoreEventType, CoreEventRegistration>);
