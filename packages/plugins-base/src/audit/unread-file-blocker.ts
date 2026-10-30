import { taskAttachmentIds, type JudgmentQuestion, type TurnControlState } from "@0xsyncroot/contracts";
import type { AuditJudge } from "./judged-auditor.js";

/** A file the conversation holds that no reader has read and none can read this turn (`UnavailableCapabilities.unreadFiles`). */
export interface UnreadFile {
  readonly id: string;
  readonly name: string;
}

/**
 * Whether a blocked answer says that a file the user attached could not be read — asked of one answer, with the names of
 * the files nothing could read, in a request of its own.
 *
 * The journal ties a file to the task when the task attached it or one of its calls named it. A follow-up such as "read it
 * again", answered at once with "I still cannot read the file", names nothing: to the journal it is the same as an
 * unrelated request answered with an unrelated blocker, and the first must stand while the second goes back. Only what the
 * answer says separates them, so a judge reads it; the question separates them cleanly, near misses included
 * (measurement: docs/incidents/2026-10-14-shared-proven-blocker.md).
 */
export const UNREADABLE_FILE_QUESTION: JudgmentQuestion = Object.freeze({
  type: "noul",
  instructions: "In the state, does the answer tell the user that a file they attached could not be read?",
  criteria: {
    true: "The answer says that a file the user attached (one of `files`, or 'the attached file') could not be read, opened or accessed, whatever reason it gives: a tool, a service, a permission, a technical problem.",
    false: "The answer reports what a file contains or what was read from it; or what it says could not be done is something else: a screen control, a record, a code, a write, data in the application.",
  },
}) as JudgmentQuestion;

/** Every negative measured scored at most 0.0005 and every positive 1.00: the bound the ending judge uses for "sure". */
export const UNREADABLE_FILE_SURE = 0.97;

/**
 * The files only a judgment can tie to the answer: unread in the conversation, unreadable this turn, and not the task's
 * (`taskAttachmentIds`) — the task's own are a fact already (`UnavailableCapabilities.attachments`).
 */
export function earlierUnreadFiles(state: Pick<TurnControlState, "turnId" | "taskTurnIds" | "context" | "unavailable">): readonly UnreadFile[] {
  const unread = state.unavailable?.unreadFiles ?? [];
  if (unread.length === 0) return [];
  const task = new Set(taskAttachmentIds(state.context.events, state.taskTurnIds?.length ? state.taskTurnIds : [state.turnId]));
  return unread.filter((file) => !task.has(file.id));
}

/**
 * True when the judge is sure the answer says one of `files` could not be read. No judge, a failed or timed-out judgment, or
 * a doubt: false — the answer is then judged as it was before the question existed.
 */
export async function saysFileUnreadable(answer: string, files: readonly UnreadFile[], ask: AuditJudge | undefined, signal: AbortSignal): Promise<boolean> {
  if (!ask || files.length === 0 || !answer.trim()) return false;
  try {
    const judged = await ask({ state: { files: files.map((file) => file.name), answer }, questions: { unreadableFile: UNREADABLE_FILE_QUESTION } }, signal);
    const reading = judged?.answers.unreadableFile;
    return reading?.type === "noul" && reading.noul >= UNREADABLE_FILE_SURE;
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  }
}
