import { createHash } from "node:crypto";
import { isProtectedDataEnvelope, withoutInlineThought, type ReviewToolLabel, type ReviewTranscriptEntry, type SessionEvent } from "@0xsyncroot/contracts";
import { SessionMasker } from "../masking/masker.js";
import type { CompiledPersonalFields } from "../masking/config.js";

/** The reader-facing words a product gives the transcript: tool labels and the sentences shown in place of content. */
export interface TranscriptWording {
  /** The label a reader sees for a tool; a tool the product does not name is shown by its id. */
  readonly toolLabels: Readonly<Record<string, string>>;
  /** The sentence a failed turn shows, by failure code, with `default` for codes not listed. */
  readonly failure: { readonly default: string; readonly codes?: Readonly<Record<string, string>> };
  /** The sentence an encrypted user message or turn-closing message shows; the reader holds no key to open it. */
  readonly encrypted: string;
}

/** A transcript entry before it is filed under a mask version. */
export type TranscriptDraft = Omit<ReviewTranscriptEntry, "maskVersion">;

export interface BuiltTranscript {
  readonly entries: readonly TranscriptDraft[];
  readonly answers: number;
  readonly startedAt: string;
  readonly lastTurnAt: string;
}

const STEP_BUDGET_FINISH_REASON = "step-budget";

type Payload = Record<string, unknown>;
const payloadOf = (event: SessionEvent): Payload =>
  event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload as Payload : {};

const sourceHash = (events: readonly SessionEvent[]): string =>
  createHash("sha256").update(events.map((event) => `${event.seq}:${event.integrityHash}`).join("\n")).digest("hex");

const hasToolCalls = (payload: Payload): boolean => Array.isArray(payload.toolCalls) && payload.toolCalls.length > 0;
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/** Narrations a later step took out of the chat, by turn. */
function supersededNarrations(events: readonly SessionEvent[]): Set<string> {
  const gone = new Set<string>();
  for (const event of events) {
    const id = payloadOf(event).narrationId;
    if (event.type === "assistant/narration-superseded" && typeof id === "string") gone.add(`${event.turnId ?? ""}\u0000${id}`);
  }
  return gone;
}

/** Each turn's last assistant message. */
function lastMessages(events: readonly SessionEvent[]): readonly SessionEvent[] {
  const last = new Map<string, SessionEvent>();
  for (const event of events) if (event.type === "assistant/message" && event.turnId) last.set(event.turnId, event);
  return [...last.values()];
}

/**
 * The answer a turn showed: its last assistant message, when that message made no tool call and carries text. Earlier
 * call-free messages of the same turn were drafts the turn's review sent back, which the chat never showed.
 */
function shownAnswers(last: readonly SessionEvent[]): Set<number> {
  const shown = new Set<number>();
  for (const event of last) {
    const payload = payloadOf(event);
    if (!hasToolCalls(payload) && text(payload.content) && payload.finishReason !== STEP_BUDGET_FINISH_REASON) shown.add(event.seq);
  }
  return shown;
}

/** The seqs of the answers each turn showed, by the rule above; `ordered` is a stream's events in seq order. */
export function shownAnswerSeqs(ordered: readonly SessionEvent[]): ReadonlySet<number> {
  return shownAnswers(lastMessages(ordered));
}

/**
 * Builds the masked transcript of one whole session, as its user saw it: the user's messages, the narrations the chat kept,
 * each turn's shown answer, a failed turn's product sentence, and between them one entry per run of tool calls naming the
 * tools only. Tool arguments and results never enter an entry; they only teach the masker which values are personal.
 * Values are collected from every tool result first, so a value the user typed before a tool returned it is masked too.
 * An encrypted payload is never opened here: a user message, or a turn's last assistant message, shows the product's
 * `encrypted` sentence in its place and is not counted as an answer; any other encrypted event shows nothing.
 */
export function buildTranscript(events: readonly SessionEvent[], fields: CompiledPersonalFields, wording: TranscriptWording): BuiltTranscript {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const masker = new SessionMasker(fields);
  for (const event of ordered) {
    const payload = payloadOf(event);
    if (event.type === "tool/result" && typeof payload.toolId === "string") masker.collect(payload.toolId, payload.result);
  }
  const superseded = supersededNarrations(ordered);
  const closing = lastMessages(ordered);
  const answersShown = shownAnswers(closing);
  const sealedClosing = new Set(closing.filter((event) => isProtectedDataEnvelope(event.payload)).map((event) => event.seq));
  const entries: TranscriptDraft[] = [];
  let tools: { first: SessionEvent; sources: SessionEvent[]; labels: ReviewToolLabel[] } | undefined;
  let answers = 0;
  const flushTools = () => {
    if (!tools) return;
    entries.push({ entrySeq: tools.first.seq, turnId: tools.first.turnId ?? "", role: "tool", bodyFormat: "text", body: "",
      toolLabels: tools.labels, maskedValues: 0, sourceHash: sourceHash(tools.sources), at: tools.first.occurredAt });
    tools = undefined;
  };
  const push = (event: SessionEvent, role: TranscriptDraft["role"], bodyFormat: TranscriptDraft["bodyFormat"], body: string, answer?: number, fixed = role === "system") => {
    flushTools();
    const masked = fixed ? { text: body, replaced: 0 } : masker.mask(body);
    entries.push({ entrySeq: event.seq, turnId: event.turnId ?? "", ...(answer !== undefined ? { answerIndex: answer } : {}), role, bodyFormat,
      body: masked.text, maskedValues: masked.replaced, sourceHash: sourceHash([event]), at: event.occurredAt });
  };
  for (const event of ordered) {
    const payload = payloadOf(event);
    if (isProtectedDataEnvelope(event.payload) && (event.type === "user/input" || sealedClosing.has(event.seq))) {
      push(event, event.type === "user/input" ? "user" : "assistant", "text", wording.encrypted, undefined, true);
    } else if (event.type === "user/input") {
      const content = text(payload.content);
      if (content) push(event, "user", "text", content);
    } else if (event.type === "assistant/narration") {
      const content = text(payload.content);
      const id = typeof payload.narrationId === "string" ? payload.narrationId : "";
      if (content && payload.audience === "user" && payload.draft !== true && !superseded.has(`${event.turnId ?? ""}\u0000${id}`)) {
        push(event, "assistant", "markdown", withoutInlineThought(content));
      }
    } else if (event.type === "assistant/message" && answersShown.has(event.seq)) {
      answers += 1;
      push(event, "assistant", "markdown", withoutInlineThought(String(payload.content)), answers);
    } else if (event.type === "turn/failed") {
      const code = typeof payload.code === "string" ? payload.code : "";
      push(event, "system", "text", wording.failure.codes?.[code] ?? wording.failure.default);
    } else if (event.type === "tool/result" && typeof payload.toolId === "string" && !(payload.bestEffort === true && payload.skipped !== undefined)) {
      // A run of calls belongs to one turn; a resumed turn's calls start their own entry.
      if (tools && tools.first.turnId !== event.turnId) flushTools();
      tools ??= { first: event, sources: [], labels: [] };
      tools.sources.push(event);
      if (!tools.labels.some((known) => known.toolId === payload.toolId)) {
        tools.labels.push({ toolId: payload.toolId, label: wording.toolLabels[payload.toolId] ?? payload.toolId });
      }
    }
  }
  flushTools();
  const turnStarts = ordered.filter((event) => event.type === "turn/start");
  const startedAt = ordered[0]?.occurredAt ?? "";
  return { entries, answers, startedAt, lastTurnAt: turnStarts.at(-1)?.occurredAt ?? startedAt };
}
