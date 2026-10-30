import type { ResolvedLlmModel } from "@0xsyncroot/contracts";

/** Kept below the measured ratio: the next request's mix of text, JSON and numbers is not the last one's. */
const MARGIN = 0.9;
const PLAUSIBLE = { min: 0.5, max: 8 } as const;

/**
 * How many serialized characters one token of a route really is, learned from the provider's own counts.
 *
 * The context budget is kept in characters and turned into tokens by an estimate — three characters a token unless the
 * adapter knows better. JSON full of Vietnamese text and figures runs nearer two and a half, so a request the budget said
 * fitted can overflow the window step after step (docs/incidents/2026-10-10-core-context-overflow.md). Every response
 * states what the request cost (`usage.inputTokens`), and a refused one often states it too;
 * the ratio of those to the characters sent replaces the estimate for this route, across turns, while it is lower.
 */
export class ContextCalibration {
  readonly #charsPerToken = new Map<string, number>();

  /** The route with the learned ratio, when one is known and is lower than the route's own estimate. */
  apply(route: ResolvedLlmModel): ResolvedLlmModel {
    const learned = this.#charsPerToken.get(key(route));
    return learned !== undefined && learned < (route.estimatedCharsPerToken ?? 3) ? { ...route, estimatedCharsPerToken: learned } : route;
  }

  /** A request of `chars` serialized characters that the provider counted as `tokens`; returns the route to use next. */
  learn(route: ResolvedLlmModel, chars: number, tokens: number | undefined): ResolvedLlmModel {
    if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0 || chars <= 0) return route;
    const ratio = (chars / tokens) * MARGIN;
    if (ratio < PLAUSIBLE.min || ratio > PLAUSIBLE.max) return route;
    // The densest request seen sets it; a lighter one raises it only a tenth of the way, so one easy step cannot bring the
    // next dense one back over the window.
    const known = this.#charsPerToken.get(key(route));
    this.#charsPerToken.set(key(route), known === undefined || ratio < known ? ratio : known + (ratio - known) * 0.1);
    return this.apply({ ...route, estimatedCharsPerToken: route.estimatedCharsPerToken ?? 3 });
  }
}

const key = (route: ResolvedLlmModel): string => `${route.providerId}\u0000${route.modelId}`;
