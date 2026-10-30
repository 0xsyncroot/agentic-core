import { randomUUID } from "node:crypto";
import type { JsonValue, JudgmentRequest, LlmAdapter, SessionEvent, TurnControlState } from "@0xsyncroot/contracts";
import { attemptEvidence, type AttemptEvidence } from "./answer-ending.js";
import type { AuditJudge, PreAskedRound } from "./judged-auditor.js";
import { nothingFound, type NothingFound } from "./not-found.js";
import { earlierUnreadFiles, type UnreadFile } from "./unread-file-blocker.js";
import { figuresInSources } from "./verbatim-figures.js";

export { goalAuditFeedback } from "./goal-audit-feedback.js";

/**
 * Whether an answer completes the user's request, judged against what the tools returned.
 *
 * The agent marking its own plan steps completed is not "done": without comparing the answer with
 * the request and the evidence, a turn can stop on a progress note, or report figures invented after
 * the table left the model's context as "completed". The judgement is the model's — an
 * independent, tool-less call that reads the journal, not the trimmed prompt — never a pattern
 * run over the answer's prose.
 */
export interface GoalAuditVerdict {
  readonly achieved: boolean;
  /** What is still to do, in the user's words. */
  readonly missing: readonly string[];
  /** Values in the answer that the evidence contradicts, each with what the evidence shows. */
  readonly unsupported: readonly string[];
  /** The judge's objections, when the judge decided: the runtime's feedback adds what each one needs. */
  readonly flags?: readonly string[];
  /** `missing` holds completion criteria of the procedure being followed (a skill's done lines), not objections to figures. */
  readonly criteria?: boolean;
}

export interface GoalAuditInput {
  readonly request: string;
  readonly goal?: string;
  readonly steps: readonly { readonly description: string; readonly status: string; readonly outcome?: string }[];
  readonly answer: string;
  readonly evidence: readonly { readonly tool: string; readonly state: string; readonly result: string }[];
  /**
   * The same evidence for a classifier: an older observation of a channel that has a newer one is
   * kept in the short form its tool journaled beside it (what happened and where it led), so a
   * fast reader sees the newest observation whole instead of a dozen screens. A claim that rests on
   * an older observation then lacks evidence for it, and the classifier doubts it: the model audit,
   * which reads `evidence`, decides.
   */
  readonly classifierEvidence?: readonly { readonly tool: string; readonly state: string; readonly result: string }[];
  /**
   * An earlier answer of this task was already sent back for stating a computed figure (read from
   * the journaled judgments). A judge cannot add rows up, so such an answer goes back once for the
   * agent to recompute; the second time the figure stands on the other criteria.
   */
  readonly computedFigureChecked?: boolean;
  /**
   * The calculation tool was offered this turn and no calculation has run. A figure worked out by
   * hand is then always sent back — never waved through once, never arbitrated — because the one
   * way to clear it is to compute it.
   */
  readonly calculationPending?: boolean;
  /**
   * A computing tool (`calculate`, `reconcile_tables`) succeeded in the task: the figures an answer states
   * were worked out by code, so sending it back "to recompute" would only repeat the same call.
   */
  readonly computedByTool?: boolean;
  /**
   * The answer writes figures, and every one is written with the same value in the task's request or in a result it read
   * (`figuresInSources`): none of them was worked out by hand, so the computed-figure question does not apply to it.
   */
  readonly figuresInEvidence?: boolean;
  /** What the task tried and how it failed, from the journal: whether a blocked ending is proven. */
  readonly attempts?: AttemptEvidence;
  /** The tools that compute from stored results (`computes`): where a figure added up from rows comes from. */
  readonly computingTools?: readonly string[];
  /** The structured-question tool is offered and the step is not the turn's forced last one: a question can be a form. */
  readonly formOffered?: boolean;
  /**
   * The ending judge read a clear "blocked" and the journal proves the blocker. "Not delivered" and "absent without
   * looking" are then the blocker itself, read from the other side; the rounds weigh what the answer states — its figures.
   */
  readonly provenBlocker?: boolean;
  /**
   * Searches of the task that came back empty (`nothingFound`). "Nothing there answers this" is then the task's answer, read
   * from the other side, as for a proven blocker: not "not delivered", not "absent without looking", not a hand-back; the
   * rounds weigh what the answer states, and the task ends done.
   */
  readonly notFound?: readonly NothingFound[];
  /** Earlier requests' files nothing could read (`earlierUnreadFiles`): what a blocked answer may name that the journal cannot tie to the task. */
  readonly unreadEarlierFiles?: readonly UnreadFile[];
}

/** The input without the runtime's own facts: what a judge or the model audit reads. */
export function withoutRuntimeFacts(input: GoalAuditInput): GoalAuditInput {
  const { classifierEvidence: _view, computedFigureChecked: _checked, calculationPending: _pending, computedByTool: _computed, figuresInEvidence: _verbatim, attempts: _attempts, formOffered: _form,
    computingTools: _tools, provenBlocker: _blocked, unreadEarlierFiles: _files, notFound: _empty, ...read } = input;
  return read;
}

/** Undefined when no verdict could be had (the audit call failed): the answer is not held hostage to it. `firstRound`: an auditor that takes its first round asked ahead (`pre`) says what it asks. */
export type GoalAuditor = ((input: GoalAuditInput, signal: AbortSignal, judge?: AuditJudge, pre?: PreAskedRound) => Promise<GoalAuditVerdict | undefined>) & { readonly firstRound?: (input: GoalAuditInput) => JudgmentRequest };

/** Above this the judge reads the answer as stating a figure computed from several values. */
export const COMPUTED_FIGURE = 0.2;
const EVIDENCE_CHARS = 48_000;
const RESULT_CHARS = 16_000;
const ITEM_CHARS = 300;
const ITEMS = 8;
const AUDIT_TIMEOUT_MS = 30_000;

/** The short form a tool journaled beside a result of a channel that keeps changing, if it did. */
function supersessionOf(event: SessionEvent): { readonly channel: string; readonly condensed: JsonValue } | undefined {
  const value = record(event.payload).supersession as { channel?: unknown; condensed?: JsonValue } | undefined;
  return value && typeof value.channel === "string" && value.condensed !== undefined ? { channel: value.channel, condensed: value.condensed } : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

function items(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .slice(0, ITEMS).map((item) => item.trim().slice(0, ITEM_CHARS));
}

/** The verdict in a reply, or undefined for anything that is not one. */
export function parseGoalAuditVerdict(text: string): GoalAuditVerdict | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
  const verdict = record(parsed);
  if (typeof verdict.achieved !== "boolean") return undefined;
  return { achieved: verdict.achieved, missing: items(verdict.missing), unsupported: items(verdict.unsupported) };
}

function text(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * What the audit reads: the task's own requests and every call's journaled result, newest first
 * within a bound. The journal keeps a result whole even after the prompt has cleared it, which is
 * exactly the evidence an answer written from memory has lost.
 */
export function goalAuditInput(state: TurnControlState, answer: string, isPlanningTool: (toolId: string) => boolean): GoalAuditInput | undefined {
  const gathered = turnEvidence(state, isPlanningTool);
  if (!gathered || !answer.trim()) return undefined;
  const plan = state.workPlan;
  const task = new Set(state.taskTurnIds.length ? state.taskTurnIds : [state.turnId]);
  const computedFigureChecked = state.context.events.some((event) => {
    if (event.type !== "judgment/classified" || !task.has(event.turnId ?? "")) return false;
    const payload = record(event.payload);
    const figure = record(record(payload.answers).derivedFigure).value;
    return payload.seam === "completion-audit" && typeof figure === "number" && figure > COMPUTED_FIGURE;
  });
  const computing = new Set((state.availableTools ?? []).filter((tool) => tool.computes).map((tool) => tool.id));
  const computedByTool = state.context.events.some((event) => event.type === "tool/result" && task.has(event.turnId ?? "")
    && computing.has(String(record(event.payload).toolId)) && record(event.payload).state === "succeeded");
  const calculationPending = computing.size > 0 && !computedByTool;
  const empty = nothingFound(state.context.events, task);
  // Read whole, not within the audit's bound: a figure the judge's copy of a result was cut before is still not computed.
  const read = state.context.events.filter((event) => event.type === "tool/result" && task.has(event.turnId ?? "") && record(event.payload).dispatched === true
    && !isPlanningTool(String(record(event.payload).toolId ?? ""))).map((event) => text((record(event.payload).result ?? record(event.payload).error) as JsonValue));
  const figuresInEvidence = figuresInSources(answer, [gathered.request, ...read]);
  return {
    ...gathered, answer: answer.slice(0, 12_000), ...(computedFigureChecked ? { computedFigureChecked } : {}), ...(calculationPending ? { calculationPending } : {}), ...(computedByTool ? { computedByTool } : {}),
    ...(figuresInEvidence ? { figuresInEvidence } : {}),
    ...(computing.size ? { computingTools: [...computing] } : {}), ...(empty.length ? { notFound: empty } : {}),
    attempts: attemptEvidence(state.context.events, task, state), ...unreadFilesOf(state),
    ...(state.availableTools?.some((tool) => tool.id === USER_INPUT_TOOL_ID) && !state.finalStep ? { formOffered: true } : {}),
    ...(plan?.goal ? { goal: plan.goal } : {}),
    steps: (plan?.steps ?? []).map((step) => ({ description: step.description, status: step.status, ...(step.outcome ? { outcome: step.outcome } : {}) })),
  };
}

const unreadFilesOf = (state: TurnControlState): { readonly unreadEarlierFiles?: readonly UnreadFile[] } => {
  const files = earlierUnreadFiles(state);
  return files.length ? { unreadEarlierFiles: files } : {};
};

/**
 * What the ending judge reads for an answer given without any tool result: the task's request, the plan and the answer.
 * The evidence rounds weigh claims against results, so they stay out: with no results they fail greetings and thanks as
 * "not delivered". How an answer ends needs no results: a hand-back or a decision asked in prose is caught whether or not
 * a tool ran.
 */
export function answerOnlyInput(state: TurnControlState, answer: string): GoalAuditInput | undefined {
  const task = new Set(state.taskTurnIds.length ? state.taskTurnIds : [state.turnId]);
  const request = taskRequest(state.context.events.filter((event) => task.has(event.turnId ?? "")));
  if (!request || !answer.trim()) return undefined;
  const plan = state.workPlan;
  return {
    request, answer: answer.slice(0, 12_000), evidence: [], attempts: attemptEvidence(state.context.events, task, state), ...unreadFilesOf(state),
    ...(state.availableTools?.some((tool) => tool.id === USER_INPUT_TOOL_ID) && !state.finalStep ? { formOffered: true } : {}),
    ...(plan?.goal ? { goal: plan.goal } : {}),
    steps: (plan?.steps ?? []).map((step) => ({ description: step.description, status: step.status, ...(step.outcome ? { outcome: step.outcome } : {}) })),
  };
}

/** The task's requests, interjections included: the latest correction is part of the request. */
function taskRequest(events: readonly SessionEvent[]): string {
  return events.filter((event) => event.type === "user/input")
    .map((event) => text(record(event.payload).content as JsonValue)).filter(Boolean).join("\n").slice(0, 4_000);
}

export interface TurnEvidence {
  readonly request: string;
  readonly evidence: GoalAuditInput["evidence"];
  readonly classifierEvidence: GoalAuditInput["evidence"];
}

/**
 * The task's own requests and every call's journaled result, newest first within a bound — what
 * any judgment of the turn reads, whatever it judges. Undefined until there is a request and at
 * least one result. `classifierEvidence` is the same with older observations of a channel short.
 */
export function turnEvidence(state: TurnControlState, isPlanningTool: (toolId: string) => boolean): TurnEvidence | undefined {
  const task = new Set(state.taskTurnIds.length ? state.taskTurnIds : [state.turnId]);
  const events = state.context.events.filter((event) => task.has(event.turnId ?? ""));
  const request = taskRequest(events);
  const results = events.filter((event): event is SessionEvent => event.type === "tool/result" && record(event.payload).dispatched === true
    && !isPlanningTool(String(record(event.payload).toolId ?? "")));
  if (!request || results.length === 0) return undefined;
  const evidence: GoalAuditInput["evidence"][number][] = [];
  const classifierEvidence: GoalAuditInput["evidence"][number][] = [];
  const newest = new Map<string, string>();
  for (const event of results) {
    const channel = supersessionOf(event)?.channel;
    if (channel) newest.set(channel, event.eventId);
  }
  let used = 0;
  for (const event of [...results].reverse()) {
    const data = record(event.payload);
    const body = text((data.result ?? data.error) as JsonValue).slice(0, RESULT_CHARS);
    if (used + body.length > EVIDENCE_CHARS) break;
    used += body.length;
    const tool = String(data.toolId ?? ""), state = String(data.state ?? "");
    evidence.unshift({ tool, state, result: body });
    const older = supersessionOf(event);
    const short = older && newest.get(older.channel) !== event.eventId
      ? text({ superseded: `Older observation of the ${older.channel}: a newer one replaces it.`, kept: older.condensed } as JsonValue) : body;
    classifierEvidence.unshift({ tool, state, result: short });
  }
  return { request, evidence, classifierEvidence };
}

/**
 * The auditor on the runtime's own model, bound once the runtime exists. One short call with no
 * tools and private reasoning off; it is not a turn and is not journaled as one. Any failure —
 * no model yet, a timeout, a reply that is not a verdict — returns undefined.
 */
export function createLlmGoalAuditor(instruction: string): { readonly audit: GoalAuditor; bind(llm: LlmAdapter): void } {
  let model: LlmAdapter | undefined;
  return {
    bind(llm) { model = llm; },
    async audit(input, signal) {
      const llm = model;
      if (!llm) return undefined;
      const id = `goal-audit-${randomUUID()}`;
      const timeout = AbortSignal.timeout(AUDIT_TIMEOUT_MS);
      const combined = AbortSignal.any([signal, timeout]);
      let reply = "";
      try {
        for await (const event of llm.stream({
          requestId: id, attemptId: id, turnId: id, stepId: id, runtimeSnapshotId: "goal-audit", model: llm.model,
          messages: [
            { role: "system", content: instruction, context: { trust: "instruction", retention: "required", provenance: "goal-audit" } },
            { role: "user", content: JSON.stringify(withoutRuntimeFacts(input)), context: { trust: "untrusted", retention: "required", provenance: "goal-audit" } },
          ],
          tools: [], parameters: { ...(llm.plainParameters ?? {}) }, contentHash: id,
        }, combined)) {
          if (event.type === "text-delta") reply += event.delta;
          if (event.type === "final") reply = event.content ?? reply;
        }
      } catch (error) {
        if (signal.aborted) throw error;
        return undefined;
      }
      return parseGoalAuditVerdict(reply);
    },
  };
}

/** The platform's structured-question tool: a question the user answers by choosing goes through it. */
const USER_INPUT_TOOL_ID = "request_user_input";
