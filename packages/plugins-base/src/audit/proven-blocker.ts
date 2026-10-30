import type { TurnTerminalDecision } from "@0xsyncroot/contracts";
import type { GoalAuditVerdict } from "./completion-audit.js";

/**
 * An answer whose blocker the journal settles — the ending judge reads a clear "blocked", and the task's journal holds a
 * denial nothing has gone past, a capability missing this turn, or the same report twice before (`blockerFinal`; failed
 * calls counted over every target only stop the "unproven blocker" objection). Such an answer is the task's partial end
 * once what it states holds; the completion rounds would otherwise read a proven blocker as "not delivered" and loop.
 */

/**
 * The reason such an answer is accepted with. Not the work-remains gate's (`work-remains-…`), so core puts no "continue?"
 * card under it: there is nothing a further lap could do.
 */
export const BLOCKER_PROVEN_REASON = "blocker-proven";

/** What the rounds read off a proven blocker itself: the request is not delivered, and what was not reached was not looked at. */
const BLOCKER_CONSEQUENCES: ReadonlySet<string> = new Set(["notDelivered", "unsupportedAbsence"]);

/**
 * What the rounds still object to in an answer whose blocker the journal proves. A figure the evidence contradicts, or one
 * added up by hand, is wrong whatever stopped the rest of the work, and goes back as before: accuracy comes first.
 * The model audit's verdict carries text, not flags: what it finds missing is the blocker; what it finds
 * unsupported is not. `failedVerdict` turns the flags left into the caller's verdict. Undefined: nothing beside the blocker.
 */
export function besideTheBlocker(verdict: GoalAuditVerdict | undefined, failedVerdict: (flags: readonly string[]) => GoalAuditVerdict): GoalAuditVerdict | undefined {
  if (!verdict || (verdict.achieved && verdict.unsupported.length === 0)) return undefined;
  if (verdict.flags) {
    const left = verdict.flags.filter((flag) => !BLOCKER_CONSEQUENCES.has(flag));
    return left.length ? failedVerdict(left) : undefined;
  }
  return verdict.unsupported.length ? { achieved: false, missing: [], unsupported: verdict.unsupported } : undefined;
}

/**
 * The answer accepted as the task's partial end. Only the product's own notice goes under it: what failed is the runtime's
 * to know (tool names and arguments), not the user's to read.
 */
export function blockerAccepted(notice?: string): TurnTerminalDecision {
  return { decision: "accept", outcome: "partial", reason: BLOCKER_PROVEN_REASON, ...(notice ? { notice } : {}) };
}
