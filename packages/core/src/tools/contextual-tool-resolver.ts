import { AgenticError, hasPermission, type ContextualToolDiscoveryContext, type ToolDefinition, type ToolExecutionPolicy, type UnavailableCapabilities } from "@0xsyncroot/contracts";
import { CONTEXTUAL_TOOL_SOURCE_CAPABILITY, TOOL_CAPABILITY, type ScopedCapabilityResolver } from "@0xsyncroot/plugin-sdk";

/**
 * A source that reads the files users attach, as this turn has it: `available`, `unavailable` (it
 * did not answer discovery), or `withheld` (it answered, and the policy kept every one of its tools
 * from this principal — `missingPermissions` says which permissions that took).
 */
export interface AttachmentReader {
  readonly sourceId: string;
  readonly state: "available" | "unavailable" | "withheld";
  readonly missingPermissions?: readonly string[];
}

/** The exact tool surface of one turn, and what the runtime knows it lacks. */
export interface ContextualToolSurface {
  readonly tools: readonly ToolDefinition[];
  /** What is missing this turn, as `TurnControlState.unavailable` carries it; absent when nothing is. */
  readonly unavailable?: UnavailableCapabilities;
  /** Every source that declares `readsAttachments`, and whether it can read this turn. */
  readonly attachmentReaders: readonly AttachmentReader[];
}

/**
 * Resolves and policy-filters the tool surface visible to one turn, keeping the facts discovery
 * learned on the way.
 *
 * A source configured to be omitted on failure must not come back as a bare empty list: the turn then
 * knows nothing, and the model keeps calling the missing tool and answering that it cannot work
 * (docs/incidents/2026-10-14-core-reader-down.md). A source says it is unavailable, and the policy's
 * removals are named with the permissions they took, so the runtime, a policy and the model all start
 * from the fact.
 */
export async function resolveContextualToolSurface(
  capabilities: ScopedCapabilityResolver,
  context: ContextualToolDiscoveryContext,
  policy: ToolExecutionPolicy,
  signal: AbortSignal,
): Promise<ContextualToolSurface> {
  const tools = [...capabilities.all(TOOL_CAPABILITY)];
  const sourceIds = new Set<string>();
  const sources: { readonly sourceId: string; readonly readsAttachments: boolean; readonly unavailable: boolean; readonly toolIds: readonly string[] }[] = [];

  for (const source of capabilities.all(CONTEXTUAL_TOOL_SOURCE_CAPABILITY)) {
    if (signal.aborted) throw signal.reason;
    const sourceId = source.id.trim();
    if (!sourceId) throw new AgenticError("validation", "Contextual tool source id cannot be empty");
    if (sourceIds.has(sourceId)) throw new AgenticError("conflict", `Duplicate contextual tool source: ${sourceId}`);
    sourceIds.add(sourceId);

    const catalog = await source.discover(context, signal);
    const revision = catalog.revision.trim();
    if (!revision) throw new AgenticError("validation", `Contextual tool source ${sourceId} returned an empty revision`);
    for (const tool of catalog.tools) {
      if (!tool.origin || tool.origin.sourceId !== sourceId || tool.origin.catalogRevision !== revision) {
        throw new AgenticError("validation", `Contextual tool ${tool.id} has invalid source provenance`);
      }
      tools.push(tool);
    }
    sources.push({ sourceId, readsAttachments: source.readsAttachments === true, unavailable: catalog.unavailable === true, toolIds: catalog.tools.map((tool) => tool.id) });
  }

  const offered = await policy.discover(tools, { security: context.security, runtime: context.runtime });
  const kept = new Set(offered.map((tool) => tool.id));
  // Only what a permission explains is called withheld: a policy may drop a tool for reasons of its own, and those are not facts this layer can state.
  const withheldTools = tools.filter((tool) => !kept.has(tool.id)).flatMap((tool) => {
    const missingPermissions = tool.requiredPermissions.filter((permission) => !hasPermission(context.security, permission));
    return missingPermissions.length > 0 ? [Object.freeze({ toolId: tool.id, missingPermissions: Object.freeze(missingPermissions) })] : [];
  });
  const unavailableSources = sources.filter((source) => source.unavailable)
    .map(({ sourceId, readsAttachments }) => Object.freeze({ sourceId, readsAttachments }));
  const withheld = new Map(withheldTools.map((tool) => [tool.toolId, tool.missingPermissions]));
  const attachmentReaders = sources.filter((source) => source.readsAttachments).map((source): AttachmentReader => {
    if (source.unavailable) return Object.freeze({ sourceId: source.sourceId, state: "unavailable" });
    if (source.toolIds.length === 0 || !source.toolIds.every((id) => withheld.has(id))) return Object.freeze({ sourceId: source.sourceId, state: "available" });
    return Object.freeze({ sourceId: source.sourceId, state: "withheld", missingPermissions: Object.freeze([...new Set(source.toolIds.flatMap((id) => withheld.get(id)!))]) });
  });
  return Object.freeze({
    tools: offered,
    ...(unavailableSources.length > 0 || withheldTools.length > 0
      ? { unavailable: Object.freeze({ sources: Object.freeze(unavailableSources), withheldTools: Object.freeze(withheldTools) }) } : {}),
    attachmentReaders: Object.freeze(attachmentReaders),
  });
}

/** Resolves and policy-filters the exact tool surface visible to one turn. */
export async function resolveContextualTools(
  capabilities: ScopedCapabilityResolver,
  context: ContextualToolDiscoveryContext,
  policy: ToolExecutionPolicy,
  signal: AbortSignal,
): Promise<readonly ToolDefinition[]> {
  return (await resolveContextualToolSurface(capabilities, context, policy, signal)).tools;
}
