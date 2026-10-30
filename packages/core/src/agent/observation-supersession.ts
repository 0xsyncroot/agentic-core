import type { JsonValue, SessionEvent, ToolDefinition } from "@0xsyncroot/contracts";
import { toolResultContent } from "./tool-result-bounds.js";

/**
 * Observations the model no longer needs whole.
 *
 * A tool that observes something which keeps changing (`ToolDefinition.observes`) leaves a result
 * per call, and a screen task makes a dozen of them, each the size of a screen. Only the newest is
 * what the model can act on; the rest were measured at 37% of every request. The journal keeps each
 * one whole; when the conversation is projected, an older result of a channel is read as the short
 * form its tool wrote beside it.
 */
export interface Supersession { readonly channel: string; readonly condensed: JsonValue }

/** What a result journals so that it can later be read short: undefined when the tool observes nothing here. */
export function supersessionOf(definition: ToolDefinition | undefined, result: JsonValue | undefined): { readonly supersession: Supersession } | Record<string, never> {
  if (!definition?.observes || result === undefined) return {};
  const condensed = definition.observes.condense(result);
  return condensed === undefined ? {} : { supersession: { channel: definition.observes.channel, condensed } };
}

function supersessionIn(event: SessionEvent): Supersession | undefined {
  const value = (event.payload as Record<string, unknown>).supersession as Partial<Supersession> | undefined;
  return value && typeof value.channel === "string" && value.condensed !== undefined ? value as Supersession : undefined;
}

/** The result of each channel that is still the newest, by event id. */
export function newestObservations(events: readonly SessionEvent[]): ReadonlyMap<string, string> {
  const newest = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "tool/result") continue;
    const channel = supersessionIn(event)?.channel;
    if (channel) newest.set(channel, event.eventId);
  }
  return newest;
}

/** What the model reads for this result: whole, short when a newer observation of its channel exists, or a pointer when it is retained and no longer needed. */
export function toolResultText(event: SessionEvent, newest: ReadonlyMap<string, string>, whole: (payload: Record<string, unknown>) => string, notNeeded?: ReadonlySet<string>): string {
  const payload = event.payload as Record<string, unknown>;
  const supersession = supersessionIn(event);
  if (supersession && newest.get(supersession.channel) !== event.eventId) {
    return toolResultContent({ result: { superseded: `Older observation of the ${supersession.channel}: a newer one later in this conversation replaces it, and its refs no longer work.`, kept: supersession.condensed } });
  }
  if (notNeeded?.has(event.eventId) && typeof payload.resultId === "string") {
    return toolResultContent({ result: { omitted: `Earlier result judged no longer needed for the request. read_result with resultId ${JSON.stringify(payload.resultId)} restores it if you need it.` } });
  }
  return whole(payload);
}
