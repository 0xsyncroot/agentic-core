import type { RuntimeSnapshot } from "../runtime/runtime-snapshot.js";
import type { JsonValue } from "../shared/json.js";
import type { ToolDefinition } from "../tools/tool.js";
import type { SecurityContext } from "./security-context.js";
import type { HumanInteractionAction } from "../interactions/interaction.js";
import type { ApprovalPresentation } from "../approvals/approval.js";
import type { StandingApprovalRecord } from "./standing-approval.js";

export type ToolPolicyOutcome = "allow" | "deny" | "require_approval";

export interface ToolPolicyDecision {
  readonly decisionId: string;
  readonly outcome: ToolPolicyOutcome;
  readonly policyRevision: string;
  readonly reason: string;
  readonly actionDigest: string;
  /** Optional trusted policy override for the delivery-safe approval explanation. */
  readonly approvalPresentation?: ApprovalPresentation;
  /** The approval given earlier in the task that this call stays within, so it ran without a card of its own (core approval-cover). */
  readonly coveredBy?: string;
  /** `false`: this card is asked whatever was approved before — a policy's veto on core approval-cover. */
  readonly coverable?: false;
  /**
   * `false`: this card is asked even under the actor's standing approval — the policy's mark for an action that cannot be
   * undone. Core never lets a standing approval answer it; only a click on the card does.
   */
  readonly standable?: false;
  /** The actor's standing approval this call ran under instead of the card the policy asked for (core sets it, never a policy). */
  readonly standingApproval?: StandingApprovalRecord;
}

export interface ToolDiscoveryContext {
  readonly security: SecurityContext;
  readonly runtime: RuntimeSnapshot;
}

/** User-supplied action data that can change the policy meaning of a resumed call. */
export interface ToolAuthorizationInteraction {
  readonly action: HumanInteractionAction;
  readonly content?: JsonValue;
  /** Binds opaque adapter state without exposing it to a remote policy service. */
  readonly continuationDigest: string;
}

export interface ToolAuthorizationInput extends ToolDiscoveryContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly executionId: string;
  readonly tool: ToolDefinition;
  readonly arguments: JsonValue;
  readonly interaction?: ToolAuthorizationInteraction;
}

/** Policy enforcement point used both before model exposure and immediately before dispatch. */
export interface ToolExecutionPolicy {
  discover(tools: readonly ToolDefinition[], context: ToolDiscoveryContext): Promise<readonly ToolDefinition[]>;
  authorize(input: ToolAuthorizationInput): Promise<ToolPolicyDecision>;
  /**
   * `false`: no principal and no turn is ever offered this tool; the harness removes it at discovery. Read at startup, which
   * has no principal, to size the system prompt for the tools some turn can offer. Absent: `true`. A wrapper forwards its
   * upstream's answer; one that does not is counted as offering every tool.
   */
  offersInSomeTurn?(tool: ToolDefinition): boolean;
}
