import type { JudgmentPort } from "@0xsyncroot/contracts";

/**
 * How a judgment is waited for depends on what losing its verdict costs, which the seam that asks decides.
 *
 * Every attempt of every turn judgment has the same deadline, `JUDGMENT_ATTEMPT_TIMEOUT_MS`, which nearly every answered
 * call meets (docs/incidents/2026-10-15-core-judgment-latency.md). A call past it is stuck
 * (the gateway's hang mode), not slow, and waiting longer buys nothing a fresh request does not. The seam's class decides
 * what happens next:
 *
 * - `deciding`: the verdict ends, sends back or steers the turn (`completion-audit`, `procedure-audit`, `skill-suggestion`, `answer-moved` and its `answer-moved-item`).
 *   A call that got no answer in time, or whose connection failed, is sent once more with the same deadline (`retriesSeam`),
 *   except while the breaker below is open (`stalled`); then the seam's own fallback takes over (the LLM audit; the LLM skill-fit question; the content hash).
 * - `advisory`: a verdict that only trims or annotates (`skill-relevance`, `tool-relevance`, `observation-review`, `result-relevance`); every
 *   one has a path that keeps today's behaviour without it. One attempt, and the breaker below. A constant, not a cut
 *   adapted to observed latency: healthy answers have a long tail, and a cut near the median drops verdicts, so skills
 *   the judge ruled out are kept.
 * - `background`: labels written for later (`action-gate` and `step-claim` in shadow); off the critical path. One attempt.
 *
 * A seam named nowhere here (a product's own) has the same deadline, one attempt and is not tracked.
 */
export type JudgmentSeamClass = "deciding" | "advisory" | "background";

export const JUDGMENT_ATTEMPT_TIMEOUT_MS = 2_000;

const SEAM_CLASS: Readonly<Record<string, JudgmentSeamClass>> = {
  "completion-audit": "deciding",
  "procedure-audit": "deciding",
  "skill-suggestion": "deciding",
  "answer-moved": "deciding",
  "answer-moved-item": "deciding",
  "skill-relevance": "advisory",
  "tool-relevance": "advisory",
  "observation-review": "advisory",
  "result-relevance": "advisory",
  "action-gate": "background",
  "step-claim": "background",
};

/** The class of a seam, or undefined for one this table does not know. */
export function seamClass(seam: string): JudgmentSeamClass | undefined {
  return Object.hasOwn(SEAM_CLASS, seam) ? SEAM_CLASS[seam] : undefined;
}

/** Whether a call to `seam` that got no answer is sent once more before the seam falls back. */
export function retriesSeam(seam: string): boolean {
  return seamClass(seam) === "deciding";
}

/** Seam under which the breaker journals its transitions. */
export const BREAKER_SEAM = "judgment-breaker";
/** Consecutive advisory timeouts (each stall counted once) that open the breaker. */
export const BREAKER_THRESHOLD = 3;
/** How long an open breaker waits before one probe call is let through. */
export const BREAKER_COOLDOWN_MS = 60_000;
/** Advisory calls that start within this of the call that was last counted belong to the same stall: a parallel batch is one event. */
export const BREAKER_SAME_STALL_MS = 1_000;

export type BreakerTransition = "open" | "probe" | "closed";

/** What the breaker journals for a transition: one `judgment/classified` row, outcome `failed` for open and probe. */
export function breakerRow(transition: BreakerTransition): { readonly outcome: "answered" | "failed"; readonly reason: string } {
  return transition === "open" ? { outcome: "failed", reason: `breaker: open ${BREAKER_COOLDOWN_MS} ms` }
    : transition === "probe" ? { outcome: "failed", reason: "breaker: probe" } : { outcome: "answered", reason: "breaker: closed" };
}

/** One admitted call's way back into the tracker. Exactly one of the three is taken; a call that took none counts as inconclusive. */
export interface JudgmentSlot {
  /** The provider answered. Returns the breaker transition this caused. */
  answered(): BreakerTransition | undefined;
  /** The adapter's own deadline ran out (an `AgenticError` of code `timeout`). Returns the breaker transition this caused. */
  timedOut(): BreakerTransition | undefined;
  /** A cancel, an abort, a transport or HTTP error, a malformed answer: tells nothing about how fast the gateway is. */
  inconclusive(): void;
}

/** `entered: "probe"` marks the call let through after the cool-down: its row is journaled before the call. */
export type Admission =
  | { readonly ask: false }
  | { readonly ask: true; readonly slot: JudgmentSlot; readonly entered?: "probe" };

interface PortBreaker {
  state: "closed" | "open" | "probing";
  /** Advisory stalls in a row, each counted once. */
  consecutive: number;
  /** When the call that was last counted started. */
  lastStallStart: number;
  openUntil: number;
}

const UNTRACKED: JudgmentSlot = Object.freeze({ answered: () => undefined, timedOut: () => undefined, inconclusive: () => undefined });

/**
 * Whether the calls that only advise should be asked at all, from how the judgment provider has been answering.
 *
 * One per `TurnStepLoop`, kept across turns like the context calibration. It is fed by answered calls and by adapter
 * timeouts, and by nothing else: a call cancelled when its review ended, a transport error and an HTTP error say nothing
 * about the gateway's speed and must not open anything.
 *
 * The breaker covers the advisory seams alone. On a dead or queuing gateway each of them would wait its full deadline, one
 * after another, for a verdict that changes nothing when absent. After three
 * stalls in a row (6 s at the 2 s deadline) — calls that started together and timed out together are one stall — they are not asked for 60 s and
 * answer undefined, the path they already take when the provider fails; then one probe call decides by its own outcome.
 * The other classes are always asked and neither feed nor are held by it.
 */
export class JudgmentLatency {
  readonly #breakers = new WeakMap<JudgmentPort, PortBreaker>();
  readonly #now: () => number;

  constructor(now: () => number = () => performance.now()) { this.#now = now; }

  /**
   * Whether the advisory calls found the provider stuck: the breaker is open or probing. A deciding seam is still asked then,
   * but once: its second attempt would be the same full deadline on a gateway known to be hanging, and its own fallback
   * answers instead.
   */
  stalled(port: JudgmentPort): boolean {
    const breaker = this.#breakers.get(port);
    return breaker !== undefined && (breaker.state === "probing" || (breaker.state === "open" && this.#now() < breaker.openUntil));
  }

  /** Whether a call to `seam` is asked now, and the slot its outcome is reported to. */
  admit(port: JudgmentPort, seam: string): Admission {
    const cls = seamClass(seam);
    if (cls !== "advisory") return { ask: true, slot: UNTRACKED };
    const breaker = this.#breaker(port);
    const started = this.#now();
    if (breaker.state === "probing") return { ask: false };
    if (breaker.state === "open") {
      if (started < breaker.openUntil) return { ask: false };
      breaker.state = "probing";
      return { ask: true, slot: this.#advisory(breaker, started, true), entered: "probe" };
    }
    return { ask: true, slot: this.#advisory(breaker, started, false) };
  }

  #breaker(port: JudgmentPort): PortBreaker {
    let breaker = this.#breakers.get(port);
    if (!breaker) { breaker = { state: "closed", consecutive: 0, lastStallStart: Number.NEGATIVE_INFINITY, openUntil: 0 }; this.#breakers.set(port, breaker); }
    return breaker;
  }

  #advisory(breaker: PortBreaker, started: number, probe: boolean): JudgmentSlot {
    return {
      answered: () => {
        if (probe) { breaker.state = "closed"; breaker.consecutive = 0; breaker.lastStallStart = Number.NEGATIVE_INFINITY; return "closed"; }
        // A straggler that began before the breaker opened says nothing while it is open; only the probe does.
        if (breaker.state === "closed") { breaker.consecutive = 0; breaker.lastStallStart = Number.NEGATIVE_INFINITY; }
        return undefined;
      },
      timedOut: () => {
        if (probe) return this.#open(breaker);
        if (breaker.state !== "closed") return undefined;
        if (started - breaker.lastStallStart < BREAKER_SAME_STALL_MS) return undefined;
        breaker.lastStallStart = started;
        breaker.consecutive += 1;
        return breaker.consecutive >= BREAKER_THRESHOLD ? this.#open(breaker) : undefined;
      },
      // A probe that learned nothing leaves the next advisory call to probe again.
      inconclusive: () => { if (probe) { breaker.state = "open"; breaker.openUntil = this.#now(); } },
    };
  }

  #open(breaker: PortBreaker): BreakerTransition {
    breaker.state = "open"; breaker.consecutive = 0; breaker.lastStallStart = Number.NEGATIVE_INFINITY;
    breaker.openUntil = this.#now() + BREAKER_COOLDOWN_MS;
    return "open";
  }
}
