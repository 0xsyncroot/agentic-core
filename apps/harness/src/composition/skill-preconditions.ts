import type { SkillCatalog } from "@0xsyncroot/contracts";

/**
 * Every write precondition the catalog's skills declare, by write tool id: what `withToolPreconditions` checks.
 *
 * Catalog-wide: a declared write is checked whichever skill is in effect, as `requiredTools` are mounted for all of them.
 * Two skills that order one write differently fail the boot — which of them is right is not the runtime's to pick.
 */
export function catalogPreconditions(skills: SkillCatalog): ReadonlyMap<string, readonly string[]> {
  const merged = new Map<string, { readonly after: readonly string[]; readonly skillId: string }>();
  for (const { id } of skills.list()) {
    for (const [toolId, { after }] of Object.entries(skills.get(id)?.preconditions ?? {})) {
      const earlier = merged.get(toolId);
      if (earlier && [...earlier.after].sort().join("\n") !== [...after].sort().join("\n")) {
        throw new Error(`Skills ${earlier.skillId} and ${id} declare different preconditions for ${toolId}: after ${earlier.after.join(", ")} / after ${after.join(", ")}`);
      }
      if (!earlier) merged.set(toolId, { after, skillId: id });
    }
  }
  return new Map([...merged].map(([toolId, { after }]) => [toolId, Object.freeze([...after])]));
}
