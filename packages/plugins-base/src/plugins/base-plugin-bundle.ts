import type { AgentProfileDefinition, KnowledgeService, MemoryService, SkillCatalog, ToolResultSpool } from "@0xsyncroot/contracts";
import type { PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { createBaseAgentToolPlugins, createReadResultToolPlugin } from "./base-tool-plugins.js";
import { createKnowledgePlugin, createMemoryPlugin, createSkillCatalogPlugin } from "./provider-plugins.js";
import { createSystemPromptPlugin } from "./system-prompt-plugin.js";
import { createAgentProfilePlugin } from "./agent-profile-plugin.js";

export interface BasePluginBundleOptions {
  /** Omit when memory is supplied by a boot-scoped persistence plugin. */
  readonly memory?: MemoryService;
  readonly knowledge: KnowledgeService;
  /** The whole catalog: boot checks only (unknown preload ids, the listing's size, telling a left-out skill from an unknown one). */
  readonly skills: SkillCatalog;
  /** The skills this composition can run, a view over `skills` that every turn reads (absent: `skills`). */
  readonly visibleSkills?: SkillCatalog;
  readonly llm: PluginDescriptor;
  readonly systemPrompt?: string;
  readonly agentProfile?: AgentProfileDefinition;
  /** When set, `read_result` is mounted so the model can read on from a cut tool result. */
  readonly toolResultSpool?: ToolResultSpool;
  /** The runtime mounts its own `calculate` (code on stored results): the expression calculator is left out. */
  readonly codeCalculation?: boolean;
}

export function createBasePluginBundle(options: BasePluginBundleOptions): readonly PluginDescriptor[] {
  const visible = options.visibleSkills ?? options.skills;
  return [
    ...(options.memory ? [createMemoryPlugin(options.memory)] : []),
    createKnowledgePlugin(options.knowledge), createSkillCatalogPlugin(visible),
    createSystemPromptPlugin(options.systemPrompt),
    ...(options.agentProfile ? [createAgentProfilePlugin(options.agentProfile, options.skills, visible)] : []),
    ...createBaseAgentToolPlugins(options.agentProfile?.preloadSkills ?? [], { arithmetic: !options.codeCalculation, fullSkills: options.skills }),
    ...(options.toolResultSpool ? [createReadResultToolPlugin(options.toolResultSpool)] : []), options.llm,
  ];
}
