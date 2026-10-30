import type {
  AgentNarrationEvent,
  AgentOutputEvent,
  AgentProgressEvent,
  AgentReasoningEvent,
  JsonValue,
  ResumableAgent,
  RunTurnResult,
  SecurityContext,
  TurnInterjections,
} from "@0xsyncroot/contracts";
import { AgenticError } from "@0xsyncroot/contracts";
import type { IncomingMessage } from "node:http";
import { readJsonBody } from "./request-body.js";

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

interface InteractionBody {
  readonly kind?: unknown;
  readonly sessionId?: unknown;
  readonly requestId?: unknown;
  readonly decision?: unknown;
  readonly action?: unknown;
  readonly content?: unknown;
  readonly agentProfileId?: unknown;
}

export interface ApprovalInteractionInput {
  readonly kind: "approval";
  readonly sessionId: string;
  readonly requestId: string;
  readonly decision: "approve" | "deny";
  readonly agentProfileId?: string;
}

export interface HumanInteractionInput {
  readonly kind: "form" | "external";
  readonly sessionId: string;
  readonly requestId: string;
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: JsonValue;
  readonly agentProfileId?: string;
}

export type PublicInteractionInput = ApprovalInteractionInput | HumanInteractionInput;

export interface PublicInteractionCallbacks {
  readonly signal?: AbortSignal;
  /** What the user said while this resumed turn was running. */
  readonly interjections?: TurnInterjections;
  readonly onProgress?: (event: AgentProgressEvent) => void;
  readonly onOutput?: (event: AgentOutputEvent) => void;
  readonly onNarration?: (event: AgentNarrationEvent) => void;
  readonly onReasoning?: (event: AgentReasoningEvent) => void;
}

export function readInteractionInput(request: IncomingMessage, fixedKind: "approval"): Promise<ApprovalInteractionInput>;
export function readInteractionInput(request: IncomingMessage): Promise<PublicInteractionInput>;
export async function readInteractionInput(
  request: IncomingMessage,
  fixedKind?: "approval",
): Promise<PublicInteractionInput> {
  const input = await readJsonBody<InteractionBody>(request);
  const kind = fixedKind ?? input.kind;
  if (kind !== "approval" && kind !== "form" && kind !== "external") {
    throw new AgenticError("validation", "interaction kind must be approval, form or external");
  }
  if (typeof input.sessionId !== "string" || !IDENTIFIER_PATTERN.test(input.sessionId)) {
    throw new AgenticError("validation", "sessionId is invalid");
  }
  if (typeof input.requestId !== "string" || !IDENTIFIER_PATTERN.test(input.requestId)) {
    throw new AgenticError("validation", "requestId is invalid");
  }
  if (input.agentProfileId !== undefined &&
      (typeof input.agentProfileId !== "string" || !IDENTIFIER_PATTERN.test(input.agentProfileId))) {
    throw new AgenticError("validation", "agentProfileId is invalid");
  }
  const common = {
    sessionId: input.sessionId, requestId: input.requestId,
    ...(typeof input.agentProfileId === "string" ? { agentProfileId: input.agentProfileId } : {}),
  };
  if (kind === "approval") {
    if (input.decision !== "approve" && input.decision !== "deny") throw new AgenticError("validation", "decision must be approve or deny");
    return { kind, ...common, decision: input.decision };
  }
  if (input.action !== "accept" && input.action !== "decline" && input.action !== "cancel") {
    throw new AgenticError("validation", "action must be accept, decline or cancel");
  }
  return { kind, ...common, action: input.action, ...(input.content === undefined ? {} : { content: input.content as JsonValue }) };
}

/** Delivery-layer dispatcher. The core remains the authority for durable challenge validation. */
export function resolveInteraction(
  agent: ResumableAgent,
  security: SecurityContext,
  interactionId: string,
  input: PublicInteractionInput,
  callbacks: PublicInteractionCallbacks = {},
): Promise<RunTurnResult> {
  if (!IDENTIFIER_PATTERN.test(interactionId)) throw new AgenticError("validation", "interactionId is invalid");
  if (input.kind === "approval") return agent.resumeTurn({
    sessionId: input.sessionId,
    approvalId: interactionId,
    decision: input.decision,
    idempotencyKey: input.requestId,
    security,
    ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}),
    ...callbacks,
  });
  return agent.resumeInteraction({
    sessionId: input.sessionId, interactionId, action: input.action,
    ...(input.content === undefined ? {} : { content: input.content }),
    idempotencyKey: input.requestId, security,
    ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}), ...callbacks,
  });
}
