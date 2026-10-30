import type { JsonValue, JudgmentAnswer, JudgmentPort, JudgmentQuestion, JudgmentRequest, JudgmentResult } from "@0xsyncroot/contracts";

/**
 * An audit decided by a fast typed judge, cross-checked by itself.
 *
 * The judge answers yes/no and one-of-N questions with probabilities in about a tenth of a second.
 * Measured against a model audit on labelled answers it let fewer wrong ones through and, on a live
 * turn, the model audit overruled it wrongly — so the judge decides. One round is not asked to carry
 * every case: a round whose answers are neither clearly a pass nor clearly a failure hands on to the
 * next, which asks the same thing another way (other wording, other framing, the full evidence
 * instead of the condensed one). A clear failure in any round ends the audit; a pass needs most of
 * the rounds to agree. Later rounds cost tokens, so they run only while the outcome is open.
 *
 * The judge writes no text: a failed audit is reported as the flags of the round that decided it, and
 * the caller turns those into its verdict. A model audit, when one is given, is the fallback for the one
 * case the judge cannot cover — when it cannot be had at all (not mounted, rate-limited, failing).
 */
export type RoundVerdict = "pass" | "fail" | "doubt";

export interface JudgmentRound<Input> {
  /** Names the round in records and in the journal's order of judgments. */
  readonly id: string;
  readonly questions: Readonly<Record<string, JudgmentQuestion>>;
  /** What this round's judge reads. A different view of the input is part of what makes a cross-check. */
  readonly state: (input: Input) => JsonValue;
  /** How this round reads its answers: clearly passing, clearly failing (with what it objects to), or neither. */
  readonly read: (answers: Readonly<Record<string, JudgmentAnswer>>, input: Input) => { readonly verdict: RoundVerdict; readonly flags: readonly string[] };
}

export interface JudgedAuditRecord {
  readonly rounds: readonly { readonly id: string; readonly verdict: RoundVerdict; readonly flags: readonly string[]; readonly elapsedMs: number }[];
  /** `unavailable`: the judge could not be had before the rounds settled it. `arbitrated`: its failure was one the model audit settles. */
  readonly decision: "pass" | "fail" | "arbitrated" | "unavailable";
  readonly flags: readonly string[];
  /**
   * `arbitrated` only: what the model audit decided (`passes` reads its verdict); `unavailable`: it gave none, and the
   * judge's failure stands. Not journaled anywhere else: live, `judge=arbitrated` was all an operator could see.
   */
  readonly arbitration?: "pass" | "fail" | "unavailable";
}

/** A judgment asked for one audit: in a turn, the turn's judge, which journals it. Undefined when it could not be had. */
export type AuditJudge = (request: JudgmentRequest, signal: AbortSignal) => Promise<JudgmentResult | undefined>;

/**
 * A first round the caller asked ahead of the audit, so it ran beside work the audit does not depend on (the ending
 * judgment). The promise is the judge's own, unwrapped: a cancelled turn rejects it, and the audit rethrows that exactly
 * as it would the same call made inside (`consensus`). `startedAt` (`performance.now()`) is when the call went out: the
 * record's `elapsedMs` for this round measures from there — from the review's start, not from when the audit began
 * waiting — so a round that was ready by then does not read as a gateway that answered in 0 ms.
 */
export interface PreAskedRound {
  readonly firstRound?: Promise<JudgmentResult | undefined>;
  readonly startedAt?: number;
}

/** What the first round of `rounds` asks of this input: the request a caller starts early and passes in as `PreAskedRound.firstRound`. */
export function firstRoundRequest<Input>(rounds: readonly JudgmentRound<Input>[], input: Input): JudgmentRequest {
  const first = rounds[0]!;
  return { state: first.state(input), questions: first.questions };
}

/** The auditor, and the request its first round asks of an input (for a caller that asks it early). */
export interface JudgedAuditor<Input, Verdict> {
  (input: Input, signal: AbortSignal, judge?: AuditJudge, pre?: PreAskedRound): Promise<Verdict | undefined>;
  readonly firstRound: (input: Input) => JudgmentRequest;
}

export interface JudgedAuditorOptions<Input, Verdict> {
  /** A fixed provider, used when the caller passes no judge of its own (outside a turn, in tests). */
  readonly judgment?: JudgmentPort;
  /** The first round is always asked; each later one only while the outcome is still open. */
  readonly rounds: readonly JudgmentRound<Input>[];
  readonly passedVerdict: Verdict;
  /** The verdict for a failed audit, from the flags the rounds raised (the judge writes no text). */
  readonly failedVerdict: (flags: readonly string[]) => Verdict;
  /** Asked when the judge cannot be had, and for a failure `arbitrated` names. Without one, the first returns no verdict and the second stands. */
  readonly modelAudit?: (input: Input, signal: AbortSignal) => Promise<Verdict | undefined>;
  /**
   * Failures the judge is not trusted to declare alone, by their flags: the model audit settles
   * them. For the kinds of objection where the judge measured wrong too often (it failed one correct
   * answer in five when its only objection was that figures did not match).
   */
  readonly arbitrated?: (flags: readonly string[]) => boolean;
  /** Whether a verdict passes the answer: how the record reads the model audit's arbitration. Without it the record names none. */
  readonly passes?: (verdict: Verdict) => boolean;
  /** Called after every audit the judge took part in (after its arbitration, when there is one), for telemetry. */
  readonly onJudged?: (record: JudgedAuditRecord, input: Input) => void;
  /** Measuring: the model audit also runs on every input and both are reported; the model's verdict is returned, so nothing changes. */
  readonly shadow?: (record: JudgedAuditRecord, verdict: Verdict | undefined, input: Input) => void;
}

/** How many of the rounds asked must pass, with none failing: more than half of all the rounds there are. */
export const passesNeeded = (rounds: number): number => rounds <= 1 ? 1 : Math.ceil(rounds / 2);

export function createJudgedAuditor<Input, Verdict>(
  options: JudgedAuditorOptions<Input, Verdict>,
): JudgedAuditor<Input, Verdict> {
  const fixed = options.judgment;
  const audit = async (input: Input, signal: AbortSignal, judge?: AuditJudge, pre?: PreAskedRound): Promise<Verdict | undefined> => {
    const ask: AuditJudge | undefined = judge ?? (fixed ? (request, abort) => fixed.judge(request, abort) : undefined);
    const settled = ask ? await consensus(options.rounds, input, ask, signal, pre) : { rounds: [], decision: "unavailable" as const, flags: [] };
    const record: JudgedAuditRecord = settled.decision === "fail" && options.modelAudit && options.arbitrated?.(settled.flags) ? { ...settled, decision: "arbitrated" } : settled;
    if (options.shadow) {
      if (record.rounds.length > 0) options.onJudged?.(record, input);
      const verdict = await options.modelAudit?.(input, signal);
      options.shadow(record, verdict, input);
      return verdict;
    }
    if (record.decision === "arbitrated") {
      const verdict = await options.modelAudit!(input, signal);
      const { passes } = options;
      options.onJudged?.(passes ? { ...record, arbitration: verdict === undefined ? "unavailable" : passes(verdict) ? "pass" : "fail" } : record, input);
      return verdict ?? options.failedVerdict(record.flags);
    }
    if (record.rounds.length > 0) options.onJudged?.(record, input);
    if (record.decision === "pass") return options.passedVerdict;
    if (record.decision === "fail") return options.failedVerdict(record.flags);
    return options.modelAudit?.(input, signal);
  };
  return Object.assign(audit, { firstRound: (input: Input) => firstRoundRequest(options.rounds, input) });
}

async function consensus<Input>(
  rounds: readonly JudgmentRound<Input>[], input: Input, ask: AuditJudge, signal: AbortSignal, pre?: PreAskedRound,
): Promise<JudgedAuditRecord> {
  const asked: JudgedAuditRecord["rounds"][number][] = [];
  // What a failure objects to is the deciding round's own flags: a doubt an earlier round raised and a later round
  // answered clearly is settled, not carried into a failure that round did not see.
  const standing = (): string[] => [...(asked.at(-1)?.flags ?? [])];
  const needed = passesNeeded(rounds.length);
  for (const [index, round] of rounds.entries()) {
    const early = index === 0 ? pre?.firstRound : undefined;
    const started = early ? pre?.startedAt ?? performance.now() : performance.now();
    let answers: JudgmentResult | undefined;
    try { answers = await (early ?? ask({ state: round.state(input), questions: round.questions }, signal)); } catch (error) {
      if (signal.aborted) throw error;
    }
    // A round that cannot be had settles nothing; with nothing settled yet, the audit is not the judge's to decide.
    if (!answers || Object.keys(round.questions).some((id) => answers!.answers[id] === undefined)) return { rounds: asked, decision: "unavailable", flags: standing() };
    const read = round.read(answers.answers, input);
    asked.push({ id: round.id, verdict: read.verdict, flags: read.flags, elapsedMs: Math.max(0, Math.round(performance.now() - started)) });
    if (read.verdict === "fail") return { rounds: asked, decision: "fail", flags: standing() };
    const passes = asked.filter((entry) => entry.verdict === "pass").length;
    // The first round passing alone is the common case and ends the audit; after a doubt, most rounds must agree.
    if ((index === 0 && read.verdict === "pass") || passes >= needed) return { rounds: asked, decision: "pass", flags: [] };
    if (passes + (rounds.length - index - 1) < needed) break; // the remaining rounds cannot reach agreement
  }
  // No round failed and too few passed: the last round asked was in doubt, and its doubts are the ones no later round settled.
  return { rounds: asked, decision: "fail", flags: standing() };
}
