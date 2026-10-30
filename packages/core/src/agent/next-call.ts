import { canonicalJson, toolNextCallReads, type JsonValue, type SessionEvent, type ToolDefinition, type ToolNextCall } from "@0xsyncroot/contracts";
import { nextCallAsks, nextCallContext, type NextCallAsk, type NextCallContext } from "./next-call-questions.js";

/** The runtime makes at most this many follow-up reads a tool named in one turn. */
export const MAX_NEXT_CALLS_PER_TURN = 2;
/** Who the journal says made a follow-up read: the runtime, on the tool's word (`tool/intent.policyId`). */
export const NEXT_CALL_INITIATOR = "runtime:next-call";
export const NEXT_CALL_SEAM = "next-call";

/** A follow-up read a tool named in the previous step, and the questions the judge is asked about it (`nextCallAsks`). */
export interface NextCallCandidate {
  readonly call: ToolNextCall;
  readonly definition: ToolDefinition;
  readonly asks: readonly NextCallAsk[];
}

const payloadOf = (event: SessionEvent) => event.payload as Record<string, unknown>;

/** The arguments as one string whatever their key order, or the raw text when they are not JSON. */
function sameArguments(raw: unknown): string {
  try { return canonicalJson(typeof raw === "string" ? JSON.parse(raw) : raw); } catch { return String(raw); }
}

/**
 * The follow-up reads the runtime may make before this step's model call, by facts alone: a succeeded result of the model's
 * own calls in the turn's previous step names it (`nextCall`; never a result the runtime made, so nothing chains); the step
 * offers the tool; it changes nothing, asks nobody, is not instructions, planning or a loader; it comes from the same source
 * as the tool that named it; the tool says what the call reads (`reads`); the turn has not made that call already; and the turn
 * has room under its bound. One per result. A call without `reads` is no candidate: nothing is asked about it.
 */
export function nextCallCandidates(events: readonly SessionEvent[], frame: {
  readonly turnId: string;
  readonly stepId: string;
  /** The composition's other places the data lives (`nextCallSources`). */
  readonly sources: Readonly<Record<string, string>>;
  readonly offered: readonly ToolDefinition[];
  /** Tools the runtime never calls in the model's place (loaders, planning). */
  readonly excluded: (toolId: string) => boolean;
}): readonly NextCallCandidate[] {
  const turn = events.filter((event) => event.turnId === frame.turnId);
  const starts = turn.filter((event) => event.type === "step/start").map((event) => event.stepId);
  const previous = starts[starts.indexOf(frame.stepId) - 1];
  if (previous === undefined) return [];
  const intents = turn.filter((event) => event.type === "tool/intent");
  let room = MAX_NEXT_CALLS_PER_TURN - intents.filter((event) => payloadOf(event).policyId === NEXT_CALL_INITIATOR).length;
  const made = new Set(intents.map((event) => `${String(payloadOf(event).toolId)}\u0000${sameArguments(payloadOf(event).arguments)}`));
  const intentOf = new Map(intents.map((event) => [String(payloadOf(event).callId), payloadOf(event)]));
  const offered = new Map(frame.offered.map((tool) => [tool.id, tool]));
  const candidates: NextCallCandidate[] = [];
  let context: NextCallContext | undefined;
  for (const event of turn) {
    const result = payloadOf(event);
    if (event.type !== "tool/result" || event.stepId !== previous || result.state !== "succeeded" || result.initiator !== undefined) continue;
    const call = result.nextCall as ToolNextCall | undefined;
    const reads = toolNextCallReads(call?.reads);
    const definition = call ? offered.get(call.toolId) : undefined;
    const key = call ? `${call.toolId}\u0000${sameArguments(call.arguments)}` : "";
    if (!call || !reads || !definition || room <= 0 || made.has(key) || frame.excluded(definition.id)) continue;
    if (definition.sideEffect !== "none" || definition.asksUser || definition.pinnedResult) continue;
    if (definition.origin?.sourceId !== originOf(intentOf.get(String(result.callId)))) continue;
    made.add(key);
    room -= 1;
    context ??= nextCallContext(events, frame.sources);
    candidates.push({ call, definition, asks: nextCallAsks(reads, result.result as JsonValue | undefined, context) });
  }
  return candidates;
}

/** The source the tool that named the call came from, as its intent journaled it; undefined for a local tool. */
function originOf(intent: Record<string, unknown> | undefined): string | undefined {
  const origin = intent?.origin as { readonly sourceId?: unknown } | undefined;
  return typeof origin?.sourceId === "string" ? origin.sourceId : undefined;
}
