import {
  CAPABILITIES,
  type ContextualToolSource, type ToolDefinition, type ToolInvocation,
} from "@0xsyncroot/contracts";
import { CONTEXTUAL_TOOL_SOURCE_CAPABILITY, type AgentPlugin, type PluginDescriptor, type PluginManifest } from "@0xsyncroot/plugin-sdk";
import { createStdioClientFactory } from "./stdio-client.js";
import { StdioProcessManager } from "./stdio-process-manager.js";
import { executeMcpTool } from "./elicitation.js";
import { createResourceTools } from "./resource-tools.js";
import { connectorHealthLog } from "./connector-health.js";
import { validateAgainstSchema } from "./schema-validation.js";
import {
  boundedJson, digest, discoverTools, filterEnv, mcpToolId, normalizeLimits, resourcesCapability, toolResultSchema, toolSideEffect, validateCommandAllowlist, validateServerId,
} from "./shared.js";
import type { McpRemoteTool, McpStdioToolsPluginConfig, NormalizedMcpLimits } from "./types.js";

function stdioToolDefinition(
  serverId: string, source: ContextualToolSource, remote: McpRemoteTool, catalogRevision: string,
  manager: StdioProcessManager, config: McpStdioToolsPluginConfig, limits: NormalizedMcpLimits,
): ToolDefinition {
  const inputSchema = boundedJson(remote.inputSchema, `MCP schema ${remote.name}`, limits.maxResultBytes);
  const outputSchema = toolResultSchema(remote.outputSchema, `MCP output schema ${remote.name}`, limits.maxResultBytes);
  const schemaDigest = digest({ inputSchema, outputSchema });
  const id = mcpToolId(serverId, remote.name);
  return {
    id, version: "1.0.0",
    description: remote.description?.trim() || `MCP tool ${remote.name} from ${serverId}`,
    inputSchema, outputSchema,
    // A subprocess runs as the deployment, not as a principal: no per-user token to check, but the
    // permission still gates who may invoke it, and the fail-closed nonIdempotent default still
    // applies to whatever the remote (untrusted) annotations claim.
    requiredPermissions: config.requiredPermissions ?? [`mcp.${serverId}.invoke`],
    sideEffect: toolSideEffect(remote, config.riskOverrides), timeoutMs: limits.timeoutMs,
    origin: { sourceId: source.id, sourceVersion: source.version, catalogRevision, nativeId: remote.name, schemaDigest },
    validateArguments: (rawArguments) => validateAgainstSchema(inputSchema, rawArguments, id),
    execute: (invocation: ToolInvocation, signal) =>
      manager.use((client) => executeMcpTool(client, serverId, remote.name, invocation, signal, limits), signal),
  };
}

/**
 * MCP over a local subprocess: one long-lived child per connector, shared by every principal (there
 * is no per-principal auth to isolate — see `packages/adapter-mcp/src/stdio-process-manager.ts` for
 * the crash/timeout/restart-budget handling this relies on). Discovery still runs through the
 * contextual mechanism so per-principal *policy* (permission filtering) applies exactly as it does
 * for the HTTP connectors, even though the process underneath is a singleton.
 */
export function createMcpStdioToolsPlugin(config: McpStdioToolsPluginConfig): PluginDescriptor {
  const serverId = validateServerId(config.serverId);
  validateCommandAllowlist(config.command, config.commandAllowlist, serverId);
  const limits = normalizeLimits(config);
  const cwd = config.cwd ?? process.cwd();
  const env = filterEnv(config.env ?? process.env, config.envPassthrough ?? []);
  const failureMode = config.failureMode ?? "omit";
  const healthLog = connectorHealthLog(serverId);
  const pluginId = `io.syncroot.adapter.mcp-stdio.${serverId}`;
  // "_" not "." — see the matching note in contextual-plugin.ts.
  const sourceId = `mcp_${serverId}`;
  const spawn = config.clientFactory ?? ((hooks: { onStderr(chunk: Buffer): void; onUnexpectedClose(): void }) =>
    createStdioClientFactory(
      { command: config.command, ...(config.args ? { args: [...config.args] } : {}), cwd, env, ...(config.maxBufferSize ? { maxBufferSize: config.maxBufferSize } : {}) },
      limits.elicitationEnabled, hooks.onStderr, hooks.onUnexpectedClose,
    )());
  let manager: StdioProcessManager | undefined;

  const plugin: AgentPlugin = {
    validate: async () => ({ valid: true }),
    activate: async (context) => {
      const activeManager = new StdioProcessManager({
        serverId, spawn,
        ...(config.maxRestarts !== undefined ? { maxRestarts: config.maxRestarts } : {}),
        ...(config.restartWindowMs !== undefined ? { restartWindowMs: config.restartWindowMs } : {}),
      });
      manager = activeManager;
      const knownResourceSchemes = new Set<string>(limits.resourcePinnedSchemes);
      const source: ContextualToolSource = {
        id: sourceId,
        version: "1.0.0",
        ...(config.readsAttachments ? { readsAttachments: true } : {}),
        discover: async (_discoveryContext, signal) => {
          let remoteTools: readonly McpRemoteTool[];
          let resourcesSupported = false;
          try {
            const discovered = await activeManager.use(async (client) => ({
              tools: await discoverTools(client, limits.maxTools),
              resourcesSupported: resourcesCapability(client),
            }), signal);
            remoteTools = discovered.tools;
            resourcesSupported = discovered.resourcesSupported;
            healthLog.recovered();
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            healthLog.failed(error);
            if (failureMode === "fail") throw error;
            // Said, not left to an empty list: see the matching note in contextual-plugin.ts.
            return { revision: digest({ serverId, unavailable: true }), tools: [], unavailable: true };
          }
          const catalogRevision = digest({
            tools: remoteTools.map((tool) => ({
              name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema ?? {}, annotations: tool.annotations ?? {},
            })),
            resourcesEnabled: limits.resourcesEnabled && resourcesSupported,
          });
          const remoteDefinitions = remoteTools.map((remote) => stdioToolDefinition(
            serverId, source, remote, catalogRevision, activeManager, config, limits,
          ));
          const resourceDefinitions = limits.resourcesEnabled && resourcesSupported
            ? createResourceTools({
                serverId, limits, knownSchemes: knownResourceSchemes,
                requiredPermissions: config.requiredPermissions ?? [`mcp.${serverId}.invoke`],
                origin: { sourceId: source.id, sourceVersion: source.version, catalogRevision },
                withClient: (_invocation, callSignal, operation) => activeManager.use(operation, callSignal),
              })
            : [];
          return { revision: catalogRevision, tools: [...remoteDefinitions, ...resourceDefinitions] };
        },
      };
      context.registrations.provide(CONTEXTUAL_TOOL_SOURCE_CAPABILITY, source);
      return { dispose: async () => { manager = undefined; await activeManager.dispose(); } };
    },
    health: async () => {
      if (!manager) return { healthy: false, detail: "not active" };
      const status = manager.health();
      return { healthy: status.healthy, ...(status.detail ? { detail: status.detail } : {}) };
    },
  };
  const manifest: PluginManifest = {
    manifestVersion: 1, id: pluginId, version: "0.1.0", publisher: "Agentic Platform", coreApi: "^1.0.0",
    artifact: { digest: `builtin:${pluginId}@0.1.0`, signature: "trusted-assembly" }, requires: {},
    provides: { [CAPABILITIES.contextualTools]: { version: "1.0.0", cardinality: "multi" } },
    permissions: {},
  };
  return {
    manifest, plugin, trustTier: "platform-core",
    config: {
      serverId, command: config.command, ...(config.args ? { args: [...config.args] } : {}), cwd,
      envPassthrough: [...(config.envPassthrough ?? [])],
      ...limits, allowedUrlOrigins: [...limits.allowedUrlOrigins], resourcePinnedSchemes: [...limits.resourcePinnedSchemes],
      failureMode, authMode: "none",
      ...(config.readsAttachments ? { readsAttachments: true } : {}),
    },
  };
}
