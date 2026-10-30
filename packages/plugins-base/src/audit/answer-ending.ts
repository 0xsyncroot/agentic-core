import { recordedAttempts, taskAttachmentIds, type JsonValue, type JudgmentAnswer, type JudgmentQuestion, type SessionEvent, type TurnControlState } from "@0xsyncroot/contracts";
import type { GoalAuditInput } from "./completion-audit.js";
import type { AuditJudge } from "./judged-auditor.js";
import { saysFileUnreadable, type UnreadFile } from "./unread-file-blocker.js";

/**
 * How a final answer ends, and whether the turn may end on it — for any product and any tool.
 *
 * Two endings are not completions however much they report: handing the work back (asking whether
 * to go on, promising it for later, asking the user to do or point out a step) and declaring a step
 * blocked without having tried. Harnesses that keep an agent at its goal treat both the same way:
 * Claude Code's goal check ("claiming the goal is impossible is evidence, not proof"), DeepSeek
 * Harness's blocked state (accepted only after three rounds on the same blocker; "difficulty or
 * uncertainty is not blocked"), OpenAI's computer-use guidance ("don't ask for confirmation if
 * safe progress is still possible"). The judge names the ending; the runtime decides from the
 * journal whether a blocker is proven. The question separates hand-backs from legitimate endings
 * (measurement: docs/incidents/2026-10-10-shared-ending-judge.md). A separate `absent` label keeps
 * "it does not exist where it would be" from being read as a blocker.
 */
export const ENDING_QUESTION: JudgmentQuestion = Object.freeze({
  type: "choice",
  instructions: "In the state, how does the answer end, measured against the request and the plan?",
  criteria: {
    done: "It completes the request and every step of the plan; offering extra work beyond the request and the plan after that still counts as done.",
    absent: "It says that what was asked for does not exist, naming the place it looked where it would be.",
    continue: "Part of the requested work or of the plan is not done yet, and it asks whether to do it, go deeper or check in more detail, waits for the user's go-ahead, or promises it for later or another turn.",
    delegate: "It asks the user to do, open, select, find or point out something in the application or the files.",
    decision: "It asks only for what the user alone can give: a choice between options it found, approval of a change it proposes, confirmation before deleting or another risky action.",
    blocked: "It says a step it had to do could not be done and names what stopped it: a refusal, a missing permission or capability, a locked record, a control it could not use.",
  },
}) as JudgmentQuestion;

/** Above this the ending is taken as read: every hand-back measured 1.00, no legitimate ending above 0.50. */
const SURE = 0.97;
/**
 * Failed calls in the task after which a blocked answer is no longer sent back as unproven; DeepSeek Harness asks for
 * three rounds on it. Counted over every target, they say the agent tried, not that what the answer names is blocked:
 * the rounds still judge such an answer as any other (`blockerFinal` leaves them out).
 */
export const BLOCKER_FAILURES = 3;
/** Blocked endings already sent back in the task: the one after these stands, so the turn cannot loop on it. */
export const BLOCKER_CLAIMS = 2;

/** What the journal shows the agent tried in this task: runtime facts the judge never reads. */
export interface AttemptEvidence {
  /** Failed calls recorded against their targets (`ToolAttempt`), all targets together. */
  readonly failures: number;
  /** A call was refused by a permission policy or by the user: final, not the agent's to retry. */
  readonly denied: boolean;
  /**
   * A denial nothing has gone past: after it in the task no write succeeded, and the denied tool did not run either. A
   * user who declined one write and then let other writes go through has not blocked what the agent reports blocked
   * later; only a denial still standing settles a blocked answer (`blockerFinal`). A read does not go past it: reading
   * the value back to report it unchanged is what an agent told "no" should do.
   */
  readonly stillDenied: boolean;
  /**
   * The task reached for a capability the runtime knows is missing this turn — a tool withheld from this
   * principal, or one whose source could not be had — or the user attached files no reader has read while
   * every source that reads them is down. Final for the turn, like a denial: otherwise each honest "cannot read the
   * file" goes back as an unproven blocker and the model calls the missing reader again.
   * A refusal marked in an earlier turn of the task counts only while the capability is still missing: a turn
   * resumed after the reader came back has nothing blocking it.
   */
  readonly unavailable: boolean;
  /** Earlier answers of the task the judge read as blocked. */
  readonly blockedClaims: number;
  /**
   * The newest failed call was refused for good: its capability is missing this turn, the user or a policy
   * denied it, or the runtime stopped it (a cycle, a spent budget). Telling the model to fix what the refusal
   * says and call again is then advice to repeat a call that cannot pass. A tool's own refusal (an MCP error,
   * a timeout) is not final: it usually names what to fix — a sheet name one space off, a smaller page.
   */
  readonly finalRefusal: boolean;
  /** The failed targets and why, newest last, for the feedback. */
  readonly tried: readonly string[];
}

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};

/** The task is about attached files: its own, or an earlier request's that a call of the task named (`taskAttachmentIds`). */
function taskHasFiles(events: readonly SessionEvent[], task: ReadonlySet<string>): boolean {
  return taskAttachmentIds(events, task).length > 0;
}

/** Whether a tool is missing this turn, by the runtime's facts: withheld, or of a source that is down (its tools are `<sourceId>_<name>`). */
function missingThisTurn(unavailable: TurnControlState["unavailable"]): (toolId: string) => boolean {
  return (toolId) => unavailable !== undefined && (unavailable.withheldTools.some((tool) => tool.toolId === toolId)
    || unavailable.sources.some((source) => toolId.startsWith(`${source.sourceId}_`)));
}

/**
 * The turn's own facts about missing capabilities, beside the journal: a call of the task that did not go through, to a
 * tool still missing this turn, or files attached that cannot be read this turn. Configuration and policy facts, never
 * the answer's prose. The runtime says the second itself (`unavailable.attachments`: every reader down or withheld, and a
 * file the task is about none of them read) — a reader withheld by permission leaves no source down, and a model that
 * obeyed the manifest's "do not call" left no refused call either. Only the task's files: one an earlier request attached
 * proves nothing for an unrelated later request ("no data for September" is not blocked by an unread spreadsheet) until
 * a call of the task names it. Without the fact, the task's files that no reader has read while no source that reads them
 * is up; the state names only the sources that are down, so a second reader that is up is the product's to know.
 */
function stateUnavailable(events: readonly SessionEvent[], task: ReadonlySet<string>, state: AttemptState): boolean {
  if (!state.unavailable) return false;
  if (state.unavailable.attachments && taskHasFiles(events, task)) return true;
  const missing = missingThisTurn(state.unavailable);
  const results = events.filter((event) => event.type === "tool/result" && task.has(event.turnId ?? ""));
  // A call that did not go through, to a tool still missing now; one that succeeded before the source went down blocks nothing.
  if (results.some((event) => record(event.payload).state !== "succeeded" && missing(String(record(event.payload).toolId ?? "")))) return true;
  const readers = state.unavailable.sources.filter((source) => source.readsAttachments);
  const ofReader = (toolId: string) => readers.some((source) => toolId.startsWith(`${source.sourceId}_`));
  const read = results.some((event) => record(event.payload).state === "succeeded" && ofReader(String(record(event.payload).toolId ?? "")));
  const offered = (state.availableTools ?? []).some((tool) => ofReader(tool.id));
  return readers.length > 0 && !read && !offered && taskHasFiles(events, task);
}

/** Runtime stops that no change of arguments gets past. */
const FINAL_CODES: ReadonlySet<string> = new Set(["cycle-detected", "budget-exceeded"]);

/** A refusal that calling again cannot get past: a capability still missing (`fresh`), a denial, or a runtime stop. */
function refusedForGood(payload: Readonly<Record<string, unknown>>, fresh: boolean): boolean {
  if (typeof payload.unavailable === "string") return fresh;
  return payload.state === "denied" || FINAL_CODES.has(String(record(payload.error).code ?? ""));
}

/** The turn's facts the evidence is read against: which turn is current, and what is missing in it. */
export type AttemptState = Partial<Pick<TurnControlState, "turnId" | "unavailable" | "availableTools">>;

export function attemptEvidence(events: readonly SessionEvent[], task: ReadonlySet<string>, state: AttemptState = {}): AttemptEvidence {
  const attempts = recordedAttempts(events as readonly { type: string; turnId?: string; payload: JsonValue }[], task);
  const missing = missingThisTurn(state.unavailable);
  let denied = false, unavailable = stateUnavailable(events, task, state), blockedClaims = 0;
  let latestFailed: { readonly payload: Readonly<Record<string, unknown>>; readonly fresh: boolean } | undefined;
  // What each call does, from its journaled intent (by execution, then call id), else from the tools offered this turn.
  const effects = new Map<string, string>();
  for (const event of events) {
    const payload = record(event.payload);
    if (event.type !== "tool/intent" || typeof payload.sideEffect !== "string") continue;
    for (const key of [payload.executionId, payload.callId]) if (typeof key === "string") effects.set(key, payload.sideEffect);
  }
  const offered = new Map((state.availableTools ?? []).map((tool) => [tool.id, tool.sideEffect as string]));
  const writes = (payload: Readonly<Record<string, unknown>>) => {
    const effect = [payload.executionId, payload.callId].map((key) => typeof key === "string" ? effects.get(key) : undefined).find(Boolean)
      ?? offered.get(String(payload.toolId ?? ""));
    return effect === "idempotent" || effect === "nonIdempotent";
  };
  const standing = new Set<string>();
  for (const event of events) {
    if (!task.has(event.turnId ?? "")) continue;
    const payload = record(event.payload);
    if (event.type === "tool/result" && payload.state === "denied") { denied = true; standing.add(String(payload.toolId ?? "")); }
    if (event.type === "tool/result" && payload.dispatched === true && payload.state === "succeeded") {
      // A write that went through goes past every denial before it; the denied tool running goes past its own.
      if (writes(payload)) standing.clear();
      else standing.delete(String(payload.toolId ?? ""));
    }
    // Written by the runtime on a call to a capability missing in that turn (`not_started`, never dispatched): it holds
    // for this turn's calls, and for an earlier turn's only while the tool is still missing now.
    const fresh = event.turnId === state.turnId || missing(String(payload.toolId ?? ""));
    if (event.type === "tool/result" && typeof payload.unavailable === "string" && fresh) unavailable = true;
    // A call the runtime held back behind a failed call of its step ran nothing: the failure before it stays the latest.
    const heldBack = record(payload.error).code === "not-started";
    if (event.type === "tool/result" && !heldBack && (payload.state !== "succeeded" || typeof record(payload.attempt).failure === "string")) latestFailed = { payload, fresh };
    if (event.type === "judgment/classified" && payload.seam === "completion-audit") {
      const ending = record(record(payload.answers).ending);
      if (ending.choice === "blocked" && typeof ending.value === "number" && ending.value >= SURE) blockedClaims += 1;
    }
  }
  return {
    failures: attempts.failures.reduce((sum, failed) => sum + failed.failures, 0), denied, stillDenied: standing.size > 0, unavailable, blockedClaims,
    finalRefusal: latestFailed !== undefined && refusedForGood(latestFailed.payload, latestFailed.fresh),
    tried: attempts.failures.slice(-6).map((failed) => `${failed.signature.slice(0, 140)} → ${failed.failure} ×${failed.failures}`),
  };
}

/** The agent has done enough that a blocked answer is no longer sent back as unproven (`unprovenBlocker`). */
export const blockerProven = (evidence: AttemptEvidence): boolean =>
  evidence.denied || evidence.unavailable || evidence.blockedClaims >= BLOCKER_CLAIMS || evidence.failures >= BLOCKER_FAILURES;

/**
 * The journal holds a fact no further lap can change: a denial still standing, a capability missing this turn, or the
 * same blocked report twice before. Only this lets a blocked answer stand without being judged on delivery
 * (`provenBlocker`): failed calls counted over every target do not — three mislabelled clicks elsewhere say nothing
 * about a "locked Save button".
 */
export const blockerFinal = (evidence: AttemptEvidence): boolean =>
  evidence.stillDenied || evidence.unavailable || evidence.blockedClaims >= BLOCKER_CLAIMS;

export type EndingFlag = "handsBack" | "unprovenBlocker" | "askedInProse";

/**
 * The flags an `ending` answer raises: a hand-back unless a search of the task found nothing (`nothingFound`); a blocker only
 * while the journal does not prove it; a decision asked in prose only while a form could carry it (the structured-question
 * tool is offered and the step is not the turn's last), so the user answers with one click instead of typing.
 * After a search that found nothing, "nothing there answers this; narrow it like this" is the answer, not a hand-back, though
 * the judge reads such answers as `continue`.
 */
export function readEnding(answer: JudgmentAnswer | undefined, evidence: AttemptEvidence | undefined, formOffered = false, nothingFound = false): readonly EndingFlag[] {
  if (answer?.type !== "choice") return [];
  const p = (label: string) => answer.probabilities[label] ?? 0;
  if (p("continue") + p("delegate") >= SURE) return nothingFound ? [] : ["handsBack"];
  if (answer.choice === "blocked" && answer.confidence >= SURE && evidence && !blockerProven(evidence)) return ["unprovenBlocker"];
  if (answer.choice === "decision" && answer.confidence >= SURE && formOffered) return ["askedInProse"];
  return [];
}

/**
 * What the ending is judged on: the request, the plan and the answer, without the tool evidence. The
 * evidence drowns an answer's last lines: live, a full report that ended by asking whether to look further,
 * after listing a check it had not done, read 0.996 "done" beside 50,000 characters of results,
 * and 1.00 "continue" without them. Measured without evidence: 9 of 9 hand-backs, 0 of 9 legitimate endings.
 */
export function endingState(input: GoalAuditInput): JsonValue {
  return { request: input.request, ...(input.goal ? { goal: input.goal } : {}), steps: input.steps, answer: input.answer } as unknown as JsonValue;
}

/** How the judge read an answer's ending, and what the runtime makes of it from the journal. */
export interface EndingReading {
  /** What sends the answer back (`readEnding`); empty when nothing does. */
  readonly flags: readonly EndingFlag[];
  /** The judge's label and how sure it was; absent when no judgment could be had. */
  readonly choice?: string;
  readonly confidence?: number;
  /**
   * A clear "blocked" whose blocker the journal settles (`blockerFinal`). Such an answer is the task's end, partial. The
   * completion rounds' "not delivered" and "absent without looking" are then the blocker itself, read from
   * the other side, and do not send it back. What they find wrong in its figures still stands.
   */
  readonly provenBlocker: boolean;
  /**
   * Files of earlier requests the judge read this blocked answer as saying could not be read (`saysFileUnreadable`): the
   * blocker proven by them, and what a product names under the answer. Absent when the journal settled the blocker itself.
   */
  readonly unreadFiles?: readonly UnreadFile[];
}

const NOT_READ: EndingReading = Object.freeze({ flags: Object.freeze([]), provenBlocker: false });

/** Asks how the answer ends, apart from the completion rounds; no judge or no answer: nothing to object to. */
export async function judgeEnding(input: GoalAuditInput, ask: AuditJudge | undefined, signal: AbortSignal): Promise<EndingReading> {
  if (!ask) return NOT_READ;
  let judged;
  try { judged = await ask({ state: endingState(input), questions: { ending: ENDING_QUESTION } }, signal); } catch (error) {
    if (signal.aborted) throw error;
    return NOT_READ;
  }
  const answer = judged?.answers.ending;
  const flags = readEnding(answer, input.attempts, input.formOffered === true, (input.notFound?.length ?? 0) > 0);
  if (answer?.type !== "choice") return { flags, provenBlocker: false };
  const blocked = answer.choice === "blocked" && answer.confidence >= SURE;
  const provenBlocker = blocked && input.attempts !== undefined && blockerFinal(input.attempts);
  // Unproven by the journal, a blocked answer may still name a file nothing could read that an earlier request attached.
  const files = blocked && !provenBlocker ? input.unreadEarlierFiles ?? [] : [];
  if (files.length > 0 && await saysFileUnreadable(input.answer, files, ask, signal)) {
    return { flags: flags.filter((flag) => flag !== "unprovenBlocker"), choice: answer.choice, confidence: answer.confidence, provenBlocker: true, unreadFiles: files };
  }
  return { flags, choice: answer.choice, confidence: answer.confidence, provenBlocker };
}

/** What the model reads for each of these flags: the runtime's terms, with what the journal shows. */
export function endingFeedback(flags: readonly string[], evidence: AttemptEvidence | undefined): readonly string[] {
  const lines: string[] = [];
  if (flags.includes("handsBack")) {
    lines.push("Your answer hands the work back to the user: it asks whether to go on, promises it for later, or asks the user to do or point out a step.",
      "Do that step yourself now with your tools. Ask the user only for what only they can give — a choice between options you found, approval of a change, confirmation before a risky action — and ask it with request_user_input when that tool is offered.");
  }
  if (flags.includes("askedInProse")) {
    lines.push("Your answer asks the user to decide, in prose. Ask it with request_user_input instead: a select field with the options you found (two options for yes or no), or a suggest field with the likely values, so the user answers with one click. Put the question in the form, not in your text.");
  }
  if (flags.includes("unprovenBlocker")) {
    const failures = evidence?.failures ?? 0;
    lines.push(`Your answer reports a step as blocked, but this task shows ${failures} failed attempt${failures === 1 ? "" : "s"}${evidence?.tried.length ? ` (${evidence.tried.join("; ")})` : ""}.`,
      // "Call again" fits a refusal of the call's arguments; after a final one it only buys the same refusal.
      evidence?.finalRefusal
        ? "A step is blocked only after it failed in more than one way. The latest refusal is final, so the same call cannot pass: read the current state again (it may still be loading or may have changed); look for the control or data another way (search, scroll, open the menu or view that holds it). Then report what each attempt returned."
        : "A step is blocked only after it failed in more than one way: first do what the refusal says to fix and call again; read the current state again (it may still be loading or may have changed); look for the control or data another way (search, scroll, open the menu or view that holds it). Then report what each attempt returned.");
  }
  return lines;
}
