import { SKILL_LOAD_TOOL } from "../tools/skill-tools.js";
import { CAPABILITIES, type AgentProfileDefinition, type SkillCatalog, type SystemPromptProvider, type SystemPromptTurn } from "@0xsyncroot/contracts";
import { SYSTEM_PROMPT_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { createBuiltinManifest, createBuiltinPlugin } from "./builtin-plugin.js";
import { preloadsInEffect } from "./skill-availability.js";

function profilePrompt(profile: AgentProfileDefinition): string {
  const domains = profile.supportedDomains.length > 0 ? profile.supportedDomains.join(", ") : "general assistance";
  return [
    "# Agent profile",
    `Identity: ${profile.name}`,
    `Introduction: ${profile.description}`,
    `Supported domains: ${domains}`,
    "When the user asks who you are or what you can help with, answer from this profile in their language.",
    "A supported domain describes intended scope, not authorization. Claim only capabilities exposed by the current tool catalog.",
    "The following trusted profile instructions define persona, boundaries, and communication style:",
    profile.instructions,
  ].join("\n");
}

/**
 * Every preloaded skill is prepended to the system prompt on every model step of every turn,
 * so this budget is a real cost multiplied across the whole conversation. Exceeding it is a
 * composition mistake to catch at boot, not a context overflow to discover in production.
 *
 * Counted in UTF-8 bytes, not UTF-16 code units, because the cost this budget exists to bound is
 * tokens and bytes track tokens far better across scripts. A string counted in `.length` charges
 * Latin text and non-Latin text the same, while the same sentence in a language outside ASCII
 * costs substantially more to send: the skills in this repo measure about 1.3 bytes per code unit,
 * so a character budget silently allowed roughly a third more than it appeared to. The number
 * below is set so every composition that fit the previous character budget still fits, with
 * comparable headroom — this corrects the unit, it does not tighten or loosen the allowance.
 *
 * Raised from 32,000 once a product needed two procedures always on. Its second runbook had been
 * left to load on demand because the first filled the allowance, and on a real request the model
 * never loaded it: seven steps of the product's main job, done without the runbook for it. A
 * procedure the work depends on does not belong behind a call the model may not make — which is
 * the argument `preloadedSkillPrompt` below already makes — so the allowance has to hold more than
 * one. The startup check on the whole system prompt still bounds what a composition carries.
 */
export const MAX_PRELOADED_SKILL_BYTES = 64_000;

/**
 * The same allowance expressed for a `skill_load` result, whose cap the tool contract enforces in
 * characters rather than bytes.
 *
 * It is a separate constant, not a reuse of the byte budget, because the two are denominated
 * differently and sharing one number would mean a change made for one silently moved the other —
 * with no error, just a different amount of text reaching the model. The value is the character
 * budget that applied before the preload check moved to bytes, so loading a skill on demand is
 * bounded exactly as it was.
 *
 * A procedure skill that carries its own method and audit runs long, and one over the cap is refused
 * whole ("nothing was kept"), so the agent works without it; the cap leaves room for such skills. A skill
 * loaded on demand costs its length once, in the turn that needs it; the preload budget is separate.
 */
/** The platform's persistence rule, at the closing position of every profile's prompt. */
// Short on purpose: it is paid on every turn of every product, and the completion gate enforces the rest.
export const PERSISTENCE = "Keep working until everything asked for is done: when a step fails, look again and try another way; never stop to ask whether to continue.";

export const MAX_SKILL_RESULT_CHARS = 40_000;

/**
 * Resolves the profile's preloaded skills into system-prompt text.
 *
 * Without this a weaker model must notice it needs a skill and call the skill tool before
 * it can act, and a model that skips that step improvises the whole procedure. Preloading
 * makes the listed skills the agent's operating procedure from the first step, which is what
 * keeps procedure in skill files instead of migrating into product code. Skills outside the
 * list stay discoverable and loadable on demand, so a profile scales by choosing which
 * procedures are always-on, not by preloading the whole catalogue.
 */
function preloadedSkillPrompt(profile: AgentProfileDefinition, skills: SkillCatalog, requested: readonly string[]): string | undefined {
  if (requested.length === 0) return undefined;
  const sections = requested.map((skillId) => {
    const skill = skills.get(skillId);
    if (!skill) throw new Error(`Agent profile ${profile.id} preloads an unknown skill: ${skillId}`);
    return `## ${skill.name} (${skill.id}@${skill.version})
${skill.instructions}`;
  });
  const prompt = [
    "# Operating procedures",
    `The following ${sections.length === 1 ? "skill is" : `${sections.length} skills are`} already loaded for you. Apply them directly; do not load them again before acting.`,
    "They define the procedures for this domain. Follow them unless the evidence in front of you contradicts them, and say so when it does.",
    "Other skills stay available to load on demand when a request falls outside these.",
    ...sections,
  ].join("\n");
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes > MAX_PRELOADED_SKILL_BYTES) {
    // Both numbers, because the gap between them is the whole point: whoever hits this will have
    // been reading a character count somewhere and needs to see why it did not predict the limit.
    throw new Error(
      `Agent profile ${profile.id} preloads ${promptBytes} bytes (${prompt.length} characters) of skill instructions, over the ${MAX_PRELOADED_SKILL_BYTES}-byte budget carried on every model step. Preload fewer skills and let the agent load the rest on demand.`,
    );
  }
  return prompt;
}

/** Computed on first read, then kept (the catalog it reads is fixed by then); a provider without entries reads as one that left the field out. */
function onFirstRead<T>(compute: () => readonly T[]): () => readonly T[] | undefined {
  let value: readonly T[] | undefined;
  return () => {
    value ??= compute();
    return value.length > 0 ? value : undefined;
  };
}

/**
 * `skills` is the composition's whole catalog: checked here, at creation, so an unknown preload id or an oversized preload
 * fails the boot. `visibleSkills` (default `skills`) is what every turn reads, the skills this composition can run: the
 * preload text, the closings and the lists core weighs a request against are read from it on first use, never at creation,
 * since a composition may fix that view only after its plugins are active. A preload outside it is never in effect.
 */
export function createAgentProfilePlugin(profile: AgentProfileDefinition, skills?: SkillCatalog, visibleSkills: SkillCatalog | undefined = skills): PluginDescriptor {
  const id = "io.syncroot.base.agent-profile";
  const preloads = profile.preloadSkills ?? [];
  // Rendered once against the whole catalog for its checks only; each turn renders from the view.
  if (skills) preloadedSkillPrompt(profile, skills, preloads);
  const prompt: SystemPromptProvider = {
    id,
    render: async (_security, turn) => {
      const text = visibleSkills ? preloadedSkillPrompt(profile, visibleSkills, preloadsInEffect(visibleSkills, preloads, turn)) : undefined;
      return text ? `${profilePrompt(profile)}\n\n${text}` : profilePrompt(profile);
    },
  };
  if (visibleSkills) describeSkills(prompt, profile, visibleSkills);
  return {
    trustTier: "platform-core",
    manifest: createBuiltinManifest(id, {
      provides: { [CAPABILITIES.systemPrompt]: { version: "1.0.0", cardinality: "multi" } },
    }),
    plugin: createBuiltinPlugin(async (context) => {
      context.registrations.provide(SYSTEM_PROMPT_CAPABILITY, prompt);
      // The closing position holds what must win against everything said before it. The platform's one
      // sentence on persistence goes first (harness guides measure such a line at the end halving early
      // stops; the completion gate enforces the same rule regardless), the profile's own words last.
      const closing = profile.closingInstructions;
      context.registrations.provide(SYSTEM_PROMPT_CAPABILITY, {
        id: `${id}.closing`, position: "closing",
        render: async () => [`# Before you begin\n${PERSISTENCE}`,
          ...(closing ? [`From the same trusted profile, placed last so it is the freshest thing you have read:\n${closing}`] : [])].join("\n"),
      });
      return { dispose: () => undefined };
    }),
    config: {
      profileId: profile.id,
      profileVersion: profile.version,
      contentDigest: profile.contentDigest,
      preloadedSkills: [...(profile.preloadSkills ?? [])],
      // Without the catalog revision, editing a preloaded SKILL.md would change how the agent
      // behaves on every turn while leaving the runtime snapshot fingerprint identical.
      ...(profile.preloadSkills?.length && skills ? { preloadedSkillsRevision: skills.revision } : {}),
    },
  };
}

/** The profile's skill lists on `prompt`, as getters over `skills` (the catalog every turn reads). */
function describeSkills(prompt: SystemPromptProvider, profile: AgentProfileDefinition, skills: SkillCatalog): void {
  const preloads = profile.preloadSkills ?? [];
  const summaries = (skillIds: readonly string[]) => skillIds.flatMap((skillId) => {
    const skill = skills.get(skillId);
    return skill ? [{ id: skill.id, name: skill.name, description: skill.description, ...(skill.role ? { role: skill.role } : {}) }] : [];
  });
  // Skills a turn may go without, offered to core's judge with what they are for.
  const conditional = onFirstRead(() => summaries(profile.conditionalSkills ?? []));
  const preloaded = onFirstRead(() => summaries(preloads));
  // Skills listed but loaded on demand: core may name one the request needs, at the end of the first step.
  const loadable = onFirstRead(() => summaries(skills.list().map((skill) => skill.id).filter((skillId) => !preloads.includes(skillId))));
  // A skill's closing line (`SkillDefinition.closing`) while it is in effect: a preload in this turn's prompt, or loaded in the task.
  const withClosing = onFirstRead(() => skills.list().flatMap(({ id: skillId }) => skills.get(skillId)?.closing ? [skillId] : []));
  const skillClosings = (turn: SystemPromptTurn & { readonly loadedSkills: ReadonlySet<string> }): readonly string[] => {
    const inEffect = new Set([...preloadsInEffect(skills, preloads, turn), ...turn.loadedSkills]);
    return (withClosing() ?? []).filter((skillId) => inEffect.has(skillId)).map((skillId) => skills.get(skillId)!.closing!);
  };
  // The tools the skills in effect require: core keeps the groups holding them on offer, whatever a relevance judgment said.
  const skillTools = (turn: SystemPromptTurn & { readonly loadedSkills: ReadonlySet<string> }): readonly string[] => {
    const inEffect = new Set([...preloadsInEffect(skills, preloads, turn), ...turn.loadedSkills]);
    return [...new Set([...inEffect].flatMap((skillId) => skills.get(skillId)?.requiredTools ?? []))];
  };
  Object.defineProperties(prompt, {
    conditionalSkills: { enumerable: true, get: conditional },
    preloadedSkills: { enumerable: true, get: preloaded },
    loadableSkills: { enumerable: true, get: loadable },
    skillLoader: { enumerable: true, get: () => (loadable() ? SKILL_LOAD_TOOL : undefined) },
    skillClosings: { enumerable: true, get: () => (withClosing() ? skillClosings : undefined) },
    skillTools: { enumerable: true, value: skillTools },
  });
}
