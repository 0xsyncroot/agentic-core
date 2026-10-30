import { parseTurnAttachments } from "../agent/attachment.js";
import { APPROVAL_DECISION, APPROVAL_EVENT } from "../approvals/approval.js";
import { isRuntimeQuestion, RUNTIME_REQUESTER_ID } from "../interactions/interaction.js";
import type { JsonValue } from "../shared/json.js";
import { TOOL_EXECUTION_STATES, TOOL_TERMINAL_EXECUTION_STATES, toolNextCallReads } from "../tools/tool.js";
import { assertValidWorkProgressFacts } from "../work/step-progress.js";
import { assertToolSelectionPayload } from "../tools/tool-groups.js";
import { CORE_EVENT_REGISTRY, type CoreEventType } from "./core-events.js";
import { boundedString, isObject, nonEmpty, type JsonObject } from "./event-payload-guards.js";
import { assertValidPlanPayload } from "./plan-event-validation.js";
import type { EventDraft } from "./session.js";

const TOOL_STATE_SET = new Set<string>(TOOL_EXECUTION_STATES);
const TOOL_TERMINAL_STATE_SET = new Set<string>(TOOL_TERMINAL_EXECUTION_STATES);
const CORE_EVENT_TYPES = new Set<string>(Object.keys(CORE_EVENT_REGISTRY));
const PAUSE_KINDS = ["approval", "interaction"];
const PAUSE_CLOSURE_REASONS = ["superseded", "expired"];

function payloadObject(draft: EventDraft): JsonObject {
  if (!draft.payload || typeof draft.payload !== "object" || Array.isArray(draft.payload)) {
    throw new Error(`Core event ${draft.type} payload must be an object`);
  }
  return draft.payload;
}

/** A runtime-authored link between two turns or a pause: every id present, the kind one of the two pauses. */
function validPauseLink(value: JsonValue | undefined, ids: readonly string[]): boolean {
  return isObject(value) && PAUSE_KINDS.includes(String(value.pauseKind)) && ids.every((key) => nonEmpty(value[key]));
}

/** A standing decision allowed the call itself: it names its revision and time, and no earlier approval covered the call too. */
function standingApprovalRecord(payload: JsonObject): boolean {
  const standing = payload.standingApproval;
  return isObject(standing) && nonEmpty(standing.revision) && boundedString(standing.revision, 64) && nonEmpty(standing.since)
    && Number.isFinite(Date.parse(standing.since)) && (standing.presentation === undefined || isObject(standing.presentation))
    && payload.outcome === "allow" && payload.coveredBy === undefined;
}

/** A closure written by the runtime says why, says so as the runtime, and cannot also claim a user's answer. */
function assertRuntimeClosure(type: string, payload: JsonObject, outcomeKey: "decision" | "action", closedOutcome: (reason: string) => string): void {
  if (payload.reason === undefined) return;
  if (!PAUSE_CLOSURE_REASONS.includes(String(payload.reason)) || payload.resolvedBy !== "runtime" ||
      payload[outcomeKey] !== closedOutcome(String(payload.reason))) {
    throw new Error(`${type} closed by the runtime requires reason superseded or expired, resolvedBy runtime and a matching ${outcomeKey}`);
  }
}

function assertValidEcho(echo: JsonValue | undefined): void {
  if (echo === undefined) return;
  if (!Array.isArray(echo) || echo.some((entry) => !isObject(entry) || typeof entry.label !== "string" || typeof entry.value !== "string")) {
    throw new Error("interaction/resolved echo must be a list of label and value strings");
  }
}

/** Checks for fields added after the first event schema; each is optional, and checked only when present. */
function assertValidLifecycleFields(draft: EventDraft, payload: JsonObject): void {
  if (draft.type === "turn/start" && payload.continuation !== undefined &&
      !validPauseLink(payload.continuation, ["pauseId", "fromTurnId", "rootTurnId"])) {
    throw new Error("turn/start has an invalid continuation");
  }
  if (draft.type === "turn/end" && payload.decision !== undefined && !["finish", "partial", "budget-reached"].includes(String(payload.decision))) {
    throw new Error("turn/end has an unknown decision");
  }
  // The user's answer to a question the runtime asked says which way they chose; a closure says nothing of the kind.
  if (draft.type === "interaction/resolved" && payload.requesterId !== undefined &&
      (payload.requesterId !== RUNTIME_REQUESTER_ID || payload.reason !== undefined || (payload.choice !== "continue" && payload.choice !== "stop"))) {
    throw new Error("interaction/resolved for a runtime question requires its choice, continue or stop");
  }
  if (draft.type === "tool/result") {
    if (payload.workStepId !== undefined && !nonEmpty(payload.workStepId)) throw new Error("tool/result workStepId must be a step id");
    if (payload.informationGain !== undefined && payload.informationGain !== "new" && payload.informationGain !== "repeated") {
      throw new Error("tool/result informationGain must be new or repeated");
    }
    if (payload.closure !== undefined && !validPauseLink(payload.closure, ["pauseId", "closedByTurnId"])) {
      throw new Error("tool/result has an invalid closure");
    }
    if (payload.nextCall !== undefined) {
      const next = payload.nextCall as Record<string, JsonValue> | null;
      if (!next || typeof next !== "object" || Array.isArray(next) || !nonEmpty(next.toolId) || typeof next.why !== "string"
        || !next.arguments || typeof next.arguments !== "object" || Array.isArray(next.arguments)) {
        throw new Error("tool/result nextCall must name a tool, its arguments as an object and why");
      }
      if (next.reads !== undefined && !toolNextCallReads(next.reads)) {
        throw new Error("tool/result nextCall reads must name its source, a one-word unit, the source's parts and the part it reads");
      }
    }
    if (payload.attempt !== undefined) {
      const attempt = payload.attempt as Record<string, JsonValue> | null;
      if (!attempt || typeof attempt !== "object" || Array.isArray(attempt) || !nonEmpty(attempt.signature) || typeof attempt.failures !== "number"
        || !Number.isInteger(attempt.failures) || attempt.failures < 0 || (attempt.failure !== undefined && !nonEmpty(attempt.failure))) {
        throw new Error("tool/result attempt must carry a signature, a failure count and an optional reason");
      }
    }
  }
  if (draft.type === APPROVAL_EVENT.RESOLVED) assertRuntimeClosure(draft.type, payload, "decision", (reason) => reason);
  if (draft.type === "interaction/resolved") {
    assertRuntimeClosure(draft.type, payload, "action", () => "cancel");
    assertValidEcho(payload.echo);
  }
}

/** A judgment's payload: a named seam, a known outcome, and bounded finite values only. */
function assertJudgmentClassified(payload: JsonObject): void {
  if (!nonEmpty(payload.seam) || !boundedString(payload.seam, 64)) throw new Error("judgment/classified requires a bounded seam");
  if (!boundedString(payload.providerId, 64) || !boundedString(payload.modelId, 128)) throw new Error("judgment/classified requires providerId and modelId");
  if (payload.outcome !== "answered" && payload.outcome !== "failed") throw new Error("judgment/classified outcome must be answered or failed");
  if (typeof payload.elapsedMs !== "number" || !Number.isFinite(payload.elapsedMs) || payload.elapsedMs < 0) throw new Error("judgment/classified requires elapsedMs");
  if (payload.reason !== undefined && !boundedString(payload.reason, 300)) throw new Error("judgment/classified reason is bounded");
  if (payload.verdict !== undefined) assertJudgmentVerdict(payload.verdict, payload.outcome);
  if (payload.answers === undefined) return;
  if (!isObject(payload.answers) || Object.keys(payload.answers).length > 64) throw new Error("judgment/classified answers must be an object of at most 64 entries");
  for (const answer of Object.values(payload.answers)) {
    if (!isObject(answer) || !nonEmpty(answer.type) || typeof answer.value !== "number" || !Number.isFinite(answer.value)) {
      throw new Error("judgment/classified answers carry a type and a finite value");
    }
  }
}

/** A seam's verdict: only beside answers, with a bounded label, a threshold between 0 and 1, a known mode and the hash's word. */
function assertJudgmentVerdict(verdict: JsonValue, outcome: JsonValue | undefined): void {
  if (outcome !== "answered") throw new Error("judgment/classified verdict needs an answered outcome");
  if (!isObject(verdict) || !nonEmpty(verdict.label) || !boundedString(verdict.label, 64)) throw new Error("judgment/classified verdict requires a bounded label");
  if (typeof verdict.threshold !== "number" || !Number.isFinite(verdict.threshold) || verdict.threshold < 0 || verdict.threshold > 1) {
    throw new Error("judgment/classified verdict threshold must lie between 0 and 1");
  }
  if (verdict.mode !== "shadow" && verdict.mode !== "on") throw new Error("judgment/classified verdict mode must be shadow or on");
  if (typeof verdict.sameHash !== "boolean") throw new Error("judgment/classified verdict sameHash must be a boolean");
  if (verdict.item !== undefined && (!nonEmpty(verdict.item) || !boundedString(verdict.item, 300))) throw new Error("judgment/classified verdict item is a bounded string");
}

/** Runtime boundary validation for core-owned durable facts. Extension events remain versioned by their owning plugin. */
export function assertValidCoreEventDraft(draft: EventDraft): void {
  if (!CORE_EVENT_TYPES.has(draft.type)) return;
  const registration = CORE_EVENT_REGISTRY[draft.type as CoreEventType];
  if ((draft.schemaVersion ?? 1) !== 1) throw new Error(`Unsupported core event schema: ${draft.type}@${draft.schemaVersion}`);
  if (!draft.turnId) throw new Error(`Core event ${draft.type} requires turnId`);
  if (registration.step && !draft.stepId) throw new Error(`Core event ${draft.type} requires stepId`);
  if (registration.call && !draft.callId) throw new Error(`Core event ${draft.type} requires callId`);
  if (registration.request && !draft.requestId) throw new Error(`Core event ${draft.type} requires requestId`);
  const payload = payloadObject(draft);
  if (draft.type === "judgment/classified") assertJudgmentClassified(payload);
  if (draft.type === "turn/start" && typeof payload.inputIdempotencyKey !== "string") throw new Error("turn/start requires inputIdempotencyKey");
  if (draft.type === "turn/start" && payload.runtimeBinding !== undefined) {
    const binding = payload.runtimeBinding;
    if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
        ["tenantId", "agentProfileId", "routeRevision", "runtimeSnapshotId"].some((key) =>
          typeof (binding as Record<string, JsonValue>)[key] !== "string" || !(binding as Record<string, JsonValue>)[key])) {
      throw new Error("turn/start has an invalid runtimeBinding");
    }
  }
  if (draft.type === "user/input" && typeof payload.content !== "string") throw new Error("user/input requires content");
  if (draft.type === "user/input" && payload.attachments !== undefined) parseTurnAttachments(payload.attachments);
  if (draft.type === "application/context" && payload.trusted === undefined && payload.untrusted === undefined) {
    throw new Error("application/context requires trusted or untrusted context");
  }
  if (draft.type === "application/context" && payload.trusted !== undefined && (!payload.trusted ||
      typeof payload.trusted !== "object" || Array.isArray(payload.trusted) || Object.values(payload.trusted).some((value) => typeof value !== "string"))) {
    throw new Error("application/context trusted values must be strings");
  }
  if (draft.type === "assistant/narration" &&
    (typeof payload.narrationId !== "string" || !payload.narrationId.trim() || payload.audience !== "user" || typeof payload.content !== "string" || !payload.content.trim())) {
    throw new Error("assistant/narration requires narrationId, audience user and non-empty content");
  }
  if (draft.type === "assistant/narration-superseded" && (typeof payload.narrationId !== "string" || !payload.narrationId.trim() ||
    typeof payload.by !== "string" || !payload.by.trim() || payload.by === payload.narrationId)) {
    throw new Error("assistant/narration-superseded requires narrationId and another narration's id as by");
  }
  if (draft.type === "step/start" && typeof payload.index !== "number") throw new Error("step/start requires index");
  if ((draft.type === "turn/end" || draft.type === "step/end") && typeof payload.status !== "string") throw new Error(`${draft.type} requires status`);
  if ((draft.type === "tool/intent" || draft.type === "tool/policy-decision" || draft.type === "tool/state" || draft.type === "tool/result") &&
    (typeof payload.callId !== "string" || typeof payload.executionId !== "string" || typeof payload.toolId !== "string")) {
    throw new Error(`${draft.type} requires callId, executionId and toolId`);
  }
  if (draft.type === "tool/intent" && payload.state !== "prepared") throw new Error("tool/intent requires prepared state");
  if (draft.type === "tool/policy-decision" &&
    (typeof payload.decisionId !== "string" || typeof payload.outcome !== "string" || typeof payload.policyRevision !== "string" ||
      typeof payload.reason !== "string" || typeof payload.actionDigest !== "string")) {
    throw new Error("tool/policy-decision requires decisionId, outcome, policyRevision, reason and actionDigest");
  }
  if (draft.type === "tool/policy-decision" && payload.coveredBy !== undefined && (typeof payload.coveredBy !== "string" || payload.outcome !== "allow")) {
    throw new Error("tool/policy-decision coveredBy names the approval an allowed call stays within");
  }
  if (draft.type === "tool/policy-decision" && payload.standingApproval !== undefined && !standingApprovalRecord(payload)) {
    throw new Error("tool/policy-decision standingApproval names the actor's standing decision on an allowed call no approval covers");
  }
  if (draft.type === "tool/state" && (typeof payload.state !== "string" || !TOOL_STATE_SET.has(payload.state))) throw new Error("tool/state requires a valid state");
  if (draft.type === "tool/result" && (typeof payload.state !== "string" || !TOOL_TERMINAL_STATE_SET.has(payload.state))) throw new Error("tool/result requires a terminal state");
  if (draft.type === "tool/result" && typeof payload.dispatched !== "boolean") throw new Error("tool/result requires dispatched");
  if (draft.type === "approval/requested" &&
    (typeof payload.approvalId !== "string" || typeof payload.callId !== "string" || typeof payload.executionId !== "string" ||
      typeof payload.toolId !== "string" || typeof payload.arguments !== "string" || typeof payload.actionDigest !== "string" ||
      typeof payload.policyRevision !== "string" || typeof payload.runtimeSnapshotId !== "string" || typeof payload.runtimeRouteRevision !== "string" || typeof payload.agentProfileId !== "string" || typeof payload.grantRevision !== "string" || typeof payload.expiresAt !== "string")) {
    throw new Error("approval/requested requires a complete action binding");
  }
  if (draft.type === "approval/requested" && payload.interaction !== undefined &&
    (typeof payload.interaction !== "object" || payload.interaction === null || Array.isArray(payload.interaction) ||
      typeof (payload.interaction as Record<string, JsonValue>).interactionId !== "string" ||
      !["accept", "decline", "cancel"].includes(String((payload.interaction as Record<string, JsonValue>).action)))) {
    throw new Error("approval/requested has an invalid interaction binding");
  }
  if (draft.type === APPROVAL_EVENT.RESOLVED &&
    (typeof payload.approvalId !== "string" || ![APPROVAL_DECISION.APPROVE, APPROVAL_DECISION.DENY, "superseded", "expired"].includes(String(payload.decision)) || typeof payload.actionDigest !== "string" || typeof payload.resolvedBy !== "string")) {
    throw new Error("approval/resolved requires approvalId, decision, actionDigest and resolvedBy");
  }
  // A question the runtime asks binds no call: the binding to the person, grants, runtime and profile is all it has.
  if (draft.type === "interaction/requested" &&
    (typeof payload.interactionId !== "string" || typeof payload.requesterId !== "string" || typeof payload.request !== "object" || payload.request === null ||
      typeof payload.policyRevision !== "string" ||
      (!isRuntimeQuestion(payload) && (typeof payload.callId !== "string" || typeof payload.executionId !== "string" ||
        typeof payload.toolId !== "string" || typeof payload.arguments !== "string" || typeof payload.actionDigest !== "string" || typeof payload.decisionId !== "string" ||
        (payload.authorizationOutcome !== "allow" && payload.authorizationOutcome !== "require_approval"))) ||
      typeof payload.runtimeSnapshotId !== "string" || typeof payload.runtimeRouteRevision !== "string" || typeof payload.agentProfileId !== "string" || typeof payload.requestedBy !== "string" ||
      typeof payload.grantRevision !== "string" || typeof payload.expiresAt !== "string")) {
    throw new Error("interaction/requested requires a complete continuation binding");
  }
  if (draft.type === "interaction/requested" && isRuntimeQuestion(payload) && draft.callId !== undefined) {
    throw new Error("interaction/requested asked by the runtime binds no call");
  }
  if (draft.type === "interaction/resolved" &&
    (typeof payload.interactionId !== "string" || typeof payload.action !== "string" || typeof payload.actionDigest !== "string" ||
      typeof payload.resolvedBy !== "string" || typeof payload.resolvedAt !== "string")) {
    throw new Error("interaction/resolved requires interactionId, action, binding, actor and timestamp");
  }
  if (draft.type === "work/plan-updated") assertValidPlanPayload(payload);
  assertValidWorkProgressFacts(draft.type, payload);
  if (draft.type === "work/decision" && typeof payload.decision !== "string") throw new Error("work/decision requires decision");
  if (draft.type === "turn/control-decision" && (typeof payload.policyId !== "string" || !payload.policyId ||
      typeof payload.policyRevision !== "string" || !payload.policyRevision || !["before-model", "tool-call", "terminal", "choice-violation"].includes(String(payload.phase)) ||
      typeof payload.decision !== "string")) {
    throw new Error("turn/control-decision requires policy identity, phase and decision");
  }
  if (draft.type === "turn/control-decision" && payload.delivered !== undefined && payload.delivered !== true) {
    throw new Error("turn/control-decision delivered is true or absent");
  }
  if (draft.type === "usage/recorded" &&
    (typeof payload.providerId !== "string" || typeof payload.model !== "string" || typeof payload.reported !== "boolean" ||
      !Number.isInteger(payload.inputTokens) || Number(payload.inputTokens) < 0 ||
      !Number.isInteger(payload.outputTokens) || Number(payload.outputTokens) < 0 ||
      !Number.isInteger(payload.totalTokens) || Number(payload.totalTokens) < 0)) {
    throw new Error("usage/recorded requires normalized non-negative token counts");
  }
  if (draft.type === "llm/attempt-failed" &&
    (typeof payload.code !== "string" || typeof payload.message !== "string" || typeof payload.retryable !== "boolean" ||
      typeof payload.willRetry !== "boolean" || !Number.isInteger(payload.attempt) || Number(payload.attempt) < 1)) {
    throw new Error("llm/attempt-failed requires normalized error details, retry decision and attempt");
  }
  if (draft.type === "memory/context-selected" && (!Array.isArray(payload.records) || typeof payload.contextHash !== "string")) {
    throw new Error("memory/context-selected requires records and contextHash");
  }
  if (draft.type === "memory/context-unavailable" &&
    ((payload.reason !== "error" && payload.reason !== "timeout") || typeof payload.message !== "string" || payload.message.length > 300 ||
      (payload.code !== undefined && (typeof payload.code !== "string" || payload.code.length > 64)))) {
    throw new Error("memory/context-unavailable requires reason error or timeout, a message of at most 300 characters and an optional code of at most 64");
  }
  if (draft.type === "model/route-selected" &&
    (typeof payload.providerId !== "string" || typeof payload.adapterId !== "string" || typeof payload.modelId !== "string" ||
      typeof payload.routeRevision !== "string" || typeof payload.metadataSource !== "string")) {
    throw new Error("model/route-selected requires a complete resolved route");
  }
  if (draft.type === "context/trimmed") {
    const count = (value: unknown) => Number.isInteger(value) && Number(value) >= 0;
    if (!count(payload.omittedMessages) || !count(payload.clearedResults ?? 0) || Number(payload.omittedMessages) + Number(payload.clearedResults ?? 0) < 1) {
      throw new Error("context/trimmed requires a positive omittedMessages or clearedResults count");
    }
  }
  if (draft.type === "context/checkpoint" &&
    (typeof payload.summary !== "string" || typeof payload.summaryHash !== "string" ||
      !Number.isInteger(payload.coveredThroughSeq) || Number(payload.coveredThroughSeq) < 1 ||
      typeof payload.compactorRevision !== "string" || typeof payload.projectorRevision !== "string" ||
      !Number.isInteger(payload.formatVersion) || typeof payload.inputDigest !== "string")) {
    throw new Error("context/checkpoint requires a versioned summary, hash, covered sequence and revisions");
  }
  if (draft.type === "turn/failed" && (typeof payload.code !== "string" || typeof payload.message !== "string" || typeof payload.retryable !== "boolean")) {
    throw new Error("turn/failed requires code, message and retryable");
  }
  if (draft.type === "tool/selection") assertToolSelectionPayload(payload);
  assertValidLifecycleFields(draft, payload);
}
