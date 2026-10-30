import { createMcpContextualHttpToolsPlugin, createMcpStdioToolsPlugin, type McpPrincipalAuthorizationResolver } from "@0xsyncroot/adapter-mcp";
import type { PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import type { McpHttpServerConfig, McpStdioServerConfig, RuntimeConfig, RuntimeSecrets } from "../runtime-config.js";
import { documentAttachmentSettings, type DocumentAttachmentSettings } from "../document-attachments.js";
import { createDocumentToolPreparation } from "../document-tool-preparation.js";

export interface McpCompositionDependencies {
  /** Platform/control-plane OAuth resolvers keyed by non-secret authProfileRef. */
  readonly authorizationResolvers?: Readonly<Record<string, McpPrincipalAuthorizationResolver>>;
  /**
   * Explicit allowlist of commands any stdio connector may spawn. Absent (or a server's `command`
   * outside it) refuses that connector at composition time: a config that can spawn a process is a
   * remote-code-execution surface, so this is never resolved from the connector's own config or env.
   */
  readonly stdioCommandAllowlist?: readonly string[];
  /**
   * Where an allowlisted command lives on this host, keyed by the command the config names. The
   * config keeps naming one program on every deployment; a host that keeps that program somewhere
   * else is the composition's to state, never the config's. A command the allowlist refuses is
   * refused before it is ever looked up here.
   */
  readonly stdioCommandPaths?: Readonly<Record<string, string>>;
  /**
   * The environment `envPassthrough` names are looked up in: the one the runtime was composed from,
   * not whatever `process.env` holds, so a child sees the same values as the runtime that spawned it
   * (EXAMPLE's office-docs reads the object-storage connection the agent itself uses). Only the names
   * in `envPassthrough` and the server's own literal `env` keys are ever copied from it.
   */
  readonly stdioEnvironment?: Readonly<Record<string, string | undefined>>;
}

function stdioPlugin(server: McpStdioServerConfig, dependencies: McpCompositionDependencies): PluginDescriptor {
  const allowlist = dependencies.stdioCommandAllowlist ?? [];
  const paths = dependencies.stdioCommandPaths;
  const located = paths && Object.hasOwn(paths, server.command) ? paths[server.command] : undefined;
  // The allowlist judges the command the config names; only one it accepts is ever relocated.
  if (located !== undefined && !allowlist.includes(server.command)) {
    throw new Error(`MCP stdio command for ${server.id} is not on the configured allowlist: ${server.command}`);
  }
  return createMcpStdioToolsPlugin({
    serverId: server.id, command: located ?? server.command, commandAllowlist: located !== undefined ? [located] : allowlist,
    // The config's own literal `env` wins over the environment, and is always passed through.
    ...(dependencies.stdioEnvironment || server.env ? { env: { ...(dependencies.stdioEnvironment ?? process.env), ...server.env } } : {}),
    ...(server.args ? { args: server.args } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {}),
    ...(server.envPassthrough || server.env
      ? { envPassthrough: [...new Set([...(server.envPassthrough ?? []), ...Object.keys(server.env ?? {})])] } : {}),
    ...(server.requiredPermissions ? { requiredPermissions: server.requiredPermissions } : {}),
    ...(server.riskOverrides ? { riskOverrides: server.riskOverrides } : {}),
    ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
    ...(server.maxTools !== undefined ? { maxTools: server.maxTools } : {}),
    ...(server.maxResultBytes !== undefined ? { maxResultBytes: server.maxResultBytes } : {}),
    ...(server.maxRestarts !== undefined ? { maxRestarts: server.maxRestarts } : {}),
    ...(server.restartWindowMs !== undefined ? { restartWindowMs: server.restartWindowMs } : {}),
    ...(server.failureMode ? { failureMode: server.failureMode } : {}),
    ...(server.elicitation ? { elicitation: server.elicitation } : {}),
    ...(server.resources ? { resources: server.resources } : {}),
  });
}

function httpPlugin(
  server: McpHttpServerConfig,
  secrets: RuntimeSecrets,
  dependencies: McpCompositionDependencies,
  documents?: DocumentAttachmentSettings,
): PluginDescriptor {
  const bearerToken = server.tokenEnv ? secrets.mcpBearerTokens[server.id] : undefined;
  if (server.tokenEnv && !bearerToken) throw new Error(`MCP bearer token is unavailable for ${server.id}`);
  const delegatedResolver = server.authProfileRef
    ? dependencies.authorizationResolvers?.[server.authProfileRef]
    : undefined;
  if (server.authMode === "delegated" && !delegatedResolver) {
    throw new Error(`MCP auth profile is unavailable: ${server.authProfileRef}`);
  }
  const authorizationResolver: McpPrincipalAuthorizationResolver = delegatedResolver ?? {
    resolve: async () => ({
      partition: server.authMode === "service" ? `service:${server.tokenEnv}` : "anonymous",
      ...(bearerToken ? { authProvider: { token: async () => bearerToken } } : {}),
    }),
  };
  const descriptor = createMcpContextualHttpToolsPlugin({
    serverId: server.id, endpoint: server.endpoint, authorizationResolver,
    ...(server.filesEndpoint && documents ? { prepareToolCall: createDocumentToolPreparation(documents) } : {}),
    ...(server.allowInsecureInternal ? { allowInsecureInternal: true } : {}),
    ...(server.requiredPermissions ? { requiredPermissions: server.requiredPermissions } : {}),
    ...(server.riskOverrides ? { riskOverrides: server.riskOverrides } : {}),
    ...(server.tokenEnv ? { secretNames: [server.tokenEnv] } : {}),
    ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
    ...(server.maxTools !== undefined ? { maxTools: server.maxTools } : {}),
    ...(server.maxResultBytes !== undefined ? { maxResultBytes: server.maxResultBytes } : {}),
    ...(server.idleTtlMs !== undefined ? { idleTtlMs: server.idleTtlMs } : {}),
    ...(server.maxConnections !== undefined ? { maxConnections: server.maxConnections } : {}),
    ...(server.failureMode ? { failureMode: server.failureMode } : {}),
    // The connector the backend archives attachments for, or hands them to, is the one that reads them: when it cannot be
    // had, the turn knows attached files cannot be read (`ContextualToolSource.readsAttachments`).
    ...(server.attachmentStorage || server.filesEndpoint ? { readsAttachments: true } : {}),
    ...(server.elicitation ? { elicitation: server.elicitation } : {}),
    ...(server.resources ? { resources: server.resources } : {}),
  });
  return server.filesEndpoint ? { ...descriptor, config: { ...descriptor.config,
    filesEndpoint: server.filesEndpoint,
    ...(server.attachmentStorage ? { attachmentStorage: { ...server.attachmentStorage } } : {}),
  } } : descriptor;
}

/** Builds an auditable plugin row for every configured MCP connector, routed by its transport. */
export function createMcpPlugins(
  config: RuntimeConfig,
  secrets: RuntimeSecrets,
  dependencies: McpCompositionDependencies,
): readonly PluginDescriptor[] {
  const documents = config.mcpServers.some(server => server.transport === "http" && server.filesEndpoint)
    ? documentAttachmentSettings(dependencies.stdioEnvironment ?? process.env, config.profile, config.mcpServers) : undefined;
  return config.mcpServers.map((server) => server.transport === "stdio"
    ? stdioPlugin(server, dependencies)
    : httpPlugin(server, secrets, dependencies, documents));
}
