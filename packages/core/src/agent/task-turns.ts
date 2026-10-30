import type { SessionEvent, TurnContinuation } from "@0xsyncroot/contracts";

function payloadOf(event: SessionEvent): Readonly<Record<string, unknown>> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Readonly<Record<string, unknown>>
    : {};
}

/** The link a resume turn's start event carries, when it is one. */
export function turnContinuation(events: readonly SessionEvent[], turnId: string): TurnContinuation | undefined {
  const start = events.find((event) => event.type === "turn/start" && event.turnId === turnId);
  const link = start ? payloadOf(start).continuation : undefined;
  if (!link || typeof link !== "object" || Array.isArray(link)) return undefined;
  const value = link as Record<string, unknown>;
  if ((value.pauseKind !== "approval" && value.pauseKind !== "interaction") ||
      typeof value.pauseId !== "string" || typeof value.fromTurnId !== "string" || typeof value.rootTurnId !== "string") {
    return undefined;
  }
  return { pauseKind: value.pauseKind, pauseId: value.pauseId, fromTurnId: value.fromTurnId, rootTurnId: value.rootTurnId };
}

/**
 * The turns of the task a turn belongs to, oldest first: the user turn that began it and every
 * turn that resumed it after an approval or an answer, up to and including this one.
 *
 * Followed through the `continuation` each resume turn's start event records, never inferred from
 * `approval/resolved` or `interaction/resolved` — a pause the runtime closed because the user wrote
 * something else is not a continuation, and the new message starts a new task. The walk stops at the view's edge: a turn
 * whose start is no longer in the bounded window still counts, the ones before it cannot be known.
 */
export function taskTurnIdsFor(events: readonly SessionEvent[], turnId: string): readonly string[] {
  const chain = [turnId];
  let link = turnContinuation(events, turnId);
  while (link && !chain.includes(link.fromTurnId)) {
    chain.unshift(link.fromTurnId);
    link = turnContinuation(events, link.fromTurnId);
  }
  return Object.freeze(chain);
}
