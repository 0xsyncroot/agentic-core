import { CAPABILITIES, type ToolDefinition } from "@0xsyncroot/contracts";
import type { AuthProvider } from "@modelcontextprotocol/client";
import { TOOL_CAPABILITY, type AgentPlugin, type PluginDescriptor, type PluginManifest } from "@0xsyncroot/plugin-sdk";
import { createHttpClientFactory } from "./http-client.js";
import { mcpToolFailure } from "./transport-error.js";
import {
  boundedJson, discoverTools, mcpToolId, normalizeLimits, resourcesCapability, toolResultSchema, toolSideEffect, validateEndpoint, validateServerId,
} from "./shared.js";
import type { McpHttpToolsPluginConfig, McpToolsPluginConfig } from "./types.js";
import { executeMcpTool } from "./elicitation.js";
import { createResourceTools } from "./resource-tools.js";
import { validateAgainstSchema } from "./schema-validation.js";

function manifest(pluginId: string, config: McpToolsPluginConfig): PluginManifest {
  return {
    manifestVersion: 1, id: pluginId, version: "0.1.0", publisher: "Agentic Platform", coreApi: "^1.0.0",
    artifact: { digest: `builtin:${pluginId}@0.1.0`, signature: "trusted-assembly" }, requires: {},
    provides: { [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } },
    permissions: {
      ...(config.endpoint ? { network: [new URL(config.endpoint).origin] } : {}),
      ...(config.secretNames?.length ? { secrets: [...config.secretNames] } : {}),
    },
  };
}

/** Backward-compatible eager mode for trusted deployment/service connectors. */
export function createMcpToolsPlugin(config: McpToolsPluginConfig): PluginDescriptor {
  const serverId = validateServerId(config.serverId);
  const pluginId = `io.syncroot.adapter.mcp.${serverId}`;
  const limits = normalizeLimits(config);
  let activeClient: Awaited<ReturnType<McpToolsPluginConfig["clientFactory"]>> | undefined;
  const plugin: AgentPlugin = {
    validate: async () => ({ valid: true }),
    activate: async (context) => {
      const client = await config.clientFactory();
      activeClient = client;
      const registrations: Array<{ dispose(): void | Promise<void> }> = [];
      try {
        for (const remote of await discoverTools(client, limits.maxTools)) {
          const id = mcpToolId(serverId, remote.name);
          const inputSchema = boundedJson(remote.inputSchema, `MCP schema ${remote.name}`, limits.maxResultBytes);
          const definition: ToolDefinition = {
            id, version: "1.0.0",
            description: remote.description?.trim() || `MCP tool ${remote.name} from ${serverId}`,
            inputSchema,
            outputSchema: toolResultSchema(remote.outputSchema, `MCP output schema ${remote.name}`, limits.maxResultBytes),
            requiredPermissions: config.requiredPermissions ?? [`mcp.${serverId}.invoke`],
            sideEffect: toolSideEffect(remote, config.riskOverrides), timeoutMs: limits.timeoutMs,
            validateArguments: (rawArguments) => validateAgainstSchema(inputSchema, rawArguments, id),
            execute: async (invocation, signal) => executeMcpTool(
              client, serverId, remote.name, invocation, signal, limits,
              config.endpoint ? new URL(config.endpoint).origin : undefined,
            ).catch(error => { throw mcpToolFailure(error, toolSideEffect(remote, config.riskOverrides)); }),
          };
          registrations.push(context.registrations.provide(TOOL_CAPABILITY, definition));
        }
        if (limits.resourcesEnabled && resourcesCapability(client)) {
          const knownResourceSchemes = new Set<string>(limits.resourcePinnedSchemes);
          const resourceTools = createResourceTools({
            serverId, limits, knownSchemes: knownResourceSchemes,
            requiredPermissions: config.requiredPermissions ?? [`mcp.${serverId}.invoke`],
            withClient: (_invocation, _signal, operation) => operation(client),
          });
          for (const definition of resourceTools) registrations.push(context.registrations.provide(TOOL_CAPABILITY, definition));
        }
      } catch (error) {
        for (const registration of registrations.reverse()) await registration.dispose();
        await client.close().catch(() => undefined);
        activeClient = undefined;
        throw error;
      }
      return { dispose: async () => { activeClient = undefined; await client.close(); } };
    },
    health: async () => ({ healthy: activeClient !== undefined, ...(!activeClient ? { detail: "not connected" } : {}) }),
  };
  return {
    manifest: manifest(pluginId, config), plugin, trustTier: "platform-core",
    config: {
      serverId, ...(config.endpoint ? { endpoint: config.endpoint } : {}), ...limits,
      allowedUrlOrigins: [...limits.allowedUrlOrigins], resourcePinnedSchemes: [...limits.resourcePinnedSchemes],
    },
  };
}

export function createMcpHttpToolsPlugin(config: McpHttpToolsPluginConfig): PluginDescriptor {
  const endpoint = validateEndpoint(config.endpoint, config.allowInsecureInternal);
  if (config.bearerToken && config.authProvider) throw new Error("MCP bearerToken and authProvider are mutually exclusive");
  const authProvider = config.authProvider ?? (config.bearerToken ? { token: async () => config.bearerToken } satisfies AuthProvider : undefined);
  const clientFactory = createHttpClientFactory(endpoint, config.fetch, config.elicitation?.enabled ?? true);
  return createMcpToolsPlugin({
    ...config, endpoint: endpoint.toString(),
    ...(config.bearerToken ? { secretNames: config.secretNames ?? [`AGENTIC_MCP_${config.serverId.toUpperCase().replaceAll("-", "_")}_TOKEN`] } : {}),
    clientFactory: () => clientFactory({ partition: "service", ...(authProvider ? { authProvider } : {}) }),
  });
}
