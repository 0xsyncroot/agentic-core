import type { JsonValue, SecurityContext, ToolDefinition, ToolInvocation } from "@0xsyncroot/contracts";
import type { AuthProvider } from "@modelcontextprotocol/client";

export interface McpRemoteTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonValue;
  readonly outputSchema?: JsonValue;
  /** Remote hints are untrusted and never lower risk by themselves. */
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
  };
}

export interface McpRemoteResource {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
}

export interface McpClientPort {
  listTools(cursor?: string): Promise<{ readonly tools: readonly McpRemoteTool[]; readonly nextCursor?: string }>;
  /** Present only when the connected server advertised the `resources` capability at connect time. */
  listResources?(cursor?: string): Promise<{ readonly resources: readonly McpRemoteResource[]; readonly nextCursor?: string }>;
  readResource?(uri: string): Promise<{ readonly contents: readonly McpResourceContent[] }>;
  callTool(
    name: string,
    argumentsValue: JsonValue,
    signal: AbortSignal,
    continuation?: McpCallContinuation,
  ): Promise<McpCallResult | JsonValue>;
  close(): Promise<void>;
}

export interface McpCallContinuation {
  readonly inputResponses: Readonly<Record<string, JsonValue>>;
  readonly requestState?: string;
}

export type McpCallResult =
  | { readonly kind: "completed"; readonly result: JsonValue }
  | {
      readonly kind: "input-required";
      readonly inputRequests: Readonly<Record<string, JsonValue>>;
      readonly requestState?: string;
    };

export type McpToolRiskOverrides = Readonly<Record<string, ToolDefinition["sideEffect"]>>;

export interface McpToolLimits {
  readonly requiredPermissions?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxTools?: number;
  readonly maxResultBytes?: number;
  readonly riskOverrides?: McpToolRiskOverrides;
  /** Durable modern MCP elicitation. URL flows default to the configured MCP endpoint origin. */
  readonly elicitation?: {
    readonly enabled?: boolean;
    readonly allowedUrlOrigins?: readonly string[];
  };
  /** Two extra neutral tools (list_resources/read_resource) when the server advertises `resources`. */
  readonly resources?: {
    readonly enabled?: boolean;
    /**
     * Deployment-pinned resource URI schemes, on top of whatever `resources/list` reveals at
     * runtime (`read_resource` also learns schemes lazily on demand — see resource-tools.ts).
     * Optional: a connector that only works once someone remembered this is a trap, so it exists
     * for a deployment that wants the set pinned explicitly, never as a requirement.
     */
    readonly allowedSchemes?: readonly string[];
  };
}

export interface McpToolsPluginConfig extends McpToolLimits {
  readonly serverId: string;
  readonly endpoint?: string;
  readonly secretNames?: readonly string[];
  readonly clientFactory: () => Promise<McpClientPort>;
}

export interface McpHttpToolsPluginConfig extends Omit<McpToolsPluginConfig, "clientFactory" | "endpoint"> {
  readonly endpoint: string;
  /** Accept http:// for a non-loopback endpoint the deployment declares cluster-internal. */
  readonly allowInsecureInternal?: boolean;
  /** @deprecated Prefer authProvider so tokens can rotate and recover from 401. */
  readonly bearerToken?: string;
  readonly authProvider?: AuthProvider;
  readonly fetch?: typeof globalThis.fetch;
}

export interface McpPrincipalAuthorizationContext {
  readonly serverId: string;
  readonly endpoint: string;
  readonly security: SecurityContext;
  readonly agentProfileId: string;
}

export interface McpPrincipalAuthorization {
  /** Opaque non-secret grant/account revision used only to partition client state. */
  readonly partition: string;
  readonly authProvider?: AuthProvider;
}

export interface McpPrincipalAuthorizationResolver {
  resolve(context: McpPrincipalAuthorizationContext, signal: AbortSignal): Promise<McpPrincipalAuthorization>;
}

export interface McpContextualHttpToolsPluginConfig extends McpToolLimits {
  readonly serverId: string;
  readonly endpoint: string;
  /** Accept http:// for a non-loopback endpoint the deployment declares cluster-internal. */
  readonly allowInsecureInternal?: boolean;
  readonly authorizationResolver: McpPrincipalAuthorizationResolver;
  /** Trusted composition may prepare an input after authorization, before remote execution. */
  readonly prepareToolCall?: (name: string, invocation: ToolInvocation, signal: AbortSignal) => Promise<void>;
  readonly fetch?: typeof globalThis.fetch;
  readonly idleTtlMs?: number;
  readonly maxConnections?: number;
  readonly secretNames?: readonly string[];
  /** Optional connectors degrade to an empty catalog; required connectors fail the turn. */
  readonly failureMode?: "omit" | "fail";
  /** The connector reads the files users attach (its deployment stores them where it reads them): `ContextualToolSource.readsAttachments`. */
  readonly readsAttachments?: boolean;
  /** Test seam; production uses the official Streamable HTTP transport. */
  readonly clientFactory?: (authorization: McpPrincipalAuthorization) => Promise<McpClientPort>;
}

export interface McpStdioToolsPluginConfig extends McpToolLimits {
  readonly serverId: string;
  readonly command: string;
  readonly args?: readonly string[];
  /** Falls back to `process.cwd()`; always passed explicitly to the child, never left implicit. */
  readonly cwd?: string;
  /**
   * Names of parent env vars the child may see, beyond a small fixed baseline the transport always
   * merges in regardless (PATH/HOME/USER/SHELL/TERM/LOGNAME on POSIX — see stdio-client.ts). No
   * secret this config doesn't name reaches the child either way; only that baseline is unavoidable.
   */
  readonly envPassthrough?: readonly string[];
  /** Test seam / source of the parent environment; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Explicit allowlist of commands this connector may spawn. Never resolved from ambient config. */
  readonly commandAllowlist: readonly string[];
  readonly maxBufferSize?: number;
  /** Crash-restart budget: at most this many (re)spawns within `restartWindowMs`. */
  readonly maxRestarts?: number;
  readonly restartWindowMs?: number;
  /** Optional connectors degrade to an empty catalog; required connectors fail the turn. */
  readonly failureMode?: "omit" | "fail";
  /** The connector reads the files users attach: `ContextualToolSource.readsAttachments`. */
  readonly readsAttachments?: boolean;
  /** Test seam; production spawns the official stdio transport. */
  readonly clientFactory?: (hooks: { onStderr(chunk: Buffer): void; onUnexpectedClose(): void }) => Promise<McpClientPort>;
}

export interface NormalizedMcpLimits {
  readonly timeoutMs: number;
  readonly maxTools: number;
  readonly maxResultBytes: number;
  readonly elicitationEnabled: boolean;
  readonly resourcesEnabled: boolean;
  readonly allowedUrlOrigins: readonly string[];
  /** Normalized to include the trailing colon, matching `new URL(uri).protocol` (e.g. "https:"). */
  readonly resourcePinnedSchemes: readonly string[];
}
