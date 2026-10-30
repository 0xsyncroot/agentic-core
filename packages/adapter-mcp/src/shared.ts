import { createHash } from "node:crypto";
import { AgenticError, canonicalJson, type JsonValue, type SecurityContext, type ToolDefinition } from "@0xsyncroot/contracts";
import type { McpClientPort, McpRemoteTool, McpToolLimits, McpToolRiskOverrides, NormalizedMcpLimits } from "./types.js";

export function validateServerId(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(value)) throw new Error(`Invalid MCP server id: ${value}`);
  return value;
}

const MAX_TOOL_ID_LENGTH = 64;

/**
 * Composes and validates the one id a tool is known by everywhere: the journal, `origin`, the
 * schema OpenAI/DeepSeek/Anthropic all see as `function.name`, and skills/docs that reference it by
 * name. Every one of those providers enforces `^[a-zA-Z0-9_-]{1,64}$` on `function.name`
 * (`packages/core/src/agent/model-tool-schema.ts` mints it straight from this id, unmodified), so
 * sanitizing per adapter instead — giving the tool three different names — is not an option: a
 * model that reads the dotted form in a skill would try to call a name no provider would accept.
 * `mcp_<serverId>_<toolName>` — `validateServerId`/discoverTools already keep both halves to
 * `[a-z0-9-]`/`[A-Za-z0-9_-]`, so only the combined length still needs checking here.
 */
export function mcpToolId(serverId: string, toolName: string): string {
  const id = `mcp_${serverId}_${toolName}`;
  if (id.length > MAX_TOOL_ID_LENGTH) {
    throw new Error(`MCP tool id "${id}" for server "${serverId}" tool "${toolName}" exceeds ${MAX_TOOL_ID_LENGTH} characters`);
  }
  return id;
}

/**
 * HTTPS unless the endpoint is loopback, or the deployment states the hop is internal.
 *
 * `allowInsecureInternal` exists because the alternative is worse: a server-to-server call to a
 * cluster Service (`http://example-mcp:5182`) that must be HTTPS gets routed out through the public
 * ingress instead, exposing an internal surface to the internet to satisfy a transport rule.
 */
export function validateEndpoint(value: string, allowInsecureInternal = false): URL {
  const endpoint = new URL(value);
  if (endpoint.username || endpoint.password) throw new Error("MCP endpoint must not contain credentials");
  if (endpoint.hash) throw new Error("MCP endpoint must not contain a fragment");
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw new Error("MCP endpoint must be http:// or https://");
  if (endpoint.protocol !== "https:" && !allowInsecureInternal && endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost" && endpoint.hostname !== "::1") {
    throw new Error("Remote MCP endpoint must use HTTPS unless allowInsecureInternal states the hop is cluster-internal");
  }
  return endpoint;
}

export function normalizeLimits(config: McpToolLimits): NormalizedMcpLimits {
  const allowedUrlOrigins = [...new Set((config.elicitation?.allowedUrlOrigins ?? []).map((value) => {
    const url = new URL(value);
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("MCP elicitation URL allowlist entries must be origins");
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "::1") {
      throw new Error("MCP elicitation URL origins must use HTTPS");
    }
    return url.origin;
  }))];
  const resourcePinnedSchemes = [...new Set((config.resources?.allowedSchemes ?? []).map((value) => {
    const trimmed = value.trim().toLowerCase();
    const scheme = trimmed.endsWith(":") ? trimmed : `${trimmed}:`;
    if (!/^[a-z][a-z0-9+.-]*:$/.test(scheme)) throw new Error(`MCP resources.allowedSchemes entry is not a valid URI scheme: ${value}`);
    return scheme;
  }))];
  const normalized = {
    timeoutMs: config.timeoutMs ?? 30_000,
    maxTools: config.maxTools ?? 100,
    maxResultBytes: config.maxResultBytes ?? 1024 * 1024,
    elicitationEnabled: config.elicitation?.enabled ?? true,
    resourcesEnabled: config.resources?.enabled ?? true,
    allowedUrlOrigins,
    resourcePinnedSchemes,
  };
  if (!Number.isInteger(normalized.timeoutMs) || normalized.timeoutMs <= 0) throw new Error("MCP timeoutMs must be positive");
  if (!Number.isInteger(normalized.maxTools) || normalized.maxTools <= 0) throw new Error("MCP maxTools must be positive");
  if (!Number.isInteger(normalized.maxResultBytes) || normalized.maxResultBytes <= 0) throw new Error("MCP maxResultBytes must be positive");
  return normalized;
}

/**
 * A config that can spawn a process is a remote-code-execution surface: the command must match an
 * explicit allowlist the composition supplied, never "whatever the config/env says". Refused at
 * composition time (config-shape validation, like {@link validateServerId}), not lazily on first use.
 */
export function validateCommandAllowlist(command: string, allowlist: readonly string[], serverId: string): void {
  if (!allowlist.includes(command)) {
    throw new Error(`MCP stdio command for ${serverId} is not on the configured allowlist: ${command}`);
  }
}

/** The child's environment is allowlisted, not inherited: only the names in `names` get through. */
export function filterEnv(source: Readonly<Record<string, string | undefined>>, names: readonly string[]): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return Object.freeze(result);
}

export function toolSideEffect(tool: McpRemoteTool, overrides: McpToolRiskOverrides = {}): ToolDefinition["sideEffect"] {
  if (tool.annotations?.destructiveHint === true) return "nonIdempotent";
  return overrides[tool.name] ?? "nonIdempotent";
}

export function boundedJson(value: unknown, label: string, maxBytes: number): JsonValue {
  let serialized: string;
  try { serialized = JSON.stringify(value); }
  catch (error) { throw new AgenticError("permanent", `${label} is not JSON serializable`, false, { cause: error }); }
  if (serialized === undefined) throw new AgenticError("permanent", `${label} is not JSON serializable`);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new AgenticError("permanent", `${label} exceeds ${maxBytes} bytes`);
  return JSON.parse(serialized) as JsonValue;
}

/**
 * Whether the connected client exposes MCP `resources/*` operations for this connector: the http
 * client only attaches `listResources`/`readResource` when the server advertised the `resources`
 * capability at connect time, so their presence on the port *is* the capability signal.
 */
export function resourcesCapability(client: McpClientPort): boolean {
  return typeof client.listResources === "function" && typeof client.readResource === "function";
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Also used by resource-tools.ts's `read_resource` input schema: one shared bound for a URI. */
export const MAX_RESOURCE_URI_LENGTH = 2048;
const MAX_RESOURCE_LINK_TEXT_LENGTH = 500;
const MAX_RESOURCE_LINKS = 100;

/**
 * `resource_link` blocks are compact references by nature, so bounding each field — never
 * exempting the block from the byte budget entirely — is what actually serves that: a validated
 * link costs almost nothing against `maxBytes`, and an oversized one (an 8 MB `uri`, say) is
 * exactly the abuse case a cap exists to catch, not a legitimate reference. Every field here is
 * server-controlled and untrusted, same as everything else in a tool result.
 */
function validateResourceLinks(value: unknown, label: string): void {
  if (!isRecord(value) || !Array.isArray(value.content)) return;
  let linkCount = 0;
  for (const block of value.content) {
    if (!isRecord(block) || block.type !== "resource_link") continue;
    linkCount += 1;
    if (linkCount > MAX_RESOURCE_LINKS) {
      throw new AgenticError("permanent", `${label}: carries more than ${MAX_RESOURCE_LINKS} resource_link blocks`);
    }
    if (typeof block.uri !== "string" || block.uri.length > MAX_RESOURCE_URI_LENGTH) {
      throw new AgenticError("permanent", `${label}: a resource_link uri exceeds ${MAX_RESOURCE_URI_LENGTH} characters`);
    }
    for (const field of ["name", "description"] as const) {
      const text = block[field];
      if (text !== undefined && (typeof text !== "string" || text.length > MAX_RESOURCE_LINK_TEXT_LENGTH)) {
        throw new AgenticError("permanent", `${label}: a resource_link ${field} exceeds ${MAX_RESOURCE_LINK_TEXT_LENGTH} characters`);
      }
    }
  }
}

/**
 * Schema for what this adapter actually hands back as a tool result.
 *
 * MCP's `outputSchema` describes `structuredContent` on its own, but the result that crosses into
 * the agent is the whole call result — `content`, `structuredContent`, `_meta`. Registering the
 * server's schema unchanged therefore claimed the envelope *was* the structured payload, and the
 * core's output check then rejected every valid result of every tool that declared an output
 * schema, while a server that declared none sailed through: the check ran exactly backwards, and
 * only servers that bothered to describe their output were punished for doing so. It failed
 * `list_budget_units` on a result the server had already marked `IsError = False`, and the model,
 * given a failed tool and no reason it could act on, told the accountant the catalogue was empty.
 *
 * `structuredContent` is deliberately **not** required here. A tool that fails answers with
 * `isError` and text content and no structured payload at all; that answer is the server's to
 * deliver, not something to replace with a validation error about a field the failure path never
 * promised. Requiring it would turn every remote tool error into a local schema error.
 */
/** How much of a refusing tool's own text is carried to the caller. */
const MAX_TOOL_ERROR_CHARS = 4_000;

/**
 * What a failing tool said, as the message the caller is given.
 *
 * A tool that refuses answers with `isError` and its reason in text content; that is the whole
 * mechanism by which a server tells an agent how to correct itself, and the spec puts it in the
 * result rather than a protocol error for exactly that reason. Both clients used to discard it and
 * raise "MCP tool X returned an error", so every refusal a server writes — its error code, the
 * header row a sheet really uses, the arguments it just rejected — stopped one layer short of the
 * only reader it was written for.
 *
 * From outside it was indistinguishable from a model ignoring advice: over two runs an agent was
 * refused 45 times with the row to use named in every refusal and used it zero times, while it
 * rewrote the one thing it could still guess at. It had never been shown the row.
 */
export function toolErrorMessage(name: string, result: unknown): string {
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const said = content
    .flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text.trim()] : []))
    .filter(Boolean)
    .join(" ")
    .slice(0, MAX_TOOL_ERROR_CHARS);
  return said ? `MCP tool ${name} returned an error: ${said}` : `MCP tool ${name} returned an error`;
}

/**
 * A tool's own refusal (`isError` result): the server answered, so the connection is healthy.
 * The principal pool keeps its client for this error and retires it for everything else.
 */
export class McpToolRefusal extends AgenticError {
  constructor(name: string, result: unknown) { super("permanent", toolErrorMessage(name, result)); }
}

export function toolResultSchema(outputSchema: JsonValue | undefined, label: string, maxBytes: number): JsonValue {
  const declared = boundedJson(outputSchema ?? {}, label, maxBytes);
  if (!isRecord(declared) || Object.keys(declared).length === 0) return {};
  return { type: "object", properties: { structuredContent: declared } };
}

/**
 * A result without the text block that only repeats its own `structuredContent`.
 *
 * A server that answers with structured content also sends the same JSON as a text block, for
 * clients that read text alone — the protocol asks it to. This adapter hands the model both, so
 * every structured result arrived twice: double the size against a budget that counts characters,
 * and nothing in the second copy that was not in the first. A 46-sheet workbook's overview is
 * 17,600 characters; doubled, it was over the runtime's 32,000 and the whole result was refused —
 * the model was told the read had failed, on a file that had been read. Dropped only when the text
 * really is that JSON: any other text block is something the server chose to say.
 */
function withoutEchoedStructuredContent(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.structuredContent) || !Array.isArray(value.content)) return value;
  const structured = canonicalJson(value.structuredContent);
  const content = value.content.filter((block) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return true;
    try { return canonicalJson(JSON.parse(block.text) as JsonValue) !== structured; } catch { return true; }
  });
  return content.length === value.content.length ? value : { ...value, content };
}

/** {@link boundedJson}, plus per-field bounds on any `resource_link` content blocks in the result. */
export function boundedToolResult(value: unknown, label: string, maxBytes: number): JsonValue {
  validateResourceLinks(value, label);
  return boundedJson(withoutEchoedStructuredContent(value), label, maxBytes);
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function principalBinding(security: SecurityContext): string {
  return digest({
    tenantId: security.tenantId, actorId: security.actorId,
    issuer: security.authentication?.issuer ?? "unspecified",
    subject: security.authentication?.subject ?? "unspecified",
    assurance: security.authentication?.assurance ?? "unspecified",
    grantRevision: security.grantRevision ?? "unspecified",
    permissions: [...security.permissions].sort(),
    roles: [...(security.roles ?? [])].sort(),
    authorizedAgentProfiles: [...(security.authorizedAgentProfiles ?? [])].sort(),
  });
}

export async function discoverTools(client: McpClientPort, maxTools: number): Promise<readonly McpRemoteTool[]> {
  const tools: McpRemoteTool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor);
    tools.push(...page.tools);
    if (tools.length > maxTools) throw new Error(`MCP tool count exceeds ${maxTools}`);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error("MCP tools/list returned a cursor cycle");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const names = new Set<string>();
  for (const tool of tools) {
    // Every major provider's function.name pattern, matched exactly (see mcpToolId's doc comment):
    // rejected loudly here, at discovery, beats a 400 from the provider that names an array index.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)) throw new Error(`MCP returned a tool name that is not a valid provider function name: ${tool.name}`);
    if (names.has(tool.name)) throw new Error(`MCP returned duplicate tool ${tool.name}`);
    names.add(tool.name);
  }
  return tools;
}
