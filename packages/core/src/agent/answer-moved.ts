import type { JsonValue, JudgmentAnswer, JudgmentQuestion, TurnJudge } from "@0xsyncroot/contracts";
import type { JudgmentSeamMode } from "./observation-review.js";
import { normalizedContentHash } from "./turn-control.js";

/** The seam the judge journals the question under; the row carries the check's verdict (`JudgmentVerdict`). */
export const ANSWER_MOVED_SEAM = "answer-moved";

/**
 * Whether the answer after a "work remains" objection moved on the point the objection raised. Measured with this wording,
 * on this state, through the gateway's System One endpoint, against independent labels on held-out answers: one that did move
 * was read as unmoved 3 times in 78 at `UNMOVED_AT_MOST` (each a long report whose only change removed the disputed figures),
 * and 53 of 77 that did not move were caught, where the content hash catches 6. That rate is this seam's accepted bar. Wordings rebuilt on the judge's guidance (statements with structured criteria, the drafts judged apart, a clause for a
 * removed figure) were no better: the objection and both drafts are judged together, or the relation is lost.
 */
export const ANSWER_MOVED_QUESTION: JudgmentQuestion = Object.freeze({
  type: "noul",
  instructions: "Compared with the previous answer, does the new answer add or change something about what the objection asked for?",
  criteria: {
    true: "The new answer adds a fact, figure, section or correction the objection asked for, or replaces a promise or a hand-back with results.",
    false: "About the objection, the new answer says the same as the previous one: reworded, reordered, or still the same promise, hand-back or claim.",
  },
}) as JudgmentQuestion;

/** At most this sure that the answer moved, it did not. */
export const UNMOVED_AT_MOST = 0.1;

/** The seam each disputed value is asked under, one row per value, the value on the row's verdict (`item`). */
export const ANSWER_MOVED_ITEM_SEAM = "answer-moved-item";

/**
 * Whether the new answer still states one value the objection disputed. On the same held-out answers, every disputed value
 * asked on the draft it was disputed in read as stated (76 of 76 at 0.9 or more), and a value at or under `VALUE_ABSENT_AT_MOST`
 * in the new answer vetoed no answer that did not move: the unmoved verdicts read wrongly fell from 3 in 78 to 1, recall unchanged.
 */
export const ANSWER_STATES_VALUE_QUESTION: JudgmentQuestion = Object.freeze({
  type: "noul",
  instructions: "`answer` states the value `value`.",
  criteria: {
    true: "The value appears in the answer, in any formatting (separators, currency, percent sign).",
    false: "The value does not appear in the answer.",
  },
}) as JudgmentQuestion;

/** At most this sure that the new answer states a disputed value, the value is gone: the answer moved. */
export const VALUE_ABSENT_AT_MOST = 0.1;

/** The lengths the measured states held: every objection and draft of the measured set fits whole. */
const REQUEST_CHARS = 300;
const OBJECTION_CHARS = 1_500;
const ANSWER_CHARS = 4_000;

interface ObjectedDraft {
  readonly hash: string; readonly answer: string; readonly objection: string; readonly toolCalls: number; readonly disputed: readonly string[];
}

const noulOf = (answers: Readonly<Record<string, JudgmentAnswer>>, id: string): number | undefined => {
  const answer = answers[id];
  return answer?.type === "noul" ? answer.noul : undefined;
};

/**
 * The judged half of the work-remains gate's "same answer" rule (`workRemainsReview`): beside the content hash, which ends the
 * work only on a byte-identical repeat, the judge reads the objection and both drafts and says whether the new one moved.
 *
 * It is asked exactly where the hash is compared: a terminal answer under a "work remains" objection, with no new result and no
 * work call since the objected answer (`Objections.objectedAnswer`). `on` waits for it and lets an unmoved verdict end the work as an identical
 * repeat does; an identical repeat is unmoved without asking. In `shadow` it is asked on every such answer, the review does not
 * wait, and nothing changes. A failed or absent judgment leaves the hash deciding alone. The verdict is journaled on the judgment's
 * own row.
 *
 * When the objection carried disputed values (`TurnTerminalDecision` continue `objection`), each is asked beside it, in parallel,
 * whether the new answer still states it: one gone (`VALUE_ABSENT_AT_MOST`) makes the answer moved, whatever the first judgment
 * read. The values only ever turn unmoved into moved; a value whose judgment failed vetoes nothing. Each value's row carries it as
 * the verdict's `item`; the first judgment's row carries the final verdict.
 */
export class AnswerMovedCheck {
  // Truly private: the loop's state is handed around as data, and a frozen abort signal crashes the process.
  readonly #judge: TurnJudge;
  readonly #mode: Exclude<JudgmentSeamMode, "off">;
  readonly #request: string;
  readonly #signal: AbortSignal;
  /** Ends a shadow judgment still out when the turn's steps are over (`close`). */
  readonly #closed = new AbortController();
  #objected: ObjectedDraft | undefined;

  constructor(judge: TurnJudge, mode: Exclude<JudgmentSeamMode, "off">, request: string, signal: AbortSignal) {
    this.#judge = judge; this.#mode = mode; this.#request = request; this.#signal = AbortSignal.any([signal, this.#closed.signal]);
  }

  /** The turn's steps are over: a shadow judgment still out is cancelled, never left to outlive the turn. */
  close(): void { this.#closed.abort(); }

  /** A "work remains" objection to a terminal answer was sent back: the draft and objection the next answer is weighed against. */
  objected(answer: string | null, objection: string, toolCalls: number, disputed: readonly string[] = []): void {
    const hash = normalizedContentHash(answer);
    this.#objected = hash === undefined || answer === null ? undefined : { hash, answer, objection, toolCalls, disputed };
  }

  /**
   * Whether `content` is the objected answer unmoved, by the judge. `objectedAnswer` is the hash the gate compares, absent once a
   * new result came; `toolCalls`, the turn's counted calls now. True only in `on`, on a verdict at or under the threshold; an
   * identical repeat is left to the hash.
   */
  async unmoved(content: string | null, objectedAnswer: string | undefined, toolCalls: number): Promise<boolean> {
    const previous = this.#objected;
    if (!previous || objectedAnswer !== previous.hash) return false;
    const sameHash = normalizedContentHash(content) === previous.hash;
    if (this.#mode === "on") return !sameHash && await this.#judged(content, previous, toolCalls, sameHash);
    this.#judged(content, previous, toolCalls, sameHash).catch(() => undefined);
    return false;
  }

  async #judged(content: string | null, previous: ObjectedDraft, toolCalls: number, sameHash: boolean): Promise<boolean> {
    const newAnswer = (content ?? "").slice(0, ANSWER_CHARS);
    const state = {
      request: this.#request.slice(0, REQUEST_CHARS), objection: previous.objection.slice(0, OBJECTION_CHARS),
      previousAnswer: previous.answer.slice(0, ANSWER_CHARS), newAnswer,
      newToolResultsSinceObjection: Math.max(0, toolCalls - previous.toolCalls),
    };
    const vetoed = this.#valueGone(previous.disputed, newAnswer, sameHash);
    const unmoved = async (value: number) => value <= UNMOVED_AT_MOST && !await vetoed;
    const asked = this.#judge(ANSWER_MOVED_SEAM, { state: state as unknown as JsonValue, questions: { moved: ANSWER_MOVED_QUESTION } }, this.#signal, {
      verdict: async (answers) => {
        const value = noulOf(answers, "moved");
        return value === undefined ? undefined : { label: await unmoved(value) ? "unmoved" : "moved", threshold: UNMOVED_AT_MOST, mode: this.#mode, sameHash };
      },
    });
    // Both settle before the check answers: no value's judgment outlives it, and a cancel of either is the check's.
    const [result] = await Promise.all([asked, vetoed]);
    const value = result ? noulOf(result.answers, "moved") : undefined;
    return value !== undefined && await unmoved(value);
  }

  /** Whether the new answer no longer states one of the disputed values, each asked on its own row. */
  async #valueGone(disputed: readonly string[], answer: string, sameHash: boolean): Promise<boolean> {
    const stated = await Promise.all(disputed.map(async (value) => {
      const result = await this.#judge(ANSWER_MOVED_ITEM_SEAM, { state: { value, answer }, questions: { states: ANSWER_STATES_VALUE_QUESTION } }, this.#signal, {
        verdict: (answers) => {
          const p = noulOf(answers, "states");
          return p === undefined ? undefined
            : { label: p <= VALUE_ABSENT_AT_MOST ? "absent" : "present", threshold: VALUE_ABSENT_AT_MOST, mode: this.#mode, sameHash, item: value };
        },
      });
      return result ? noulOf(result.answers, "states") : undefined;
    }));
    return stated.some((p) => p !== undefined && p <= VALUE_ABSENT_AT_MOST);
  }
}
