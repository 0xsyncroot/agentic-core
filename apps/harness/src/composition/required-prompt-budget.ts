import {
  inPromptOrder,
  type SecurityContext,
  type SkillDefinition,
  type SystemPromptProvider,
  type SystemPromptTurn,
  type ToolDefinition,
  type ToolExecutionPolicy,
} from "@0xsyncroot/contracts";
import { DEFAULT_AGENT_OPTIONS } from "@0xsyncroot/core";

export interface RequiredPromptUsage {
  /** Size of the required system message as the model request carries it (JSON). */
  readonly chars: number;
  /** Half of the smaller of the default context and the route's own context, in characters. */
  readonly budget: number;
  /** The system text that was measured. */
  readonly text: string;
}

/**
 * The size of the required system prompts against the budget the startup check enforces. One function for the startup check
 * and for any test of a prompt's size, so the two cannot drift. `routeContextChars` is the model route's window in characters;
 * absent (a model that publishes none) the default context applies. `turn` is what core tells a provider about the turn it
 * renders for; absent, every preloaded skill counts.
 */
export async function measureRequiredPrompt(
  prompts: readonly SystemPromptProvider[],
  security: SecurityContext,
  routeContextChars: number = DEFAULT_AGENT_OPTIONS.maxContextChars,
  turn?: SystemPromptTurn,
): Promise<RequiredPromptUsage> {
  const text = (await Promise.all(inPromptOrder(prompts).map((prompt) => prompt.render(security, turn)))).filter(Boolean).join("\n\n");
  const chars = JSON.stringify([{ role: "system", content: text,
    context: { trust: "instruction", retention: "required", provenance: "runtime-system-prompt" } }]).length;
  return { chars, budget: Math.floor(Math.min(DEFAULT_AGENT_OPTIONS.maxContextChars, routeContextChars) / 2), text };
}

/**
 * Makes `offersInSomeTurn` binding: a tool the policy declares it never offers is dropped at discovery, so a turn cannot
 * send a prompt the startup check left out. The declaration is forwarded for the check to read.
 */
export function bindToolOffers(policy: ToolExecutionPolicy): ToolExecutionPolicy {
  return {
    discover: async (tools, context) => (await policy.discover(tools, context)).filter((tool) => policy.offersInSomeTurn?.(tool) !== false),
    authorize: (input) => policy.authorize(input),
    offersInSomeTurn: (tool) => policy.offersInSomeTurn?.(tool) ?? true,
  };
}

/**
 * The tools some turn of this composition can be offered: the mounted tools its policy does not decline, and the tools a
 * skill requires from a connector whose namespace a contextual source owns (their list is unknowable at boot).
 */
export function offerableToolIds(input: {
  readonly mounted: readonly ToolDefinition[];
  readonly contextualSourceIds: readonly string[];
  readonly skills: readonly Pick<SkillDefinition, "requiredTools">[];
  readonly policy: ToolExecutionPolicy;
}): ReadonlySet<string> {
  const contextual = input.skills.flatMap((skill) => skill.requiredTools)
    .filter((toolId) => input.contextualSourceIds.some((sourceId) => toolId.startsWith(`${sourceId}_`)));
  return new Set([
    ...input.mounted.filter((tool) => input.policy.offersInSomeTurn?.(tool) !== false).map((tool) => tool.id),
    ...contextual,
  ]);
}

/**
 * The skills no turn of this composition can follow: one of their required tools is outside `offerableToolIds`, which is
 * a mounted tool the policy declares it never offers (a tool in a contextual source's namespace always counts as offerable).
 * A tool absent from one turn only (a connector down, a permission missing, no verified tab) never excludes a skill here.
 */
export function unofferableSkillIds(input: Omit<Parameters<typeof offerableToolIds>[0], "skills"> & {
  readonly skills: readonly Pick<SkillDefinition, "id" | "requiredTools">[];
}): ReadonlySet<string> {
  const offerable = offerableToolIds(input);
  return new Set(input.skills.filter((skill) => skill.requiredTools.some((toolId) => !offerable.has(toolId))).map((skill) => skill.id));
}

/** The startup check: the system prompt of a turn that offers every tool some turn can offer must fit the budget. */
export async function enforceRequiredPromptBudget(input: Parameters<typeof offerableToolIds>[0] & {
  readonly prompts: readonly SystemPromptProvider[];
  readonly security: SecurityContext;
  readonly routeContextChars: number;
}): Promise<RequiredPromptUsage> {
  const usage = await measureRequiredPrompt(input.prompts, input.security, input.routeContextChars, { offeredToolIds: offerableToolIds(input) });
  if (usage.chars > usage.budget) {
    throw new Error(`Required system prompts use ${usage.chars} characters and exceed the ${usage.budget}-character startup budget`);
  }
  return usage;
}
