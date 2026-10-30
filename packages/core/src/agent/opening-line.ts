import type { AgentNarrationEvent, LlmAdapter, PreparedLlmRequest } from "@0xsyncroot/contracts";
import type { ClaimedTurn } from "./claimed-turn.js";

/** How long the opening line may take, from its call to its journal row, before it is given up. */
export const OPENING_LINE_TIMEOUT_MS = 3_000;
/** The provenance of the opening line's two messages: what tells its request apart from the turn's model steps. */
export const OPENING_LINE_PROVENANCE = "opening-line";
/** One short sentence was asked for; text past this is not one, and is withdrawn whole. */
const MAX_OPENING_CHARS = 400;

export interface OpeningLine {
  /** Gives the line up if it is still being written, and settles once it is told, withdrawn or failed. Never rejects. */
  close(): Promise<void>;
}

/**
 * The opening line: one sentence that tells the user, as soon as the request arrives, that it was understood and what it is
 * about. The turn's first model step takes seconds (setup, reasoning, a plan); until it says something the user sees nothing.
 *
 * Started before the turn's setup and run beside it: one call to the turn's own model with private reasoning off
 * (`plainParameters`), no tools and no history, the composition's `instruction` as the system message and the request as
 * untrusted material. Each word is streamed on the narration channel as it arrives (`opening:<turnId>`) and the sentence is
 * journaled as `assistant/narration` with `opening: true` and no step.
 *
 * It is never the model's context: the conversation projection does not read narrations, so the main prompt and its cached
 * prefix are unchanged. It is not the turn's narration either: the loop's narration state (`narratedText`, `NarrationChain`)
 * never sees it, so the model's own narration and plan announcement are decided as without it.
 *
 * Only the line itself is shown. A failure, a timeout, a reply that is no sentence or a turn that ended first shows nothing,
 * and a line already on screen is withdrawn (`discarded`); the end is `completed` only once the row is journaled, so a reload
 * shows what the live stream showed.
 */
export function startOpeningLine(turn: ClaimedTurn, llm: LlmAdapter, instruction: string, timeoutMs = OPENING_LINE_TIMEOUT_MS): OpeningLine {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(new Error(`Opening line exceeded ${timeoutMs} ms`)), timeoutMs);
  const told = tell(turn, llm, instruction, AbortSignal.any([turn.signal, stop.signal]))
    .catch(() => undefined)
    .finally(() => clearTimeout(timer));
  return {
    close: async () => {
      stop.abort(new Error("Turn ended before its opening line"));
      await told;
    },
  };
}

async function tell(turn: ClaimedTurn, llm: LlmAdapter, instruction: string, signal: AbortSignal): Promise<void> {
  const narrationId = `opening:${turn.turnId}`;
  const notify = (event: AgentNarrationEvent) => {
    try { turn.input.onNarration?.(event); } catch { /* Observers cannot fail a durable turn. */ }
  };
  const envelope = { turnId: turn.turnId, narrationId, audience: "user" as const };
  let text = "";
  let started = false;
  const say = (delta: string) => {
    if (!delta) return;
    if (!started) { notify({ type: "assistant-narration-start", ...envelope }); started = true; }
    text += delta;
    if (text.length > MAX_OPENING_CHARS) throw new Error(`Opening line exceeded ${MAX_OPENING_CHARS} characters`);
    notify({ type: "assistant-narration-delta", ...envelope, delta });
  };
  // A reply that runs on past its first line is cut there: the rest is not the one sentence asked for.
  const ended = new AbortController();
  try {
    let streamed = false;
    const stream = AbortSignal.any([signal, ended.signal]);
    for await (const event of untilAborted(llm.stream(openingRequest(turn, llm, instruction, narrationId), stream), stream)) {
      if (event.type === "text-delta") {
        streamed = true;
        const line = firstLine(text, event.delta);
        say(line.delta);
        if (line.complete) { ended.abort(); break; }
      } else if (event.type === "final" && !streamed && event.content) {
        // An adapter that does not stream text gives the whole reply at its end.
        say(firstLine(text, event.content).delta);
      }
    }
    const content = text.trim();
    if (!content) throw new Error("Opening line is empty");
    signal.throwIfAborted();
    await turn.writer.append([{
      type: "assistant/narration", turnId: turn.turnId, payload: { narrationId, audience: "user", content, opening: true },
    }], narrationId);
    notify({ type: "assistant-narration-end", ...envelope, status: "completed" });
  } catch (error) {
    if (started) notify({ type: "assistant-narration-end", ...envelope, status: "discarded" });
    throw error;
  } finally {
    ended.abort();
  }
}

/**
 * The stream's events until `signal` aborts. An adapter that ignores its signal would otherwise hold `close()` until its stream
 * ends and keep words coming past the deadline: the wait for its next event is given up at the abort, and its end is not awaited.
 */
async function* untilAborted<T>(events: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = events[Symbol.asyncIterator]();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(signal.reason); });
  aborted.catch(() => undefined);
  if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const next = iterator.next();
      next.catch(() => undefined);
      const step = await Promise.race([next, aborted]);
      if (step.done) return;
      yield step.value;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    iterator.return?.().catch(() => undefined);
  }
}

/** The part of `delta` that still belongs to the first line after `told`, leading blank space dropped, and whether that line ended. */
function firstLine(told: string, delta: string): { readonly delta: string; readonly complete: boolean } {
  const fresh = told.trim() ? delta : delta.replace(/^\s+/u, "");
  const newline = fresh.indexOf("\n");
  return newline < 0 ? { delta: fresh, complete: false } : { delta: fresh.slice(0, newline), complete: true };
}

function openingRequest(turn: ClaimedTurn, llm: LlmAdapter, instruction: string, id: string): PreparedLlmRequest {
  return {
    requestId: id, attemptId: id, turnId: turn.turnId, stepId: id, runtimeSnapshotId: turn.runtimeLease.snapshot.id, model: llm.model,
    messages: [
      { role: "system", content: instruction, context: { trust: "instruction", retention: "required", provenance: OPENING_LINE_PROVENANCE } },
      // The request is what the sentence is about, never instructions to follow.
      { role: "user", content: turn.input.content, context: { trust: "untrusted", retention: "required", provenance: OPENING_LINE_PROVENANCE } },
    ],
    tools: [], parameters: { ...(llm.plainParameters ?? {}) }, contentHash: id,
  };
}
