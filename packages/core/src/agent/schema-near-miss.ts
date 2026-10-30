/** How many allowed names a validation error lists before it says there are more. */
const MAX_LISTED = 20;

/** How many characters of a caller-supplied name a validation error echoes. */
const MAX_NAME_SHOWN = 60;

/** A name reduced to what a typist keeps: no case, no accents, no spaces, dashes or underscores. */
function normalised(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\u0111/gi, "d").toLowerCase().replace(/[\s_.-]+/g, "");
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1);
      current.push(Math.min(substitution, previous[column]! + 1, current[column - 1]! + 1));
    }
    previous = current;
  }
  return previous[right.length]!;
}

/**
 * The allowed name the given one was most likely meant to be, or undefined when none is near.
 *
 * "Near" is a different spelling of the same normalised name, one name inside the other (`sheet`
 * for `sheetName`), or a few edits for the length. Naming a far-off candidate would send the
 * model somewhere the error has no reason to point.
 */
export function closestName(given: string, allowed: readonly string[]): string | undefined {
  const wanted = normalised(given);
  if (wanted === "") return undefined;
  let best: { readonly name: string; readonly distance: number } | undefined;
  for (const name of allowed) {
    const candidate = normalised(name);
    const longer = Math.max(wanted.length, candidate.length);
    const shorter = Math.min(wanted.length, candidate.length);
    const distance = editDistance(wanted, candidate);
    const near = distance <= Math.max(1, Math.floor(longer / 3)) || (shorter >= 3 && (candidate.includes(wanted) || wanted.includes(candidate)));
    if (near && (best === undefined || distance < best.distance)) best = { name, distance };
  }
  return best?.name;
}

/** The names a value may take, in a form the model can copy from, cut at a readable length. */
export function allowedList(names: readonly string[]): string {
  return names.length > MAX_LISTED ? `${names.slice(0, MAX_LISTED).join(", ")}, …` : names.join(", ");
}

/**
 * A name the caller supplied, cut so one refusal cannot grow with the input.
 *
 * Names the schema declares are short by construction; an unknown name is whatever the caller sent,
 * and a refusal that quotes it whole would carry a 100k-character key into the model's context.
 */
export function shownName(name: string): string {
  if (name.length <= MAX_NAME_SHOWN) return name;
  return `${name.slice(0, MAX_NAME_SHOWN).replace(/[\ud800-\udbff]$/u, "")}…`;
}
