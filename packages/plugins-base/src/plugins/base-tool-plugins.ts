import { CAPABILITIES, type SkillCatalog, type SystemPromptProvider, type SystemPromptTurn, type ToolDefinition, type ToolGroup, type ToolResultSpool } from "@0xsyncroot/contracts";
import {
  KNOWLEDGE_CAPABILITY,
  MEMORY_CAPABILITY,
  SKILL_CAPABILITY,
  SYSTEM_PROMPT_CAPABILITY,
  TOOL_CAPABILITY,
  WORK_PLANNING_CAPABILITY,
  type PluginDescriptor,
} from "@0xsyncroot/plugin-sdk";
import { createKnowledgeTools } from "../tools/knowledge-tools.js";
import { createMemorySearchTool } from "../tools/memory-tool.js";
import { createWorkPlanningProvider } from "../tools/plan-tool.js";
import { createSkillTools } from "../tools/skill-tools.js";
import { createUtilityTools } from "../tools/utility-tools.js";
import { createReadResultTool } from "../tools/read-result-tool.js";
import { createUserInputTool } from "../tools/user-input-tool.js";
import { createToolsLoadTool } from "../tools/tools-load-tool.js";
import { createBuiltinManifest, createBuiltinPlugin } from "./builtin-plugin.js";
import { preloadsInEffect } from "./skill-availability.js";

function toolManifest(id: string, requires: Readonly<Record<string, string>> = {}) {
  return createBuiltinManifest(id, {
    requires,
    provides: { [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } },
    permissions: { capabilities: Object.keys(requires) },
  });
}

function registerTools(context: Parameters<Parameters<typeof createBuiltinPlugin>[0]>[0], tools: readonly ToolDefinition[]): void {
  for (const tool of tools) context.registrations.provide(TOOL_CAPABILITY, tool);
}

export function createKnowledgeToolsPlugin(): PluginDescriptor {
  const id = "io.syncroot.base.knowledge-tools";
  return {
    trustTier: "platform-core",
    manifest: toolManifest(id, { [CAPABILITIES.knowledge]: "^1.0.0" }),
    plugin: createBuiltinPlugin(async (context) => {
      const knowledge = context.capabilities.require(KNOWLEDGE_CAPABILITY);
      registerTools(context, createKnowledgeTools(knowledge));
      return { dispose: () => undefined };
    }),
  };
}

export function createMemoryToolsPlugin(): PluginDescriptor {
  const id = "io.syncroot.base.memory-tools";
  const manifest = createBuiltinManifest(id, {
    requires: { [CAPABILITIES.memory]: "^1.0.0" },
    provides: { [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } },
    permissions: {
      capabilities: [CAPABILITIES.memory],
      capabilityOperations: { [CAPABILITIES.memory]: ["read"] },
    },
  });
  return {
    trustTier: "platform-core",
    manifest,
    plugin: createBuiltinPlugin(async (context) => {
      const memory = context.capabilities.require(MEMORY_CAPABILITY);
      registerTools(context, [createMemorySearchTool(memory)]);
      return { dispose: () => undefined };
    }),
  };
}

/**
 * `fullSkills` is the composition's whole catalog, read at activation only (the listing's size) and by `skill_load` to tell
 * a skill this composition leaves out from an unknown id. Every turn reads the `SKILL_CAPABILITY` catalog: the skills it can
 * run. Absent, the capability is both.
 */
export function createSkillToolsPlugin(preloadedSkillIds: readonly string[] = [], fullSkills?: SkillCatalog): PluginDescriptor {
  const id = "io.syncroot.base.skill-tools";
  return {
    trustTier: "platform-core",
    manifest: createBuiltinManifest(id, {
      requires: { [CAPABILITIES.skills]: "^1.0.0" },
      provides: {
        [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" },
        [CAPABILITIES.systemPrompt]: { version: "1.0.0", cardinality: "multi" },
      },
      permissions: { capabilities: [CAPABILITIES.skills] },
    }),
    plugin: createBuiltinPlugin(async (context) => {
      const skills = context.capabilities.require(SKILL_CAPABILITY);
      const catalog = fullSkills ?? skills;
      // A preloaded skill's full text is already in the system prompt. Telling the model to
      // load it anyway costs a step and re-injects the same instructions as a tool result.
      const listing = (source: SkillCatalog, turn?: SystemPromptTurn) => {
        const preloaded = new Set(preloadsInEffect(source, preloadedSkillIds, turn));
        const available = source.list().map(({ id: skillId, version, name, description }) => ({
          id: skillId, version, name, description,
          ...(preloaded.has(skillId) ? { alreadyLoaded: true } : {}),
        }));
        return { encodedSkills: JSON.stringify(available), loadable: available.filter((skill) => !preloaded.has(skill.id)) };
      };
      if (listing(catalog).encodedSkills.length > 32_000) {
        throw new Error("Available skill metadata exceeds the 32000-character system-prompt budget");
      }
      registerTools(context, createSkillTools(skills, catalog));
      const prompt: SystemPromptProvider = {
        id: `${id}.prompt`,
        // A preloaded skill left out of this turn (its judge found it unneeded, or a tool it requires is absent this turn only)
        // is listed as loadable, so the model can still load it. A skill the composition can never run is not listed at all.
        render: async (_security, turn) => { const { encodedSkills, loadable } = listing(skills, turn); return [
            "Curated skills are trusted, versioned operating instructions selected by the active runtime profile.",
            `Available skills (metadata only): ${encodedSkills}`,
            ...(loadable.length > 0
              ? ["Before answering or acting on a request that matches a skill not marked alreadyLoaded, call skill_load for that skill and follow its instructions."]
              : []),
            "A skill marked alreadyLoaded is in your instructions already: apply it directly and do not load it again.",
            "Use skill_list if the compact metadata is insufficient. A skill guides behavior but never grants a missing tool or permission.",
          ].join("\n"); },
      };
      context.registrations.provide(SYSTEM_PROMPT_CAPABILITY, prompt);
      return { dispose: () => undefined };
    }),
  };
}

export function createUtilityToolsPlugin(options: { readonly arithmetic?: boolean } = {}): PluginDescriptor {
  const id = "io.syncroot.base.utility-tools";
  return {
    trustTier: "platform-core",
    manifest: toolManifest(id),
    plugin: createBuiltinPlugin(async (context) => {
      registerTools(context, createUtilityTools(options));
      return { dispose: () => undefined };
    }),
  };
}

export function createWorkPlanningPlugin(): PluginDescriptor {
  const id = "io.syncroot.base.work-planning";
  return {
    trustTier: "platform-core",
    manifest: createBuiltinManifest(id, {
      provides: {
        [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" },
        [CAPABILITIES.workPlanning]: { version: "1.0.0", cardinality: "single" },
        [CAPABILITIES.systemPrompt]: { version: "1.0.0", cardinality: "multi" },
      },
    }),
    plugin: createBuiltinPlugin(async (context) => {
      const workPlanning = createWorkPlanningProvider();
      const markId = workPlanning.markDefinition.id;
      const prompt: SystemPromptProvider = {
        id: `${id}.prompt`,
        render: async () => [
          `${workPlanning.definition.id} is what the user watches while you work: publish it, in the language the user is writing in. A short sentence beside a business tool call is shown too, as a progress note; what a step found still goes in that step's outcome.`,
          `Publish a concise plan through ${workPlanning.definition.id} as the first action of any request you expect to take more than one action — before the first business tool call, not after the work. A plan published once the work is done showed the user nothing while they waited.`,
          "One sentence written beside that first plan update, before any other call, is shown to the user as your opening line; the runtime delivers it and you keep working right after — do not wait for a reply to it.",
          "When you stop to ask the user something, leave the step you are asking about in progress and the later steps pending. Marking a step completed says the user already answered.",
          `Keep exactly one plan step in progress. Once the plan exists, when a step's status changes, send ${markId} with its id, status and a one-sentence outcome (numbers you observed when completed), in the same step as the work: the step you finished, beside the first call of the next one. Revise the plan with ${workPlanning.definition.id} only when evidence changes the approach. Mark a step completed only once you have seen the result that completes it, never beside the call that does it.`,
          "Your final answer is a reply with no tool call, planning calls included: when you give it, the runtime closes the plan from the results.",
          "Do not change the plan after every tool call while the same plan step is still in progress; group related actions under that step.",
          "The plan is shown to the user as a live activity trace, so write every step description for them:",
          "- in the language the user is writing in, plain and friendly, one short line, no tool, system or internal identifiers;",
          "- a pending or in-progress step states the intent (\"Check August timekeeping data\");",
          "- a completed step's outcome states the concrete result you observed, including the numbers that matter (\"Retrieved 152 employees\", \"Found 3 employees with missing data\"). Never claim an outcome a tool result did not show.",
          "Calls whose arguments you already know may go together in one step, in the order they must run: the runtime runs them in that order, stops the ones that change state or ask the user after the first call that does not succeed, and returns every result at once. A call that depends on a result you have not seen yet waits for the next step.",
          "When a step's results arrive, decide whether they added evidence. Do not repeat equivalent actions that produce no new information.",
          "When required evidence or input is unavailable, stop: ask one free fact in chat with no tool call, or call request_user_input for a choice among known options or a guessable open answer — never continue on speculative actions.",
        ].join("\n"),
      };
      registerTools(context, [workPlanning.definition, workPlanning.markDefinition]);
      context.registrations.provide(WORK_PLANNING_CAPABILITY, workPlanning);
      context.registrations.provide(SYSTEM_PROMPT_CAPABILITY, prompt);
      return { dispose: () => undefined };
    }),
  };
}

export function createUserInputToolsPlugin(): PluginDescriptor {
  const id = "io.syncroot.base.user-input";
  return {
    trustTier: "platform-core",
    manifest: toolManifest(id),
    plugin: createBuiltinPlugin(async (context) => {
      registerTools(context, [createUserInputTool()]);
      return { dispose: () => undefined };
    }),
  };
}

/** `tools_load`, for a composition that declares tool groups: the way to a group a turn was not offered. */
export function createToolsLoadToolPlugin(groups: readonly ToolGroup[]): PluginDescriptor {
  const id = "io.syncroot.base.tools-load";
  return {
    trustTier: "platform-core",
    manifest: toolManifest(id),
    plugin: createBuiltinPlugin(async (context) => {
      registerTools(context, [createToolsLoadTool(groups)]);
      return { dispose: () => undefined };
    }),
  };
}

export function createReadResultToolPlugin(spool: ToolResultSpool): PluginDescriptor {
  const id = "io.syncroot.base.read-result";
  return {
    trustTier: "platform-core",
    manifest: toolManifest(id),
    plugin: createBuiltinPlugin(async (context) => {
      registerTools(context, [createReadResultTool(spool)]);
      return { dispose: () => undefined };
    }),
  };
}

/** Composition helper only; each returned descriptor remains independently removable. `fullSkills`: see `createSkillToolsPlugin`. */
export function createBaseAgentToolPlugins(
  preloadedSkillIds: readonly string[] = [], options: { readonly arithmetic?: boolean; readonly fullSkills?: SkillCatalog } = {},
): readonly PluginDescriptor[] {
  return [
    createKnowledgeToolsPlugin(),
    createMemoryToolsPlugin(),
    createSkillToolsPlugin(preloadedSkillIds, options.fullSkills),
    createUtilityToolsPlugin(options),
    createUserInputToolsPlugin(),
    createWorkPlanningPlugin(),
  ];
}
