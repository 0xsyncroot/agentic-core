import type { AgentProfileDefinition, CatalogReader, CatalogReleaseContent, JudgmentPort, KnowledgeService, PublicAgentProfile, SecurityContext, SkillCatalog, ToolExecutionPolicy, ToolResultSpool } from "@0xsyncroot/contracts";
import type { RuntimeSnapshotSource } from "@0xsyncroot/core";
import type { PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import type { RuntimeCompositionDependencies } from "../runtime-dependencies.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { checkMountedRuntime, composedArtifactVerifier, runtimeMount, type MountedRuntime } from "../runtime-mount.js";
import { CatalogRuntimeProvider } from "./catalog-runtime-provider.js";
import type { GenerationAssembler } from "./generation-cache.js";
import type { InfraExports } from "./infra-exports.js";

/** What a product builds one generation from. */
export interface GenerationBuildInput {
  /** The release and its item revisions, in the store's order. */
  readonly content: CatalogReleaseContent;
  readonly infraSnapshotId: string;
  /** The hash of the tenant tool switches the generation serves. */
  readonly switchesHash: string;
}

/** What the harness sees of an active generation; a product keys per-generation policy data by `snapshotId`. */
export interface GenerationView {
  readonly snapshotId: string;
  readonly toolIds: readonly string[];
  /** Each mounted tool with its description, as `BlankRuntime.availableTools` lists the single host's. */
  readonly availableTools: MountedRuntime["availableTools"];
  /** The write preconditions the generation's skills declare: each write tool id and the tools it must come after. */
  readonly preconditions: ReadonlyMap<string, readonly string[]>;
}

/** A product's part of one generation; the harness mounts the platform plugins around it. */
export interface GenerationParts {
  /** Product plugins, each of the first-party-domain trust tier. */
  readonly descriptors: readonly PluginDescriptor[];
  readonly verifyArtifact: (descriptor: PluginDescriptor) => Promise<boolean>;
  readonly skills: SkillCatalog;
  readonly agentProfile: AgentProfileDefinition;
  /** The product's own checks, after the harness's; a throw fails the build. */
  verify?(view: GenerationView): void | Promise<void>;
  /** Runs once every check passed. */
  activated?(view: GenerationView): void;
  /** Runs after the generation shut down: evicted, failed after activation, or closed. */
  dispose?(): Promise<void>;
}

export interface GenerationBuilder {
  build(input: GenerationBuildInput): Promise<GenerationParts>;
}

/** Catalog routing, chosen by the composition root in place of a runtime provider factory and additional plugins. */
export interface CatalogCompositionDependencies {
  readonly reader: CatalogReader;
  /** The agents this deployment serves; the first is the default agent profile. */
  readonly agentIds: readonly string[];
  readonly builder: GenerationBuilder;
  readonly pollIntervalMs: number;
  readonly buildTimeoutMs: number;
  readonly maxGenerations: number;
  readonly subscribeHints?: (onHint: () => void) => () => void;
  /** Where a failed channel read, generation build or eviction shutdown is reported. */
  readonly onBackgroundFailure: (error: unknown) => void;
}

/** What the boot checks found for one generation, as `BlankRuntime` reports it. */
export interface GenerationDescription extends MountedRuntime {
  readonly agentProfile: PublicAgentProfile;
}

export interface CatalogRuntime {
  readonly provider: CatalogRuntimeProvider;
  /** The live generation the provider started with, for the agent the composition lists first. */
  readonly boot: GenerationDescription;
}

function publicProfile(profile: AgentProfileDefinition): PublicAgentProfile {
  return Object.freeze({ id: profile.id, version: profile.version, name: profile.name, description: profile.description,
    supportedDomains: profile.supportedDomains });
}

/**
 * Builds and starts the catalog runtime provider over an active infra host. Each generation mounts the platform plugins
 * every composition mounts (the model plugin stays on the infra host and reaches the generation re-exported), then the
 * product's parts, and passes the same boot checks a single-host runtime passes, plus the product's own.
 */
export async function startCatalogRuntime(input: {
  readonly catalog: CatalogCompositionDependencies;
  readonly config: RuntimeConfig;
  readonly dependencies: RuntimeCompositionDependencies;
  readonly infra: RuntimeSnapshotSource;
  readonly infraExports: InfraExports;
  readonly routeRevision: string;
  readonly knowledge: KnowledgeService;
  readonly llm: PluginDescriptor;
  readonly toolResultSpool: ToolResultSpool;
  readonly judgment: JudgmentPort | undefined;
  readonly policy: ToolExecutionPolicy;
  readonly security: SecurityContext;
  readonly routeContextChars: number;
}): Promise<CatalogRuntime> {
  const { catalog } = input;
  const described = new Map<string, GenerationDescription>();
  const assemble: GenerationAssembler = async ({ identity, content, infra }) => {
    const parts = await catalog.builder.build({ content, infraSnapshotId: infra.snapshot.id, switchesHash: identity.switchesHash });
    if (parts.agentProfile.id !== identity.agentId) {
      throw new Error(`Release ${identity.releaseId} of agent ${identity.agentId} carries agent profile ${parts.agentProfile.id}`);
    }
    const mount = runtimeMount({ config: input.config, dependencies: input.dependencies, knowledge: input.knowledge,
      skills: parts.skills, agentProfile: parts.agentProfile, llm: input.llm, toolResultSpool: input.toolResultSpool,
      judgment: input.judgment });
    let description: GenerationDescription | undefined;
    let snapshotId: string | undefined;
    return {
      descriptors: [...mount.leading.filter((descriptor) => descriptor !== input.llm), ...mount.trailing, ...parts.descriptors],
      verifyArtifact: composedArtifactVerifier(parts),
      activated: async ({ snapshot, capabilities }) => {
        const mounted = await checkMountedRuntime({ capabilities, skills: parts.skills, visibleSkills: mount.visibleSkills,
          policy: input.policy, security: input.security, routeContextChars: input.routeContextChars });
        const view: GenerationView = Object.freeze({ snapshotId: snapshot.id, toolIds: mounted.availableTools.map((tool) => tool.id),
          availableTools: mounted.availableTools, preconditions: mounted.preconditions });
        await parts.verify?.(view);
        parts.activated?.(view);
        snapshotId = snapshot.id;
        description = Object.freeze({ ...mounted, agentProfile: publicProfile(parts.agentProfile) });
        described.set(snapshot.id, description);
      },
      dispose: async () => {
        // A rebuild of the same release has the same id and may have described itself before this one shut down.
        if (snapshotId !== undefined && described.get(snapshotId) === description) described.delete(snapshotId);
        await parts.dispose?.();
      },
    };
  };
  const provider = new CatalogRuntimeProvider({ reader: catalog.reader, agentIds: catalog.agentIds, routeRevision: input.routeRevision,
    pollIntervalMs: catalog.pollIntervalMs, buildTimeoutMs: catalog.buildTimeoutMs, maxGenerations: catalog.maxGenerations,
    ...(catalog.subscribeHints ? { subscribeHints: catalog.subscribeHints } : {}), onBackgroundFailure: catalog.onBackgroundFailure,
    infra: input.infra, infraExports: input.infraExports, assemble });
  try {
    await provider.start();
    const bootAgent = catalog.agentIds[0]!;
    const bootSnapshot = provider.liveSnapshotId(bootAgent);
    const boot = bootSnapshot === undefined ? undefined : described.get(bootSnapshot);
    if (!boot) throw new Error(`The live generation of agent ${bootAgent} is not built`);
    return { provider, boot };
  } catch (error) {
    try { await provider.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Catalog runtime start and cleanup both failed"); }
    throw error;
  }
}
