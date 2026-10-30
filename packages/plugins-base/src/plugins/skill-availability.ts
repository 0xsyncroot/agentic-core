import type { SkillCatalog, SystemPromptTurn } from "@0xsyncroot/contracts";

/**
 * The preloaded skills to leave out of this turn's prompt: those the turn's judge found unneeded, and those whose
 * required tools are absent from this turn only. Both stay listed, and loadable, in the skill catalog. `skills` is the
 * catalog the turn reads: a skill whose tools the composition never offers is not in it, so it is never one of these.
 */
export function skillsLeftOut(skills: SkillCatalog, preloadedIds: readonly string[], turn?: SystemPromptTurn): ReadonlySet<string> {
  const left = new Set(turn?.skippedSkills ?? []);
  const offered = turn?.offeredToolIds;
  if (offered) {
    for (const skillId of preloadedIds) {
      const skill = skills.get(skillId);
      if (skill && skill.requiredTools.some((toolId) => !offered.has(toolId))) left.add(skillId);
    }
  }
  return left;
}

/**
 * The preloaded skills in effect for a turn: in the catalog the turn reads and not left out of it. One set for the preload
 * text, the closings, the listing's `alreadyLoaded` marker; a preload outside the catalog is none of them.
 */
export function preloadsInEffect(skills: SkillCatalog, preloadedIds: readonly string[], turn?: SystemPromptTurn): readonly string[] {
  const left = skillsLeftOut(skills, preloadedIds, turn);
  return preloadedIds.filter((skillId) => skills.get(skillId) !== undefined && !left.has(skillId));
}
