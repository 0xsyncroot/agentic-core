export interface SkillDefinition {
  readonly id: string; readonly version: string; readonly name: string; readonly description: string;
  readonly instructions: string; readonly requiredTools: readonly string[];
  /**
   * What the skill is to a request (default `procedure`). A `procedure` is the way one kind of task is done, so a request
   * whose task another skill describes can go without it. A `supporting` skill is one step any task may take (reading an
   * attachment, say): it never wins a choice between skills, so it is never left out for losing one.
   */
  readonly role?: "procedure" | "supporting";
  /**
   * What the procedure counts as done, one criterion per line. When the task's request calls for this skill (judged against
   * every skill the agent has), the completion audit asks one question per criterion and sends back the ones it finds unmet.
   * A line "<condition> => <requirement>" holds only answers the condition describes (phrase it as something the answer
   * does): the audit asks whether it applies, then the requirement. One "=>" per line, both sides non-empty.
   */
  readonly done?: readonly string[];
  /**
   * One short line the procedure needs read last (SKILL.md, after a `<!-- closing -->` marker): sent at the end of every
   * request of a task the skill is in effect in, after the request's own closing instruction — where an instruction that
   * has to hold against everything said before it is followed. Not part of `instructions`, and never in a tool result.
   */
  readonly closing?: string;
  /**
   * Writes the procedure orders after other calls, by write tool id: `after` lists the tool ids that must have a succeeded
   * result in the current task before the write is proposed. Every id is one of `requiredTools`. A composition enforces it
   * by mounting the precondition check on its turn-control policy; the agent still plans and orders every step itself.
   * Never part of a listing (`SkillCatalog.list`).
   */
  readonly preconditions?: Readonly<Record<string, { readonly after: readonly string[] }>>;
}

/** The longest closing a skill may carry: it is paid on every request of a task the skill is in effect in. */
export const MAX_SKILL_CLOSING_CHARS = 300;
export interface SkillCatalog {
  /** Immutable digest of the complete, canonical catalog, including full instructions. */
  readonly revision: string;
  list(): readonly Omit<SkillDefinition, "instructions">[];
  get(id: string): SkillDefinition | undefined;
}
