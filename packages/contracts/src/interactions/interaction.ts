import type { AgentNarrationEvent, AgentOutputEvent, AgentProgressEvent, AgentReasoningEvent, TurnInterjections } from "../agent/agent.js";
import type { SecurityContext } from "../security/security-context.js";
import type { JsonValue } from "../shared/json.js";

export type HumanInteractionAction = "accept" | "decline" | "cancel";

/**
 * Most suggested answers a free-text question may offer.
 *
 * The validator refuses more, the planning guidance tells the model the number, and the widget
 * lays out exactly that many chips: all three read this one constant (the widget mirrors it).
 */
export const INTERACTION_SUGGESTION_LIMIT = 4;

/**
 * A choice field's keyword for an open list: `"otherAnswer": true` lets the person answer in their
 * own words when none of the choices fits, and those words are the field's value. A list without it
 * is closed — an MCP elicitation's enum, an approval's decision, the runtime's own question — and an
 * answer outside it is refused. The widget offers its "other" choice only on an open list.
 */
export const INTERACTION_OTHER_ANSWER = "otherAnswer";

/**
 * What the user answered, as the user saw it: each question's title beside the chosen answer's
 * title (several choices joined with ", "). Built by the runtime from the request schema so
 * history can show the answer without re-reading the form. It is the user's data, so the event
 * carrying it is classified confidential. At most 12 entries, each value at most 500 characters.
 */
export type HumanInteractionEcho = readonly { readonly label: string; readonly value: string }[];

/**
 * The longest a tool may keep its question open (`ttlMs`). A question that waits on work the person
 * does elsewhere (an hour in another application) outlives the deployment's interaction TTL, but a
 * card left answerable for days resumes a task nobody remembers; longer requests are cut to this.
 */
export const INTERACTION_TTL_CAP_MS = 8 * 60 * 60_000;

/** In-band, non-sensitive input. Secrets and credentials must use an external interaction. */
export interface FormInteractionRequest {
  readonly kind: "form";
  readonly message: string;
  readonly title?: string;
  readonly requestedSchema: JsonValue;
  /** How long this card stays answerable, in ms (≤ INTERACTION_TTL_CAP_MS). Absent: the deployment's interaction TTL. */
  readonly ttlMs?: number;
}

/** Consent to continue an out-of-band flow. The URL is displayed but never fetched by core. */
export interface ExternalInteractionRequest {
  readonly kind: "external";
  readonly message: string;
  readonly title?: string;
  readonly url: string;
  readonly externalId: string;
  /** As FormInteractionRequest.ttlMs. */
  readonly ttlMs?: number;
}

/** How long a requested interaction stays answerable: the tool's own `ttlMs` when it set one (capped), else `fallbackMs`. */
export function interactionTtlMs(request: Pick<HumanInteractionRequest, "ttlMs">, fallbackMs: number): number {
  return request.ttlMs === undefined ? fallbackMs : Math.min(request.ttlMs, INTERACTION_TTL_CAP_MS);
}

export type HumanInteractionRequest = FormInteractionRequest | ExternalInteractionRequest;

/**
 * The `requesterId` of a question the runtime itself asks: no tool raised it, so no call is bound
 * to it. Its `interaction/requested` carries no callId, executionId, toolId, arguments or policy
 * decision, and its challenge names `toolId` "runtime" with an empty `callId`. The answer resumes
 * the same task through the same continuation link a tool's question uses.
 */
export const RUNTIME_REQUESTER_ID = "runtime";

/** Whether a journaled `interaction/requested` payload is a question the runtime asked rather than a tool. */
export function isRuntimeQuestion(payload: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return payload?.requesterId === RUNTIME_REQUESTER_ID && payload.callId === undefined;
}

export interface HumanInteractionBinding {
  readonly interactionId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly toolId: string;
  readonly requesterId: string;
  readonly actionDigest: string;
  readonly policyRevision: string;
  readonly runtimeSnapshotId: string;
  readonly runtimeRouteRevision: string;
  readonly agentProfileId: string;
  readonly grantRevision: string;
  readonly expiresAt: string;
}

/** Safe delivery projection. Opaque continuation state is deliberately absent. */
export type HumanInteractionChallenge = HumanInteractionBinding & HumanInteractionRequest;

export interface ResumeHumanInteractionInput {
  readonly sessionId: string;
  readonly interactionId: string;
  readonly action: HumanInteractionAction;
  readonly content?: JsonValue;
  readonly security: SecurityContext;
  readonly idempotencyKey: string;
  readonly agentProfileId?: string;
  /** What the user said while this resumed turn was running. See {@link TurnInterjections}. */
  readonly interjections?: TurnInterjections;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: AgentProgressEvent) => void;
  readonly onOutput?: (output: AgentOutputEvent) => void;
  readonly onNarration?: (narration: AgentNarrationEvent) => void;
  readonly onReasoning?: (reasoning: AgentReasoningEvent) => void;
}
