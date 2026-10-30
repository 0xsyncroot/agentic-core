import type { SecurityContext } from "./security/security-context.js";
import type { SkillSummary } from "./skills/skill-fit.js";

export interface SystemPromptProvider {
  readonly id: string;
  /**
   * `closing` puts this text after every other provider's, whatever order they were registered in.
   *
   * Where an instruction sits decides whether it is followed. Measured on a real model with a
   * 51,000-character system prompt: one sentence asking it to reason in the user's language was
   * followed about one time in five from near the top — no better than not asking — and nine
   * times in ten as the last thing in the prompt. Anything that has to hold against the weight of
   * everything else said belongs here, and little else does: a closing section everyone writes to
   * is the middle again.
   */
  readonly position?: "closing";
  /**
   * Preloaded skills this provider may leave out of a turn that does not need them (the profile's
   * `conditionalSkills`). Core asks the turn's judge about each once per turn and passes the ones
   * confidently not needed back as `turn.skippedSkills`; a skipped skill stays loadable on demand.
   */
  readonly conditionalSkills?: readonly SkillSummary[];
  /** The skills this provider puts in the prompt: what a request is weighed against, with the loadable ones, when core asks which procedure it calls for. */
  readonly preloadedSkills?: readonly SkillSummary[];
  /**
   * Skills this provider lists but does not put in the prompt (load on demand). Core asks the turn's judge about each once per
   * turn and names the ones a request confidently needs at the end of the turn's first step, so a smaller model loads them.
   */
  readonly loadableSkills?: readonly SkillSummary[];
  /** The tool that loads one of `loadableSkills`, and the argument naming the skill: how core tells a loaded skill and names the way in. */
  readonly skillLoader?: { readonly toolId: string; readonly argument: string };
  render(security: SecurityContext, turn?: SystemPromptTurn): Promise<string>;
  /**
   * The closing lines (`SkillDefinition.closing`) of this provider's skills in effect for a request: a preloaded skill the
   * prompt carries for `turn`, and each skill `loadedSkills` names (loaded in the task). Core sends them last in the request,
   * after its own closing instruction, on every step — a skill loaded during a turn has its line from the next step on.
   */
  skillClosings?(turn: SystemPromptTurn & { readonly loadedSkills: ReadonlySet<string> }): readonly string[];
  /**
   * The tools the skills in effect for `turn` require (`SkillDefinition.requiredTools`): each preloaded skill the turn does
   * not skip and each skill `loadedSkills` names. Core offers every tool group holding one of them, whatever a relevance
   * judgment said. A tool a procedure names that lies in a group no required tool belongs to may be left out; one load of that
   * group offers it.
   */
  skillTools?(turn: SystemPromptTurn & { readonly loadedSkills: ReadonlySet<string> }): readonly string[];
}

/** What core tells a provider about the turn it renders for. Absent: render as for every turn. */
export interface SystemPromptTurn {
  readonly skippedSkills?: ReadonlySet<string>;
  /**
   * The tools offered to the model this turn. A preloaded skill whose required tools are not all here is listed as
   * loadable instead of preloaded: its procedure names tools the turn does not have, and a model reading it calls them.
   */
  readonly offeredToolIds?: ReadonlySet<string>;
}

/** The providers in the order their text is sent: as registered, closing ones last. */
export function inPromptOrder<T extends Pick<SystemPromptProvider, "position">>(prompts: readonly T[]): readonly T[] {
  return [...prompts.filter((prompt) => prompt.position !== "closing"), ...prompts.filter((prompt) => prompt.position === "closing")];
}
