import type { ChatMessage, LlmCallUsage, ToolSchema } from "@0xsyncroot/contracts";

/**
 * How long a model call is silent before its first stream event, learned from the calls that were answered.
 *
 * The gateway sends response headers only after it has read the prompt (tens of seconds for a large uncached prompt, under
 * a second for a small one), so a hung call cannot be told from a slow prefill by headers.
 * What can be told is how long a prompt of this many uncached tokens usually takes. A constant hedge delay is wrong both
 * ways: late for a hang on a healthy gateway, early for a long uncached prompt on a slow one.
 */

/** Never hedge earlier than this, whatever was learned: the healthy tail of first events reaches several seconds. */
export const HEDGE_MIN_MS = 6_000;
/** The delay stays at the configured cap until a model has this many samples; until then the constant of before is the prior. */
export const HEDGE_MIN_SAMPLES = 5;
/** Deviations above the estimate the hedge waits for (as TCP's retransmission timeout waits four deviations over its smoothed RTT). */
export const HEDGE_DEVIATION_FACTOR = 4;
/**
 * A sample above the estimate moves it by half the difference, one below by a tenth. A gateway that turns slow must be
 * believed at once, or the next hung call is hedged too early on a stale estimate and doubles the load of a queue;
 * one that recovers is believed slowly, because a run of fast answers says little about the next slow one.
 */
export const RAISE_WEIGHT = 0.5;
export const DECAY_WEIGHT = 0.1;
/** Uncached tokens are fitted in thousands, so base and slope stay on comparable scales. */
const TOKENS_PER_UNIT = 1_000;

interface Fit {
  /** ms of a call with nothing to read. */
  base: number;
  /** ms for each thousand uncached tokens. */
  slope: number;
  /** Smoothed absolute error of the estimate, ms. */
  deviation: number;
  samples: number;
}

/**
 * `ttft(u) = base + slope · u/1000`, fitted online per model id, with a smoothed deviation (RTO style).
 *
 * A normalised step on `[1, u/1000]`: the estimate at a sample's own `u` moves by `weight · error` exactly, so the two
 * weights above are what they say whatever `u` is. `base` and `slope` never go negative.
 */
export class FirstEventModel {
  readonly #fits = new Map<string, Fit>();

  /** `floorMs` is the shortest hedge delay; the default is `HEDGE_MIN_MS`, a test shortens it to keep its waits short. */
  constructor(private readonly floorMs = HEDGE_MIN_MS) {}

  /** The learned time to the first event of a call with `uncachedTokens` to read; undefined until the model has a sample. */
  expectedMs(modelId: string, uncachedTokens: number): number | undefined {
    const fit = this.#fits.get(modelId);
    return fit ? fit.base + fit.slope * (uncachedTokens / TOKENS_PER_UNIT) : undefined;
  }

  /**
   * Silence after which the call is made once more: `clamp(floor, expected + 4 · deviation, capMs)`, the cap itself
   * until the model has `HEDGE_MIN_SAMPLES` samples. A cap below the floor wins; a cap of 0 turns the hedge off.
   */
  hedgeAfterMs(modelId: string, uncachedTokens: number, capMs: number): number {
    if (capMs <= 0) return 0;
    const fit = this.#fits.get(modelId);
    if (!fit || fit.samples < HEDGE_MIN_SAMPLES) return capMs;
    const wait = fit.base + fit.slope * (uncachedTokens / TOKENS_PER_UNIT) + HEDGE_DEVIATION_FACTOR * fit.deviation;
    return Math.round(Math.min(capMs, Math.max(this.floorMs, wait)));
  }

  /** One call whose first event came from the call that was sent first, `firstEventMs` after it was sent. */
  learn(modelId: string, uncachedTokens: number, firstEventMs: number): void {
    if (!Number.isFinite(firstEventMs) || firstEventMs < 0 || !Number.isFinite(uncachedTokens) || uncachedTokens < 0) return;
    const fit = this.#fits.get(modelId);
    if (!fit) {
      this.#fits.set(modelId, { base: firstEventMs, slope: 0, deviation: firstEventMs / 2, samples: 1 });
      return;
    }
    const x = uncachedTokens / TOKENS_PER_UNIT;
    const error = firstEventMs - (fit.base + fit.slope * x);
    const step = (error > 0 ? RAISE_WEIGHT : DECAY_WEIGHT) * error / (1 + x * x);
    fit.base = Math.max(0, fit.base + step);
    fit.slope = Math.max(0, fit.slope + step * x);
    const spread = Math.abs(error);
    fit.deviation += (spread > fit.deviation ? RAISE_WEIGHT : DECAY_WEIGHT) * (spread - fit.deviation);
    fit.samples += 1;
  }
}

/**
 * A request as the gateway reads it, in pieces: the leading system messages, the tool schemas (a chat template renders
 * them with the system message, at the start), then the rest of the conversation. `warm` pieces open the list; they are
 * the same from turn to turn, so the gateway already holds them when a turn begins.
 */
export interface PromptPieces {
  readonly pieces: readonly string[];
  readonly warm: number;
}

/** Images are left out: a few hundred tokens each, and a base64 body would swamp the text it sits beside. */
function messagePiece(message: ChatMessage): string {
  const { images, ...rest } = message;
  return JSON.stringify(images?.length ? { ...rest, imageCount: images.length } : rest);
}

export function promptPieces(messages: readonly ChatMessage[], tools: readonly ToolSchema[]): PromptPieces {
  let leading = 0;
  while (leading < messages.length && messages[leading]!.role === "system") leading += 1;
  return {
    pieces: [...messages.slice(0, leading).map(messagePiece), JSON.stringify(tools), ...messages.slice(leading).map(messagePiece)],
    warm: leading + 1,
  };
}

function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let at = 0;
  while (at < limit && a.charCodeAt(at) === b.charCodeAt(at)) at += 1;
  return at;
}

/**
 * Characters of `request` the gateway has not read before: those past the common prefix with the previous request of the
 * same turn; for a turn's first request, those past the system message and the tools.
 */
export function uncachedChars(request: PromptPieces, previous: PromptPieces | undefined): number {
  const total = request.pieces.reduce((sum, piece) => sum + piece.length, 0);
  let shared = 0;
  if (!previous) {
    for (let at = 0; at < request.warm; at += 1) shared += request.pieces[at]!.length;
    return total - shared;
  }
  const count = Math.min(request.pieces.length, previous.pieces.length);
  for (let at = 0; at < count; at += 1) {
    const piece = request.pieces[at]!, before = previous.pieces[at]!;
    if (piece === before) { shared += piece.length; continue; }
    shared += commonPrefix(piece, before);
    break;
  }
  return total - shared;
}

/** Fallback of the model's `estimatedCharsPerToken`, as the context policies use. */
const DEFAULT_CHARS_PER_TOKEN = 3;

/** `uncachedChars` in tokens. */
export function estimatedUncachedTokens(request: PromptPieces, previous: PromptPieces | undefined, charsPerToken: number | undefined): number {
  return Math.ceil(uncachedChars(request, previous) / (charsPerToken && charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN));
}

/**
 * What the provider said of its prompt cache for one call, for the journal. The tokens read afresh (`uncachedInputTokens`,
 * beside the estimate the hedge was set from) only when it said both counts: a missing cache count is not "nothing cached".
 */
export function cacheUse(usage: LlmCallUsage | undefined): { readonly cachedInputTokens?: number; readonly uncachedInputTokens?: number } {
  const cached = usage?.cachedInputTokens;
  if (cached === undefined) return {};
  return { cachedInputTokens: cached, ...(usage?.inputTokens === undefined ? {} : { uncachedInputTokens: Math.max(0, usage.inputTokens - cached) }) };
}

/** How much of one call was private reasoning, for the journal: the provider's token count and the streamed length, never the text. */
export function reasoningUse(usage: LlmCallUsage | undefined): { readonly reasoningTokens?: number; readonly reasoningChars?: number } {
  return {
    ...(usage?.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    ...(usage?.reasoningChars !== undefined ? { reasoningChars: usage.reasoningChars } : {}),
  };
}
