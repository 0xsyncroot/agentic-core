import type { EventDraft, PauseClosureReason, PauseKind, SessionEvent } from "@0xsyncroot/contracts";
import type { ClaimedTurn } from "./claimed-turn.js";
import { toJsonValue } from "./json-value.js";

/**
 * What the model reads for a paused call the runtime withdrew. Model-facing, so English like every
 * instruction the runtime writes; the model answers the user in the conversation's language.
 */
export const PAUSE_CLOSURE_MESSAGES: Readonly<Record<PauseClosureReason, string>> = Object.freeze({
  superseded: "The user sent a new message instead of answering this request, so it was withdrawn and nothing was run. "
    + "Read their new message; ask again only if it is still needed.",
  expired: "This request expired before the user answered, so it was withdrawn and nothing was run. "
    + "Read their new message; ask again only if it is still needed.",
});

const ID_KEY: Readonly<Record<PauseKind, string>> = { approval: "approvalId", interaction: "interactionId" };

/** A request the journal put to the user that nobody has answered. */
export interface OpenPause {
  readonly kind: PauseKind;
  readonly pauseId: string;
  /** The `approval/requested` or `interaction/requested` event: its envelope names the paused call. */
  readonly requested: SessionEvent;
  readonly payload: Readonly<Record<string, unknown>>;
}

function payloadOf(event: SessionEvent): Readonly<Record<string, unknown>> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Readonly<Record<string, unknown>>
    : {};
}

function pauseKindOf(type: string, suffix: "requested" | "resolved"): PauseKind | undefined {
  if (type === `approval/${suffix}`) return "approval";
  if (type === `interaction/${suffix}`) return "interaction";
  return undefined;
}

/** Every request in the events with no resolution for the same pause, oldest first. */
export function openPauses(events: readonly SessionEvent[]): readonly OpenPause[] {
  const resolved = new Set<string>();
  for (const event of events) {
    const kind = pauseKindOf(event.type, "resolved");
    const id = kind ? payloadOf(event)[ID_KEY[kind]] : undefined;
    if (kind && typeof id === "string") resolved.add(`${kind}:${id}`);
  }
  return events.flatMap((event): OpenPause[] => {
    const kind = pauseKindOf(event.type, "requested");
    const payload = payloadOf(event);
    const pauseId = kind ? payload[ID_KEY[kind]] : undefined;
    if (!kind || typeof pauseId !== "string" || resolved.has(`${kind}:${pauseId}`)) return [];
    return [{ kind, pauseId, requested: event, payload }];
  });
}

/** `expired` once the request's own deadline has passed, whoever notices it; `superseded` before that. */
function closureReason(pause: OpenPause, now: number): PauseClosureReason {
  return Date.parse(String(pause.payload.expiresAt)) <= now ? "expired" : "superseded";
}

function resolvedDraft(pause: OpenPause, reason: PauseClosureReason, closingTurnId: string, resolvedAt: string): EventDraft {
  const common = { reason, actionDigest: String(pause.payload.actionDigest ?? ""), resolvedBy: "runtime", resolvedAt };
  return pause.kind === "approval"
    ? { type: "approval/resolved", turnId: closingTurnId, payload: { approvalId: pause.pauseId, decision: reason, ...common } }
    : { type: "interaction/resolved", turnId: closingTurnId, payload: { interactionId: pause.pauseId, action: "cancel", ...common } };
}

/**
 * The paused call's own result, under the paused call's turn, step and call — where the model's
 * call is, so the next request answers that call with this — joined to it by its execution.
 */
function closedResultDraft(pause: OpenPause, reason: PauseClosureReason, closingTurnId: string): EventDraft | undefined {
  const { requested, payload } = pause;
  const executionId = payload.executionId;
  if (typeof executionId !== "string" || !requested.turnId || !requested.stepId || !requested.callId) return undefined;
  return {
    type: "tool/result", turnId: requested.turnId, stepId: requested.stepId, callId: requested.callId,
    payload: toJsonValue({
      callId: requested.callId, executionId, toolId: String(payload.toolId ?? ""), state: "cancelled", dispatched: false,
      error: { type: "tool_error", code: reason, retryable: false, message: PAUSE_CLOSURE_MESSAGES[reason] },
      closure: { pauseKind: pause.kind, pauseId: pause.pauseId, closedByTurnId: closingTurnId },
    }),
  };
}

/**
 * The drafts that close every pause still open in the events, on behalf of the turn now running.
 *
 * Each pause gets its resolution, written as the runtime's and with why, and its paused call a
 * cancelled result the model reads — unless that call already has one: a worker lost mid-turn
 * leaves its pause open but lease recovery has already closed the call, and a second result would
 * answer the model's call twice.
 */
export function pauseClosureDrafts(events: readonly SessionEvent[], closingTurnId: string, now = Date.now()): readonly EventDraft[] {
  const answeredExecutions = new Set(events.flatMap((event) => {
    const executionId = event.type === "tool/result" ? payloadOf(event).executionId : undefined;
    return typeof executionId === "string" ? [executionId] : [];
  }));
  const resolvedAt = new Date(now).toISOString();
  return openPauses(events).flatMap((pause) => {
    const reason = closureReason(pause, now);
    const result = answeredExecutions.has(String(pause.payload.executionId)) ? undefined : closedResultDraft(pause, reason, closingTurnId);
    if (result) answeredExecutions.add(String(pause.payload.executionId));
    return [resolvedDraft(pause, reason, closingTurnId, resolvedAt), ...(result ? [result] : [])];
  });
}

/**
 * A new message from the user closes whatever the previous turn left waiting on them.
 *
 * A card left open after the user wrote something else was a call the model had made and nobody
 * answered: the next request carried a tool call with no result, which providers refuse, and the
 * card stayed live — an approval the user had walked away from could still run the write later.
 * This is what a person does with a question they no longer want answered: they say so. The pause
 * is resolved by the runtime and its call answered with why, in the turn's first append after its
 * claim, before the model or a policy reads anything; a click on the old card then finds it closed.
 */
export async function closeOpenPauses(turn: ClaimedTurn): Promise<void> {
  const drafts = pauseClosureDrafts(await turn.view.events(), turn.turnId);
  if (drafts.length > 0) await turn.writer.append(drafts, `pause-closure:${turn.turnId}`);
}
