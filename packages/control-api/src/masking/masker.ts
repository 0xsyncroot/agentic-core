import { collectMarked, numericValue } from "./collect.js";
import { normalizeWords, toolFieldsOf, type CompiledPersonalFields, type PersonalKind } from "./config.js";
import { coefficientForms, coefficientValue, moneyForms, nameForms } from "./variants.js";

export interface MaskResult {
  readonly text: string;
  /** Occurrences of known values replaced in this text. */
  readonly replaced: number;
}

interface NameForm { readonly words: readonly string[]; readonly canonical: string; readonly keep: number }
interface Span { readonly start: number; readonly end: number; readonly canonical: string }

const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const NUMBER = /\d+(?:[.,]\d+)*/gu;
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
const MAX_NAME_WORDS = 8;
const MAX_NAME_CHARS = 100;
const MIN_IDENTIFIER_CHARS = 3;
const MAX_IDENTIFIER_CHARS = 64;

const kindOf = (canonical: string): PersonalKind => canonical.slice(0, canonical.indexOf(":")) as PersonalKind;

/**
 * Masks one session. Values come only from tool results through the product's marks (`collect`); `mask` replaces their known
 * written forms with labels such as `[Name 2]`. A value keeps its label for the whole session, and labels are numbered per kind
 * in the order the masked text first shows them, so masking the same session again in the same order gives the same text.
 */
export class SessionMasker {
  /** Written form of a number → its value; money and coefficients share it, since one number token is one value. */
  readonly #numbers = new Map<string, string>();
  readonly #identifiers = new Map<string, string>();
  readonly #fullNames = new Map<string, readonly string[]>();
  readonly #labels = new Map<string, string>();
  readonly #counters = new Map<PersonalKind, number>();
  #names: Map<string, NameForm[]> | undefined;

  constructor(private readonly fields: CompiledPersonalFields) {}

  /** Takes the marked values of one tool result; a tool without marks adds nothing. */
  collect(toolId: string, result: unknown): void {
    const marks = toolFieldsOf(this.fields, toolId);
    if (!marks) return;
    collectMarked(result, marks, (kind, value) => this.#add(kind, value));
  }

  /** Distinct personal values known for the session. */
  get known(): number {
    return new Set([...this.#numbers.values(), ...this.#identifiers.values()]).size + this.#fullNames.size;
  }

  mask(input: string): MaskResult {
    const text = input.normalize("NFC");
    const spans = [...this.#numberSpans(text), ...this.#identifierSpans(text), ...this.#nameSpans(text)]
      .sort((a, b) => a.start - b.start || b.end - a.end);
    let out = "";
    let at = 0;
    let replaced = 0;
    for (const span of spans) {
      if (span.start < at) continue;
      out += text.slice(at, span.start) + this.#label(span.canonical);
      at = span.end;
      replaced += 1;
    }
    return { text: out + text.slice(at), replaced };
  }

  #add(kind: PersonalKind, value: unknown): void {
    if (kind === "money") {
      const amount = numericValue(value);
      if (amount === undefined || Math.abs(amount) < this.fields.moneyAtLeast) return;
      const canonical = `money:${Math.abs(amount).toFixed(2)}`;
      this.#addForms(moneyForms(amount, this.fields.moneyAtLeast, this.fields.units), canonical);
      return;
    }
    if (kind === "coefficient") {
      const amount = numericValue(value);
      const known = amount === undefined ? undefined : coefficientValue(amount);
      if (known !== undefined) this.#addForms(coefficientForms(known), `coefficient:${known}`);
      return;
    }
    if (kind === "identifier") {
      const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
      if (text.length < MIN_IDENTIFIER_CHARS || text.length > MAX_IDENTIFIER_CHARS) return;
      if (!this.#identifiers.has(text)) this.#identifiers.set(text, `identifier:${text}`);
      return;
    }
    if (typeof value !== "string" || value.length > MAX_NAME_CHARS || !/\p{L}/u.test(value) || /\p{N}/u.test(value)) return;
    const words = normalizeWords(value).split(" ");
    if (words.length < this.fields.minWords || words.length > MAX_NAME_WORDS) return;
    const canonical = `person-name:${words.join(" ")}`;
    if (!this.#fullNames.has(canonical)) { this.#fullNames.set(canonical, words); this.#names = undefined; }
  }

  /** A form already known keeps its first value, so a later value never relabels text masked before it. */
  #addForms(forms: readonly string[], canonical: string): void {
    for (const form of forms) if (!this.#numbers.has(form)) this.#numbers.set(form, canonical);
  }

  #label(canonical: string): string {
    const known = this.#labels.get(canonical);
    if (known) return known;
    const kind = kindOf(canonical);
    const next = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, next);
    const label = `[${this.fields.labels[kind]} ${next}]`;
    this.#labels.set(canonical, label);
    return label;
  }

  #numberSpans(text: string): Span[] {
    if (this.#numbers.size === 0) return [];
    const spans: Span[] = [];
    for (const match of text.matchAll(NUMBER)) {
      const start = match.index;
      const end = start + match[0].length;
      const unit = /^\s+([\p{L}\p{M}]+)/u.exec(text.slice(end, end + 40));
      const word = unit?.[1] ? normalizeWords(unit[1]) : undefined;
      const withUnit = word !== undefined && unit ? this.#numbers.get(`${match[0]} ${word}`) : undefined;
      if (withUnit && unit) spans.push({ start, end: end + unit[0].length, canonical: withUnit });
      else {
        const canonical = this.#numbers.get(match[0]);
        if (canonical) spans.push({ start, end, canonical });
      }
    }
    return spans;
  }

  #identifierSpans(text: string): Span[] {
    const spans: Span[] = [];
    for (const [value, canonical] of this.#identifiers) {
      for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
        const before = text[at - 1];
        const after = text[at + value.length];
        if ((before === undefined || !WORD_CHAR.test(before)) && (after === undefined || !WORD_CHAR.test(after))) {
          spans.push({ start: at, end: at + value.length, canonical });
        }
      }
    }
    return spans;
  }

  /** First word → forms starting with it, longest first. A given name two full names share becomes its own value. */
  #nameIndex(): Map<string, NameForm[]> {
    if (this.#names) return this.#names;
    const forms: NameForm[] = [];
    const given = new Map<string, Set<string>>();
    for (const [canonical, words] of this.#fullNames) {
      const variants = nameForms(words, this.fields.honorifics);
      forms.push({ words: variants.full, canonical, keep: 0 });
      for (const form of variants.given) {
        const key = form.join(" ");
        given.set(key, (given.get(key) ?? new Set()).add(canonical));
      }
    }
    for (const [key, owners] of given) {
      const words = key.split(" ");
      const honorific = this.fields.honorifics.find((candidate) => candidate.every((word, index) => words[index] === word));
      const keep = honorific?.length ?? 0;
      const canonical = owners.size === 1 ? [...owners][0] ?? "" : `person-name:${words.slice(keep).join(" ")}`;
      if (!this.#fullNames.has(key) || owners.size === 1) forms.push({ words, canonical, keep });
    }
    const index = new Map<string, NameForm[]>();
    for (const form of forms) {
      const first = form.words[0] ?? "";
      index.set(first, [...(index.get(first) ?? []), form]);
    }
    for (const list of index.values()) list.sort((a, b) => b.words.length - a.words.length);
    this.#names = index;
    return index;
  }

  #nameSpans(text: string): Span[] {
    if (this.#fullNames.size === 0) return [];
    const index = this.#nameIndex();
    const words = [...text.matchAll(WORD)].map((match) => ({ word: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length }));
    const spans: Span[] = [];
    words.forEach((first, at) => {
      for (const form of index.get(first.word) ?? []) {
        const run = words.slice(at, at + form.words.length);
        if (run.length !== form.words.length || run.some((word, k) => word.word !== form.words[k])) continue;
        if (run.some((word, k) => k > 0 && !/^\s+$/u.test(text.slice(run[k - 1]?.end, word.start)))) continue;
        const kept = run[form.keep];
        const last = run[run.length - 1];
        if (kept && last) spans.push({ start: kept.start, end: last.end, canonical: form.canonical });
        return;
      }
    });
    return spans;
  }
}
