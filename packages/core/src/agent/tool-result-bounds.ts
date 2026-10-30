import type { JsonValue } from "@0xsyncroot/contracts";
import { sha256 } from "../hash.js";

/**
 * Keeps a tool result inside the model's budget by cutting its largest list, and saying so.
 *
 * A result over the budget used to be refused outright: the call failed with "exceeds 12000
 * characters", and the model went on without the data it had been asked to report on — a
 * monthly work sheet for a whole unit, in the case that surfaced it. The budget is right, a
 * result that size does not fit a context; refusing is wrong, because a prefix that names what
 * it left out is strictly more than nothing. Tool shapes are not published to the runtime, so
 * the rule is structural: the largest array anywhere in the value keeps its first rows, and the
 * cut is recorded where the model reads the result and where the journal keeps it.
 */

export interface TruncationMark {
  readonly path: string;
  readonly shown: number;
  readonly total: number;
  /** Where the whole result is kept, when the runtime keeps it: `read_result` pages through it. */
  readonly resultId?: string;
  /**
   * Hash of the whole list before the cut. Two cuts with the same digest hid the same entries, so a reader that read one
   * of them whole has read the other: a sheet read again after a write, unchanged, is not a second unseen sheet.
   */
  readonly digest?: string;
}

export interface BoundedToolResult {
  readonly value: JsonValue;
  /** Every cut made, in order; empty when the value fit whole. */
  readonly marks: readonly TruncationMark[];
}

function size(value: JsonValue): number { return JSON.stringify(value).length; }

/** The array whose serialized form is the largest, anywhere in the value, with the path to it. */
function largestArray(value: JsonValue, path: string, segments: readonly string[] = []): { readonly path: string; readonly segments: readonly string[]; readonly array: readonly JsonValue[]; readonly size: number } | undefined {
  if (Array.isArray(value)) {
    const own = { path, segments, array: value, size: size(value) };
    const inner = value.map((item, index) => largestArray(item, `${path}[${index}]`, [...segments, String(index)])).filter((found): found is NonNullable<typeof found> => found !== undefined);
    const largestInner = inner.sort((left, right) => right.size - left.size)[0];
    // A list of two employees each carrying a month of days: the inner list is the one to cut.
    return largestInner && largestInner.size > own.size / 2 && value.length <= 3 ? largestInner : own;
  }
  if (value && typeof value === "object") {
    const found = Object.entries(value).map(([key, item]) => largestArray(item, path ? `${path}.${key}` : key, [...segments, key]))
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
    return found.sort((left, right) => right.size - left.size)[0];
  }
  return undefined;
}

function replaceAt(value: JsonValue, path: readonly string[], replacement: JsonValue): JsonValue {
  if (path.length === 0) return replacement;
  const [head, ...rest] = path;
  if (Array.isArray(value)) return value.map((item, index) => String(index) === head ? replaceAt(item, rest, replacement) : item);
  if (value && typeof value === "object") return { ...value, [head!]: replaceAt((value as Record<string, JsonValue>)[head!] ?? null, rest, replacement) };
  return value;
}

/**
 * The value bounded to `maxChars` when serialized, or the original when it already fits.
 *
 * Cuts the largest list to the prefix that fits, then repeats on whatever list is largest
 * next. A value no list cut can bound — one enormous string, say — comes back whole with no
 * marks, for the caller's budget to refuse.
 *
 * A cut always keeps at least one entry. Cutting to zero used to be reachable whenever a single
 * entry was itself over budget, and what came back was an empty list plus a note saying nothing
 * had been read — indistinguishable, to the model, from a tool that legitimately found nothing,
 * and with the entry itself gone there was nothing left to fetch it back by. That is the one
 * shape this function must not produce: a result that looks like an answer and is an erasure.
 * Keeping one entry either fits, or leaves the value over budget so the caller refuses it out
 * loud, which is the honest outcome when a single indivisible entry is too big to send.
 */
export function boundToolResult(value: JsonValue, maxChars: number): BoundedToolResult {
  if (size(value) <= maxChars) return { value, marks: [] };
  let current = value;
  const marks: TruncationMark[] = [];
  for (let round = 0; round < 4 && size(current) > maxChars; round += 1) {
    const target = largestArray(current, "");
    if (!target || target.array.length === 0) break;
    // As many leading entries as fit beside the rest of the value, measured entry by entry. An average entry size keeps a
    // head of long entries (long texts first, short figures after) over budget round after round, and the whole result is
    // then refused with "no list to shorten".
    const room = maxChars - (size(current) - target.size) - 2;
    let used = 0, fitting = 0;
    for (const entry of target.array) {
      const next = used + size(entry) + (fitting > 0 ? 1 : 0);
      if (next > room) break;
      used = next; fitting += 1;
    }
    const keep = Math.max(1, Math.min(target.array.length - 1, fitting));
    // No progress is possible when the list is already down to the one entry that must survive;
    // stop rather than spend the remaining rounds re-cutting the same target to the same length.
    if (keep >= target.array.length) break;
    marks.push({ path: target.path || "(root)", shown: keep, total: target.array.length, digest: sha256(target.array) });
    // Replaced by its segments: a key holding "." or "[" (a sheet named "P. Staff") split as a path wrote the cut elsewhere.
    current = replaceAt(current, target.segments, target.array.slice(0, keep));
  }
  return marks.length === 0 || size(current) > maxChars ? { value, marks: [] } : { value: current, marks };
}

/**
 * The sentence the model reads under a cut result: which list, how much of it, and what to do.
 * Model-facing, so English like every instruction the runtime writes; the model answers the user
 * in the conversation's language.
 */
export function truncationNote(marks: readonly TruncationMark[]): string {
  return marks.map((mark) => mark.resultId
    ? `[Result too large: list ${mark.path} shows only ${mark.shown} of ${mark.total} entries; the rest were not shown yet. `
      + `The whole result is kept as resultId "${mark.resultId}": a tool that takes resultIds reads all of it from there. To read the entries yourself, `
      + `call read_result with {"resultId":"${mark.resultId}","path":"${mark.path}","offset":${mark.shown}} and keep going from the nextOffset it returns until it says done. `
      + `Do not ask the user to narrow or split the request.]`
    : `[Result too large: list ${mark.path} shows only ${mark.shown} of ${mark.total} entries; the rest were not read. `
    + `Draw no conclusion about the entries not shown: say plainly that ${mark.shown} of ${mark.total} were seen, or call again with a narrower filter if the tool has one.]`).join("\n");
}

/**
 * The value with, in every object, scalar members first, then nested objects, then arrays — the
 * larger array later. What tells the model a result is partial (a cursor, a done flag, a count)
 * is scalar, and the bulk is an array; a context cut keeps the head of a result, so the order
 * decides which of them survives it. The order the tool wrote is not enough: a JSON column in the
 * journal's store may re-sort keys (MySQL `json` orders by length, `jsonb` likewise), so the
 * order is imposed here, where the result is read back as well as where it is first shown.
 */
export function scalarsFirst(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(scalarsFirst);
  if (value === null || typeof value !== "object") return value;
  const rank = (member: JsonValue) => Array.isArray(member) ? 2 : member !== null && typeof member === "object" ? 1 : 0;
  const members = Object.entries(value).map(([key, member]) => [key, scalarsFirst(member)] as const);
  const arrays = members.filter(([, member]) => rank(member) === 2);
  const weight = new Map(arrays.length > 1 ? arrays.map(([key, member]) => [key, size(member)] as const) : []);
  return Object.fromEntries(members.map((entry, index) => ({ entry, index })).sort((left, right) =>
    rank(left.entry[1]) - rank(right.entry[1]) || (weight.get(left.entry[0]) ?? 0) - (weight.get(right.entry[0]) ?? 0) || left.index - right.index,
  ).map(({ entry }) => entry));
}

/**
 * What a tool result says to the model, in the step it ran and in every replay of the journal: the
 * tool's own value, then what the runtime adds about it — a cut list, or a `note` such as the one
 * written beside a question the user skipped.
 */
export function toolResultContent(payload: {
  readonly result?: JsonValue; readonly error?: JsonValue; readonly truncated?: JsonValue; readonly note?: JsonValue; readonly resultId?: JsonValue;
}): string {
  const marks = Array.isArray(payload.truncated) ? payload.truncated as unknown as readonly TruncationMark[] : [];
  return JSON.stringify(scalarsFirst(payload.result ?? payload.error ?? null)) + (marks.length > 0 ? `\n${truncationNote(marks)}` : "")
    + (typeof payload.resultId === "string" ? `\n[Retained observation: read_result with resultId ${JSON.stringify(payload.resultId)} can retrieve this result. It records this moment, not the current screen.]` : "")
    + (typeof payload.note === "string" && payload.note ? `\n${payload.note}` : "");
}
