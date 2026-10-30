import type { SecurityContext, StandingApproval, StandingApprovalSource, ToolDefinition, ToolPolicyDecision } from "@0xsyncroot/contracts";
import { sha256 } from "../hash.js";

/**
 * How long one read of a standing approval may take before the card is asked instead. A source bounds its own reads more
 * tightly (it knows its store); this is the runtime's backstop for one that does not, so a slow settings store can delay a
 * write by a second at most and never hold the turn.
 */
export const STANDING_APPROVAL_LOOKUP_MS = 1_000;

/** The actor's standing approval for a call the policy would ask about (turn-setup binds it to the turn); undefined: ask. */
export type StandingApprovalLookup = (tool: ToolDefinition, decision: ToolPolicyDecision) => Promise<StandingApproval | undefined>;

function valid(answer: StandingApproval | undefined): StandingApproval | undefined {
  if (!answer || typeof answer !== "object") return undefined;
  const { revision, since } = answer;
  if (typeof revision !== "string" || !revision.trim() || revision.length > 64) return undefined;
  if (typeof since !== "string" || !Number.isFinite(Date.parse(since))) return undefined;
  return Object.freeze({ revision, since });
}

/**
 * Reads the source live for each call, bounded by `timeoutMs` and the turn's own signal. Whatever goes wrong (the source
 * throws, answers late or malformed, the turn stops) is an ask: the card costs a click, a write run unasked cannot be undone.
 */
export function standingApprovalLookup(
  source: StandingApprovalSource,
  scope: { readonly security: SecurityContext; readonly sessionId: string },
  signal: AbortSignal,
  timeoutMs = STANDING_APPROVAL_LOOKUP_MS,
): StandingApprovalLookup {
  return async (tool) => {
    if (signal.aborted) return undefined;
    // A timer of its own, not AbortSignal.timeout: that one is unref'd, and a read that never settles must still end.
    const late = new AbortController();
    const timer = setTimeout(() => late.abort(new Error("Standing approval lookup timed out")), timeoutMs);
    const bound = AbortSignal.any([signal, late.signal]);
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<undefined>((resolve) => { onAbort = () => resolve(undefined); bound.addEventListener("abort", onAbort, { once: true }); });
    try {
      const reading = Promise.resolve().then(() => source.current({ ...scope, toolId: tool.id }, bound));
      reading.catch(() => undefined);
      return valid(await Promise.race([reading, stopped]));
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
      if (onAbort) bound.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * The decision the coordinator acts on once the cover had its say: the card the policy asked for, allowed by the actor's
 * standing approval when there is one. The digest and revision the card bound are kept, and the card itself is kept in the
 * record, so the journal shows exactly what ran unasked. A `standingApproval` a policy set is dropped: only the core says so.
 * A card the policy marked `standable: false` (an action that cannot be undone) is never answered here, whatever is passed.
 */
export function settleStanding(decision: ToolPolicyDecision, standing: StandingApproval | undefined): ToolPolicyDecision {
  const { standingApproval: claimed, approvalPresentation: presentation, ...rest } = decision;
  if (!standing || decision.outcome !== "require_approval" || decision.standable === false) {
    return claimed === undefined ? decision : Object.freeze({ ...rest, ...(presentation ? { approvalPresentation: presentation } : {}) });
  }
  return Object.freeze({
    ...rest,
    decisionId: `standing-${sha256({ decisionId: decision.decisionId, revision: standing.revision }).slice(0, 24)}`,
    outcome: "allow",
    reason: `Allowed by the actor's standing approval ${standing.revision} (since ${standing.since})`,
    standingApproval: Object.freeze({ revision: standing.revision, since: standing.since, ...(presentation ? { presentation } : {}) }),
  });
}
