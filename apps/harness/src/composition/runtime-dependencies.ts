import type { AgentTelemetrySink, KnowledgeService, ToolExecutionPolicy, ToolGroup, ToolResultSpool, TurnAdmissionController, TurnContextProvider, TurnControlPolicy } from "@0xsyncroot/contracts";
import type { AgentRuntimeDependencies, RuntimeProvider, RuntimeSnapshotSource } from "@0xsyncroot/core";
import type { PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import type { CalculationViews } from "@0xsyncroot/adapter-calculation-quickjs";
import type { McpCompositionDependencies } from "./providers/mcp-plugin-catalog.js";
import type { CatalogCompositionDependencies } from "./catalog/catalog-generations.js";

export interface FirstPartyPluginBundle {
  /** Product-owned descriptors selected explicitly by this composition root. */
  readonly descriptors: readonly PluginDescriptor[];
  /** Product/control-plane artifact verifier. Trust tier declarations alone are never sufficient. */
  readonly verifyArtifact: (descriptor: PluginDescriptor) => Promise<boolean>;
}

export interface RuntimeCompositionDependencies {
  /** Product language for model-facing runtime notices; the neutral harness defaults to English. */
  readonly modelInstructions?: AgentRuntimeDependencies["modelInstructions"];
  /** The product's words for asking whether to go on after the runtime's own limit stopped a turn; omitted, it never asks. */
  readonly continueQuestion?: AgentRuntimeDependencies["continueQuestion"];
  /** A product's measured defaults for the fast-judgment seams; AGENTIC_JUDGMENT_MODE=shadow turns the ones that are on into shadow. */
  readonly judgmentSeams?: AgentRuntimeDependencies["judgmentSeams"];
  /** Where else the product's data lives besides the attached files, each in one sentence, for the `next-call` judge. */
  readonly nextCallSources?: AgentRuntimeDependencies["nextCallSources"];
  /** Platform/control-plane OAuth resolvers keyed by non-secret authProfileRef. */
  readonly mcpAuthorizationResolvers?: McpCompositionDependencies["authorizationResolvers"];
  /**
   * Explicit allowlist of commands any stdio MCP connector may spawn. Absent (or a server's
   * `command` outside it) refuses that connector at composition time — never resolved from the
   * connector's own entry (`AGENTIC_MCP_SERVERS` or `AGENTIC_MCP_CONFIG_FILE`) or ambient env, same fail-closed posture as
   * `mcpAuthorizationResolvers`. See `McpCompositionDependencies.stdioCommandAllowlist`.
   */
  readonly mcpStdioCommandAllowlist?: McpCompositionDependencies["stdioCommandAllowlist"];
  /** Where an allowlisted stdio command lives on this host. See `McpCompositionDependencies.stdioCommandPaths`. */
  readonly mcpStdioCommandPaths?: McpCompositionDependencies["stdioCommandPaths"];
  /**
   * The store of whole tool results (`read_result`, `calculate`). A product whose own tool reads retained results (a table
   * comparison) supplies the store it built that tool with; absent, the runtime makes its own in memory.
   */
  readonly toolResultSpool?: ToolResultSpool;
  /** Views of stored results the product offers `calculate` (its own loader for a table read in pages, for example). */
  readonly calculationViews?: CalculationViews["views"];
  /** Control-plane routing for the exact tenant/profile kitchen. Required in production. */
  readonly runtimeProviderFactory?: (input: {
    readonly defaultSource: RuntimeSnapshotSource;
    readonly defaultRouteRevision: string;
  }) => RuntimeProvider;
  /** A shared quota/concurrency adapter is required in production. */
  readonly admissionController?: TurnAdmissionController;
  /**
   * Observability sink. Omitted means the runtime emits nothing, which is a deployment
   * decision: the durable session events remain the record either way.
   */
  readonly telemetry?: AgentTelemetrySink;
  /**
   * Composition-time decoration of the model plugin, for tracing and nothing else.
   *
   * A seam rather than a setting: a deployment that traces nothing composes the plugin
   * untouched, and the manifest a decorator returns is the one artifact verification still
   * checks — so turning tracing on cannot be mistaken for shipping a different adapter.
   */
  readonly decorateLlmPlugin?: (descriptor: PluginDescriptor) => PluginDescriptor;
  /**
   * Composition-time decoration of the knowledge service (e.g. judged reranking). The platform
   * knowledge plugin still owns the capability; a decorator can only reorder or annotate what the
   * wrapped service returns, and the `knowledge_search` tool's own timeout still bounds it.
   */
  readonly decorateKnowledge?: (knowledge: KnowledgeService) => KnowledgeService;
  /** Product/control-plane policy decoration without coupling domain code to core implementations. */
  readonly toolExecutionPolicyFactory?: (baseline: ToolExecutionPolicy) => ToolExecutionPolicy;
  /** Trusted product context projection; the generic harness supplies no default. */
  readonly turnContextProvider?: TurnContextProvider;
  /** Trusted product/control-plane model-step policy; the generic harness supplies no default behavior. */
  readonly turnControlPolicy?: TurnControlPolicy;
  /**
   * The person's standing approval ("never ask me"), read by core for each new call the policy would put on a card.
   * Omitted, every card is asked. A product composes it from its own setting and the runtime's `settings` store.
   */
  readonly standingApproval?: AgentRuntimeDependencies["standingApproval"];
  /**
   * The product's tool groups. With a judgment provider, a turn is offered only the groups its request may need, and the
   * base `tools_load` tool is mounted as the way to the others. Omitted, every turn is offered every tool.
   */
  readonly toolGroups?: readonly ToolGroup[];
  /** Optional product extension bundle. The generic harness has no product-specific imports or defaults. */
  readonly additionalPlugins?: FirstPartyPluginBundle;
  /**
   * Routing by catalog release: the host built at boot keeps only persistence, the model and the connectors, and every
   * release a channel serves becomes a generation the product's builder supplies skills, profile and plugins for. It
   * replaces `runtimeProviderFactory` and `additionalPlugins`, and the skill roots and profile file are not read.
   */
  readonly catalog?: CatalogCompositionDependencies;
  /** Override the agent loop step budget. Defaults to DEFAULT_AGENT_OPTIONS.maxSteps. */
  readonly agentMaxSteps?: number;
  /** Override the per-turn tool-call and wall-clock budgets. See composition/agent-budgets.ts. */
  readonly agentMaxToolCalls?: number;
  readonly agentTurnTimeoutMs?: number;
}
