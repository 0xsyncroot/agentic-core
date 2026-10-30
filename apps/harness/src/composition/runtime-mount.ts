import { createEchoToolPlugin } from "@0xsyncroot/adapter-echo";
import { createCalculationToolPlugin } from "@0xsyncroot/adapter-calculation-quickjs";
import type { AgentProfileDefinition, JudgmentPort, KnowledgeService, SecurityContext, SkillCatalog, ToolExecutionPolicy, ToolResultSpool } from "@0xsyncroot/contracts";
import { CONTEXTUAL_TOOL_SOURCE_CAPABILITY, SYSTEM_PROMPT_CAPABILITY, TOOL_CAPABILITY, type PluginDescriptor, type ScopedCapabilityResolver } from "@0xsyncroot/plugin-sdk";
import { createBasePluginBundle, createJudgmentPlugin, createRankCandidatesPlugin, createToolsLoadToolPlugin } from "@0xsyncroot/plugins-base";
import { enforceRequiredPromptBudget, unofferableSkillIds, type RequiredPromptUsage } from "./required-prompt-budget.js";
import type { RuntimeCompositionDependencies } from "./runtime-dependencies.js";
import type { RuntimeConfig } from "./runtime-config.js";
import { SealableSkillCatalog } from "./skill-catalog-view.js";
import { catalogPreconditions } from "./skill-preconditions.js";

/** The platform plugins a runtime mounts around its skills and profile, in the order every composition mounts them. */
export interface RuntimeMount {
  /** What every turn reads; sealed by `checkMountedRuntime` once the host is active. */
  readonly visibleSkills: SealableSkillCatalog;
  /** The base bundle and `calculate`: what comes before the connectors. */
  readonly leading: readonly PluginDescriptor[];
  /** Diagnostics, `tools_load` and the judgment tools: what comes after the connectors. */
  readonly trailing: readonly PluginDescriptor[];
}

export function runtimeMount(input: {
  readonly config: RuntimeConfig;
  readonly dependencies: RuntimeCompositionDependencies;
  readonly knowledge: KnowledgeService;
  readonly skills: SkillCatalog;
  readonly agentProfile?: AgentProfileDefinition;
  /** The model plugin, placed where the base bundle places it; a generation leaves it out by reference, the infra host owns it. */
  readonly llm: PluginDescriptor;
  readonly toolResultSpool: ToolResultSpool;
  readonly judgment: JudgmentPort | undefined;
}): RuntimeMount {
  const { config, dependencies, skills, agentProfile, llm, toolResultSpool, judgment } = input;
  const visibleSkills = new SealableSkillCatalog(skills);
  return {
    visibleSkills,
    leading: [
      ...createBasePluginBundle({ knowledge: input.knowledge, skills, visibleSkills, llm, toolResultSpool, codeCalculation: true,
        ...(agentProfile ? { agentProfile } : {}) }),
      // Exact figures by code, on the same retained results `read_result` pages through.
      createCalculationToolPlugin(toolResultSpool, dependencies.calculationViews ? { views: dependencies.calculationViews } : {}),
    ],
    trailing: [
      ...(config.enableDiagnosticTools ? [createEchoToolPlugin()] : []),
      ...(dependencies.toolGroups ? [createToolsLoadToolPlugin(dependencies.toolGroups)] : []),
      // Mount the explicitly selected typed-judgment provider; absent providers leave seams on their fallback paths.
      ...(judgment ? [createJudgmentPlugin(judgment), createRankCandidatesPlugin(judgment)] : []),
    ],
  };
}

/** What the boot checks of one active host found. */
export interface MountedRuntime {
  readonly availableTools: readonly { readonly id: string; readonly description: string }[];
  readonly preconditions: ReadonlyMap<string, readonly string[]>;
  readonly requiredPrompt: RequiredPromptUsage;
}

/**
 * The checks every active host passes before it serves a turn: each skill's tools are mounted, the skills no turn can follow
 * leave the view, and the required prompt of a turn offered every offerable tool fits the budget. A failure throws.
 */
export async function checkMountedRuntime(input: {
  readonly capabilities: ScopedCapabilityResolver;
  readonly skills: SkillCatalog;
  readonly visibleSkills: SealableSkillCatalog;
  readonly policy: ToolExecutionPolicy;
  readonly security: SecurityContext;
  readonly routeContextChars: number;
}): Promise<MountedRuntime> {
  const { capabilities, skills, policy } = input;
  const mountedTools = capabilities.all(TOOL_CAPABILITY);
  const mountedToolIds = new Set(mountedTools.map((tool) => tool.id));
  /**
   * A contextual source's own tool list is unknowable at boot: discovery is per-principal and
   * plugin activation is deliberately network-free (see contextual-plugin.ts in adapter-mcp).
   * What this can verify is that some mounted source actually owns the required tool's
   * namespace — a `ContextualToolSource.id` is `mcp_<serverId>` and its tools are
   * `mcp_<serverId>_<name>` (underscore, not dot: OpenAI/DeepSeek/Anthropic all reject a dotted
   * `function.name`, so mcpToolId in adapter-mcp mints ids this way) — which still catches the
   * boot-time mistakes this check exists for (a typo'd server id, a connector nobody configured)
   * without claiming knowledge the composition does not have. Whether the remote server actually
   * exposes that specific tool is checked where it belongs: at dispatch, against the live
   * discovered catalog.
   */
  const contextualSourceIds = capabilities.all(CONTEXTUAL_TOOL_SOURCE_CAPABILITY).map((source) => source.id);
  const toolIsSatisfied = (toolId: string): boolean =>
    mountedToolIds.has(toolId) || contextualSourceIds.some((sourceId) => toolId.startsWith(`${sourceId}_`));
  const missingSkillTools = skills.list().flatMap((skill) =>
    skill.requiredTools
      .filter((toolId) => !toolIsSatisfied(toolId))
      .map((toolId) => `${skill.id} requires "${toolId}", but no static tool and no configured MCP connector provides it`));
  if (missingSkillTools.length > 0) {
    throw new Error(`Curated skills require tools that are not mounted:\n${missingSkillTools.join("\n")}`);
  }
  // A skill that needs a tool this policy never offers leaves every turn's catalog, by the budget's own predicate.
  input.visibleSkills.seal(unofferableSkillIds({ mounted: mountedTools, contextualSourceIds, skills: skills.list(), policy }));
  // Sized for the tools some turn can be offered under this policy: a skill no turn sends does not count.
  const requiredPrompt = await enforceRequiredPromptBudget({ prompts: capabilities.all(SYSTEM_PROMPT_CAPABILITY),
    security: input.security, routeContextChars: input.routeContextChars, mounted: mountedTools, contextualSourceIds,
    skills: skills.list(), policy });
  return {
    availableTools: mountedTools.map(({ id, description }) => ({ id, description })),
    preconditions: catalogPreconditions(skills),
    requiredPrompt,
  };
}

/**
 * Who may be mounted: a platform plugin assembled by this composition, or a product plugin the composition itself supplied
 * and the product's verifier accepts. A declared trust tier alone is never enough.
 */
export function composedArtifactVerifier(product?: {
  readonly descriptors: readonly PluginDescriptor[];
  readonly verifyArtifact: (descriptor: PluginDescriptor) => Promise<boolean>;
}): (descriptor: PluginDescriptor) => Promise<boolean> {
  const descriptors = product?.descriptors ?? [];
  for (const descriptor of descriptors) {
    if (descriptor.trustTier !== "first-party-domain") {
      throw new Error(`Additional plugin ${descriptor.manifest.id} must use the first-party-domain trust tier`);
    }
  }
  const supplied = new Set(descriptors.map((descriptor) => descriptor.plugin));
  return async (descriptor) => {
    if (descriptor.trustTier === "platform-core") {
      return descriptor.manifest.artifact.digest.startsWith("builtin:") && descriptor.manifest.artifact.signature === "trusted-assembly";
    }
    return descriptor.trustTier === "first-party-domain" && supplied.has(descriptor.plugin) && Boolean(await product?.verifyArtifact(descriptor));
  };
}
