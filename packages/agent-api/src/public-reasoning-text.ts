/**
 * Model-written text on its way to a browser, with the runtime's own identifiers taken out of it.
 *
 * Two kinds of text cross that the model wrote for itself rather than for the reader: its
 * reasoning, when a product chooses to show it, and the plan it keeps — a step's description and
 * what the step found. Both name what the model was handed: the tools it is about to call, the
 * ids in a tool result. A real plan step read "… (unitId: 00000001-0000-4000-8000-000000000001)",
 * and the page showed it. Those are recognisable by shape, not by meaning — a word with an
 * underscore inside it, a lowerCamelCase name, a long run of hex, a UUID — and nothing a person
 * writes in prose has that shape, so they can be dropped without reading what the sentence says.
 */
const IDENTIFIER = /[^\s()[\]]*(?:[A-Za-z0-9]_[A-Za-z0-9]|\b[a-z]+[A-Z][A-Za-z0-9]*|[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-)[^\s()[\]]*/giu;
/** Eight or more hex characters that are not simply a number: the head of an id, however it was cut short. */
const HEX_ID = /(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{8,}/iu;
/** A bracket left holding nothing but what was removed: "(unitId: 137b…)" → "(… …)" → gone. */
const EMPTIED_BRACKET = /\s*[([](?:\s*…[\s:=,;/|-]*)+[)\]]/gu;
const HELD_WORD_MAX_CHARS = 256;
const HELD_SENTENCE_MAX_CHARS = 600;

export function withoutIdentifiers(text: string): string {
  // `i` would make `[a-z]+[A-Z]` match any two letters; the camelCase branch needs case to mean something.
  return text.replace(IDENTIFIER, (token) => (/[A-Za-z0-9]_[A-Za-z0-9]|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-/u.test(token) || HEX_ID.test(token)
    || /(?:^|[^A-Za-z])[a-z]+[A-Z]/u.test(token) ? "…" : token))
    // Two things removed side by side leave one gap, not two.
    .replace(/…(?:\s*…)+/gu, "…").replace(EMPTIED_BRACKET, "");
}

/** The plan as a browser may see it: the same plan, its sentences without the runtime's identifiers. */
export function publicPlan<T extends { readonly goal?: string; readonly steps: readonly { readonly description: string; readonly outcome?: string }[] }>(plan: T): T {
  return {
    ...plan, ...(plan.goal !== undefined ? { goal: withoutIdentifiers(plan.goal) } : {}),
    steps: plan.steps.map((step) => ({
      ...step, description: withoutIdentifiers(step.description),
      ...(step.outcome !== undefined ? { outcome: withoutIdentifiers(step.outcome) } : {}),
    })),
  };
}

/**
 * Reasoning text as it streams: identifiers out, and — when the product says which sentences may
 * cross — only those sentences.
 *
 * Text arrives in fragments that split words anywhere, so the last unfinished word is held back
 * until its end is seen: an id cut in two would otherwise pass as two harmless halves. With a
 * sentence test the unit held back is the sentence, because the test is about the sentence: a
 * model that thinks in another language than its user would otherwise put that language on the
 * page word by word before anything could judge it.
 */
export class ReasoningTextFilter {
  #held = "";
  readonly #accept: ((sentence: string) => boolean) | undefined;

  constructor(accept?: (sentence: string) => boolean) {
    this.#accept = accept;
  }

  /** What may be published now; "" while the only text so far is still being written. */
  push(delta: string): string {
    const text = this.#held + delta;
    if (this.#accept) return this.#sentences(text, false);
    const boundary = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"));
    if (boundary < 0 && text.length < HELD_WORD_MAX_CHARS) {
      this.#held = text;
      return "";
    }
    const cut = boundary < 0 ? text.length : boundary + 1;
    this.#held = text.slice(cut);
    return withoutIdentifiers(text.slice(0, cut));
  }

  /** What was held, once the reasoning has ended and nothing more can complete it. */
  flush(): string {
    const rest = this.#accept ? this.#sentences(this.#held, true) : withoutIdentifiers(this.#held);
    this.#held = "";
    return rest;
  }

  #sentences(text: string, final: boolean): string {
    const parts = text.split(/(?<=[.!?…:;])\s+|\n+/u);
    this.#held = final ? "" : parts.pop() ?? "";
    if (this.#held.length > HELD_SENTENCE_MAX_CHARS) { parts.push(this.#held); this.#held = ""; }
    const kept = parts.map((part) => part.trim()).filter((part) => part && this.#accept?.(part)).map(withoutIdentifiers);
    return kept.length > 0 ? `${kept.join(" ")} ` : "";
  }
}
