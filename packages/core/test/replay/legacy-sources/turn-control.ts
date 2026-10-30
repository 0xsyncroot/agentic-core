import {
  AgenticError,
  type EventDraft,
  type JsonValue,
  type LlmToolChoice,
  type ToolDefinition,
  type TurnControlPolicy,
  type TurnControlServices,
  type TurnControlState,
  type TurnModelDirective,
  type TurnObservationRequest,
  type TurnTerminalDecision,
} from "@0xsyncroot/contracts";
import { sha256 } from "../../../src/hash.js";

export { toolChoiceViolation } from "./choice-violation.js";

const MAX_POLICY_ID_CHARS = 200;
const MAX_POLICY_TEXT_CHARS = 2_000;

export interface EffectiveTurnDirective {
  readonly directive: TurnModelDirective;
  readonly tools: readonly ToolDefinition[];
}

export function validateTurnControlPolicy(policy: TurnControlPolicy): void {
  for (const [label, value] of [["id", policy.id], ["revision", policy.revision]] as const) {
    if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > MAX_POLICY_ID_CHARS) {
      throw new AgenticError("validation", `Turn-control policy ${label} must be a non-empty bounded string`);
    }
  }
  if (policy.keepDraftsAsNarration !== undefined && typeof policy.keepDraftsAsNarration !== "boolean") {
    throw new AgenticError("validation", "Turn-control policy keepDraftsAsNarration must be a boolean");
  }
}

function toolChoice(value: unknown): LlmToolChoice | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "required" || value === "none") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgenticError("validation", "Turn-control tool choice is invalid");
  }
  const entries = Object.entries(value);
  if (entries.length !== 1 || entries[0]?.[0] !== "name" || typeof entries[0][1] !== "string" || !entries[0][1]) {
    throw new AgenticError("validation", "Named turn-control tool choice must contain exactly one non-empty name");
  }
  return Object.freeze({ name: entries[0][1] });
}

export async function resolveTurnDirective(
  policy: TurnControlPolicy | undefined,
  state: TurnControlState,
  tools: readonly ToolDefinition[],
  signal: AbortSignal,
  services: TurnControlServices = {},
): Promise<EffectiveTurnDirective> {
  if (!policy) return { directive: Object.freeze({}), tools };
  validateTurnControlPolicy(policy);
  const candidate = await policy.beforeModelStep(state, signal, services);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new AgenticError("validation", "Turn-control policy returned an invalid model directive");
  }
  if (candidate.stop !== undefined) {
    if (!candidate.stop || typeof candidate.stop !== "object" || Array.isArray(candidate.stop)) {
      throw new AgenticError("validation", "Turn-control stop must contain a reason and content");
    }
    if ((candidate.observations?.length ?? 0) > 0) throw new AgenticError("validation", "Turn-control stop cannot dispatch observations");
    const stop = Object.freeze({ reason: boundedPolicyText(candidate.stop.reason, "stop reason", true)!,
      content: boundedPolicyText(candidate.stop.content, "stop content", true)! });
    return Object.freeze({ directive: Object.freeze({ stop, allowedToolIds: Object.freeze([]), toolChoice: "none" }), tools: Object.freeze([]) });
  }
  if (candidate.allowedToolIds !== undefined && !Array.isArray(candidate.allowedToolIds)) {
    throw new AgenticError("validation", "Turn-control allowedToolIds must be an array");
  }
  const available = new Map(tools.map((tool) => [tool.id, tool]));
  const ids = candidate.allowedToolIds === undefined ? tools.map((tool) => tool.id) : [...candidate.allowedToolIds];
  if (ids.some((id) => typeof id !== "string" || !id || !available.has(id)) || new Set(ids).size !== ids.length) {
    throw new AgenticError("validation", "Turn-control policy selected an unavailable or duplicate tool");
  }
  const choice = toolChoice(candidate.toolChoice);
  const selected = choice === "none" ? [] : ids.map((id) => available.get(id)!);
  if (choice === "required" && selected.length === 0) {
    throw new AgenticError("validation", "Required tool choice needs at least one selected tool");
  }
  if (choice && typeof choice === "object" && !selected.some((tool) => tool.id === choice.name)) {
    throw new AgenticError("validation", `Named tool choice is not selected: ${choice.name}`);
  }
  const observations = observationRequests(candidate.observations, available);
  const directive: TurnModelDirective = Object.freeze({
    ...(candidate.allowedToolIds === undefined ? {} : { allowedToolIds: Object.freeze(ids) }),
    ...(choice === undefined ? {} : { toolChoice: choice }),
    ...(observations.length === 0 ? {} : { observations }),
  });
  return Object.freeze({ directive, tools: Object.freeze(selected) });
}

function observationRequests(value: unknown, available: ReadonlyMap<string, ToolDefinition>): readonly TurnObservationRequest[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AgenticError("validation", "Turn-control observations must be an array");
  return value.map((item: unknown): TurnObservationRequest => {
    const request = item as { readonly toolId?: unknown; readonly arguments?: unknown; readonly reason?: unknown } | null;
    const tool = typeof request?.toolId === "string" ? available.get(request.toolId) : undefined;
    if (!tool) throw new AgenticError("validation", "Turn-control observation names a tool the session does not carry");
    if (tool.sideEffect !== "none") throw new AgenticError("validation", `Turn-control observation must be side-effect free: ${tool.id}`);
    if (!request?.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments)) throw new AgenticError("validation", `Turn-control observation arguments must be an object: ${tool.id}`);
    return Object.freeze({
      toolId: tool.id, arguments: Object.freeze({ ...(request.arguments as Record<string, JsonValue>) }),
      reason: boundedPolicyText(request.reason, "observation reason", true)!,
    });
  });
}

function boundedPolicyText(value: unknown, label: string, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > MAX_POLICY_TEXT_CHARS) {
    throw new AgenticError("validation", `Turn-control ${label} must be a non-empty bounded string`);
  }
  return value;
}

export function validateTerminalDecision(value: unknown): TurnTerminalDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgenticError("validation", "Turn-control policy returned an invalid terminal decision");
  }
  const candidate = value as { readonly decision?: unknown; readonly reason?: unknown; readonly feedback?: unknown; readonly fallback?: unknown; readonly workRemains?: unknown };
  if (candidate.decision === "accept") {
    const reason = boundedPolicyText(candidate.reason, "accept reason", false);
    const outcome = (candidate as { readonly outcome?: unknown }).outcome;
    if (outcome !== undefined && outcome !== "completed" && outcome !== "partial") {
      throw new AgenticError("validation", "Turn-control accepted outcome must be completed or partial");
    }
    const notice = boundedPolicyText((candidate as { readonly notice?: unknown }).notice, "accept notice", false);
    return Object.freeze({ decision: "accept", ...(reason ? { reason } : {}), ...(outcome ? { outcome } : {}), ...(notice ? { notice } : {}) });
  }
  if (candidate.decision === "continue") {
    const fallback = boundedPolicyText(candidate.fallback, "fallback", false);
    if (candidate.workRemains !== undefined && typeof candidate.workRemains !== "boolean") {
      throw new AgenticError("validation", "Turn-control workRemains must be a boolean");
    }
    return Object.freeze({
      decision: "continue",
      feedback: boundedPolicyText(candidate.feedback, "feedback", true)!,
      ...(fallback ? { fallback } : {}),
      ...(candidate.workRemains ? { workRemains: true } : {}),
    });
  }
  throw new AgenticError("validation", "Turn-control terminal decision must be accept or continue");
}

export function turnControlDecisionDraft(
  policy: TurnControlPolicy,
  turnId: string,
  stepId: string,
  phase: "before-model" | "tool-call" | "terminal" | "choice-violation",
  decision: string,
  details: Readonly<Record<string, JsonValue>> = {},
): EventDraft {
  return {
    type: "turn/control-decision", turnId, stepId, classification: "confidential",
    payload: { policyId: policy.id, policyRevision: policy.revision, phase, decision, ...details },
  };
}

export function terminalCandidateHash(candidate: {
  readonly content: string | null; readonly finishReason: string; readonly status?: string; readonly toolCalls: readonly unknown[];
}): string {
  return sha256({ content: candidate.content, finishReason: candidate.finishReason,
    status: candidate.status ?? null, toolCalls: candidate.toolCalls });
}

export function normalizedText(content: string): string {
  return content.normalize("NFC").replace(/\s+/gu, " ").trim();
}

export function normalizedContentHash(content: string | null): string | undefined {
  const text = content === null ? "" : normalizedText(content);
  return text ? sha256({ content: text }) : undefined;
}

export type TurnOutputReview =
  | { readonly kind: "proceed"; readonly terminalDecision?: Extract<TurnTerminalDecision, { readonly decision: "accept" }> }
  | {
    readonly kind: "continue";
    readonly phase: "tool-call" | "terminal" | "choice-violation";
    readonly feedback: string;
    readonly fallback?: string;
    readonly escalate?: boolean;
    readonly deduplicated?: boolean;
    readonly workRemains?: boolean;
  }
  | { readonly kind: "close"; readonly feedback: string; readonly reason: string; readonly noticeFollows: boolean };
