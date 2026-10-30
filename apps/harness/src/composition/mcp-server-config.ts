import { readMcpServersFile } from "./mcp-server-file.js";
import type { McpHttpServerConfig, McpServerConfig, McpStdioServerConfig } from "./runtime-config.js";

export type { McpHttpServerConfig, McpServerConfig, McpStdioServerConfig } from "./runtime-config.js";
export type McpAuthMode = McpHttpServerConfig["authMode"];

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function positiveIntegerField(at: string, field: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${at}.${field} must be a positive integer`);
  }
  return value;
}

/** Origins only: no path/query/fragment/credentials, and HTTPS unless it targets loopback. */
function httpsOrigin(at: string, field: string, value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${at}.${field} entries must be valid URLs`); }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error(`${at}.${field} entries must be origins, with no path, query or credentials`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "::1") {
    throw new Error(`${at}.${field} entries must use HTTPS`);
  }
  return url.origin;
}

function elicitationField(at: string, value: unknown): McpServerConfig["elicitation"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${at}.elicitation must be an object`);
  const record = value as Record<string, unknown>;
  if (record.enabled !== undefined && typeof record.enabled !== "boolean") throw new Error(`${at}.elicitation.enabled must be a boolean`);
  let allowedUrlOrigins: readonly string[] | undefined;
  if (record.allowedUrlOrigins !== undefined) {
    if (!Array.isArray(record.allowedUrlOrigins) || record.allowedUrlOrigins.some((origin) => typeof origin !== "string")) {
      throw new Error(`${at}.elicitation.allowedUrlOrigins must be a string array`);
    }
    allowedUrlOrigins = Object.freeze(
      record.allowedUrlOrigins.map((origin) => httpsOrigin(at, "elicitation.allowedUrlOrigins", origin as string)),
    );
  }
  return Object.freeze({
    ...(record.enabled !== undefined ? { enabled: record.enabled as boolean } : {}),
    ...(allowedUrlOrigins ? { allowedUrlOrigins } : {}),
  });
}

function resourcesField(at: string, value: unknown): McpServerConfig["resources"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${at}.resources must be an object`);
  const record = value as Record<string, unknown>;
  if (record.enabled !== undefined && typeof record.enabled !== "boolean") throw new Error(`${at}.resources.enabled must be a boolean`);
  const allowedSchemes = stringArrayField(at, "resources.allowedSchemes", record.allowedSchemes);
  return Object.freeze({
    ...(record.enabled !== undefined ? { enabled: record.enabled as boolean } : {}),
    ...(allowedSchemes ? { allowedSchemes } : {}),
  });
}

function failureModeField(at: string, value: unknown): McpServerConfig["failureMode"] {
  if (value === undefined) return undefined;
  if (value !== "omit" && value !== "fail") throw new Error(`${at}.failureMode must be "omit" or "fail"`);
  return value;
}

/** Fields meaningful only for the other transport: present but silently ignored would hide a typo. */
function rejectFields(at: string, record: Record<string, unknown>, fields: readonly string[], transport: string): void {
  for (const field of fields) {
    if (record[field] !== undefined) throw new Error(`${at}.${field} is not valid for transport "${transport}"`);
  }
}

const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

function stringArrayField(at: string, field: string, value: unknown, pattern?: RegExp): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item || (pattern && !pattern.test(item)))) {
    throw new Error(`${at}.${field} must be an array of ${pattern ? "environment variable names" : "non-empty strings"}`);
  }
  return Object.freeze([...(value as string[])]);
}

/** Fields common to both transports, shared verbatim so http/stdio stay in lockstep. */
function commonFields(at: string, record: Record<string, unknown>): Partial<McpServerConfig> {
  if (record.requiredPermissions !== undefined && (!Array.isArray(record.requiredPermissions) || record.requiredPermissions.some((permission) => typeof permission !== "string" || !permission.trim()))) {
    throw new Error(`${at}.requiredPermissions must be a string array`);
  }
  if (record.riskOverrides !== undefined && (typeof record.riskOverrides !== "object" || record.riskOverrides === null || Array.isArray(record.riskOverrides) || Object.entries(record.riskOverrides as Record<string, unknown>).some(([name, risk]) => !name || !["none", "idempotent", "nonIdempotent"].includes(String(risk))))) {
    throw new Error(`${at}.riskOverrides is invalid`);
  }
  const timeoutMs = positiveIntegerField(at, "timeoutMs", record.timeoutMs);
  const maxTools = positiveIntegerField(at, "maxTools", record.maxTools);
  const maxResultBytes = positiveIntegerField(at, "maxResultBytes", record.maxResultBytes);
  const failureMode = failureModeField(at, record.failureMode);
  const elicitation = elicitationField(at, record.elicitation);
  const resources = resourcesField(at, record.resources);
  return {
    ...(record.requiredPermissions ? { requiredPermissions: record.requiredPermissions as string[] } : {}),
    ...(record.riskOverrides ? { riskOverrides: Object.freeze({ ...(record.riskOverrides as Record<string, "none" | "idempotent" | "nonIdempotent">) }) } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxTools !== undefined ? { maxTools } : {}),
    ...(maxResultBytes !== undefined ? { maxResultBytes } : {}),
    ...(failureMode !== undefined ? { failureMode } : {}),
    ...(elicitation !== undefined ? { elicitation } : {}),
    ...(resources !== undefined ? { resources } : {}),
  };
}

export const HTTP_ONLY_FIELDS = ["endpoint", "filesEndpoint", "attachmentStorage", "authMode", "tokenEnv", "authProfileRef", "idleTtlMs", "maxConnections", "allowInsecureInternal", "sessionToken"] as const;
export const STDIO_ONLY_FIELDS = ["command", "args", "cwd", "envPassthrough", "env", "maxRestarts", "restartWindowMs"] as const;

function sessionTokenField(at: string, value: unknown): McpHttpServerConfig["sessionToken"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${at}.sessionToken must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["keyEnv", "issuer", "audience", "claims"].includes(key)) {
      throw new Error(key === "key" || key === "secret"
        ? `${at}.sessionToken.${key} must not appear in the file; name the environment variable holding it with keyEnv`
        : `${at}.sessionToken.${key} is not a known field`);
    }
  }
  if (typeof record.keyEnv !== "string" || !ENV_NAME_PATTERN.test(record.keyEnv)) throw new Error(`${at}.sessionToken.keyEnv must be an environment variable name`);
  const text = (name: string, value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) throw new Error(`${at}.sessionToken.${name} must be a non-empty string`);
    return value.trim();
  };
  const issuer = text("issuer", record.issuer);
  const audience = text("audience", record.audience);
  if (!issuer && !audience) throw new Error(`${at}.sessionToken needs issuer or audience — a token checked against neither is accepted from any issuer sharing the key`);
  const claims = record.claims === undefined ? {} : record.claims;
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) throw new Error(`${at}.sessionToken.claims must be a mapping`);
  for (const key of Object.keys(claims)) {
    if (!["tenant", "user", "session"].includes(key)) throw new Error(`${at}.sessionToken.claims.${key} is not a known field (tenant, user, session)`);
  }
  const named = claims as Record<string, unknown>;
  return Object.freeze({
    keyEnv: record.keyEnv,
    ...(issuer ? { issuer } : {}),
    ...(audience ? { audience } : {}),
    claims: Object.freeze({
      tenant: text("claims.tenant", named.tenant) ?? "tenantId",
      user: text("claims.user", named.user) ?? "sub",
      session: text("claims.session", named.session) ?? "sid",
    }),
  });
}

/** Literal, non-secret child environment: names must be env names, values plain strings. */
function childEnvField(at: string, value: unknown): McpStdioServerConfig["env"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${at}.env must be a mapping of NAME: value`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) throw new Error(`${at}.env supports at most 32 variables`);
  for (const [name, item] of entries) {
    if (!ENV_NAME_PATTERN.test(name)) throw new Error(`${at}.env.${name} is not an environment variable name`);
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") throw new Error(`${at}.env.${name} must be a plain value`);
  }
  return Object.freeze(Object.fromEntries(entries.map(([name, item]) => [name, String(item)])));
}

function parseHttpServer(at: string, record: Record<string, unknown>): McpHttpServerConfig {
  rejectFields(at, record, STDIO_ONLY_FIELDS, "http");
  if (typeof record.endpoint !== "string") throw new Error(`${at} requires endpoint for transport "http"`);
  let filesEndpoint: string | undefined;
  let attachmentStorage: McpHttpServerConfig["attachmentStorage"];
  if (record.filesEndpoint !== undefined) {
    if (typeof record.filesEndpoint !== "string") throw new Error(`${at}.filesEndpoint must be a URL`);
    try {
      const files = new URL(record.filesEndpoint);
      if (files.origin !== new URL(record.endpoint).origin || files.username || files.password || files.search || files.hash) throw new Error();
      filesEndpoint = files.href.replace(/\/$/, "");
    } catch { throw new Error(`${at}.filesEndpoint must have the same origin as endpoint, with no credentials, query or fragment`); }
    if ((record.authMode ?? (record.tokenEnv ? "service" : "anonymous")) !== "service" || !record.tokenEnv) {
      throw new Error(`${at}.filesEndpoint requires service auth and tokenEnv`);
    }
  }
  if (record.attachmentStorage !== undefined) {
    const storage = record.attachmentStorage;
    if (!storage || typeof storage !== "object" || Array.isArray(storage)) {
      throw new Error(`${at}.attachmentStorage must be a storage mapping`);
    }
    const fields = storage as Record<string, unknown>;
    if (Object.keys(fields).some(key => !["s3EnvPrefix", "keyPrefix"].includes(key))
      || typeof fields.s3EnvPrefix !== "string" || !ENV_NAME_PATTERN.test(fields.s3EnvPrefix)
      || typeof fields.keyPrefix !== "string" || !fields.keyPrefix.trim()
      || fields.keyPrefix.split("/").some(part => part === "." || part === "..")) {
      throw new Error(`${at}.attachmentStorage requires s3EnvPrefix and a non-empty keyPrefix, with no other fields`);
    }
    attachmentStorage = Object.freeze({ s3EnvPrefix: fields.s3EnvPrefix, keyPrefix: fields.keyPrefix.trim() });
  }
  if (record.tokenEnv !== undefined && typeof record.tokenEnv !== "string") throw new Error(`${at}.tokenEnv must be a string`);
  if (typeof record.tokenEnv === "string" && !ENV_NAME_PATTERN.test(record.tokenEnv)) throw new Error(`${at}.tokenEnv must be an environment variable name`);
  const authMode = record.authMode ?? (record.tokenEnv ? "service" : "anonymous");
  if (authMode !== "anonymous" && authMode !== "service" && authMode !== "delegated") throw new Error(`${at}.authMode is invalid`);
  if (authMode === "service" && !record.tokenEnv) throw new Error(`${at} service auth requires tokenEnv`);
  if (authMode !== "service" && record.tokenEnv) throw new Error(`${at}.tokenEnv is only valid for service auth`);
  if (record.authProfileRef !== undefined && (typeof record.authProfileRef !== "string" || !record.authProfileRef.trim())) throw new Error(`${at}.authProfileRef must be a non-empty string`);
  if (authMode === "delegated" && !record.authProfileRef) throw new Error(`${at} delegated auth requires authProfileRef`);
  const idleTtlMs = positiveIntegerField(at, "idleTtlMs", record.idleTtlMs);
  const maxConnections = positiveIntegerField(at, "maxConnections", record.maxConnections);
  if (record.allowInsecureInternal !== undefined && typeof record.allowInsecureInternal !== "boolean") throw new Error(`${at}.allowInsecureInternal must be a boolean`);
  const sessionToken = sessionTokenField(at, record.sessionToken);
  return Object.freeze({
    id: record.id as string, transport: "http", endpoint: record.endpoint, authMode,
    ...(filesEndpoint ? { filesEndpoint } : {}),
    ...(attachmentStorage ? { attachmentStorage } : {}),
    ...(record.tokenEnv ? { tokenEnv: record.tokenEnv as string } : {}),
    ...(typeof record.authProfileRef === "string" ? { authProfileRef: record.authProfileRef } : {}),
    ...(idleTtlMs !== undefined ? { idleTtlMs } : {}),
    ...(maxConnections !== undefined ? { maxConnections } : {}),
    ...(record.allowInsecureInternal === true ? { allowInsecureInternal: true } : {}),
    ...(sessionToken ? { sessionToken } : {}),
    ...commonFields(at, record),
  }) as McpHttpServerConfig;
}

function parseStdioServer(at: string, record: Record<string, unknown>): McpStdioServerConfig {
  rejectFields(at, record, HTTP_ONLY_FIELDS, "stdio");
  if (typeof record.command !== "string" || !record.command.trim()) throw new Error(`${at} requires command for transport "stdio"`);
  const args = stringArrayField(at, "args", record.args);
  if (record.cwd !== undefined && (typeof record.cwd !== "string" || !record.cwd.trim())) throw new Error(`${at}.cwd must be a non-empty string`);
  const envPassthrough = stringArrayField(at, "envPassthrough", record.envPassthrough, ENV_NAME_PATTERN);
  const childEnv = childEnvField(at, record.env);
  const maxRestarts = positiveIntegerField(at, "maxRestarts", record.maxRestarts);
  const restartWindowMs = positiveIntegerField(at, "restartWindowMs", record.restartWindowMs);
  return Object.freeze({
    id: record.id as string, transport: "stdio", command: record.command,
    ...(args ? { args } : {}),
    ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
    ...(envPassthrough ? { envPassthrough } : {}),
    ...(childEnv ? { env: childEnv } : {}),
    ...(maxRestarts !== undefined ? { maxRestarts } : {}),
    ...(restartWindowMs !== undefined ? { restartWindowMs } : {}),
    ...commonFields(at, record),
  }) as McpStdioServerConfig;
}

export const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_SERVERS = 20;

/** Validates one list of server entries, whichever source it came from; `label` prefixes every error. */
export function parseServerList(value: unknown, label: string): readonly McpServerConfig[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  if (value.length > MAX_SERVERS) throw new Error(`${label} supports at most ${MAX_SERVERS} servers`);
  const ids = new Set<string>();
  return Object.freeze(value.map((item, index) => {
    const at = `${label}[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`${at} must be an object`);
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id) throw new Error(`${at} requires id`);
    if (ids.has(record.id)) throw new Error(`Duplicate MCP server id: ${record.id}`);
    ids.add(record.id);
    const transport = record.transport ?? "http";
    if (transport !== "http" && transport !== "stdio") throw new Error(`${at}.transport must be "http" or "stdio"`);
    return transport === "stdio" ? parseStdioServer(at, record) : parseHttpServer(at, record);
  }));
}

/**
 * The configured MCP servers: from the file named by `AGENTIC_MCP_CONFIG_FILE`, or else from the
 * `AGENTIC_MCP_SERVERS` JSON. Both at once is refused rather than merged — with two sources, nobody
 * reading either one alone knows what the service actually mounts.
 */
export function parseMcpServers(env: NodeJS.ProcessEnv): readonly McpServerConfig[] {
  const file = optional(env.AGENTIC_MCP_CONFIG_FILE);
  const source = optional(env.AGENTIC_MCP_SERVERS);
  if (file && source) {
    throw new Error(`AGENTIC_MCP_SERVERS and AGENTIC_MCP_CONFIG_FILE are both set; move the servers into ${file} and unset AGENTIC_MCP_SERVERS`);
  }
  if (file) return readMcpServersFile(file);
  if (!source) return [];
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) throw new Error(`AGENTIC_MCP_SERVERS exceeds ${MAX_SOURCE_BYTES} bytes`);
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("AGENTIC_MCP_SERVERS must be valid JSON"); }
  if (!Array.isArray(value)) throw new Error("AGENTIC_MCP_SERVERS must be a JSON array");
  return parseServerList(value, "AGENTIC_MCP_SERVERS");
}
