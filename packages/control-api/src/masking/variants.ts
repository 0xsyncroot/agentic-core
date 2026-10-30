/**
 * Written forms of a known value. Money: the integer part grouped by dots, by commas or not at all; decimals after a comma or a
 * point, a whole amount also with `,00`; the truncated and the rounded integer; and scale-word forms (`12,5 <word>`). Coefficients:
 * the decimals after a point or a comma, also padded to two places. Names: the full name, and each configured
 * honorific before the last word or the last two words. Every form is derived from the value; nothing is guessed from text.
 */

function grouped(digits: string, separator: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/gu, separator);
}

function integerForms(value: number): string[] {
  const digits = String(value);
  return [digits, grouped(digits, "."), grouped(digits, ",")];
}

function decimalForms(integer: number, decimals: string): string[] {
  const digits = String(integer);
  return [`${digits}.${decimals}`, `${digits},${decimals}`, `${grouped(digits, ".")},${decimals}`, `${grouped(digits, ",")}.${decimals}`];
}

/** Forms of `amount` (its absolute value) with scale `units`; integers below `atLeast` are not forms of money. */
export function moneyForms(amount: number, atLeast: number, units: readonly { readonly word: string; readonly factor: number }[]): string[] {
  const value = Math.abs(amount);
  const forms = new Set<string>();
  for (const integer of new Set([Math.trunc(value), Math.round(value)])) {
    if (integer >= atLeast) for (const form of integerForms(integer)) forms.add(form);
  }
  const cents = Math.round(value * 100);
  if (value >= atLeast) {
    const integer = Math.trunc(cents / 100);
    const fraction = String(cents % 100).padStart(2, "0");
    for (const decimals of new Set([fraction, fraction.replace(/0$/u, "")])) for (const form of decimalForms(integer, decimals)) forms.add(form);
  }
  for (const unit of units) {
    const scaled = value / unit.factor;
    if (scaled < 1) continue;
    if (Number.isInteger(scaled)) for (const form of integerForms(scaled)) forms.add(`${form} ${unit.word}`);
    for (const places of [1, 2]) {
      const text = scaled.toFixed(places).replace(/0+$/u, "");
      if (text.endsWith(".")) continue;
      const [whole = "", fraction = ""] = text.split(".");
      forms.add(`${whole}.${fraction} ${unit.word}`);
      forms.add(`${whole},${fraction} ${unit.word}`);
    }
  }
  return [...forms];
}

/** Places a coefficient is compared at: salary factors and rates are written with up to four decimals. */
const COEFFICIENT_PLACES = 4;

/** The value a coefficient is known by: its absolute value at `COEFFICIENT_PLACES`, or undefined for zero and non-numbers. */
export function coefficientValue(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  const text = String(Number(Math.abs(value).toFixed(COEFFICIENT_PLACES)));
  return text === "0" ? undefined : text;
}

/**
 * Forms of a coefficient: `5.7`, `5,7`, `5.70`, `5,70`. A whole coefficient has only its decimal forms (`4,0`, `4.00`): the bare
 * digit is too common in text (months, counts) to stand for one person's factor, so it stays visible.
 */
export function coefficientForms(known: string): string[] {
  const [whole = "", fraction = ""] = known.split(".");
  const decimals = new Set(fraction === "" ? ["0", "00"] : [fraction, fraction.padEnd(2, "0")]);
  return [...decimals].flatMap((digits) => [`${whole}.${digits}`, `${whole},${digits}`]);
}

/** Word lists that stand for a person: the full name, and honorific + given name for the last one and two words. */
export function nameForms(words: readonly string[], honorifics: readonly (readonly string[])[]): { readonly full: readonly string[]; readonly given: readonly (readonly string[])[] } {
  const given = [words.slice(-1)];
  if (words.length > 2) given.push(words.slice(-2));
  return { full: words, given: given.flatMap((part) => honorifics.map((honorific) => [...honorific, ...part])) };
}
