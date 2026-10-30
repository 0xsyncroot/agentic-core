import { loadMarkdownAgentProfile } from "@0xsyncroot/adapter-agent-profile-markdown";
import { loadMarkdownSkillCatalog } from "@0xsyncroot/adapter-skills-markdown";
import { SignedHttpToolExecutionBroker } from "@0xsyncroot/adapter-tool-broker-http";
import { AesGcmEnvelopeProtector, DerivedTenantKeyProvider } from "@0xsyncroot/adapter-crypto-node";
import { type ActorSettingStore, type MemoryService, type PublicAgentProfile, type ResumableAgent, type SecurityContext, type SessionStore } from "@0xsyncroot/contracts";
import { ConfiguredContextCompactionPolicy, DEFAULT_AGENT_OPTIONS, DefaultAgentLoop, InMemoryToolResultSpool, DeterministicConversationCompactor, PermissionToolExecutionPolicy, PluginHost, acquireRuntimeView, resolveLlmModel,
  type RuntimeResolutionRequest, type RuntimeViewLease } from "@0xsyncroot/core";
import { ACTOR_SETTING_CAPABILITY, LLM_CAPABILITY, MEMORY_CAPABILITY, SESSION_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import { TOOLS_LOAD_TOOL, BaseMemoryContextPolicy, InMemoryKnowledgeService } from "@0xsyncroot/plugins-base";
import { bindToolOffers, type RequiredPromptUsage } from "./required-prompt-budget.js";
import { startCatalogRuntime, type CatalogRuntime } from "./catalog/catalog-generations.js";
import { InfraExports } from "./catalog/infra-exports.js";
import { checkMountedRuntime, composedArtifactVerifier, runtimeMount, type MountedRuntime } from "./runtime-mount.js";
import { loadKnowledgeDocuments } from "./object-store-knowledge-loader.js";
import { AuthenticatedSharedRuntimeProvider } from "./authenticated-shared-runtime-provider.js";
import { createJudgmentPort, judgmentFallbackModel, judgmentSeamModes } from "./judgment-provider.js";
import { createLlmPlugin } from "./providers/llm-provider-catalog.js";
import { createMcpPlugins } from "./providers/mcp-plugin-catalog.js";
import { createPersistencePlugins, PersistenceResourceRegistry } from "./providers/persistence-provider-catalog.js";
import { readRuntimeSettings, type PersistenceSelection, type RuntimeConfig } from "./runtime-config.js";
import type { RuntimeCompositionDependencies } from "./runtime-dependencies.js";

export type { FirstPartyPluginBundle, RuntimeCompositionDependencies } from "./runtime-dependencies.js";

export interface BlankRuntime {
  readonly agent: ResumableAgent;
  readonly host: PluginHost;
  readonly sessions: SessionStore;
  readonly memory: MemoryService;
  /** Per-person settings, from the engine that keeps the sessions (every engine has one). */
  readonly settings: ActorSettingStore;
  readonly config: RuntimeConfig;
  readonly model: {
    readonly providerId: string;
    readonly modelId: string;
    readonly routeRevision: string;
    readonly metadataSource: string;
    readonly contextWindowTokens?: number;
    readonly maxOutputTokens?: number;
    readonly features: { readonly textStreaming: boolean; readonly privateReasoning: boolean };
  };
  readonly storage: PersistenceSelection;
  readonly knowledgeDocuments: number;
  readonly availableTools: readonly { readonly id: string; readonly description: string }[];
  /** The skills' write preconditions, merged (`catalogPreconditions`); empty when none declares one. Enforced only where a composition mounts `withToolPreconditions`. */
  readonly preconditions: ReadonlyMap<string, readonly string[]>;
  /** The size the startup check measured: the required system prompt of a turn offered every tool some turn can be offered. */
  readonly requiredPrompt: RequiredPromptUsage;
  readonly agentProfile?: PublicAgentProfile;
  /**
   * Leases a runtime view from the provider the agent loop uses, with every check it applies (listed agents, authentication
   * evidence, pin) and the same default agent profile. For composition, checks and tests only: a turn's runtime is acquired
   * inside the agent loop, never through this.
   */
  acquireRuntime(request: RuntimeResolutionRequest): Promise<RuntimeViewLease>;
  close(): Promise<void>;
}

function withDefaultAgentProfile(agent: ResumableAgent, agentProfileId: string | undefined): ResumableAgent {
  if (!agentProfileId) return agent;
  const selected = <T extends { readonly agentProfileId?: string }>(input: T): T =>
    input.agentProfileId ? input : { ...input, agentProfileId };
  return Object.freeze({
    runTurn: (input: Parameters<ResumableAgent["runTurn"]>[0]) => agent.runTurn(selected(input)),
    resumeTurn: (input: Parameters<ResumableAgent["resumeTurn"]>[0]) => agent.resumeTurn(selected(input)),
    resumeInteraction: (input: Parameters<ResumableAgent["resumeInteraction"]>[0]) => agent.resumeInteraction(selected(input)),
  });
}

export async function createBlankRuntime(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: RuntimeCompositionDependencies = {},
): Promise<BlankRuntime> {
  const { config, secrets } = readRuntimeSettings(env);
  const { catalog } = dependencies;
  if (catalog && (dependencies.runtimeProviderFactory || dependencies.additionalPlugins)) {
    throw new Error("Catalog routing replaces the runtime provider factory and the additional plugins; compose one or the other");
  }
  if (config.profile === "production" && !dependencies.runtimeProviderFactory && !catalog) {
    throw new Error("Production composition requires an explicit tenant/profile RuntimeProvider factory or catalog routing");
  }
  if (config.profile === "production" && dependencies.admissionController?.productionSafe !== true) {
    throw new Error("Production composition requires a production-safe shared TurnAdmissionController");
  }
  const protector = secrets.dataEncryptionRootKey
    ? new AesGcmEnvelopeProtector(new DerivedTenantKeyProvider(secrets.dataEncryptionRootKey, secrets.dataEncryptionKeyId))
    : undefined;
  const knowledgeDocuments = await loadKnowledgeDocuments(config.knowledgeRoots, config.profile);
  const baseKnowledge = new InMemoryKnowledgeService(knowledgeDocuments);
  const knowledge = dependencies.decorateKnowledge?.(baseKnowledge) ?? baseKnowledge;
  // Under catalog routing each generation brings its own skills and profile; the boot host reads neither.
  const skills = catalog ? undefined : await loadMarkdownSkillCatalog({ roots: config.skillRoots });
  const agentProfile = !catalog && config.agentProfileFile
    ? await loadMarkdownAgentProfile({ file: config.agentProfileFile })
    : undefined;
  const baseLlm = createLlmPlugin(config, secrets);
  const judgment = createJudgmentPort(env);
  const fallbackModel = judgmentFallbackModel(env);
  const llm = dependencies.decorateLlmPlugin?.(baseLlm) ?? baseLlm;
  const host = new PluginHost({
    policyRevisions: {
      policy: config.policyRevision,
      memoryPolicy: config.memoryPolicyRevision,
    },
  });
  const persistenceRegistry = new PersistenceResourceRegistry();
  const bootstrapSecurity: SecurityContext = {
    tenantId: "platform-bootstrap",
    actorId: "platform-bootstrap",
    permissions: new Set(),
    correlationId: crypto.randomUUID(),
    purpose: "platform-bootstrap",
  };

  let catalogRuntime: CatalogRuntime | undefined;
  try {
    // Whole results the runtime had to cut, kept for `read_result`; in memory until a pilot says otherwise.
    const toolResultSpool = dependencies.toolResultSpool ?? new InMemoryToolResultSpool();
    const mount = skills
      ? runtimeMount({ config, dependencies, knowledge, skills, ...(agentProfile ? { agentProfile } : {}), llm, toolResultSpool, judgment })
      : undefined;
    const persistence = await createPersistencePlugins(config.persistence, secrets, persistenceRegistry, protector, config.mysqlPoolSize, config.sessionRedis);
    const connectors = createMcpPlugins(config, secrets, { stdioEnvironment: env,
      ...(dependencies.mcpAuthorizationResolvers ? { authorizationResolvers: dependencies.mcpAuthorizationResolvers } : {}),
      ...(dependencies.mcpStdioCommandAllowlist ? { stdioCommandAllowlist: dependencies.mcpStdioCommandAllowlist } : {}),
      ...(dependencies.mcpStdioCommandPaths ? { stdioCommandPaths: dependencies.mcpStdioCommandPaths } : {}),
    });
    // With catalog routing the boot host holds the infra plugins only; each generation re-exports them where they stood.
    const infraExports = mount ? undefined : new InfraExports([...persistence, llm, ...connectors]);
    const plugins = infraExports?.descriptors
      ?? [...persistence, ...mount!.leading, ...connectors, ...mount!.trailing, ...dependencies.additionalPlugins?.descriptors ?? []];
    await host.activate(plugins, { security: bootstrapSecurity, verifyArtifact: composedArtifactVerifier(dependencies.additionalPlugins) });
    let model: BlankRuntime["model"];
    const sessions: SessionStore = host.capabilities.require(SESSION_CAPABILITY);
    const memory: MemoryService = host.capabilities.require(MEMORY_CAPABILITY);
    const settings = host.capabilities.require(ACTOR_SETTING_CAPABILITY);
    const mountedLlm = host.capabilities.require(LLM_CAPABILITY);
    const resolvedModel = await resolveLlmModel(mountedLlm, new AbortController().signal);
    const routeContextChars = resolvedModel.contextWindowTokens
      ? Math.floor(resolvedModel.contextWindowTokens *
        (resolvedModel.estimatedCharsPerToken ?? config.contextCompaction.estimatedCharsPerToken))
      : DEFAULT_AGENT_OPTIONS.maxContextChars;
    const baselineToolPolicy = new PermissionToolExecutionPolicy();
    const toolExecutionPolicy = bindToolOffers(dependencies.toolExecutionPolicyFactory?.(baselineToolPolicy) ?? baselineToolPolicy);
    const defaultRouteRevision = `harness:${config.policyRevision}:${resolvedModel.routeRevision}`;
    if (catalog && infraExports) {
      catalogRuntime = await startCatalogRuntime({ catalog, config, dependencies, infra: host, infraExports,
        routeRevision: defaultRouteRevision, knowledge, llm, toolResultSpool, judgment, policy: toolExecutionPolicy,
        security: bootstrapSecurity, routeContextChars });
    }
    const described: MountedRuntime & { readonly agentProfile?: PublicAgentProfile } = catalogRuntime?.boot ?? {
      ...await checkMountedRuntime({ capabilities: host.capabilities, skills: skills!, visibleSkills: mount!.visibleSkills,
        policy: toolExecutionPolicy, security: bootstrapSecurity, routeContextChars }),
      ...(agentProfile ? { agentProfile: Object.freeze({ id: agentProfile.id, version: agentProfile.version, name: agentProfile.name,
        description: agentProfile.description, supportedDomains: agentProfile.supportedDomains }) } : {}),
    };
    model = {
      providerId: resolvedModel.providerId,
      modelId: resolvedModel.modelId,
      routeRevision: resolvedModel.routeRevision,
      metadataSource: resolvedModel.metadataSource,
      ...(resolvedModel.contextWindowTokens ? { contextWindowTokens: resolvedModel.contextWindowTokens } : {}),
      ...(resolvedModel.maxOutputTokens ? { maxOutputTokens: resolvedModel.maxOutputTokens } : {}),
      features: {
        textStreaming: mountedLlm.features?.textStreaming ?? false,
        privateReasoning: mountedLlm.features?.privateReasoning ?? false,
      },
    };
    const toolExecutionBroker = config.toolBrokerUrl && secrets.toolBrokerSecret
      ? new SignedHttpToolExecutionBroker({
          baseUrl: config.toolBrokerUrl, secret: secrets.toolBrokerSecret,
          allowInsecureLoopback: config.profile === "development",
        })
      : undefined;
    const defaultAgentProfileId = catalog ? catalog.agentIds[0] : agentProfile?.id;
    const runtimeProvider = catalogRuntime?.provider ?? dependencies.runtimeProviderFactory?.({
      defaultSource: host,
      defaultRouteRevision,
    }) ?? new AuthenticatedSharedRuntimeProvider(host, defaultRouteRevision, agentProfile?.id ?? "default");
    // One tool result may take a sixteenth of the model's input window, between the default and 200k
    // characters. A fixed 32k was a quarter of the 120k fallback; against a 1M-token window it cut a
    // 113-row catalogue to 56 rows, and the model then had nothing to answer from.
    const maxToolResultChars = resolvedModel.contextWindowTokens
      ? Math.min(200_000, Math.max(DEFAULT_AGENT_OPTIONS.maxToolResultChars, Math.floor(routeContextChars / 16)))
      : DEFAULT_AGENT_OPTIONS.maxToolResultChars;
    const agentOptions = { maxToolResultChars, maxSteps: dependencies.agentMaxSteps ?? config.agentMaxSteps, maxToolCalls: dependencies.agentMaxToolCalls ?? config.agentMaxToolCalls,
      turnTimeoutMs: dependencies.agentTurnTimeoutMs ?? config.agentTurnTimeoutMs, llmAttemptTimeoutMs: config.agentLlmAttemptTimeoutMs,
      llmHedgeAfterMs: config.agentLlmHedgeAfterMs, interactionTtlMs: config.interactionTtlMs,
      maxObservationRounds: config.agentMaxObservationRounds, maxAnswerChars: config.agentMaxAnswerChars,
      memoryContextTimeoutMs: config.agentMemoryContextTimeoutMs };
    const agent = new DefaultAgentLoop(runtimeProvider, sessions, agentOptions, {
      memoryContextPolicy: new BaseMemoryContextPolicy(),
      toolResultSpool,
      ...(dependencies.modelInstructions ? { modelInstructions: dependencies.modelInstructions } : {}),
      ...(dependencies.continueQuestion ? { continueQuestion: dependencies.continueQuestion } : {}),
      conversationCompactor: new DeterministicConversationCompactor(2, "deterministic-v4", dependencies.modelInstructions?.compaction),
      contextCompactionPolicy: new ConfiguredContextCompactionPolicy({
        ...config.contextCompaction,
        revision: `runtime:${config.policyRevision}`,
      }),
      ...(dependencies.admissionController ? { admissionController: dependencies.admissionController } : {}),
      ...(dependencies.telemetry ? { telemetry: dependencies.telemetry } : {}),
      ...(judgment ? { judgmentSeams: judgmentSeamModes(env, dependencies.judgmentSeams) } : {}),
      ...(dependencies.nextCallSources ? { nextCallSources: dependencies.nextCallSources } : {}),
      ...(judgment && fallbackModel ? { judgmentFallbackModel: fallbackModel } : {}),
      ...(dependencies.turnControlPolicy ? { turnControlPolicy: dependencies.turnControlPolicy } : {}),
      ...(dependencies.turnContextProvider ? { turnContextProvider: dependencies.turnContextProvider } : {}),
      ...(dependencies.standingApproval ? { standingApproval: dependencies.standingApproval } : {}),
      ...(dependencies.toolGroups ? { toolGroups: { groups: dependencies.toolGroups, loader: TOOLS_LOAD_TOOL } } : {}),
      toolExecutionPolicy,
      ...(toolExecutionBroker ? { toolExecutionBroker } : {}),
    });
    return {
      agent: withDefaultAgentProfile(agent, defaultAgentProfileId),
      host,
      sessions,
      memory,
      settings,
      config,
      model,
      storage: config.persistence,
      knowledgeDocuments: knowledgeDocuments.length,
      availableTools: described.availableTools,
      preconditions: described.preconditions,
      requiredPrompt: described.requiredPrompt,
      ...(described.agentProfile ? { agentProfile: described.agentProfile } : {}),
      acquireRuntime: (request) => acquireRuntimeView(runtimeProvider,
        request.agentProfileId || !defaultAgentProfileId ? request : { ...request, agentProfileId: defaultAgentProfileId }),
      close: async () => {
        const errors: unknown[] = [];
        // Generations hold leases on the boot host, so they shut down first.
        try { await catalogRuntime?.provider.close(); } catch (error) { errors.push(error); }
        try { await host.shutdown(); } catch (error) { errors.push(error); }
        try { await persistenceRegistry.closeAll(); } catch (error) { errors.push(error); }
        if (errors.length > 0) throw new AggregateError(errors, "Runtime shutdown completed with errors");
      },
    };
  } catch (error) {
    const errors: unknown[] = [error];
    try {
      await catalogRuntime?.provider.close();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    try {
      await host.shutdown();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    try {
      await persistenceRegistry.closeAll();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    if (errors.length > 1) throw new AggregateError(errors, "Runtime composition and cleanup both failed");
    throw error;
  }
}
