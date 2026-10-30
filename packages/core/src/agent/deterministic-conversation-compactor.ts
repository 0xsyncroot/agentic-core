import { AgenticError, APPROVAL_EVENT, type ConversationCompaction, type ConversationCompactor, type DataClassification, type SessionEvent } from "@0xsyncroot/contracts";
import { attachmentCompactionSuffix, attachmentManifestFromPayload } from "./attachment-manifest.js";
import { assistantToolCallIds, ToolCallPairing } from "./tool-call-pairing.js";
import { DEFAULT_COMPACTION_TEXT, type CompactionText } from "./context-budget-text.js";

const CLASSIFICATION_RANK: Readonly<Record<DataClassification, number>> = {
  public: 0, internal: 1, confidential: 2, restricted: 3,
};

function highestClassification(events: readonly SessionEvent[], fallback: DataClassification): DataClassification {
  return events.reduce((highest, event) =>
    CLASSIFICATION_RANK[event.classification ?? "internal"] > CLASSIFICATION_RANK[highest]
      ? event.classification ?? "internal"
      : highest, fallback);
}

function clean(value: string, limit = 600): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

function compactJson(value: unknown, limit = 1_200): string {
  try { return clean(JSON.stringify(value), limit); }
  catch { return "[unserializable]"; }
}

function checkpointLine(event: SessionEvent, text: CompactionText): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  if (event.type === "user/input" && typeof payload.content === "string") {
    return `${text.user}: ${clean(payload.content)}${attachmentCompactionSuffix(attachmentManifestFromPayload(payload.attachments))}`;
  }
  if (event.type === "application/context") {
    return `${text.applicationContext}: ${compactJson({
      trusted: payload.trusted ?? null,
      untrusted: payload.untrusted ?? null,
    })}`;
  }
  if (event.type === "assistant/message" && typeof payload.content === "string" && payload.content.trim()) return `${text.assistant}: ${clean(payload.content)}`;
  if (event.type === "tool/result") return `${text.tool} ${String(payload.toolId ?? "unknown")}: ${String(payload.state ?? "unknown")}; resultId=${String(payload.resultId ?? "unavailable")}; ${"observation"}=${compactJson(
    payload.result ?? payload.error ?? null,
  )}`;
  if (event.type === "work/plan-updated") return `${text.workPlan}: ${compactJson({
    goal: payload.goal ?? null,
    steps: payload.steps ?? null,
    updatedAt: payload.updatedAt ?? null,
  })}`;
  if (event.type === APPROVAL_EVENT.RESOLVED) return `${text.approval} ${String(payload.decision ?? "resolved")}`;
  if (event.type === "turn/failed") return `${text.turnFailed}: ${clean(String(payload.code ?? "failed"), 120)}`;
  return undefined;
}

/**
 * Where a call's outcome lands in the journal, for the purpose of not splitting it from its call.
 *
 * Its result, paired the way the projector pairs it. A call with no result is closed once its turn
 * has ended and the user has written since — nothing will answer it any more, and the projector
 * answers it with the missing-result notice — so a legacy call nobody closed cannot hold compaction
 * back for ever. Otherwise it is still open (an unanswered pause, say) and bounds nothing yet.
 */
function closedAt(
  journal: { readonly pairing: ToolCallPairing; readonly endedTurns: ReadonlySet<string>; readonly lastUserInputSeq: number },
  message: SessionEvent, callId: string,
): number {
  const result = journal.pairing.resultFor(message, callId);
  if (result) return result.seq;
  const ended = message.turnId !== undefined && journal.endedTurns.has(message.turnId);
  return ended && journal.lastUserInputSeq > message.seq ? message.seq : Number.POSITIVE_INFINITY;
}

/** Never split an assistant tool call from its eventual result/approval continuation. */
function causalCoveredThrough(events: readonly SessionEvent[], proposed: number, withinTurn = false): number {
  let boundary = proposed;
  const journal = {
    pairing: new ToolCallPairing(events),
    endedTurns: new Set(events.flatMap((event) => (event.type === "turn/end" || event.type === "turn/failed") && event.turnId ? [event.turnId] : [])),
    lastUserInputSeq: Math.max(0, ...events.filter((event) => event.type === "user/input").map((event) => event.seq)),
  };
  const closedSeq = new Map<string, number>();
  for (const event of events) {
    const ids = assistantToolCallIds(event);
    if (ids.length > 0) closedSeq.set(event.eventId, Math.max(...ids.map((id) => closedAt(journal, event, id))));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of events) {
      if (event.seq > boundary) break;
      const closed = closedSeq.get(event.eventId);
      if (closed === undefined || closed <= boundary) continue;
      const turnStart = withinTurn ? undefined : [...events].reverse().find((candidate) => candidate.type === "turn/start" &&
        candidate.turnId === event.turnId && candidate.seq <= event.seq);
      const next = Math.min(boundary, (turnStart?.seq ?? event.seq) - 1);
      if (next < boundary) { boundary = next; changed = true; }
    }
  }
  return boundary;
}

/**
 * Loss-bounded, deterministic checkpointing. It never invokes an LLM and never
 * represents the checkpoint as trusted instructions.
 */
export class DeterministicConversationCompactor implements ConversationCompactor {
  constructor(private readonly minimumRecentTurns = 2, private readonly revision = "deterministic-v4", private readonly text: CompactionText = DEFAULT_COMPACTION_TEXT) {
    if (!Number.isInteger(minimumRecentTurns) || minimumRecentTurns < 1) throw new Error("minimumRecentTurns must be a positive integer");
  }

  async compact(input: Parameters<ConversationCompactor["compact"]>[0]): Promise<ConversationCompaction | undefined> {
    if (input.events.some((event) => event.tenantId !== input.security.tenantId)) throw new AgenticError("denied", "Conversation compaction tenant boundary violation");
    const starts = input.events.filter((event) => event.type === "turn/start");
    let retainedIndex = Math.max(0, starts.length - this.minimumRecentTurns);
    while (retainedIndex > 0) {
      const candidate = starts[retainedIndex - 1];
      if (!candidate) break;
      const retainedChars = JSON.stringify(input.events.filter((event) => event.seq >= candidate.seq)).length;
      if (retainedChars > input.budget.targetContextChars) break;
      retainedIndex -= 1;
    }
    const firstRetained = starts[retainedIndex];
    const priorCovered = Number((input.priorCheckpoint?.payload as Record<string, unknown> | undefined)?.coveredThroughSeq ?? 0);
    let proposed = firstRetained ? firstRetained.seq - 1 : priorCovered;
    let withinTurn = false;
    if (proposed <= priorCovered) {
      // A single long tool-using turn needs compaction too. Keep its two newest steps whole.
      const newestTurn = [...input.events].reverse().find((event) => event.type === "step/start")?.turnId;
      const steps = input.events.filter((event) => event.type === "step/start" && event.turnId === newestTurn);
      const firstRecent = steps.at(-2);
      if (!firstRecent) return undefined;
      proposed = firstRecent.seq - 1;
      withinTurn = true;
    }
    const coveredThroughSeq = causalCoveredThrough(input.events, proposed, withinTurn);
    if (coveredThroughSeq <= priorCovered) return undefined;
    const covered = input.events.filter((event) => event.seq > priorCovered && event.seq <= coveredThroughSeq && event.type !== "context/checkpoint");
    const priorSummary = (input.priorCheckpoint?.payload as Record<string, unknown> | undefined)?.summary;
    const lines = [typeof priorSummary === "string" ? priorSummary : undefined, ...covered.map((event) => checkpointLine(event, this.text))].filter((line): line is string => Boolean(line));
    const raw = lines.join("\n");
    const maxSummaryChars = Math.max(1_024, Math.min(16_000, Math.floor(input.budget.targetContextChars / 2)));
    const requestPrefix = `${this.text.user}: `;
    const lastRequest = lines.filter((line) => line.startsWith(requestPrefix)).at(-1) ??
      (typeof priorSummary === "string" ? priorSummary.split("\n").filter((line) => line.startsWith(requestPrefix)).at(-1) : undefined);
    const prefix = `${this.text.historyPrefix}${lastRequest ? `\n${lastRequest}` : ""}\n`;
    const summary = raw.length <= maxSummaryChars ? raw : `${prefix}${raw.slice(-Math.max(0, maxSummaryChars - prefix.length))}`;
    return {
      summary, coveredThroughSeq, revision: this.revision,
      classification: highestClassification(covered, input.priorCheckpoint?.classification ?? "internal"),
    };
  }
}
