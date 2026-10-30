/** The shape of one configured MCP server, from AGENTIC_MCP_SERVERS or AGENTIC_MCP_CONFIG_FILE. */
export type McpAuthMode = "anonymous" | "service" | "delegated";

export type McpTransport = "http" | "stdio";

export interface McpServerConfigCommon {
  readonly id: string;
  readonly requiredPermissions?: readonly string[];
  readonly riskOverrides?: Readonly<Record<string, "none" | "idempotent" | "nonIdempotent">>;
  readonly timeoutMs?: number;
  readonly maxTools?: number;
  readonly maxResultBytes?: number;
  readonly failureMode?: "omit" | "fail";
  readonly elicitation?: { readonly enabled?: boolean; readonly allowedUrlOrigins?: readonly string[] };
  readonly resources?: { readonly enabled?: boolean; readonly allowedSchemes?: readonly string[] };
}

export interface McpHttpServerConfig extends McpServerConfigCommon {
  readonly transport: "http";
  readonly endpoint: string;
  /** Optional internal binary file API, on the same origin as this MCP service. */
  readonly filesEndpoint?: string;
  /** Backend archive only; credentials are never passed to the remote file service. */
  readonly attachmentStorage?: { readonly s3EnvPrefix: string; readonly keyPrefix: string };
  readonly authMode: McpAuthMode;
  readonly tokenEnv?: string;
  readonly authProfileRef?: string;
  readonly idleTtlMs?: number;
  readonly maxConnections?: number;
  /** http:// to a non-loopback endpoint, for a hop the deployment declares cluster-internal. */
  readonly allowInsecureInternal?: boolean;
  /**
   * The end user's own session token is what this server accepts (a product forwards it unchanged
   * as the Bearer). Declares how that token is verified: HS256 with the key in `keyEnv`, for
   * `audience`. The harness only validates the shape; the product composition that forwards the
   * token verifies it — the value of the key is never written in the file.
   */
  readonly sessionToken?: McpSessionTokenConfig;
}

/** A subprocess runs as the deployment, not as a principal: no endpoint, auth mode or token. */
export interface McpStdioServerConfig extends McpServerConfigCommon {
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Names of parent env vars the child may see. Nothing else from the environment reaches it. */
  readonly envPassthrough?: readonly string[];
  /** Non-secret values set for the child, written in the config itself (addresses, log levels). */
  readonly env?: Readonly<Record<string, string>>;
  readonly maxRestarts?: number;
  readonly restartWindowMs?: number;
}

export type McpServerConfig = McpHttpServerConfig | McpStdioServerConfig;

/**
 * How the end user's session token is verified: HS256 with the key in `keyEnv`; `iss` must equal
 * `issuer` and/or `aud` must equal `audience` (at least one is declared); `claims` names which
 * claims carry the tenant, the user and the session — issuers name them differently.
 */
export interface McpSessionTokenConfig {
  readonly keyEnv: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly claims: { readonly tenant: string; readonly user: string; readonly session: string };
}
