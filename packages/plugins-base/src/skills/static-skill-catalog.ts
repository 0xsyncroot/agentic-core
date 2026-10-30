import type { SkillCatalog, SkillDefinition } from "@0xsyncroot/contracts";
import { createHash } from "node:crypto";

export class StaticSkillCatalog implements SkillCatalog {
  readonly revision: string;
  readonly #skills: ReadonlyMap<string, SkillDefinition>;
  constructor(skills: readonly SkillDefinition[]) {
    const snapshots = new Map<string, SkillDefinition>();
    for (const skill of skills) {
      if (snapshots.has(skill.id)) throw new Error(`Duplicate skill: ${skill.id}`);
      snapshots.set(skill.id, Object.freeze({ ...skill, requiredTools: Object.freeze([...skill.requiredTools]) }));
    }
    this.#skills = snapshots;
    const canonical = [...snapshots.values()].sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, version, name, description, requiredTools, instructions }) => ({
        id, version, name, description, requiredTools: [...requiredTools], instructions,
      }));
    this.revision = `sha256-${createHash("sha256").update(JSON.stringify(canonical)).digest("base64url")}`;
  }
  list(): readonly Omit<SkillDefinition, "instructions">[] {
    return [...this.#skills.values()].sort((a, b) => a.id.localeCompare(b.id)).map(({ instructions: _, ...summary }) => summary);
  }
  get(id: string): SkillDefinition | undefined { return this.#skills.get(id); }
}
