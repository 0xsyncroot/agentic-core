import type { TurnControlServices, TurnControlState } from "@0xsyncroot/contracts";
import type { GoalAuditInput, GoalAuditor } from "./completion-audit.js";
import type { PreAskedRound } from "./judged-auditor.js";
import { procedureApplicabilityRequests, type ProcedurePreAsked } from "./procedure-audit.js";

/**
 * Whether the first round may be asked beside the ending. A review whose ending sends the answer back never reads the
 * rounds, and a round-1 row it left in the journal would still be read later: `goalAuditInput` takes any `derivedFigure`
 * above the bound as "this figure was already sent back to be recomputed" (`computedFigureChecked`), so the once-only
 * send-back would be spent by a review that did not send it. The row cannot change a later reading when the rule it feeds
 * never fires: a figure worked out by hand fails every round (`calculationPending`), a computing tool already ran
 * (`computedByTool`), or the figure was already sent back (`computedFigureChecked`). Otherwise round 1 waits for the ending.
 */
export const firstRoundSafeEarly = (audited: GoalAuditInput): boolean =>
  audited.calculationPending === true || audited.computedByTool === true || audited.computedFigureChecked === true;

/** The judgments of one terminal review that do not depend on its ending, asked together with it, and the way to cancel what the review did not read. */
export interface TerminalWave {
  /** Pass to the auditor: its first round, when `firstRoundSafeEarly` and the auditor can be asked ahead. */
  readonly rounds: PreAskedRound;
  /** Pass to `procedureVerdict`: the applicability of each loaded procedure. Its criteria are never asked early. */
  readonly procedure: ProcedurePreAsked;
  /** The review is over, whatever it returned or threw: calls it did not read are cancelled, so they hold no gateway capacity. */
  release(): void;
}

export interface TerminalWaveInput {
  readonly state: TurnControlState;
  readonly audited: GoalAuditInput;
  readonly judge: TurnControlServices["judge"];
  readonly signal: AbortSignal;
  /** The auditor the rounds go to: `firstRound` says what its first round asks (absent: it cannot be asked ahead). */
  readonly auditor: Pick<GoalAuditor, "firstRound">;
  readonly procedureMode: "shadow" | "on" | undefined;
}

/**
 * Starts, beside the ending the caller has just started, the judgments of the review that do not wait for it: the first
 * round and each procedure's applicability. The review then reads them in its old order with its old reading functions, so
 * its decisions are the sequential ones; only the waiting overlaps. A rejection is kept raw for the reader (a turn that was
 * cancelled must reject the review, not read as "no verdict" and reach the model audit); the side branch here only keeps an
 * unread one from being an unhandled rejection.
 */
export function startTerminalWave(input: TerminalWaveInput): TerminalWave {
  const { state, audited, judge, signal, auditor, procedureMode } = input;
  if (!judge) return { rounds: {}, procedure: {}, release: () => undefined };
  const reviewDone = new AbortController();
  const early = AbortSignal.any([signal, reviewDone.signal]);
  const ask = (seam: string, request: Parameters<typeof judge>[1]) => {
    const call = (async () => judge(seam, request, early))();
    call.catch(() => undefined);
    return call;
  };
  const startedAt = performance.now();
  const firstRound = firstRoundSafeEarly(audited) && auditor.firstRound ? ask("completion-audit", auditor.firstRound(audited)) : undefined;
  const applicability = new Map(procedureApplicabilityRequests(state, audited, procedureMode).map(({ skillId, request }) => [skillId, ask("procedure-audit", request)] as const));
  return {
    rounds: firstRound ? { firstRound, startedAt } : {}, procedure: applicability.size ? { applicability } : {},
    release: () => reviewDone.abort(),
  };
}
