import type { AgentReasoningEvent } from "@0xsyncroot/contracts";
import { ReasoningTextFilter, withoutIdentifiers } from "./public-reasoning-text.js";

/**
 * How much of the model's private reasoning a product publishes.
 *
 * `lifecycle` (the default): that the model is thinking, and when it stopped — never a word of it.
 * `text`: what it is thinking. With a `summarize` function that is a sentence about the thought,
 * written for the user by a second call (below); without one it is the reasoning itself, less the
 * runtime's identifiers. Either way it is a choice a product makes in its own composition.
 */
export type PublicReasoningMode = "lifecycle" | "text";

/** A thought, rewritten as one sentence for the person waiting. Nothing, when there is nothing worth saying. */
export type ReasoningSummarizer = (thought: string, signal: AbortSignal) => Promise<string | undefined>;

export interface PublicReasoningOptions {
  readonly reasoning?: PublicReasoningMode;
  /** Which sentences may cross — a product's own test, e.g. of language. Applied to summaries too. */
  readonly reasoningSentence?: (sentence: string) => boolean;
  /**
   * Rewrites the reasoning before any of it crosses. With this set the raw reasoning never does.
   *
   * Raw reasoning is written for nobody: in whatever language the model fell into, naming tools
   * and ids, half a sentence at a time. Asking the model to reason in the user's language helps
   * and cannot be relied on, and a filter that guesses a sentence's language let through an
   * English sentence because it quoted a file name and a phrase in the user's language. The
   * assistants people compare this with do not show raw reasoning either: a second model writes a
   * short account of it, and that is what is shown.
   */
  readonly reasoningSummary?: ReasoningSummarizer;
}

const PUBLIC_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/u;
const REASONING_MAX_CHARS = 64_000;
const ACTIVE_REASONING_LIMIT = 4;
/** New reasoning worth a fresh sentence about it; less than this is the same thought still being had. */
const SUMMARY_EVERY_CHARS = 400;
/** A thought that ends having said at least this much gets its one sentence even if it never reached the interval. */
const SUMMARY_MIN_CHARS = 60;
/** How much of the reasoning's tail a summary is written from. */
const SUMMARY_WINDOW_CHARS = 1_600;
const SUMMARY_TIMEOUT_MS = 8_000;
const SUMMARY_MAX_CHARS = 200;
/** A bound on a stream's second-model calls: a turn that reasons for an hour does not buy a thousand of them. */
const SUMMARY_MAX_CALLS = 80;

interface Thought {
  readonly turnId: string;
  chars: number;
  readonly filter: ReasoningTextFilter;
  /** The reasoning so far, tail only, and how much of it no summary has covered yet. */
  raw: string;
  fresh: number;
  summaries: number;
  inFlight: AbortController | undefined;
  ended: "completed" | "discarded" | undefined;
}

/**
 * The model's private reasoning on its way to a browser: that it is happening, always; what it
 * says, only as the product chose (see {@link PublicReasoningMode}).
 *
 * Without the lifecycle the stream is silent for as long as the model thinks before its first
 * word — on a reasoning model, most of the wait — and the user watches a turn that looks stalled.
 */
export class PublicReasoningStream {
  readonly #thoughts = new Map<string, Thought>();
  readonly #mode: PublicReasoningMode;
  readonly #sentence: PublicReasoningOptions["reasoningSentence"];
  readonly #summarize: ReasoningSummarizer | undefined;
  #calls = 0;

  constructor(readonly publish: (event: string, payload: unknown) => void, options: PublicReasoningOptions = {}) {
    this.#mode = options.reasoning ?? "lifecycle";
    this.#sentence = options.reasoningSentence;
    this.#summarize = options.reasoningSummary;
  }

  handle(reasoning: AgentReasoningEvent): void {
    if (reasoning.audience !== "user" ||
        typeof reasoning.reasoningId !== "string" || !PUBLIC_ID_PATTERN.test(reasoning.reasoningId) ||
        typeof reasoning.turnId !== "string" || !PUBLIC_ID_PATTERN.test(reasoning.turnId)) return;
    const id = reasoning.reasoningId;
    if (reasoning.type === "assistant-reasoning-start") {
      if (this.#thoughts.has(id) || this.#thoughts.size >= ACTIVE_REASONING_LIMIT) return;
      this.#thoughts.set(id, {
        turnId: reasoning.turnId, chars: 0, filter: new ReasoningTextFilter(this.#sentence),
        raw: "", fresh: 0, summaries: 0, inFlight: undefined, ended: undefined,
      });
      this.publish(reasoning.type, { type: reasoning.type, ...this.#envelope(id, reasoning.turnId) });
      return;
    }
    const thought = this.#thoughts.get(id);
    if (!thought || thought.turnId !== reasoning.turnId || thought.ended) return;
    if (reasoning.type === "assistant-reasoning-delta") {
      // Past the cap the text stops and the lifecycle goes on: the turn is still thinking.
      if (this.#mode !== "text" || typeof reasoning.delta !== "string" || !reasoning.delta ||
          thought.chars + reasoning.delta.length > REASONING_MAX_CHARS) return;
      thought.chars += reasoning.delta.length;
      if (this.#summarize) {
        thought.raw = (thought.raw + reasoning.delta).slice(-SUMMARY_WINDOW_CHARS);
        thought.fresh += reasoning.delta.length;
        if (thought.fresh >= SUMMARY_EVERY_CHARS) this.#summary(id, thought);
        return;
      }
      this.#text(id, thought, thought.filter.push(reasoning.delta));
      return;
    }
    if (reasoning.status !== "completed" && reasoning.status !== "discarded") return;
    thought.ended = reasoning.status;
    if (this.#summarize) {
      // A thought that never reached the interval still gets its one sentence; a call already
      // out is waited for, so the sentence does not arrive after the thought it belongs to closed.
      if (reasoning.status === "completed" && !thought.inFlight && thought.fresh >= (thought.summaries === 0 ? SUMMARY_MIN_CHARS : SUMMARY_EVERY_CHARS / 2)) {
        this.#summary(id, thought);
      }
      if (thought.inFlight) return;
    } else this.#text(id, thought, thought.filter.flush());
    this.#close(id, thought);
  }

  /** A turn that ends mid-thought closes what it opened, so no client is left showing "thinking". */
  discardAll(): void {
    for (const [id, thought] of this.#thoughts) {
      thought.inFlight?.abort();
      this.publish("assistant-reasoning-end", { type: "assistant-reasoning-end", ...this.#envelope(id, thought.turnId), status: "discarded" });
    }
    this.#thoughts.clear();
  }

  #envelope(reasoningId: string, turnId: string) {
    return { turnId, reasoningId, audience: "user" as const };
  }

  #text(id: string, thought: Thought, delta: string): void {
    if (delta) this.publish("assistant-reasoning-delta", { type: "assistant-reasoning-delta", ...this.#envelope(id, thought.turnId), delta });
  }

  #close(id: string, thought: Thought): void {
    if (this.#thoughts.get(id) !== thought) return;
    this.#thoughts.delete(id);
    this.publish("assistant-reasoning-end", { type: "assistant-reasoning-end", ...this.#envelope(id, thought.turnId), status: thought.ended ?? "discarded" });
  }

  /** One call at a time per thought: a second sentence about the same seconds of thinking is noise. */
  #summary(id: string, thought: Thought): void {
    if (!this.#summarize || thought.inFlight || this.#calls >= SUMMARY_MAX_CALLS) return;
    this.#calls += 1;
    thought.fresh = 0;
    const controller = new AbortController();
    thought.inFlight = controller;
    const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
    // Product code and a network call: neither a throw nor a hang may reach the stream.
    Promise.resolve().then(() => this.#summarize?.(thought.raw, controller.signal)).catch(() => undefined).then((sentence) => {
      clearTimeout(timer);
      thought.inFlight = undefined;
      if (this.#thoughts.get(id) !== thought) return;
      const said = typeof sentence === "string" ? withoutIdentifiers(sentence.trim().replaceAll(/\s+/gu, " ")).slice(0, SUMMARY_MAX_CHARS) : "";
      if (said && (!this.#sentence || this.#sentence(said))) {
        thought.summaries += 1;
        // Ends on a full stop and a space, so the client's "sentence being written now" is this one, whole.
        this.#text(id, thought, `${/[.!?…]$/u.test(said) ? said : `${said}.`} `);
      }
      if (thought.ended) this.#close(id, thought);
      else if (thought.fresh >= SUMMARY_EVERY_CHARS) this.#summary(id, thought);
    });
  }
}
