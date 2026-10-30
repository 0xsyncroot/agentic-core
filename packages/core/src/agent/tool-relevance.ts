import type { JsonValue, JudgmentQuestion, ToolGroup, TurnJudge, WorkPlan } from "@0xsyncroot/contracts";
import type { JudgmentMemo } from "./judgment-memo.js";

/** A group is left out only when the judge is this sure the request does not need it: the skill-relevance threshold. */
const NOT_NEEDED = 0.1;
/** The judged state stays small: a judge answers a short state fast, and the request and the plan are all it weighs. */
const MAX_STATE_CHARS = 2_000;
const MAX_REQUEST_CHARS = 1_200;
/** Changes whenever the question's words do, so a kept verdict or a measurement never outlives the wording it answered. */
export const TOOL_RELEVANCE_QUESTION_VERSION = "tool-relevance/1";

export type GroupVerdict = "needed" | "not-needed" | "no-verdict";

/** The question for one group, in skill-relevance's lenient shape: only a request plainly about something else goes without it. */
export function toolRelevanceQuestion(group: Pick<ToolGroup, "id" | "purpose">): JudgmentQuestion {
  return {
    type: "noul",
    instructions: `Does handling the request need the tools of the group "${group.id}": ${group.purpose}`,
    criteria: { true: "The request is about what these tools do, or may lead to it.", false: "The request is plainly about something else that these tools do not cover." },
  };
}

/**
 * What the judge reads: the request (its newest part when long) and the task's plan, its goal and each sub-goal with its
 * status, cut from the last sub-goal back until the state fits.
 */
export function toolRelevanceState(request: string, plan: WorkPlan | undefined): JsonValue {
  const text = request.length > MAX_REQUEST_CHARS ? request.slice(-MAX_REQUEST_CHARS) : request;
  const steps = (plan?.steps ?? []).map(({ description, status }) => ({ description, status }));
  for (let kept = steps.length; kept > 0; kept -= 1) {
    const state = { request: text, plan: { goal: plan!.goal, steps: steps.slice(0, kept) } };
    if (fits(state)) return state;
  }
  return { request: newestThatFits(text) };
}

const fits = (state: JsonValue): boolean => JSON.stringify(state).length <= MAX_STATE_CHARS;

/** The longest end of `text` whose request-only state fits: escaped characters count as the JSON writes them. */
function newestThatFits(text: string): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits({ request: text.slice(text.length - middle) })) low = middle; else high = middle - 1;
  }
  return text.slice(text.length - low);
}

/**
 * One verdict per group, each asked in its own call (asked many things in one state, the judge answers by position), all at
 * once. A failed or skipped judgment is `no-verdict`, and the caller offers that group. A verdict is kept per session and
 * state (`memo`), so a turn that asks the same thing again asks nothing new.
 */
export async function judgeToolGroups(
  judge: TurnJudge, groups: readonly ToolGroup[], state: JsonValue, signal: AbortSignal,
  memo?: { readonly verdicts: JudgmentMemo; readonly scope: string },
): Promise<ReadonlyMap<string, GroupVerdict>> {
  const verdicts = await Promise.all(groups.map(async (group): Promise<GroupVerdict> => {
    const question = toolRelevanceQuestion(group);
    const ask = async () => {
      const answer = (await judge("tool-relevance", { state, questions: { needed: question } }, signal))?.answers.needed;
      return answer?.type === "noul" ? answer.noul <= NOT_NEEDED : undefined;
    };
    const key = { seam: "tool-relevance", version: TOOL_RELEVANCE_QUESTION_VERSION, scope: memo?.scope ?? "", group: group.id, question: question.instructions, state };
    const leftOut = memo ? await memo.verdicts.remember(key, ask) : await ask();
    return leftOut === undefined ? "no-verdict" : leftOut ? "not-needed" : "needed";
  }));
  return new Map(groups.map((group, index) => [group.id, verdicts[index]!]));
}
