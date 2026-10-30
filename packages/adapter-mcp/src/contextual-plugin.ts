import {
  AgenticError, CAPABILITIES,
  type ContextualToolSource, type SecurityContext, type ToolDefinition, type ToolInvocation,
} from "@0xsyncroot/contracts";
import { CONTEXTUAL_TOOL_SOURCE_CAPABILITY, type AgentPlugin, type PluginDescriptor, type PluginManifest } from "@0xsyncroot/plugin-sdk";
import { createHttpClientFactory } from "./http-client.js";
import { mcpToolFailure } from "./transport-error.js";
import { connectorHealthLog } from "./connector-health.js";
import { PrincipalClientPool } from "./principal-client-pool.js";
import { isUnreachable } from "./read-recovery.js";
import { executeMcpTool } from "./elicitation.js";
import { createResourceTools } from "./resource-tools.js";
import { validateAgainstSchema } from "./schema-validation.js";
import {
  boundedJson, digest, discoverTools, mcpToolId, normalizeLimits, principalBinding, resourcesCapability, toolResultSchema, toolSideEffect, validateEndpoint, validateServerId,
} from "./shared.js";
import type { McpContextualHttpToolsPluginConfig, McpRemoteTool, NormalizedMcpLimits } from "./types.js";

function samePrincipal(left: SecurityContext, right: SecurityContext): boolean {
  return principalBinding(left) === principalBinding(right);
}

function contextualDefinition(
  serverId: string, source: ContextualToolSource, remote: McpRemoteTool,
  catalogRevision: string, discoverySecurity: SecurityContext, agentProfileId: string,
  pool: PrincipalClientPool, config: McpContextualHttpToolsPluginConfig, limits: NormalizedMcpLimits,
): ToolDefinition {
  const inputSchema = boundedJson(remote.inputSchema, `MCP schema ${remote.name}`, limits.maxResultBytes);
  const outputSchema = toolResultSchema(remote.outputSchema, `MCP output schema ${remote.name}`, limits.maxResultBytes);
  const schemaDigest = digest({ inputSchema, outputSchema });
  const id = mcpToolId(serverId, remote.name);
  return {
    id, version: "1.0.0",
    description: remote.description?.trim() || `MCP tool ${remote.name} from ${serverId}`,
    inputSchema, outputSchema,
    requiredPermissions: config.requiredPermissions ?? [`mcp.${serverId}.invoke`],
    sideEffect: toolSideEffect(remote, config.riskOverrides), timeoutMs: limits.timeoutMs,
    origin: {
      sourceId: source.id, sourceVersion: source.version, catalogRevision,
      nativeId: remote.name, schemaDigest,
    },
    // Runs before authorization: a malformed call is refused before anyone is asked to approve it.
    validateArguments: (rawArguments) => validateAgainstSchema(inputSchema, rawArguments, id),
    execute: async (invocation: ToolInvocation, signal) => {
      if (!samePrincipal(discoverySecurity, invocation.security)) {
        throw new AgenticError("denied", `MCP tool ${remote.name} principal binding changed after discovery`);
      }
      await config.prepareToolCall?.(remote.name, invocation, signal);
      return pool.use({ security: invocation.security, agentProfileId }, signal, (client) =>
        executeMcpTool(client, serverId, remote.name, invocation, signal, limits, new URL(config.endpoint).origin),
        toolSideEffect(remote, config.riskOverrides) === "none")
        .catch(error => { throw mcpToolFailure(error, toolSideEffect(remote, config.riskOverrides)); });
    },
  };
}

/** Plugin activation is network-free; discovery and execution are principal-scoped and lazy. */
export function createMcpContextualHttpToolsPlugin(config: McpContextualHttpToolsPluginConfig): PluginDescriptor {
  const serverId = validateServerId(config.serverId);
  const endpoint = validateEndpoint(config.endpoint, config.allowInsecureInternal);
  const limits = normalizeLimits(config);
  const idleTtlMs = config.idleTtlMs ?? 60_000;
  const maxConnections = config.maxConnections ?? 100;
  if (!Number.isInteger(idleTtlMs) || idleTtlMs <= 0) throw new Error("MCP idleTtlMs must be positive");
  if (!Number.isInteger(maxConnections) || maxConnections <= 0) throw new Error("MCP maxConnections must be positive");
  const pluginId = `io.syncroot.adapter.mcp-contextual.${serverId}`;
  // "_" not "." — matches the tool id separator (mcpToolId) so create-runtime.ts's boot check,
  // which prefix-matches `sourceId + "_"` against required tool ids, sees the same namespace.
  const sourceId = `mcp_${serverId}`;
  const failureMode = config.failureMode ?? "omit";
  const healthLog = connectorHealthLog(serverId);
  let pool: PrincipalClientPool | undefined;
  let lastDiscoveryFailureAt: string | undefined;
  // Whether the last discovery that ended in a verdict ended with the connector not answering (`isUnreachable`). Read once at
  // the entry of each discovery, so a connector known to be down does not add its read retries (0.5 s + 1.5 s) before every
  // turn's first model call. Not `lastDiscoveryFailureAt`: any error sets that, a 401 included.
  let unreachable = false;
  const plugin: AgentPlugin = {
    validate: async () => ({ valid: true }),
    activate: async (context) => {
      const activePool = new PrincipalClientPool(
        serverId, endpoint.toString(), config.authorizationResolver,
        config.clientFactory ?? createHttpClientFactory(endpoint, config.fetch, limits.elicitationEnabled), idleTtlMs, maxConnections,
      );
      pool = activePool;
      // Lives for the plugin's activation, not one discovery call: schemes learned from one turn's
      // list_resources stay known for read_resource on a later turn, on the same connector.
      const knownResourceSchemes = new Set<string>(limits.resourcePinnedSchemes);
      const source: ContextualToolSource = {
        id: sourceId,
        version: "1.0.0",
        ...(config.readsAttachments ? { readsAttachments: true } : {}),
        discover: async (discoveryContext, signal) => {
          let remoteTools: readonly McpRemoteTool[];
          let resourcesSupported = false;
          const retryReads = !unreachable;
          try {
            const discovered = await activePool.use(discoveryContext, signal, async (client) => ({
              tools: await discoverTools(client, limits.maxTools),
              resourcesSupported: resourcesCapability(client),
            }), true, retryReads);
            remoteTools = discovered.tools;
            resourcesSupported = discovered.resourcesSupported;
            lastDiscoveryFailureAt = undefined;
            unreachable = false;
            healthLog.recovered();
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            lastDiscoveryFailureAt = new Date().toISOString();
            if (isUnreachable(error)) unreachable = true;
            healthLog.failed(error);
            if (failureMode === "fail") throw error;
            // Said, not left to an empty list: the turn then knows these tools are missing, and why (contracts' `unavailable`).
            return { revision: digest({ serverId, unavailable: true }), tools: [], unavailable: true };
          }
          const catalogRevision = digest({
            tools: remoteTools.map((tool) => ({
              name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema ?? {}, annotations: tool.annotations ?? {},
            })),
            resourcesEnabled: limits.resourcesEnabled && resourcesSupported,
          });
          const agentProfileId = discoveryContext.agentProfileId ?? "default";
          const remoteDefinitions = remoteTools.map((remote) => contextualDefinition(
            serverId, source, remote, catalogRevision, discoveryContext.security,
            agentProfileId, activePool, config, limits,
          ));
          const resourceDefinitions = limits.resourcesEnabled && resourcesSupported
            ? createResourceTools({
                serverId, limits, knownSchemes: knownResourceSchemes,
                requiredPermissions: config.requiredPermissions ?? [`mcp.${serverId}.invoke`],
                origin: { sourceId: source.id, sourceVersion: source.version, catalogRevision },
                withClient: (invocation, signal, operation) => {
                  if (!samePrincipal(discoveryContext.security, invocation.security)) {
                    throw new AgenticError("denied", `MCP resource tool for ${serverId} principal binding changed after discovery`);
                  }
                  return activePool.use({ security: invocation.security, agentProfileId }, signal, operation, true);
                },
              })
            : [];
          return { revision: catalogRevision, tools: [...remoteDefinitions, ...resourceDefinitions] };
        },
      };
      context.registrations.provide(CONTEXTUAL_TOOL_SOURCE_CAPABILITY, source);
      return { dispose: async () => { pool = undefined; await activePool.close(); } };
    },
    health: async () => ({
      healthy: pool !== undefined && lastDiscoveryFailureAt === undefined,
      detail: !pool ? "not active" : lastDiscoveryFailureAt ? `last discovery failed at ${lastDiscoveryFailureAt}` : `lazy principal pool: ${pool.size} connection(s)`,
    }),
  };
  const manifest: PluginManifest = {
    manifestVersion: 1, id: pluginId, version: "0.1.0", publisher: "Agentic Platform", coreApi: "^1.0.0",
    artifact: { digest: `builtin:${pluginId}@0.1.0`, signature: "trusted-assembly" }, requires: {},
    provides: { [CAPABILITIES.contextualTools]: { version: "1.0.0", cardinality: "multi" } },
    permissions: {
      network: [endpoint.origin],
      ...(config.secretNames?.length ? { secrets: [...config.secretNames] } : {}),
    },
  };
  return {
    manifest, plugin, trustTier: "platform-core",
    config: {
      serverId, endpoint: endpoint.toString(), ...limits,
      allowedUrlOrigins: [...limits.allowedUrlOrigins], resourcePinnedSchemes: [...limits.resourcePinnedSchemes],
      idleTtlMs, maxConnections, failureMode, authMode: "principal",
      ...(config.readsAttachments ? { readsAttachments: true } : {}),
    },
  };
}
