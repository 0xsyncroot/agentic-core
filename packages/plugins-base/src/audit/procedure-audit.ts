import { APPROVAL_EVENT, RUNTIME_REQUESTER_ID, skillFitQuestion, skillFitState, type JsonValue, type JudgmentQuestion, type TurnControlServices, type TurnControlState } from "@0xsyncroot/contracts";
import { SKILL_LOAD_TOOL } from "../tools/skill-tools.js";
import type { GoalAuditInput, GoalAuditVerdict } from "./completion-audit.js";

/**
 * A criterion goes back when the judge leans to "unmet"; a procedure is held to its criteria when the judge leans to "the
 * request asks for it". Both thresholds come from criterion verdicts labelled blind by an independent reviewer
 * (docs/incidents/2026-10-11-shared-procedure-audit.md).
 */
const UNMET = 0.5;
const APPLIES = 0.5;
const MAX_CRITERIA = 12;
/** Separates a criterion's condition from its requirement in a skill's `done` line: language-neutral, so the core names no domain. */
export const CRITERION_CONDITION = "=>";

/** A `done` line as its parts: "<condition> => <requirement>", or a requirement alone. */
export function splitCriterion(line: string): { readonly condition?: string; readonly requirement: string } {
  const at = line.indexOf(CRITERION_CONDITION);
  return at < 0 ? { requirement: line.trim() } : { condition: line.slice(0, at).trim(), requirement: line.slice(at + CRITERION_CONDITION.length).trim() };
}

type Ask = (request: { readonly state: JsonValue; readonly questions: Readonly<Record<string, JudgmentQuestion>> }, signal: AbortSignal)
  => Promise<{ readonly answers?: Readonly<Record<string, unknown>> } | undefined>;

type Asked = Awaited<ReturnType<Ask>>;

export interface ProcedureCriteria { readonly skillId: string; readonly done: readonly string[] }

/**
 * Applicability judgments asked ahead of the verdict, by skill id (`procedureApplicabilityRequests` builds the requests).
 * Raw promises of the turn's judge: a cancelled turn rejects them, and `applies` rethrows it as it would its own call.
 * Only applicability is ever asked early: a journaled `met` row counts as an objecting round (`objectedIn`), so the criteria
 * wait for the procedure to apply.
 */
export interface ProcedurePreAsked { readonly applicability?: ReadonlyMap<string, Promise<Asked>> }

/**
 * The completion criteria of the procedures loaded in this task — the `done` lines of each skill, read from its load result.
 *
 * A skill states what its own work counts as done; the audit asks about those lines rather than knowing any skill. The
 * generic questions ("does it deliver a result, are its figures in the evidence") pass an answer that skips a step the
 * procedure requires.
 */
export function procedureCriteria(state: TurnControlState): readonly ProcedureCriteria[] {
  const task = new Set(state.taskTurnIds.length ? state.taskTurnIds : [state.turnId]);
  const found = new Map<string, string[]>();
  let count = 0;
  for (const event of state.context.events) {
    if (event.type !== "tool/result" || !task.has(event.turnId ?? "")) continue;
    const payload = event.payload as Record<string, unknown>;
    if (payload.toolId !== SKILL_LOAD_TOOL.toolId || payload.state !== "succeeded") continue;
    const result = payload.result as Record<string, unknown> | null | undefined;
    if (typeof result?.id !== "string" || !Array.isArray(result.done)) continue;
    const lines = found.get(result.id) ?? [];
    for (const line of result.done) {
      if (typeof line === "string" && line.trim() && !lines.includes(line.trim()) && count < MAX_CRITERIA) { lines.push(line.trim()); count += 1; }
    }
    found.set(result.id, lines);
  }
  return [...found].filter(([, done]) => done.length).map(([skillId, done]) => ({ skillId, done }));
}

/**
 * A judgment that cannot be had settles nothing and the audit fails open; a turn that was stopped is not a judge error.
 * Swallowed, an abort read as "nothing unmet": the answer of a stopped turn came back as audited and passed (the turn's
 * judge throws on abort, as every other audit here rethrows it).
 */
const failOpen = (signal: AbortSignal) => (error: unknown): undefined => {
  if (signal.aborted) throw error;
  return undefined;
};

/**
 * Whether the task's request calls for the procedure at all, judged against every skill the agent has. A loaded skill is not
 * proof: a lookup that loads a procedure skill is not doing that procedure, and the judge never finds a criterion "not
 * applicable" when that is folded into the same question. Asked apart, as the judge's guidance has it, the task's fit
 * decides; without the catalog or the judge, the procedure applies.
 */
async function applies(skillId: string, input: GoalAuditInput, state: TurnControlState, ask: Ask, signal: AbortSignal, early?: Promise<Asked>): Promise<boolean> {
  const request = applicabilityRequest(skillId, input, state);
  if (!request) return true;
  const fit = (await (early ?? ask(request, signal)).catch(failOpen(signal)))?.answers?.fits as { type?: string; noul?: number } | undefined;
  return !(fit?.type === "noul" && typeof fit.noul === "number" && fit.noul < APPLIES);
}

/** The applicability question for a skill the agent has; undefined for one outside the catalog (it applies without asking). */
function applicabilityRequest(skillId: string, input: GoalAuditInput, state: TurnControlState): Parameters<Ask>[0] | undefined {
  const skills = state.availableSkills ?? [];
  if (!skills.some((skill) => skill.id === skillId)) return undefined;
  return { state: skillFitState(input.request, skills) as unknown as JsonValue, questions: { fits: skillFitQuestion(skillId) } };
}

/**
 * The applicability requests `procedureVerdict` will ask for this answer, so a caller can ask them while the other
 * judgments of the terminal review are out. Empty when the verdict is settled without asking (`procedureHeldOff`).
 */
export function procedureApplicabilityRequests(state: TurnControlState, audited: GoalAuditInput, mode: "shadow" | "on" = "shadow"):
  readonly { readonly skillId: string; readonly request: Parameters<Ask>[0] }[] {
  if (procedureHeldOff(state, mode)) return [];
  return procedureCriteria(state).flatMap(({ skillId }) => {
    const request = applicabilityRequest(skillId, audited, state);
    return request ? [{ skillId, request }] : [];
  });
}

/**
 * The criteria the judge finds unmet by the answer: for each procedure the request calls for, one question per criterion,
 * asked in parallel on the request and the answer only. Whether the answer's figures hold is the evidence rounds' question;
 * with the evidence in the state a complete, correct answer failed 3 of 6 criteria and verdicts moved between runs.
 */
export async function unmetProcedureCriteria(
  procedures: readonly ProcedureCriteria[], input: GoalAuditInput, state: TurnControlState, ask: Ask | undefined, signal: AbortSignal,
  pre?: ProcedurePreAsked,
): Promise<readonly string[]> {
  if (!ask || procedures.length === 0) return [];
  const held = (await Promise.all(procedures.map(async (procedure) =>
    (await applies(procedure.skillId, input, state, ask, signal, pre?.applicability?.get(procedure.skillId))) ? procedure.done : [])))
    .flat();
  // The searches of the task that found nothing (`notFound`, every search of that tool empty): on the request and the answer
  // alone, an honest "nothing in the documents" reads as taking ideas from a document and fails the citation line; with the
  // fact in the state it does not. Only such tasks carry it: no other state changes.
  const answerState = { request: input.request, answer: input.answer, ...(input.notFound?.length ? { searchesThatFoundNothing: input.notFound } : {}) } as unknown as JsonValue;
  // One question per call: two in one state were answered together, not each on its own.
  const noul = async (id: "applies" | "met", question: JudgmentQuestion): Promise<number | undefined> => {
    const answer = (await ask({ state: answerState, questions: { [id]: question } }, signal).catch(failOpen(signal)))?.answers?.[id] as
      { type?: string; noul?: number } | undefined;
    return answer?.type === "noul" && typeof answer.noul === "number" ? answer.noul : undefined;
  };
  const verdicts = await Promise.all(held.map(async (criterion) => {
    // "<a case the answer contains> => <what that case then needs>": a criterion that concerns only some answers. Whether the
    // answer holds such a case is its own judgment, asked first and alone; the requirement is judged only where it holds.
    // Asked together, the judge read a case that merely resembled the condition as one (a group left to confirm, read as a
    // group whose error was settled) and sent a complete answer back.
    const { condition, requirement } = splitCriterion(criterion);
    if (condition) {
      const applies = await noul("applies", appliesQuestion(condition));
      if (applies === undefined || applies < APPLIES) return undefined;
    }
    const met = await noul("met", metQuestion(requirement));
    return met !== undefined && met < UNMET ? criterion : undefined;
  }));
  return verdicts.filter((criterion): criterion is string => criterion !== undefined);
}

/** Whether the answer meets a criterion's requirement. */
function metQuestion(requirement: string): JudgmentQuestion {
  return { type: "noul", instructions: `Does the answer meet this completion criterion: "${requirement}"?`,
    criteria: { true: "The answer does what the criterion asks.", false: "What the criterion asks for is missing from the answer or only partial." } };
}

/**
 * Whether the answer holds a case of what a criterion's condition describes, every qualifier included. Worded as "does the
 * answer do this", a case that only resembled the condition was taken for one (a group left to confirm read as a group whose
 * error is settled); on recorded drafts this wording keeps the send-back the condition is for and drops those.
 */
function appliesQuestion(condition: string): JudgmentQuestion {
  return { type: "noul", instructions: `Does the answer contain a case of exactly what this condition describes: "${condition}"?`,
    criteria: { true: "At least one part of the answer is such a case, every qualifier of the condition included.",
      false: "No part of the answer is such a case; a part that only resembles it (a qualifier missing or reversed) does not count." } };
}

/**
 * Whether a journalled procedure-audit judgment objected: its criterion unmet and, when it carried a condition, the condition
 * held (the journal stores a noul's number as `value`). A condition is asked on a row of its own, and its criterion's row
 * exists only when it held, so a row with `met` alone counts as it is.
 */
function objectedIn(answers: unknown): boolean {
  const noul = (id: string) => {
    const answer = (answers as Record<string, { readonly noul?: number; readonly value?: number }> | null | undefined)?.[id];
    const value = answer?.noul ?? answer?.value;
    return typeof value === "number" ? value : undefined;
  };
  const met = noul("met"), applies = noul("applies");
  return met !== undefined && met < 0.5 && (applies === undefined || applies >= 0.5);
}

/** Procedure-audit rounds that may object in one task before the answer stands. */
const PROCEDURE_OBJECTIONS = 2;

/** How many of the task's procedure-audit rounds objected: each contiguous run of the seam's judgments is one round. */
function objectingRounds(events: TurnControlState["context"]["events"], task: ReadonlySet<string>): number {
  let rounds = 0, inRound = false, objected = false;
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (task.has(event.turnId ?? "") && event.type === "judgment/classified" && payload.seam === "procedure-audit") {
      inRound = true;
      objected ||= objectedIn(payload.answers);
      continue;
    }
    if (inRound) { rounds += objected ? 1 : 0; inRound = false; objected = false; }
  }
  return rounds + (inRound && objected ? 1 : 0);
}

/**
 * Whether the answer stands without asking about its procedure at all.
 *
 * A task that carries on from the user's answer to the agent's own question (a form, an approval) does what was answered;
 * the procedure's report came before the question. Held to the report's criteria again, each answered form or approval
 * opened three more send-backs. The runtime's own "continue?" question resumes the same work, and is judged as it was.
 * Only an approval of a call that changes data counts: a read-only permission (control of the screen, asked at the start of
 * nearly every screen task) precedes the report, and counting it would skip the audit for every such task.
 */
function procedureHeldOff(state: TurnControlState, mode: "shadow" | "on"): boolean {
  const task = new Set(state.taskTurnIds.length ? state.taskTurnIds : [state.turnId]);
  const payloadOf = (event: { readonly payload: unknown }) => (event.payload ?? {}) as Record<string, unknown>;
  // A pause the runtime closed itself (the user wrote something else instead) was not answered by the user at all.
  const writes = new Set(state.context.events.filter((event) => event.type === APPROVAL_EVENT.REQUESTED && payloadOf(event).sideEffect !== "none")
    .map((event) => payloadOf(event).approvalId));
  const answered = state.context.events.some((event) => task.has(event.turnId ?? "") && payloadOf(event).resolvedBy !== RUNTIME_REQUESTER_ID && (
    (event.type === APPROVAL_EVENT.RESOLVED && writes.has(payloadOf(event).approvalId))
    || (event.type === "interaction/resolved" && payloadOf(event).requesterId !== RUNTIME_REQUESTER_ID)));
  if (answered) return true;
  // At most two objecting rounds per task (the runtime's "continue?" turns included). Unbounded, the report is rewritten
  // whole each time and the later rewrites drift from it; one round is too few, since correct runs take two or three
  // (measured: docs/incidents/2026-10-11-shared-procedure-audit.md). A round is one contiguous run of this seam's judgments.
  return mode === "on" && objectingRounds(state.context.events, task) >= PROCEDURE_OBJECTIONS;
}

/**
 * The verdict of the done criteria of the loaded procedures the request calls for: passed when none is unmet (or there are none).
 *
 * `shadow` (default) asks and journals the judgments without sending anything back; `on` is a product's choice once it has
 * measured the gain against the extra steps (history: docs/incidents/2026-10-11-shared-procedure-audit.md).
 * `pre`: applicability asked ahead (`procedureApplicabilityRequests`); the criteria are asked here, once the procedure applies.
 */
export async function procedureVerdict(state: TurnControlState, audited: GoalAuditInput, judge: TurnControlServices["judge"], signal: AbortSignal,
  mode: "shadow" | "on" = "shadow", pre?: ProcedurePreAsked): Promise<GoalAuditVerdict> {
  if (procedureHeldOff(state, mode)) return { achieved: true, missing: [], unsupported: [] };
  const ask = judge ? (request: Parameters<NonNullable<typeof judge>>[1], abort: AbortSignal) => judge("procedure-audit", request, abort) : undefined;
  const unmet = await unmetProcedureCriteria(procedureCriteria(state), audited, state, ask, signal, pre);
  return unmet.length && mode === "on" ? { achieved: false, missing: unmet, unsupported: [], criteria: true } : { achieved: true, missing: [], unsupported: [] };
}
