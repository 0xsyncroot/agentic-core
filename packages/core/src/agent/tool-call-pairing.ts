import type { SessionEvent } from "@0xsyncroot/contracts";

function payloadOf(event: SessionEvent): Readonly<Record<string, unknown>> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Readonly<Record<string, unknown>>
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function intentKey(turnId: string | undefined, stepId: string | undefined, callId: string): string {
  return JSON.stringify([turnId ?? "", stepId ?? "", callId]);
}

/** The ids of the tool calls an assistant message made, in order. */
export function assistantToolCallIds(event: SessionEvent): readonly string[] {
  if (event.type !== "assistant/message") return [];
  const calls = payloadOf(event).toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call) => call && typeof call === "object" && typeof (call as Record<string, unknown>).id === "string"
    ? [String((call as Record<string, unknown>).id)] : []);
}

/**
 * Pairs a model's tool calls with what the journal recorded for them, in two hops.
 *
 * An assistant message names its calls only by the provider's call id, and providers reuse those
 * ids across turns — "call_0" in every response, for some. Joining a call to "the next result with
 * that id" let an old call that never got a result take a later turn's result, and the call that
 * really ran was then left without one. The journal already holds the unambiguous link: the intent
 * written for a call carries the turn, step and call id of the message that made it, and an
 * execution id that every later row of that call — its result included, even one written by the
 * turn that resumed it after an approval — repeats. So a call is paired with its intent by
 * `(turnId, stepId, callId)`, and the intent with its result by `executionId`.
 *
 * Rows journaled before intents or results carried those ids fall back to the old look-ahead by
 * call id, and only onto results that name no execution, so a legacy row cannot steal a result
 * the two-hop join owns.
 */
export class ToolCallPairing {
  readonly #intentsByCall = new Map<string, SessionEvent>();
  readonly #intentsByExecution = new Map<string, SessionEvent>();
  readonly #resultsByExecution = new Map<string, SessionEvent>();
  readonly #positions = new Map<string, number>();

  constructor(private readonly events: readonly SessionEvent[]) {
    for (const [index, event] of events.entries()) {
      this.#positions.set(event.eventId, index);
      const payload = payloadOf(event);
      const callId = event.callId ?? text(payload.callId);
      const executionId = text(payload.executionId);
      if (event.type === "tool/intent" && callId) {
        const key = intentKey(event.turnId, event.stepId, callId);
        if (!this.#intentsByCall.has(key)) this.#intentsByCall.set(key, event);
        if (executionId && !this.#intentsByExecution.has(executionId)) this.#intentsByExecution.set(executionId, event);
      }
      if (event.type === "tool/result" && executionId && !this.#resultsByExecution.has(executionId)) {
        this.#resultsByExecution.set(executionId, event);
      }
    }
  }

  /** The intent the message's call was journaled under, when the journal has one. */
  intentFor(message: SessionEvent, callId: string): SessionEvent | undefined {
    return this.#intentsByCall.get(intentKey(message.turnId, message.stepId, callId));
  }

  /** The intent a result belongs to: by execution, else (legacy rows) the latest earlier intent with its call id. */
  intentOfResult(result: SessionEvent): SessionEvent | undefined {
    const executionId = text(payloadOf(result).executionId);
    const byExecution = executionId ? this.#intentsByExecution.get(executionId) : undefined;
    if (byExecution) return byExecution;
    const callId = result.callId ?? text(payloadOf(result).callId);
    const before = this.events.slice(0, this.#positions.get(result.eventId) ?? this.events.length);
    return [...before].reverse().find((event) => event.type === "tool/intent" && (event.callId ?? payloadOf(event).callId) === callId);
  }

  /**
   * The result of one call an assistant message made, skipping results already paired.
   * Undefined means the journal holds no result for that call (within this window).
   */
  resultFor(message: SessionEvent, callId: string, consumed: ReadonlySet<string> = new Set()): SessionEvent | undefined {
    const intent = this.intentFor(message, callId);
    const executionId = intent ? text(payloadOf(intent).executionId) : undefined;
    if (executionId) {
      const result = this.#resultsByExecution.get(executionId);
      if (result && !consumed.has(result.eventId)) return result;
    }
    const start = (this.#positions.get(message.eventId) ?? -1) + 1;
    return this.events.slice(start).find((candidate) => candidate.type === "tool/result" && !consumed.has(candidate.eventId) &&
      payloadOf(candidate).callId === callId && !this.#ownedByAnotherIntent(candidate, intent));
  }

  /** A result whose execution belongs to some other journaled intent is that call's, whatever its call id. */
  #ownedByAnotherIntent(result: SessionEvent, intent: SessionEvent | undefined): boolean {
    const executionId = text(payloadOf(result).executionId);
    const owner = executionId ? this.#intentsByExecution.get(executionId) : undefined;
    return owner !== undefined && owner !== intent;
  }
}
