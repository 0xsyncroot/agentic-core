import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parse } from "yaml";
import { HTTP_ONLY_FIELDS, MAX_SOURCE_BYTES, STDIO_ONLY_FIELDS, parseServerList } from "./mcp-server-config.js";
import type { McpServerConfig } from "./mcp-server-types.js";

/**
 * `AGENTIC_MCP_CONFIG_FILE`: the MCP server list as a reviewed YAML file. Same schema and validation
 * as the `AGENTIC_MCP_SERVERS` JSON (`parseServerList`), plus the checks only a file needs.
 */
// Built on first use, not at load: this module and mcp-server-config.js import each other, and
// the field lists are not initialized yet while this one is being evaluated.
let knownFields: ReadonlySet<string> | undefined;
function isKnownField(key: string): boolean {
  knownFields ??= new Set<string>([
  "id", "transport", "requiredPermissions", "riskOverrides", "timeoutMs", "maxTools", "maxResultBytes",
  "failureMode", "elicitation", "resources", ...HTTP_ONLY_FIELDS, ...STDIO_ONLY_FIELDS,
]);
  return knownFields.has(key);
}
/** Keys a file must never carry: each would put a credential into git and an image layer. */
const SECRET_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  token: "tokenEnv", accessToken: "tokenEnv", apiKey: "tokenEnv", secret: "tokenEnv", password: "tokenEnv",
  headers: "tokenEnv or authProfileRef", authorization: "tokenEnv or authProfileRef",
});
function containsPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return value.includes("${");
  if (Array.isArray(value)) return value.some(containsPlaceholder);
  if (value && typeof value === "object") return Object.values(value).some(containsPlaceholder);
  return false;
}

/**
 * The file-only checks, run before the shared validation: unknown keys, literal credentials, and
 * `${...}` placeholders.
 *
 * Every value is written in the file itself — endpoints included — so the file is the whole answer
 * to "what does this deployment connect to". An environment with different endpoints gets its own
 * copy of the file (a product's config directory, or AGENTIC_MCP_CONFIG_FILE), the same way elk.yaml
 * and langfuse.yaml differ per environment; only secrets stay out, named through tokenEnv.
 *
 * The environment source tolerates unknown keys for compatibility; a file is new and reviewed, so a
 * misspelt `riskOverride` there fails at boot instead of silently leaving every read gated.
 */
function checkFileEntry(item: unknown, at: string): void {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return;
  for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
    const replacement = SECRET_FIELDS[key];
    if (replacement) throw new Error(`${at}.${key} must not appear in the file; name the secret with ${replacement} instead`);
    if (!isKnownField(key)) throw new Error(`${at}.${key} is not a known field`);
    if (containsPlaceholder(value)) {
      throw new Error(`${at}.${key} cannot use \${...}; write the value itself, and give each environment its own copy of the file`);
    }
  }
}

/**
 * Reads the MCP server list from a YAML file — the reviewed, diffable form of `AGENTIC_MCP_SERVERS`.
 *
 * Same schema and same validation as the environment variable, plus the file-only checks in
 * `resolveFileEntry`. Read synchronously because it runs once, at boot, inside the synchronous
 * settings reader; a missing file is an error naming the path, never an empty list.
 */
export function readMcpServersFile(path: string): readonly McpServerConfig[] {
  const name = basename(path);
  let source: string;
  try { source = readFileSync(path, "utf8"); } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    throw new Error(code === "ENOENT" ? `MCP server file not found: ${path}` : `MCP server file ${path} could not be read (${code ?? "unknown error"})`);
  }
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) throw new Error(`${name} exceeds ${MAX_SOURCE_BYTES} bytes`);
  let document: unknown;
  try { document = parse(source); } catch (error) {
    throw new Error(`${name} is not valid YAML: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) throw new Error(`${name} must be a mapping with a servers list`);
  const root = document as Record<string, unknown>;
  for (const key of Object.keys(root)) if (key !== "servers") throw new Error(`${name}: unknown top-level key ${key}`);
  // `servers:` with nothing under it parses as null — an empty list written down, not an omission.
  const servers = root.servers ?? (Object.hasOwn(root, "servers") ? [] : undefined);
  if (servers === undefined) throw new Error(`${name} requires a servers list (write servers: [] for none)`);
  const label = `${name} servers`;
  if (Array.isArray(servers)) servers.forEach((item, index) => checkFileEntry(item, `${label}[${index}]`));
  return parseServerList(servers, label);
}
