const ENUM = /^[a-z][a-z_:-]{0,39}$/u;

/** A recorded enum, normalized so a value with a parenthesised detail stays one token. */
export function token(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/ \(([^)]+)\)$/u, ":$1");
  if (!ENUM.test(text)) throw new Error(`not an enum value: ${text.slice(0, 40)}`);
  return text;
}

/** Ordinals per run: the first distinct value is 1. */
export class Ordinals {
  #seen = new Map();
  of(value) {
    if (value === undefined || value === null || value === "") return 0;
    if (!this.#seen.has(value)) this.#seen.set(value, this.#seen.size + 1);
    return this.#seen.get(value);
  }
}
