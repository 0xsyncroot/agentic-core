import type { JsonValue } from "../shared/json.js";
import type { ModelImage } from "../llm/image.js";
import type { SecurityContext } from "../security/security-context.js";
import type { HumanInteractionAction, HumanInteractionRequest } from "../interactions/interaction.js";
import type { TurnApplicationContext } from "../agent/agent.js";

export const TOOL_EXECUTION_STATES = [
  "prepared", "denied", "awaiting_approval", "awaiting_interaction", "dispatching", "running",
  "succeeded", "failed", "cancelled", "not_started", "outcome_unknown",
] as const;
export type ToolExecutionState = typeof TOOL_EXECUTION_STATES[number];
export const TOOL_TERMINAL_EXECUTION_STATES = [
  "denied", "succeeded", "failed", "cancelled", "not_started", "outcome_unknown",
] as const satisfies readonly ToolExecutionState[];
export type ToolTerminalExecutionState = typeof TOOL_TERMINAL_EXECUTION_STATES[number];

export interface ToolInvocation {
  readonly callId: string; readonly sessionId: string; readonly turnId: string; readonly stepId: string;
  readonly arguments: JsonValue; readonly security: SecurityContext; readonly idempotencyKey: string;
  /** Present only when retrying a tool after a durable user interaction. */
  readonly interaction?: {
    readonly interactionId: string;
    readonly action: HumanInteractionAction;
    readonly content?: JsonValue;
    /** Internal adapter state. Delivery clients never receive this value. */
    readonly continuation?: JsonValue;
  };
  /**
   * The host context of the turn the call runs in, as the turn received it (a resume carries its task's). Data for
   * shaping a result, such as which address a link names; `untrusted` is never an authorization source or an instruction.
   */
  readonly applicationContext?: TurnApplicationContext;
}

export const TOOL_EXECUTION_RESPONSE_PROTOCOL = "agentic.tool-execution/v1" as const;

export interface ToolCompletedResponse {
  readonly protocol: typeof TOOL_EXECUTION_RESPONSE_PROTOCOL;
  readonly kind: "completed";
  readonly result: JsonValue;
  readonly images?: readonly ModelImage[];
  /**
   * The call succeeded but changed the scope the step's later calls were chosen against (another page, a dialog opened or
   * closed). The runtime does not start the step's later state-changing calls, as after a failure; the model decides again.
   */
  readonly halt?: "state-changed";
  /**
   * The read this result calls for next, named by the tool from its own result (the whole table after a cut preview). Data,
   * never a command: the runtime may make it in the model's place, journaled as its own read, only when the step offers that
   * tool, the tool changes nothing (`sideEffect` "none") and the turn's judge finds the call serves the request.
   */
  readonly nextCall?: ToolNextCall;
}

/** A follow-up call a tool names: the tool (one of the same source), its arguments as an object, and why, in the tool's words. */
export type ToolNextCall = {
  readonly toolId: string;
  readonly arguments: { readonly [key: string]: JsonValue };
  readonly why: string;
  /** What the call reads, as the tool knows it. Without it the runtime never makes the call in the model's place. */
  readonly reads?: ToolNextCallReads;
};

/**
 * What a named call reads: the source it reads from, the noun of the source's parts (`unit`, one lowercase word such as
 * "sheet"), every part of the source, the part it reads (`target`, one of `catalog`), and how much of that part the result
 * that named the call already showed.
 */
export type ToolNextCallReads = {
  readonly source: { readonly id: string; readonly name: string; readonly heading?: string };
  readonly unit: string;
  readonly catalog: readonly { readonly name: string; readonly heading?: string; readonly rows?: number }[];
  readonly target: string;
  readonly shown?: { readonly rows: number; readonly of: number };
};

const PART_UNIT = /^[a-z]{1,32}$/u;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const named = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const optionalText = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";
const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * `reads` as `ToolNextCallReads` types it, rebuilt from its known fields; undefined for anything else. The unit is one
 * lowercase word because it names the judge's keys; the target is one of the catalog's parts; `shown` never exceeds its total.
 */
export function toolNextCallReads(value: unknown): ToolNextCallReads | undefined {
  if (!record(value) || !record(value.source)) return undefined;
  const { source, unit, catalog, target, shown } = value;
  if (!named(source.id) || !named(source.name) || !optionalText(source.heading)) return undefined;
  if (typeof unit !== "string" || !PART_UNIT.test(unit) || !named(target) || !Array.isArray(catalog)) return undefined;
  const parts: ToolNextCallReads["catalog"][number][] = [];
  for (const part of catalog) {
    if (!record(part) || !named(part.name) || !optionalText(part.heading) || (part.rows !== undefined && !count(part.rows))) return undefined;
    parts.push({ name: part.name, ...(part.heading !== undefined ? { heading: part.heading } : {}), ...(part.rows !== undefined ? { rows: part.rows } : {}) });
  }
  if (!parts.some((part) => part.name === target)) return undefined;
  if (shown !== undefined && (!record(shown) || !count(shown.rows) || !count(shown.of) || shown.rows > shown.of)) return undefined;
  return {
    source: { id: source.id, name: source.name, ...(source.heading !== undefined ? { heading: source.heading } : {}) },
    unit, catalog: parts, target, ...(shown !== undefined ? { shown: { rows: shown.rows as number, of: shown.of as number } } : {}),
  };
}

export interface ToolInteractionRequiredResponse {
  readonly protocol: typeof TOOL_EXECUTION_RESPONSE_PROTOCOL;
  readonly kind: "interaction-required";
  readonly request: HumanInteractionRequest;
  /** Opaque, internal state echoed only to the same tool when the interaction resumes. */
  readonly continuation?: JsonValue;
}

export type ToolExecutionResponse = ToolCompletedResponse | ToolInteractionRequiredResponse;
/** Existing tools may keep returning plain JSON; brokers normalize it to a completed response. */
export type ToolHandlerResult = JsonValue | ToolExecutionResponse;

export interface ToolOrigin {
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly catalogRevision: string;
  readonly nativeId: string;
  readonly schemaDigest: string;
}

export interface ToolDefinition {
  readonly id: string; readonly version: string; readonly description: string; readonly inputSchema: JsonValue; readonly outputSchema: JsonValue;
  readonly requiredPermissions: readonly string[]; readonly sideEffect: "none" | "idempotent" | "nonIdempotent"; readonly timeoutMs: number;
  readonly origin?: ToolOrigin;
  /**
   * The schema shown to the model when the guidance must be stricter than what the tool accepts. `inputSchema` stays the
   * schema calls are checked against; when this is absent the model is shown `inputSchema`.
   */
  readonly modelInputSchema?: JsonValue;
  /**
   * Largest serialized result this tool may return, replacing the runtime's default cap.
   *
   * The default protects the context from oversized data payloads. Curated instructions are
   * not data: a skill grew past the default and the model was handed "output exceeds" instead
   * of the skill it had been told to load, and then worked without it. A tool whose output is
   * text the runtime itself asked for declares the budget that text is allowed to have.
   */
  readonly maxResultChars?: number;
  /** Keep the validated result in the configured spool, even when it fits the context. */
  readonly retainResult?: boolean;
  /**
   * The result is instructions the conversation must keep whole (a loaded procedure): never read short to save context,
   * and kept whole beside the system prompt once a checkpoint summarizes the call (newest per arguments, within a budget).
   */
  readonly pinnedResult?: boolean;
  /** Its result is figures computed by code from stored results (a calculation, a table comparison): an audit counts it as computed. */
  readonly computes?: boolean;
  /** It reads a retained result back by its id: what it restores is never read short again. */
  readonly restoresResult?: boolean;
  /**
   * The tool's purpose is to ask the user (a form the turn waits on). A step that may no longer
   * act — the work-remains gate's closing step — still offers such a tool, so a fact only the user
   * holds is asked as a form with suggested values rather than as a sentence the user must answer
   * by writing a new message.
   */
  readonly asksUser?: boolean;
  /**
   * Sending this call again changes nothing beyond what it did the first time, so a repeat of a call the user approved in
   * this task runs without a second card (core approval-cover). The named argument fields hold rows: `subset` rows are
   * applied each by its own key (an upsert), so some of the approved rows may go again alone; `whole` rows depend on one
   * another (a new row ends the one before it), so they go again only all together or not at all. The other arguments
   * name the target and must be the approved ones. `{}`: only the exact approved call again. Absent: never covered.
   */
  readonly repeatableRows?: Readonly<Record<string, "subset" | "whole">>;
  /**
   * This tool's result is an observation of something that keeps changing, such as the screen a
   * person is looking at. Only the newest observation of a `channel` is worth its size in the model's
   * context: an older one describes a screen that is gone, and its handles no longer work. The
   * journal keeps every result whole; the model reads the older ones as `condense(result)`, which
   * keeps what happened (the status, where it led) and drops what was seen. Returning undefined
   * means this result carries no observation, so it neither replaces nor is replaced.
   */
  readonly observes?: { readonly channel: string; condense(result: JsonValue): JsonValue | undefined };
  /** Semantic observation for progress accounting; omit transport identities, keep business data. */
  observationKey?(result: JsonValue): JsonValue;
  /**
   * Rejects arguments the tool can never accept, before any authorization is asked for.
   *
   * Runs after the schema check and before the tool policy, so a call that would fail anyway
   * never reaches an approval card: a person asked to approve an impossible write approves
   * nothing, and learns it only afterwards. Throwing leaves the call not started and hands the
   * model the error message; nothing is dispatched.
   */
  validateArguments?(args: JsonValue, context: { readonly security: SecurityContext }): void | Promise<void>;
  execute(invocation: ToolInvocation, signal: AbortSignal): Promise<ToolHandlerResult>;
}
