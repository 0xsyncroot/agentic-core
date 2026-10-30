import { skillFitQuestion, skillFitState, type JsonValue, type JudgmentQuestion, type SessionContextView, type SessionEvent, type SkillSummary, type SystemPromptProvider, type TurnJudge } from "@0xsyncroot/contracts";
import type { JudgmentSeamMode } from "./observation-review.js";
import type { JudgmentMemo } from "./judgment-memo.js";
import { coveredPinnedResults } from "./pinned-results.js";
import type { SkillFitFallback } from "./skill-fit-fallback.js";
import { ToolCallPairing } from "./tool-call-pairing.js";

/** At most one judgment field per skill, and a judgment has 64. */
const MAX_SKILLS = 64;
/** A skill is left out only when the judge is this sure the request does not need it. */
const NOT_NEEDED = 0.1;

/**
 * Which conditional preloaded skills this turn can go without.
 *
 * Every preloaded skill is sent on every model step of every turn; a request about one screen
 * carried the full payroll procedure too. A profile marks the skills a turn may go without, and two rules leave one out:
 * - topic: the turn's judge is asked at the start of the turn, one skill per call, whether the request needs it (journaled as
 *   `skill-relevance`), and the skill goes when it is sure it is not needed;
 * - competing: a procedure skill (`SkillDefinition.role`) goes when its skill-fit answer rules it out while another skill's
 *   answer fits (`SkillFit`): the request asks for a task another procedure describes. A supporting skill never wins that
 *   choice, so only the topic rule leaves it out.
 * A skill left out stays listed as loadable, so a model that does need it loads it. Any doubt, failure or absent judge keeps all.
 * A verdict is asked once per request (`memo`, keyed by `scope` — whose session it is): a resume asks nothing new. `fit`
 * is the turn's skill-fit answers, shared with `suggestedSkills`, so each skill is asked once whichever seam reads it.
 */
export async function skippedSkills(
  judge: TurnJudge | undefined, mode: JudgmentSeamMode | undefined, prompts: readonly SystemPromptProvider[], request: string, signal: AbortSignal,
  memo?: { readonly verdicts: JudgmentMemo; readonly scope: string }, fit?: SkillFit,
): Promise<ReadonlySet<string>> {
  if (!judge || !mode || mode === "off" || !request.trim()) return new Set();
  const candidates = [...new Map(prompts.flatMap((prompt) => prompt.conditionalSkills ?? []).map((skill) => [skill.id, skill])).values()].slice(0, MAX_SKILLS);
  if (candidates.length === 0) return new Set();
  // One question per skill, each in its own call: asked many things in one state the judge answers by position (doc 18 §12, §16).
  const [byTopic, byFit] = await Promise.all([Promise.all(candidates.map(async (skill) => {
    const question: JudgmentQuestion = {
      type: "noul",
      instructions: `Does handling the request need the operating instructions of the skill "${skill.name}": ${skill.description}`,
      criteria: { true: "The request is about what this skill covers, or may lead to it.", false: "The request is plainly about something else that this skill does not cover." },
    };
    const ask = async () => {
      const answer = (await judge("skill-relevance", { state: { request } as JsonValue, questions: { needed: question } }, signal))?.answers.needed;
      return answer?.type === "noul" ? answer.noul <= NOT_NEEDED : undefined;
    };
    const key = { seam: "skill-relevance", scope: memo?.scope ?? "", skill: skill.id, question: question.instructions, request };
    return (memo ? await memo.verdicts.remember(key, ask) : await ask()) === true;
  })), outcompeted(fit ?? new SkillFit(judge, prompts, request, signal, memo), candidates)]);
  if (mode !== "on") return new Set();
  return new Set(candidates.filter((skill, index) => byTopic[index] || byFit.has(skill.id)).map((skill) => skill.id));
}

/**
 * The procedure skills among `candidates` the judge rules out (p(fits) at most 0.1) while it finds another skill fits (at
 * least 0.9), on its own answers only. Nothing is asked when no candidate is a procedure or no other skill competes.
 */
async function outcompeted(fit: SkillFit, candidates: readonly SkillSummary[]): Promise<ReadonlySet<string>> {
  const procedures = candidates.filter((skill) => skill.role !== "supporting");
  if (procedures.length === 0 || fit.skills.length < 2) return new Set();
  const answers = new Map(await Promise.all(fit.skills.map(async (skill) => [skill.id, await fit.answer(skill.id)] as const)));
  const fits = (id: string) => [...answers].some(([other, answer]) => other !== id && answer?.by === "judge" && answer.fits);
  return new Set(procedures.filter((skill) => answers.get(skill.id)?.ruledOut === true && fits(skill.id)).map((skill) => skill.id));
}

/** Every skill the providers give the agent, preloaded or loadable, once each: what a request is weighed against. */
export function skillSummaries(prompts: readonly SystemPromptProvider[]): readonly SkillSummary[] {
  const all = prompts.flatMap((prompt) => [...(prompt.preloadedSkills ?? []), ...(prompt.conditionalSkills ?? []), ...(prompt.loadableSkills ?? [])]);
  return [...new Map(all.map((skill) => [skill.id, skill])).values()].slice(0, MAX_SKILLS);
}

/** A loadable skill is named only when the judge is at least this sure the request asks for its work. */
const NEEDED = 0.9;

/** A skill-fit answer read at both thresholds, and who gave it; `ruledOut` is the judge's alone (the chat model only says yes). */
interface FitAnswer { readonly fits: boolean; readonly ruledOut: boolean; readonly by: "judge" | "fallback" }

/**
 * The turn's skill-fit answers (`skillFitQuestion`, with every skill the agent has in the state, so the skills compete), asked
 * once per skill however many seams read them: `suggestedSkills` names a loadable skill that fits, `skippedSkills` leaves out
 * a procedure another skill outcompetes. An answer is kept in the memo under the suggestion's key, so a resume asks nothing.
 */
export class SkillFit {
  readonly skills: readonly SkillSummary[];
  readonly state: ReturnType<typeof skillFitState>;
  readonly #asked = new Map<string, Promise<FitAnswer | undefined>>();

  constructor(
    private readonly judge: TurnJudge, prompts: readonly SystemPromptProvider[], request: string, private readonly signal: AbortSignal,
    private readonly memo?: { readonly verdicts: JudgmentMemo; readonly scope: string },
  ) {
    this.skills = skillSummaries(prompts);
    this.state = skillFitState(request, this.skills);
  }

  /** The memo key of a skill's verdict (p(fits) at least 0.9); the chat model's yes is kept under it too. */
  key(skillId: string): Readonly<Record<string, JsonValue>> {
    return { seam: "skill-suggestion", scope: this.memo?.scope ?? "", skill: skillId, state: this.state as unknown as JsonValue };
  }

  /** The skill's answer, kept or asked now; undefined when the judge gave none. */
  answer(skillId: string): Promise<FitAnswer | undefined> {
    let asked = this.#asked.get(skillId);
    if (!asked) { asked = this.#ask(skillId); this.#asked.set(skillId, asked); }
    return asked;
  }

  async #ask(skillId: string): Promise<FitAnswer | undefined> {
    const key = this.key(skillId), ruledOutKey = { ...key, verdict: "ruled-out" };
    const kept = this.memo?.verdicts.get(key);
    if (kept !== undefined) {
      const by = this.memo?.verdicts.get({ ...key, by: "fallback" }) ? "fallback" : "judge";
      return { fits: kept, ruledOut: by === "judge" && this.memo?.verdicts.get(ruledOutKey) === true, by };
    }
    const answer = (await this.judge("skill-suggestion", { state: this.state as unknown as JsonValue, questions: { fits: skillFitQuestion(skillId) } }, this.signal))?.answers.fits;
    if (answer?.type !== "noul") return undefined;
    const verdict = { fits: answer.noul >= NEEDED, ruledOut: answer.noul <= NOT_NEEDED, by: "judge" as const };
    this.memo?.verdicts.set(key, verdict.fits);
    this.memo?.verdicts.set(ruledOutKey, verdict.ruledOut);
    return verdict;
  }
}

/**
 * Load-on-demand skills a request asks for that the model has not loaded: named by the runtime at the end of the turn's first step.
 *
 * The judge is asked once per loadable skill, in its own call (`SkillFit`): the skills compete, and only a confident yes names
 * one. The model still decides — the provider's loader tool stays the way in. A skill already loaded in this task is not named again.
 *
 * A skill the judge gave no verdict on (it failed twice) is put to `fallback`, the chat model, which names it or does not: only
 * a "yes" counts and is kept like the judge's. A skill the judge answered, suggested or ruled out, is never put to it.
 */
export async function suggestedSkills(
  judge: TurnJudge | undefined, mode: JudgmentSeamMode | undefined, prompts: readonly SystemPromptProvider[], request: string,
  loaded: ReadonlySet<string>, signal: AbortSignal, memo?: { readonly verdicts: JudgmentMemo; readonly scope: string }, fallback?: SkillFitFallback,
  fit?: SkillFit,
): Promise<readonly SuggestedSkill[]> {
  if (!judge || !mode || mode === "off" || !request.trim()) return [];
  const candidates = [...new Map(prompts.flatMap((prompt) => prompt.loadableSkills ?? []).map((skill) => [skill.id, skill])).values()]
    .filter((skill) => !loaded.has(skill.id)).slice(0, MAX_SKILLS);
  if (candidates.length === 0) return [];
  const fits = fit ?? new SkillFit(judge, prompts, request, signal, memo);
  const verdicts = await Promise.all(candidates.map(async (skill) => {
    const answer = await fits.answer(skill.id);
    if (answer || !fallback) return answer?.fits ? answer.by : undefined;
    const yes = await fallback(skill, fits.state, signal) === true;
    // The chat model's yes is kept under the judge's key (it is not asked again) and marked as its own beside it.
    if (yes) { memo?.verdicts.set(fits.key(skill.id), true); memo?.verdicts.set({ ...fits.key(skill.id), by: "fallback" }, true); }
    return yes ? "fallback" : undefined;
  }));
  return mode === "on" ? candidates.flatMap(({ id, name }, index) => verdicts[index] ? [{ id, name, by: verdicts[index] }] : []) : [];
}

/** A skill the request asks for that the model has not loaded, and who said so: the judge (`p(fits)` at least 0.9) or the chat model in its place. */
export interface SuggestedSkill { readonly id: string; readonly name: string; readonly by: "judge" | "fallback" }

/** The first step's note for the skills the judge found needed. */
export function skillSuggestionText(skills: readonly { readonly id: string; readonly name: string }[], loaderToolId: string): string {
  return `Runtime check: ${skills.map((skill) => `the skill "${skill.name}" (${skill.id})`).join(" and ")} ${skills.length === 1 ? "matches" : "match"} this request and `
    + `${skills.length === 1 ? "is" : "are"} not loaded. Load ${skills.length === 1 ? "it" : "them"} with ${loaderToolId} before planning: the procedure is how this kind of request is done.`;
}

/**
 * The skills the model can read right now: a load it made in the raw tail, or one the checkpoint
 * covers that comes back whole after it (a pinned loader). A load summarized away is not loaded:
 * counting every load in the journal kept the runtime from naming a skill the model no longer had.
 */
export function visibleSkillLoads(
  context: SessionContextView, evidence: readonly SessionEvent[], loader: { readonly toolId: string; readonly argument: string }, pinned: ReadonlySet<string>,
): ReadonlySet<string> {
  const skillOf = (args: unknown): string[] => {
    if (typeof args !== "string") return [];
    try { const id = (JSON.parse(args) as Record<string, unknown>)[loader.argument]; return typeof id === "string" ? [id] : []; } catch { return []; }
  };
  const pairing = new ToolCallPairing(context.events);
  const tail = context.events.flatMap((event) => {
    const payload = event.payload as Record<string, unknown>;
    if (event.type !== "tool/result" || payload.toolId !== loader.toolId || payload.state !== "succeeded") return [];
    return skillOf((pairing.intentOfResult(event)?.payload as Record<string, unknown> | undefined)?.arguments);
  });
  const covered = Number((context.checkpoint?.payload as Record<string, unknown> | undefined)?.coveredThroughSeq ?? 0);
  const kept = coveredPinnedResults(evidence, covered, pinned).filter((result) => result.toolId === loader.toolId).flatMap((result) => skillOf(result.arguments));
  return new Set([...tail, ...kept]);
}
