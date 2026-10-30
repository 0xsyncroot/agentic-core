import { canonicalJson, type JsonValue, type SessionEvent, type ToolDefinition, type ToolPolicyDecision } from "@0xsyncroot/contracts";
import { sha256 } from "../hash.js";

/** Calls one approval may cover after its own: a retry of what did not go through, not a loop that never asks again. */
export const MAX_COVERED_REPEATS = 1;
/** How long after the user approved a call a repeat of it still counts as what they approved. */
export const APPROVAL_COVER_TTL_MS = 15 * 60_000;

/** What the approval bound and the call about to be asked for must share (the resume binding, continuation-binding.ts). */
export interface CoverBinding {
  readonly actorId: string; readonly grantRevision: string; readonly agentProfileId: string;
  readonly runtimeSnapshotId: string; readonly runtimeRouteRevision: string; readonly policyRevision: string;
}

/** The new call, as the cover compares it with the approved one. */
export interface CoverCandidate {
  readonly toolId: string;
  readonly rows: Readonly<Record<string, "subset" | "whole">>;
  readonly arguments: JsonValue;
  /** The decision's digest: an exact repeat is the same digest, card included. */
  readonly actionDigest: string;
  readonly binding: CoverBinding;
}

export interface ApprovalCover {
  readonly approvalId: string;
  /** `repeat`: the approved call again, digest for digest; `rows`: some of its rows and nothing else. */
  readonly kind: "repeat" | "rows";
}

/** Finds the approval a new call of `tool` stays within (turn-setup binds it to the task's journal); undefined: ask. */
export type ApprovalCoverLookup = (tool: ToolDefinition, args: JsonValue, decision: ToolPolicyDecision) => Promise<ApprovalCover | undefined>;

/**
 * The decision the coordinator acts on: the card the policy asked for, answered by the approval the call stays within, when
 * there is one; otherwise the policy's own, less any `coveredBy` it set (only the core says what an approval covers).
 */
export function settleCover(decision: ToolPolicyDecision, cover: ApprovalCover | undefined): ToolPolicyDecision {
  const { approvalPresentation: _shown, coveredBy: _claimed, ...rest } = decision;
  if (!cover) return decision.coveredBy === undefined ? decision : Object.freeze({ ...rest, ...(_shown ? { approvalPresentation: _shown } : {}) });
  return Object.freeze({
    ...rest,
    decisionId: `cover-${sha256({ decisionId: decision.decisionId, approvalId: cover.approvalId }).slice(0, 24)}`,
    outcome: "allow",
    reason: `Within approval ${cover.approvalId} given in this task (${cover.kind})`,
    coveredBy: cover.approvalId,
  });
}

interface Approved { readonly approvalId: string; readonly executionId: string; readonly args: Record<string, JsonValue>; readonly actionDigest: string; readonly at: number }

/**
 * The approval the user gave in this task that `candidate` stays within, if any; its card is then not asked again.
 *
 * A write reported as not done, or partly done, is sent again by the model; asked again for each sending, the user answers
 * the same card twice (docs/incidents/2026-10-15-core-approval-repeat.md). A harness that skips
 * a prompt does it on a stored key whose scope the prompt showed, never because the model calls it a retry; here the card
 * says that what does not go through is sent again, and the key is the approved call — the same tool, target and values,
 * all of its rows or (for rows applied each by its own key) some of them.
 *
 * The approval must bind what a resume binds (actor, grant, profile, runtime, route, policy), carry no form answer, have
 * been approved within `APPROVAL_COVER_TTL_MS` in this task's turns and its call dispatched; and nothing may have happened
 * since that the user would want to weigh in on: no message or form answer from them, no other card they answered, no other
 * write. One repeat per approval. Calls are told apart by execution id: providers reuse call ids. Anything else is asked.
 */
export function coveringApproval(events: readonly SessionEvent[], taskTurnIds: readonly string[], candidate: CoverCandidate, now: number): ApprovalCover | undefined {
  const args = record(candidate.arguments);
  if (!args) return undefined;
  const task = new Set(taskTurnIds);
  const approved = latestApproval(events.filter((event) => task.has(event.turnId ?? "")), candidate, now);
  if (!approved) return undefined;
  if (candidate.actionDigest === approved.actionDigest) return { approvalId: approved.approvalId, kind: "repeat" };
  return withinRows(args, approved.args, candidate.rows) ? { approvalId: approved.approvalId, kind: "rows" } : undefined;
}

/** The newest approval of this tool in the task that still covers a repeat, or undefined. Only the newest: a later one voids it. */
function latestApproval(events: readonly SessionEvent[], candidate: CoverCandidate, now: number): Approved | undefined {
  let current: Approved | undefined;
  let covered = 0, dispatched = false;
  const requested = new Map<string, Record<string, JsonValue>>();
  const sideEffects = new Map<string, JsonValue | undefined>();
  for (const event of events) {
    const payload = record(event.payload) ?? {};
    const executionId = typeof payload.executionId === "string" ? payload.executionId : "";
    if (event.type === "tool/intent") sideEffects.set(executionId, payload.sideEffect);
    if (event.type === "approval/requested") requested.set(String(payload.approvalId), payload);
    const answered = (event.type === "approval/resolved" || event.type === "interaction/resolved") && payload.resolvedBy !== "runtime";
    if (event.type === "approval/resolved" && answered) {
      // Any card the user answers starts over: the newest answer is the only one a repeat may lean on.
      const asked = requested.get(String(payload.approvalId));
      current = asked && payload.decision === "approve" && boundAlike(asked, payload, candidate) ? approvedCall(asked, payload) : undefined;
      covered = 0; dispatched = false;
      continue;
    }
    if (!current) continue;
    const own = executionId === current.executionId;
    if (event.type === "user/input" || answered) current = undefined;
    else if (event.type === "tool/result" && own) dispatched ||= payload.dispatched === true;
    else if (event.type === "tool/policy-decision" && !own) {
      if (payload.coveredBy === current.approvalId) covered += 1;
      // Another write the user was asked about, one another approval covered, or one their standing approval ran, changes
      // what a repeat would undo: writes run under a standing approval end the cover too.
      else if (payload.outcome === "require_approval" || typeof payload.coveredBy === "string" || payload.standingApproval !== undefined) current = undefined;
    } else if (event.type === "tool/state" && payload.state === "dispatching" && !own && sideEffects.get(executionId) === "nonIdempotent") current = undefined;
  }
  return current && dispatched && covered < MAX_COVERED_REPEATS && now - current.at <= APPROVAL_COVER_TTL_MS ? current : undefined;
}

function boundAlike(asked: Record<string, JsonValue>, resolved: Record<string, JsonValue>, candidate: CoverCandidate): boolean {
  const b = candidate.binding;
  return asked.toolId === candidate.toolId && asked.interaction === undefined && asked.requestedBy === b.actorId && resolved.resolvedBy === b.actorId
    && asked.grantRevision === b.grantRevision && asked.agentProfileId === b.agentProfileId && asked.runtimeSnapshotId === b.runtimeSnapshotId
    && asked.runtimeRouteRevision === b.runtimeRouteRevision && asked.policyRevision === b.policyRevision;
}

function approvedCall(asked: Record<string, JsonValue>, resolved: Record<string, JsonValue>): Approved | undefined {
  const args = typeof asked.arguments === "string" ? record(parse(asked.arguments)) : undefined;
  const at = Date.parse(String(resolved.resolvedAt ?? ""));
  return args && Number.isFinite(at) && typeof asked.actionDigest === "string" && typeof asked.executionId === "string"
    ? { approvalId: String(asked.approvalId), executionId: asked.executionId, args, actionDigest: asked.actionDigest, at } : undefined;
}

/**
 * Every argument but the row fields is the approved one, by its exact key; `subset` rows are some of the approved rows of
 * their field (as many times at most as approved, none sent empty where rows were approved); `whole` rows are all of them,
 * in the approved order, or none; at least one row goes.
 */
function withinRows(args: Record<string, JsonValue>, approved: Record<string, JsonValue>, rows: Readonly<Record<string, "subset" | "whole">>): boolean {
  const isRow = (key: string) => Object.hasOwn(rows, key);
  const rest = (value: Record<string, JsonValue>) => canonicalJson(Object.fromEntries(Object.entries(value).filter(([key]) => !isRow(key))));
  if (rest(args) !== rest(approved)) return false;
  let sent = 0;
  for (const [field, mode] of Object.entries(rows)) {
    if (args[field] === undefined) continue;
    const mine = rowsOf(args[field]), allowed = rowsOf(approved[field]);
    if (!mine || !allowed || (mine.length === 0 && allowed.length > 0)) return false;
    if (mode === "whole") {
      if (canonicalJson(mine) !== canonicalJson(allowed)) return false;
    } else {
      const left = new Map<string, number>();
      for (const row of allowed) left.set(canonicalJson(row), (left.get(canonicalJson(row)) ?? 0) + 1);
      for (const row of mine) {
        const key = canonicalJson(row), count = left.get(key) ?? 0;
        if (count === 0) return false;
        left.set(key, count - 1);
      }
    }
    sent += mine.length;
  }
  return sent > 0;
}

/** A row field's rows: an array, or the JSON text of one (some writes send their rows as a string). Anything else: none. */
function rowsOf(value: JsonValue | undefined): readonly JsonValue[] | undefined {
  const rows = typeof value === "string" ? parse(value) : value;
  return Array.isArray(rows) ? rows : undefined;
}

function parse(text: string): JsonValue | undefined {
  try { return JSON.parse(text) as JsonValue; } catch { return undefined; }
}

function record(value: unknown): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined;
}
