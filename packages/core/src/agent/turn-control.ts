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
import { sha256 } from "../hash.js";

export { toolChoiceViolation } from "./choice-violation.js";

const MAX_POLICY_ID_CHARS = 200;
const MAX_POLICY_TEXT_CHARS = 2_000;
const MAX_DISPUTED_VALUES = 8;
const MAX_DISPUTED_VALUE_CHARS = 300;

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

/**
 * The step's directive and the tools it offers. `tools` is the turn's surface, what a policy may name; `offered` is what
 * the turn offers the model (its tool selection), never wider than `tools`. A policy's list is narrowed to `offered`
 * unless the policy forces the choice, which then stands whole: a named tool, or `required` with a list of its own.
 */
/** A directive that changes nothing (every tool offered, the model free to choose, no reads): journaling one a step recorded that the policy had nothing to say. */
export function isDefaultDirective(directive: TurnModelDirective): boolean {
  return directive.allowedToolIds === undefined && (directive.toolChoice === undefined || directive.toolChoice === "auto") &&
    (directive.observations?.length ?? 0) === 0 && !directive.stop;
}

export async function resolveTurnDirective(
  policy: TurnControlPolicy | undefined,
  state: TurnControlState,
  tools: readonly ToolDefinition[],
  signal: AbortSignal,
  services: TurnControlServices = {},
  offered: readonly ToolDefinition[] = tools,
): Promise<EffectiveTurnDirective> {
  if (!policy) return { directive: Object.freeze({}), tools: offered };
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
  const universe = new Set(offered.map((tool) => tool.id));
  const named = typeof choice === "object" && choice !== null;
  const forced = named || (candidate.allowedToolIds !== undefined && choice === "required");
  const selected = choice === "none" ? [] : ids.filter((id) => forced || universe.has(id)).map((id) => available.get(id)!);
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

/**
 * The reads a policy may perform for itself: side-effect-free tools the session carries.
 *
 * A write here would let a composition policy act on the world without the model, the tool
 * policy's approval step, or the user; the directive is refused rather than trimmed, because a
 * policy asking for that is misconfigured, not merely optimistic.
 */
function observationRequests(value: unknown, available: ReadonlyMap<string, ToolDefinition>): readonly TurnObservationRequest[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AgenticError("validation", "Turn-control observations must be an array");
  return value.map((item: unknown): TurnObservationRequest => {
    const request = item as { readonly toolId?: unknown; readonly arguments?: unknown; readonly reason?: unknown } | null;
    const tool = typeof request?.toolId === "string" ? available.get(request.toolId) : undefined;
    if (!tool) throw new AgenticError("validation", "Turn-control observation names a tool the session does not carry");
    if (tool.sideEffect !== "none") throw new AgenticError("validation", `Turn-control observation must be side-effect free: ${tool.id}`);
    if (!request?.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments)) throw new AgenticError("validation", `Turn-control observation arguments must be an object: ${tool.id}`);
    const bound = (item as { readonly bestEffort?: { readonly timeoutMs?: unknown } | null }).bestEffort;
    if (bound !== undefined && (!bound || typeof bound.timeoutMs !== "number" || !Number.isInteger(bound.timeoutMs) || bound.timeoutMs <= 0)) {
      throw new AgenticError("validation", `Turn-control best-effort observation needs a positive integer timeoutMs: ${tool.id}`);
    }
    return Object.freeze({
      toolId: tool.id, arguments: Object.freeze({ ...(request.arguments as Record<string, JsonValue>) }),
      reason: boundedPolicyText(request.reason, "observation reason", true)!,
      ...(bound ? { bestEffort: Object.freeze({ timeoutMs: bound.timeoutMs as number }) } : {}),
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

/** An objection's disputed values (`TurnTerminalDecision` continue `objection`): at most `MAX_DISPUTED_VALUES`, each a bounded non-empty string. */
function disputedValues(objection: unknown): readonly string[] {
  if (objection === undefined) return [];
  const disputed = objection && typeof objection === "object" && !Array.isArray(objection) ? (objection as { readonly disputed?: unknown }).disputed : undefined;
  if (!Array.isArray(disputed) || disputed.length > MAX_DISPUTED_VALUES
    || disputed.some((value) => typeof value !== "string" || !value.trim() || value.length > MAX_DISPUTED_VALUE_CHARS)) {
    throw new AgenticError("validation", "Turn-control objection must list at most 8 disputed values of bounded length");
  }
  return Object.freeze([...disputed as string[]]);
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
    const disputed = disputedValues((candidate as { readonly objection?: unknown }).objection);
    const delivered = (candidate as { readonly delivered?: unknown }).delivered;
    if (delivered !== undefined && delivered !== true) throw new AgenticError("validation", "Turn-control delivered must be true when set");
    return Object.freeze({
      decision: "continue",
      feedback: boundedPolicyText(candidate.feedback, "feedback", true)!,
      ...(fallback ? { fallback } : {}),
      ...(candidate.workRemains ? { workRemains: true } : {}),
      ...(disputed.length ? { objection: Object.freeze({ disputed }) } : {}),
      ...(delivered ? { delivered: true as const } : {}),
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

/** A text's identity as a reader sees it: whitespace runs and Unicode composition do not make two answers different. */
export function normalizedText(content: string): string {
  return content.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** A terminal answer's identity: journaled with an objection to it, and kept in the turn's ledger so the gate can tell the same answer coming back (`workRemainsReview`). */
export function normalizedContentHash(content: string | null): string | undefined {
  const text = content === null ? "" : normalizedText(content);
  return text ? sha256({ content: text }) : undefined;
}

/**
 * `delivered` on a verdict: the work-remains gate decided it from a policy decision that marked the answer delivered
 * (`TurnTerminalDecision` continue `delivered`). Journaled on the row the verdict writes, so a replay of the journal decides as the gate did.
 */
export type TurnOutputReview =
  | {
    readonly kind: "proceed"; readonly terminalDecision?: Extract<TurnTerminalDecision, { readonly decision: "accept" }>;
    readonly delivered?: true;
  }
  | {
    readonly kind: "continue";
    readonly phase: "tool-call" | "terminal" | "choice-violation";
    readonly feedback: string;
    readonly fallback?: string;
    /** One objection was already sent back (`objectionsHeard`): the feedback should now carry the way out too. */
    readonly escalate?: boolean;
    /** The turn's objections are spent, or nothing can buy another step: the fallback stands. */
    readonly exhausted?: boolean;
    /** The policy's "do not stop yet": journaled with the objection, and the gate's rules apply to it (`workRemainsReview`). */
    readonly workRemains?: boolean;
    /** A work-remains objection's disputed values (`TurnTerminalDecision` continue `objection`), for `AnswerMovedCheck`. */
    readonly disputed?: readonly string[];
    readonly delivered?: true;
  }
  // The gate ended the work: a closing step follows.
  | { readonly kind: "close"; readonly feedback: string; readonly reason: string; readonly noticeFollows: boolean; readonly delivered?: true };
