/**
 * Whether every figure an answer writes is also written, with the same value, in what the task read.
 *
 * A figure copied from a result was not worked out by hand, whatever a judge reading a long state makes of it: a total
 * the list itself prints is not a "computed figure". This only ever clears that question; it never finds an answer wrong,
 * because a short number (a count, a month) can appear in the evidence by chance. The same value written with another
 * separator convention is the same figure: 1.132.885.748 = 1,132,885,748 = 1132885748; 4,09 = 4.09; 5,20 = 5.2.
 */

/** A run of digits and separators that is not part of a word or a code (`e62`, `NV001`, `T9`). */
const FIGURE = /(?<![\p{L}\p{N}_])\d[\d.,]*/gu;
const CONVENTIONS = [{ group: ".", point: "," }, { group: ",", point: "." }] as const;

/** The value a digit string and its decimals stand for, written one way: no leading zeros, no trailing decimal zeros. */
function canonical(whole: string, fraction: string): string {
  const integer = whole.replace(/^0+(?=\d)/u, "");
  const decimals = fraction.replace(/0+$/u, "");
  return decimals ? `${integer}.${decimals}` : integer;
}

/** Every value a written figure can stand for: thousands grouped by "." or by ",", the other one the decimal point. */
function readings(token: string): readonly string[] {
  const values = new Set<string>();
  for (const { group, point } of CONVENTIONS) {
    const parts = token.split(point);
    if (parts.length > 2) continue;
    const [whole = "", fraction = ""] = parts;
    const groups = whole.split(group);
    if (!/^\d*$/u.test(fraction) || groups.some((part) => !/^\d+$/u.test(part))) continue;
    if (groups.length > 1 && (groups[0]!.length > 3 || groups.slice(1).some((part) => part.length !== 3))) continue;
    values.add(canonical(groups.join(""), fraction));
  }
  return [...values];
}

function figures(text: string): readonly string[] {
  return [...text.matchAll(FIGURE)].map((match) => match[0].replace(/[.,]+$/u, "")).filter(Boolean);
}

/** The value a JSON number holds, written as `canonical` writes it: sign and exponent dropped, as a written figure has neither. */
function numberValue(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  const [whole = "", fraction = ""] = Math.abs(value).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }).split(".");
  return canonical(whole, fraction);
}

/**
 * Every value a source writes. A tool result arrives as JSON: its numbers are read as numbers and its keys and strings as text,
 * because digits run across JSON's own commas are not one figure — `[42000000,38500000]` holds 42000000 and 38500000, not
 * 42000000.385. A source that is not JSON (the request) is read as text.
 */
function sourceValues(source: string, into: Set<string>): void {
  const fromText = (text: string) => { for (const token of figures(text)) for (const value of readings(token)) into.add(value); };
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { fromText(source); return; }
  const walk = (value: unknown): void => {
    if (typeof value === "number") { const read = numberValue(value); if (read) into.add(read); }
    else if (typeof value === "string") fromText(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { fromText(key); walk(item); }
  };
  walk(parsed);
}

/**
 * True when `answer` writes at least one figure and each has a reading some figure in `sources` shares. An answer with no
 * figure in digits is not cleared: a figure written in words is not read here, so the judge's reading of it stands.
 */
export function figuresInSources(answer: string, sources: readonly string[]): boolean {
  const stated = figures(answer);
  if (stated.length === 0) return false;
  const known = new Set<string>();
  for (const source of sources) sourceValues(source, known);
  return stated.every((token) => readings(token).some((value) => known.has(value)));
}
