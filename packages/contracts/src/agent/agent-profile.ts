/** Trusted, versioned identity and operating scope for one routed agent profile. */
export interface AgentProfileDefinition {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  /** Short, user-facing introduction suitable for runtime discovery and the widget. */
  readonly description: string;
  /** Human-readable domains this profile is intended to support. */
  readonly supportedDomains: readonly string[];
  /** Trusted Markdown instructions injected independently from domain skills. */
  readonly instructions: string;
  /**
   * The few instructions that must be the last thing in the system prompt to be followed at all
   * (see `SystemPromptProvider.position`). In AGENT.md: whatever follows a `<!-- closing -->` line.
   */
  readonly closingInstructions?: string;
  /** Digest of the canonical source, binding profile content to a runtime snapshot. */
  readonly contentDigest: string;
  /**
   * Skill IDs whose full instructions are injected into the system prompt at boot, so a
   * weaker model does not have to self-call `skill_load` before applying the skill. The
   * IDs must exist in the loaded catalog; the harness validates this at composition time.
   */
  readonly preloadSkills?: readonly string[];
  /**
   * Preloaded skills a turn may go without: each turn's judge is asked whether the request needs
   * them, and one confidently not needed is left out of that turn's prompt (still loadable on
   * demand). Must be a subset of `preloadSkills`.
   */
  readonly conditionalSkills?: readonly string[];
}

export type PublicAgentProfile = Omit<AgentProfileDefinition, "instructions" | "contentDigest">;
