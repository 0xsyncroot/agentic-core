import type { ApprovalPresentation } from "../approvals/approval.js";
import type { SecurityContext } from "./security-context.js";

/**
 * A person's standing decision that the calls they would be asked to approve run without asking: "never ask me", set by
 * them, read live on every such call. `revision` names the stored decision, `since` when it was made (ISO 8601).
 *
 * It only ever answers a card. A call the policy refuses (a missing permission, an unverified client) stays refused, a
 * question a tool asks is still asked, and a card already shown is still answered by a click.
 */
export interface StandingApproval {
  readonly revision: string;
  readonly since: string;
}

/** What the journal keeps of a standing decision on the call it allowed: the decision and the card it replaced. */
export interface StandingApprovalRecord extends StandingApproval {
  readonly presentation?: ApprovalPresentation;
}

export interface StandingApprovalQuery {
  readonly security: SecurityContext;
  readonly sessionId: string;
  readonly toolId: string;
}

/**
 * Where the runtime reads a person's standing approval (a product composes it from its own settings). `undefined`: ask.
 *
 * The runtime bounds every read and asks on a late, failing or malformed answer; a source still answers fast and fails
 * closed itself, since a card asked for nothing costs a click and a write run without one cannot be taken back.
 */
export interface StandingApprovalSource {
  current(query: StandingApprovalQuery, signal: AbortSignal): Promise<StandingApproval | undefined>;
}
