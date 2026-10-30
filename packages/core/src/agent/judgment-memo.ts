import type { JsonValue } from "@0xsyncroot/contracts";
import { sha256 } from "../hash.js";

/** Verdicts kept per runtime: enough for every live session's skills and retained results, bounded all the same. */
const CAPACITY = 4_096;

/**
 * Verdicts the judge already gave, kept for later steps and later turns that ask the same question about the same request.
 *
 * An approval resume is a new turn with the same request, and a retained result comes up again a few steps on: asked
 * afresh, each costs a judgment that gives the same answer (docs/incidents/2026-10-14-core-judgment-reuse.md).
 * A verdict depends on the question,
 * its subject and the request, so that is its key; a new request asks anew. Only answers are kept: a failed judgment is
 * asked again next time. Held by the agent loop, in memory: a resume served by another replica asks once more, as before.
 */
export class JudgmentMemo {
  readonly #verdicts = new Map<string, boolean>();

  /** The verdict given for `key`, or undefined when it was never answered (or has been evicted). */
  get(key: Readonly<Record<string, JsonValue>>): boolean | undefined {
    const id = sha256(key);
    const verdict = this.#verdicts.get(id);
    if (verdict !== undefined) { this.#verdicts.delete(id); this.#verdicts.set(id, verdict); }
    return verdict;
  }

  set(key: Readonly<Record<string, JsonValue>>, verdict: boolean): void {
    const id = sha256(key);
    this.#verdicts.delete(id);
    this.#verdicts.set(id, verdict);
    while (this.#verdicts.size > CAPACITY) this.#verdicts.delete(this.#verdicts.keys().next().value!);
  }

  /** The kept verdict, or the one `ask` gives now — kept when it is an answer. */
  async remember(key: Readonly<Record<string, JsonValue>>, ask: () => Promise<boolean | undefined>): Promise<boolean | undefined> {
    const kept = this.get(key);
    if (kept !== undefined) return kept;
    const verdict = await ask();
    if (verdict !== undefined) this.set(key, verdict);
    return verdict;
  }
}
