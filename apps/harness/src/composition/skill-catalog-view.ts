import type { SkillCatalog, SkillDefinition } from "@0xsyncroot/contracts";

/**
 * The skills a composition can run: its whole catalog minus the skills no turn of it can follow, fixed once at boot.
 *
 * Every per-turn reader (the listing in the system prompt, `skill_list`, `skill_load`, the profile's preloaded, conditional
 * and loadable lists, the closings) reads this view, so a skill that needs a tool the composition never offers is not
 * listed, not loadable and never in effect. Activation-time checks read the whole catalog instead: which skills to leave
 * out is only known once the tool policy is bound, after the plugins are active, so the view is sealed then, by
 * `createBlankRuntime`, before anything renders a turn. A read before that throws, so a reader the seal does not precede
 * fails the boot instead of serving the unfiltered catalog.
 *
 * `revision` is the whole catalog's, so the view changes no plugin-set id and no pending approval's binding. What is left
 * out follows from the tool policy, which the runtime snapshot does not record: two compositions with the same plugins and
 * different policies (a product's standard and screen-only ones) share one `pluginSetId`, as they did before this view existed.
 */
export class SealableSkillCatalog implements SkillCatalog {
  readonly revision: string;
  readonly #full: SkillCatalog;
  #excluded: ReadonlySet<string> | undefined;

  constructor(full: SkillCatalog) {
    this.#full = full;
    this.revision = full.revision;
  }

  /** Fixes the skills this composition leaves out; once. */
  seal(excluded: ReadonlySet<string>): void {
    if (this.#excluded) throw new Error("The skill catalog view is already sealed");
    this.#excluded = new Set(excluded);
  }

  list(): readonly Omit<SkillDefinition, "instructions">[] {
    const excluded = this.#sealed();
    return this.#full.list().filter((skill) => !excluded.has(skill.id));
  }

  get(id: string): SkillDefinition | undefined {
    return this.#sealed().has(id) ? undefined : this.#full.get(id);
  }

  #sealed(): ReadonlySet<string> {
    if (!this.#excluded) throw new Error("The skill catalog view was read before the composition sealed it; only per-turn code reads it");
    return this.#excluded;
  }
}
