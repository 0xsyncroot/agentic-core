/** Text whose last characters are checked for a loop, and the longest unit such a loop repeats. */
const LOOP_WINDOW_CHARS = 4_096;
const LOOP_MAX_UNIT_CHARS = 128;
/** New text between two checks for a loop: a check reads the window again, so not one per delta. */
const LOOP_CHECK_EVERY_CHARS = 512;

/**
 * The bound on the text one model attempt streams (answer or narration alike: which one it is is known only once the attempt
 * ends), and on its reasoning. A provider without an output ceiling lets a degenerate generation run until its own token
 * limit, and the step waits for all of it.
 *
 * A degenerate generation can repeat one short unit for minutes, until the provider's length limit, and the delivery
 * stream may run out of its event budget first and fail the whole turn; generated again, the same request answers
 * normally. The loop test below flags such runaways and no normal answer
 * (docs/incidents/2026-10-14-core-runaway-answer.md).
 *
 * Two signs end such an attempt, so that the step is generated again:
 * - its text loops: the last `LOOP_WINDOW_CHARS` are one unit of at most `LOOP_MAX_UNIT_CHARS` repeated exactly, which is
 *   at least 32 identical copies in a row, and the unit has a letter in it — tables, lists and separators written for a
 *   person vary from row to row, and a blank template's rows (no letter) are not taken for a loop;
 * - it passes `maxChars`, for a runaway that does not repeat itself exactly (reasoning has the adapter's own budget, and
 *   is bounded here by the loop test only).
 */
export class AnswerBound {
  #chars = 0;
  #tail = "";
  #sinceCheck = 0;

  constructor(private readonly maxChars: number, private readonly channel: "answer" | "reasoning" = "answer") {}

  /** Why the attempt has to stop once `delta` is added, or undefined while its text is within the bounds. */
  push(delta: string): string | undefined {
    this.#chars += delta.length;
    if (this.#chars > this.maxChars) return `Model ${this.channel} exceeded ${this.maxChars} characters`;
    this.#tail = (this.#tail + delta).slice(-LOOP_WINDOW_CHARS);
    this.#sinceCheck += delta.length;
    if (this.#tail.length < LOOP_WINDOW_CHARS || this.#sinceCheck < LOOP_CHECK_EVERY_CHARS) return undefined;
    this.#sinceCheck = 0;
    const unit = loopUnit(this.#tail);
    return unit === undefined ? undefined : `Model ${this.channel} looped on a ${unit}-character unit after ${this.#chars} characters`;
  }
}

/**
 * The length of the unit `text` repeats from end to end, if one of at most `LOOP_MAX_UNIT_CHARS` does and it has a letter.
 * The shortest such unit is found first; a longer one is a multiple of it, with the same characters.
 */
function loopUnit(text: string): number | undefined {
  for (let unit = 1; unit <= LOOP_MAX_UNIT_CHARS; unit += 1) {
    let at = unit;
    while (at < text.length && text.charCodeAt(at) === text.charCodeAt(at - unit)) at += 1;
    if (at === text.length) return /\p{L}/u.test(text.slice(-unit)) ? unit : undefined;
  }
  return undefined;
}
