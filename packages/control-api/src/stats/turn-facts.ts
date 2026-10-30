import { UNRELEASED_RELEASE_ID, type SessionEvent, type TurnFact, type TurnFactStatus } from "@0xsyncroot/contracts";
import type { ActorPseudonyms } from "../pseudonym.js";
import { shownAnswerSeqs } from "../projection/transcript.js";

/** Bumped whenever this file changes a fact for the same journal; part of the projector revision, so every fact is saved again. */
export const TURN_FACT_ENGINE_REVISION = "3";

/** What a stream contributes to each of its facts. */
export interface TurnFactContext {
  readonly tenantId: string;
  readonly sessionId: string;
  /** The agent of a turn whose start carries no runtime binding: the stream's own agent. */
  readonly defaultAgentId: string;
  readonly pseudonyms: ActorPseudonyms;
  /** A turn without a close whose own last event is older than this instant is abandoned; a younger one is open. */
  readonly idleBefore: string;
}

/** A turn without a close: `open` while its last event is younger than the threshold, `abandoned` after. */
type Unclosed = "open" | "abandoned";

type Payload = Record<string, unknown>;
const payloadOf = (event: SessionEvent): Payload =>
  event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload as Payload : {};
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
const hasText = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";
const elapsed = (from: string, to: string): number => Math.max(0, Date.parse(to) - Date.parse(from));

const FAILED_STATES = new Set(["failed", "outcome_unknown"]);
const REFUSED_STATES = new Set(["denied"]);
const CARD_EVENTS = new Set(["approval/requested", "interaction/requested"]);
const END_STATUSES = new Set<string>(["completed", "partial", "awaiting_approval", "awaiting_interaction"]);

/** The status a close gives its turn; a turn without a close takes its unclosed status and ends at its own last event. */
function statusOf(close: SessionEvent, unclosed: Unclosed | undefined): TurnFactStatus {
  if (unclosed) return unclosed;
  if (close.type === "turn/failed") return "failed";
  const endStatus = payloadOf(close).status;
  return END_STATUSES.has(endStatus as TurnFactStatus) ? endStatus as TurnFactStatus : "completed";
}

/**
 * Measures one turn from its start to `close`, over the events journaled in between. `close` is the first close, or the
 * turn's last event when the turn has none; a turn without a close has no response time.
 */
function factOf(turn: readonly SessionEvent[], start: SessionEvent, close: SessionEvent, unclosed: Unclosed | undefined, shown: ReadonlySet<number>, context: TurnFactContext): TurnFact {
  const startPayload = payloadOf(start);
  const binding = startPayload.runtimeBinding as { agentProfileId?: unknown } | undefined;
  const status = statusOf(close, unclosed);
  let firstOutput: SessionEvent | undefined;
  let steps = 0, toolCalls = 0, toolFailed = 0, toolRefused = 0, cards = 0, inputTokens = 0, outputTokens = 0;
  for (const event of turn) {
    if (event.seq <= start.seq || event.seq > close.seq) continue;
    const payload = payloadOf(event);
    if (event.type === "step/start") steps += 1;
    else if (CARD_EVENTS.has(event.type)) cards += 1;
    else if (event.type === "usage/recorded") {
      inputTokens += count(payload.inputTokens);
      outputTokens += count(payload.outputTokens);
    } else if (event.type === "tool/result") {
      toolCalls += 1;
      if (FAILED_STATES.has(String(payload.state))) toolFailed += 1;
      if (REFUSED_STATES.has(String(payload.state))) toolRefused += 1;
    } else if (!firstOutput && ((event.type === "assistant/narration" && hasText(payload.content)) || shown.has(event.seq))) {
      firstOutput = event;
    }
  }
  return {
    tenantId: context.tenantId, sessionId: context.sessionId, turnId: start.turnId ?? "",
    agentId: typeof binding?.agentProfileId === "string" && binding.agentProfileId ? binding.agentProfileId : context.defaultAgentId,
    channel: "live", releaseId: UNRELEASED_RELEASE_ID, runtimeSnapshotId: start.runtimeSnapshotId,
    origin: startPayload.continuation !== null && typeof startPayload.continuation === "object" ? "continuation" : "user",
    actorKey: context.pseudonyms.actorKey(context.tenantId, start.actorId), actorKeyVersion: context.pseudonyms.version,
    startedAt: start.occurredAt,
    ...(firstOutput ? { firstOutputAt: firstOutput.occurredAt } : {}), endedAt: close.occurredAt, status,
    ...(unclosed ? {} : { responseMs: elapsed(start.occurredAt, close.occurredAt) }), ...(firstOutput ? { firstOutputMs: elapsed(start.occurredAt, firstOutput.occurredAt) } : {}),
    steps, toolCalls, toolFailed, toolRefused, cards, inputTokens, outputTokens, sourceLastSeq: close.seq,
  };
}

/**
 * The facts of every turn in one stream, in start order. A turn is the events of one turn id from its `turn/start` to its
 * first `turn/end` or `turn/failed`; a resume is its own turn (origin `continuation`). A turn without a close ends at its own
 * last event, with no response time: `abandoned` when that event is older than `idleBefore`, `open` otherwise, so the same
 * rule decides here and in the store's sweep of open facts. A close without a start and events without a turn id yield nothing.
 * First output is the first content the user saw: a narration that carries text, the opening acknowledgement included, or
 * the answer the turn showed by the transcript's rule (`shownAnswerSeqs`), so a draft the review sent back never counts and
 * the accepted answer counts at the instant it was journaled, since the answer is shown only once accepted. An encrypted
 * payload shows no text here, so it never counts as output.
 * Tool calls count `tool/result` rows; failed = `failed` or `outcome_unknown`; refused = `denied`. Cards are approval and
 * interaction requests. Tokens sum `usage/recorded`. Event order in the input does not matter: events are ordered by seq.
 */
export function extractTurnFacts(events: readonly SessionEvent[], context: TurnFactContext): readonly TurnFact[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const turns = new Map<string, SessionEvent[]>();
  for (const event of ordered) {
    if (!event.turnId) continue;
    const list = turns.get(event.turnId);
    if (list) list.push(event);
    else turns.set(event.turnId, [event]);
  }
  const shown = shownAnswerSeqs(ordered);
  const facts: TurnFact[] = [];
  for (const turn of turns.values()) {
    const start = turn.find((event) => event.type === "turn/start");
    if (!start) continue;
    const close = turn.find((event) => event.seq > start.seq && (event.type === "turn/end" || event.type === "turn/failed"));
    if (close) {
      facts.push(factOf(turn, start, close, undefined, shown, context));
      continue;
    }
    const last = turn[turn.length - 1] ?? start;
    facts.push(factOf(turn, start, last, Date.parse(last.occurredAt) < Date.parse(context.idleBefore) ? "abandoned" : "open", shown, context));
  }
  facts.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.sourceLastSeq - b.sourceLastSeq);
  return facts;
}
