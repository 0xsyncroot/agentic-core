import { withoutInlineThought, projectTurnWork, type AgenticError, type SessionEvent, type TurnWork } from "@0xsyncroot/contracts";
import { historyTimelines, supersededNarrationIds } from "./history-timeline.js";
import type { ToolTraceLabeller } from "./public-agent-stream.js";
import { publicMessage, type BusinessMessages } from "./error-mapping.js";
import { publicPlan } from "./public-reasoning-text.js";

/** The finish reason core journals when the budget took a step's tool calls away (`budgetFinal`). */
const STEP_BUDGET_FINISH_REASON = "step-budget";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function approvalPresentation(value: unknown): Record<string, unknown> | undefined {
  const source = record(value);
  const bounded = (item: unknown, maximum: number) =>
    typeof item === "string" && item.trim() && item.length <= maximum ? item.trim() : undefined;
  const summary = bounded(source?.summary, 800);
  const action = bounded(source?.action, 160);
  const target = bounded(source?.target, 320);
  const impact = bounded(source?.impact, 800);
  if (!source || !summary || !action || !target || !impact) return undefined;
  const rawFields = Array.isArray(source.fields) ? source.fields : [];
  if (rawFields.length > 8) return undefined;
  const fields = rawFields.flatMap((item) => {
    const candidate = record(item);
    const label = bounded(candidate?.label, 80);
    const value = candidate?.value;
    return label && ["string", "number", "boolean"].includes(typeof value) && String(value).length <= 256 &&
      (typeof value !== "number" || Number.isFinite(value)) ? [{ label, value }] : [];
  });
  if (fields.length !== rawFields.length) return undefined;
  return { summary, action, target, impact, ...(fields.length ? { fields } : {}) };
}

/** `approval/resolved.decision` is already `"approve" | "deny" | PauseClosureReason`, so this is a straight rename. */
function approvalState(resolved: Record<string, unknown> | undefined): "pending" | "approved" | "denied" | "superseded" | "expired" {
  const decision = resolved?.decision;
  if (decision === "approve") return "approved";
  if (decision === "deny") return "denied";
  return decision === "superseded" || decision === "expired" ? decision : "pending";
}

/** A runtime-closed pause carries `reason`; a user-initiated decline/cancel does not (spec v2.1 §10.8). */
function interactionState(resolved: Record<string, unknown> | undefined): "pending" | "answered" | "declined" | "superseded" | "expired" {
  if (!resolved) return "pending";
  const reason = resolved.reason;
  if (reason === "superseded" || reason === "expired") return reason;
  return resolved.action === "accept" ? "answered" : "declined";
}

/** A turn's narrations as the chat last showed them: one a later step superseded is left out. */
function narrationsOf(turnEvents: readonly SessionEvent[]): readonly Record<string, unknown>[] {
  const superseded = supersededNarrationIds(turnEvents);
  return turnEvents.flatMap((candidate) => {
    const payload = record(candidate.payload);
    return candidate.type === "assistant/narration" && payload?.audience === "user" &&
      typeof payload.narrationId === "string" && typeof payload.content === "string" && payload.content.trim() &&
      !superseded.get(candidate.turnId ?? "")?.has(payload.narrationId)
      ? [{ narrationId: payload.narrationId, content: withoutInlineThought(payload.content), audience: "user" as const, ...(payload.draft === true ? { draft: true } : {}) }]
      : [];
  });
}

/** `work` mirrors `TurnWork` minus the fields the entry already carries at the top level. */
function turnWorkPayload(work: TurnWork | undefined, timeline: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    ...(work?.durationMs !== undefined ? { durationMs: work.durationMs } : {}),
    ...(work?.decision ? { decision: work.decision } : {}),
    ...(work?.plan ? { plan: publicPlan(work.plan) } : {}),
    timeline,
    tools: timeline.filter((item) => item.type === "tool-completed").map(({ callId, label, status, workStepId }) => ({ callId, label, status, ...(workStepId ? { workStepId } : {}) })),
  };
}

/**
 * One turn's history entry, built the way the wire v1 assistant shape describes it: a status
 * from the turn's own lifecycle, durable narration, `projectTurnWork`'s per-turn work, and an
 * approval/interaction card whose `state` is read off its (possibly later-turn) resolution event
 * rather than guessed from expiry — the runtime already closed it if it is gone.
 */
function assistantEntry(
  turnId: string,
  events: readonly SessionEvent[],
  work: TurnWork | undefined,
  terminal: SessionEvent | undefined,
  timeline: readonly Record<string, unknown>[],
  businessMessages?: BusinessMessages,
): Record<string, unknown> | undefined {
  const turnEvents = events.filter((candidate) => candidate.turnId === turnId);
  const narrations = narrationsOf(turnEvents);

  const approvalRequested = turnEvents.find((candidate) => candidate.type === "approval/requested");
  const approvalRequestedPayload = record(approvalRequested?.payload);
  const approvalResolvedPayload = approvalRequestedPayload
    ? record(events.find((candidate) => candidate.type === "approval/resolved" &&
        record(candidate.payload)?.approvalId === approvalRequestedPayload.approvalId)?.payload)
    : undefined;
  const presentation = approvalPresentation(approvalRequestedPayload?.presentation);
  const approval = approvalRequestedPayload ? {
    approvalId: approvalRequestedPayload.approvalId, sessionId: terminal?.sessionId ?? approvalRequested?.sessionId, turnId,
    // toolId withheld, as on the live stream: see PublicAgentStreamWriter.progress.
    callId: approvalRequestedPayload.callId, sideEffect: approvalRequestedPayload.sideEffect,
    actionDigest: approvalRequestedPayload.actionDigest, policyRevision: approvalRequestedPayload.policyRevision,
    runtimeSnapshotId: approvalRequestedPayload.runtimeSnapshotId, agentProfileId: approvalRequestedPayload.agentProfileId,
    grantRevision: approvalRequestedPayload.grantRevision, expiresAt: approvalRequestedPayload.expiresAt,
    state: approvalState(approvalResolvedPayload),
    ...(presentation ? { presentation } : {}),
  } : undefined;

  const interactionRequested = turnEvents.find((candidate) => candidate.type === "interaction/requested");
  const interactionRequestedPayload = record(interactionRequested?.payload);
  const interactionRequest = record(interactionRequestedPayload?.request);
  const interactionResolvedPayload = interactionRequestedPayload
    ? record(events.find((candidate) => candidate.type === "interaction/resolved" &&
        record(candidate.payload)?.interactionId === interactionRequestedPayload.interactionId)?.payload)
    : undefined;
  const interaction = interactionRequestedPayload && interactionRequest ? {
    ...interactionRequest,
    interactionId: interactionRequestedPayload.interactionId, sessionId: terminal?.sessionId ?? interactionRequested?.sessionId, turnId,
    callId: interactionRequestedPayload.callId, requesterId: interactionRequestedPayload.requesterId,
    actionDigest: interactionRequestedPayload.actionDigest, policyRevision: interactionRequestedPayload.policyRevision,
    runtimeSnapshotId: interactionRequestedPayload.runtimeSnapshotId, agentProfileId: interactionRequestedPayload.agentProfileId,
    grantRevision: interactionRequestedPayload.grantRevision, expiresAt: interactionRequestedPayload.expiresAt,
    state: interactionState(interactionResolvedPayload),
    ...(interactionResolvedPayload?.echo !== undefined ? { echo: interactionResolvedPayload.echo } : {}),
  } : undefined;

  const failedPayload = terminal?.type === "turn/failed" ? record(terminal.payload) : undefined;
  const assistant = [...turnEvents].reverse().find((candidate) => candidate.type === "assistant/message" &&
    (approval || interaction || typeof record(candidate.payload)?.content === "string"));
  const assistantPayload = record(assistant?.payload);
  // A closed turn with nothing to show (no answer, no card, no failure) stays out of history, as
  // before; a turn still open on reload always gets its one placeholder entry.
  if (terminal && !assistant && !approval && !interaction && !failedPayload) return undefined;

  // As the live stream says it: a failed turn by its reason first, and a turn the budget stopped
  // while the model was still reaching for tools by the product's own sentence — that message's
  // text was a working note, or the runtime's transcript note, never an answer.
  const failedReason = typeof failedPayload?.reason === "string" ? failedPayload.reason as AgenticError["reason"] : undefined;
  const budgetStopped = assistantPayload?.finishReason === STEP_BUDGET_FINISH_REASON;
  const content = approval ? "Approval required."
    : failedPayload ? publicMessage(businessMessages, String(failedPayload.code), failedReason)
      : budgetStopped ? businessMessages?.emptyAnswer?.stopped ?? ""
        : typeof assistantPayload?.content === "string" ? withoutInlineThought(assistantPayload.content)
          : typeof interactionRequest?.message === "string" ? interactionRequest.message : "";
  const status = work?.status ?? (terminal ? (terminal.type === "turn/failed" ? "failed" : "completed") : "in_progress");

  return {
    role: "assistant", content,
    ...(assistantPayload?.ui !== undefined ? { ui: assistantPayload.ui } : {}),
    ...(narrations.length ? { narrations } : {}),
    ...(work?.continuesTurnId ? { continuesTurnId: work.continuesTurnId } : {}),
    ...(approval ? { approval } : {}), ...(interaction ? { interaction } : {}),
    // The classified code as structure, so a client tells a user's stop (`cancelled`) apart without reading the sentence.
    ...(failedPayload ? { failure: { code: typeof failedPayload.code === "string" ? failedPayload.code : "unknown" } } : {}),
    turnId, status, at: assistant?.occurredAt ?? terminal?.occurredAt ?? approvalRequested?.occurredAt ?? interactionRequested?.occurredAt,
    work: turnWorkPayload(work, timeline),
  };
}

export function visibleMessages(events: readonly SessionEvent[], options: { readonly toolTrace?: ToolTraceLabeller; readonly businessMessages?: BusinessMessages } = {}): readonly Record<string, unknown>[] {
  const timelines = historyTimelines(events, options.toolTrace);
  const workByTurn = new Map(projectTurnWork(events).map((work) => [work.turnId, work]));
  const messages: Record<string, unknown>[] = [];
  const handledTurns = new Set<string>();
  let lastUserTurnId: string | undefined;

  for (const event of events) {
    if (event.type === "user/input") {
      const content = record(event.payload)?.content;
      if (typeof content === "string") messages.push({ role: "user", content, turnId: event.turnId, at: event.occurredAt, attachments: publicAttachments(record(event.payload)?.attachments) });
      if (event.turnId) lastUserTurnId = event.turnId;
      continue;
    }
    if ((event.type !== "turn/end" && event.type !== "turn/failed") || !event.turnId || handledTurns.has(event.turnId)) continue;
    handledTurns.add(event.turnId);
    const entry = assistantEntry(event.turnId, events, workByTurn.get(event.turnId), event, timelines.get(event.turnId) ?? [], options.businessMessages);
    if (entry) messages.push(entry);
  }

  // A reload mid-turn (no terminal event yet) still gets one entry, so the caller can render the
  // same faded "still working" line live and history show for the same operation.
  if (lastUserTurnId && !handledTurns.has(lastUserTurnId)) {
    const entry = assistantEntry(lastUserTurnId, events, workByTurn.get(lastUserTurnId), undefined, timelines.get(lastUserTurnId) ?? [], options.businessMessages);
    if (entry) messages.push(entry);
  }

  return messages;
}

function publicAttachments(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const file = record(item);
    return file && typeof file.name === "string" && typeof file.id === "string" ? [{ id: file.id, name: file.name,
      type: file.mediaType, size: file.byteSize, source: file.source }] : [];
  }) : [];
}
