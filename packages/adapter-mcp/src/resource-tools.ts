import { AgenticError, type JsonValue, type ToolDefinition, type ToolInvocation, type ToolOrigin } from "@0xsyncroot/contracts";
import { boundedJson, digest, mcpToolId, MAX_RESOURCE_URI_LENGTH } from "./shared.js";
import { validateAgainstSchema } from "./schema-validation.js";
import type { McpClientPort, NormalizedMcpLimits } from "./types.js";

const MAX_URI_LENGTH = MAX_RESOURCE_URI_LENGTH;
const MAX_CURSOR_LENGTH = 4096;

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemeOf(uri: string): string | undefined {
  try { return new URL(uri).protocol; } catch { return undefined; }
}

export interface ResourceToolsConfig {
  readonly serverId: string;
  readonly limits: NormalizedMcpLimits;
  /** Schemes actually seen from this server's `resources/list`; `read_resource` fails closed outside it. */
  readonly knownSchemes: Set<string>;
  readonly requiredPermissions: readonly string[];
  readonly origin?: Pick<ToolOrigin, "sourceId" | "sourceVersion" | "catalogRevision">;
  /** Runs `operation` against a client bound to whichever principal (or single static connector) owns this call. */
  readonly withClient: <T>(
    invocation: ToolInvocation, signal: AbortSignal, operation: (client: McpClientPort) => Promise<T>,
  ) => Promise<T>;
}

function toolOrigin(
  base: Pick<ToolOrigin, "sourceId" | "sourceVersion" | "catalogRevision">,
  nativeId: string, inputSchema: JsonValue, outputSchema: JsonValue,
): ToolOrigin {
  return { ...base, nativeId, schemaDigest: digest({ inputSchema, outputSchema }) };
}

/**
 * The MCP resource-intake pattern as two neutral, product-agnostic tools: a bounded catalog page
 * plus a bounded read of one resource by URI. Registered only when the connector's client actually
 * exposes `listResources`/`readResource` (i.e. the server advertised the `resources` capability).
 */
export function createResourceTools(config: ResourceToolsConfig): readonly ToolDefinition[] {
  const { serverId, limits } = config;
  const listId = mcpToolId(serverId, "list_resources");
  const readId = mcpToolId(serverId, "read_resource");
  const listInputSchema: JsonValue = {
    type: "object",
    properties: { cursor: { type: "string", maxLength: MAX_CURSOR_LENGTH } },
    additionalProperties: false,
  };
  const listOutputSchema: JsonValue = {};
  const listDefinition: ToolDefinition = {
    id: listId, version: "1.0.0",
    description: `Lists resources exposed by the ${serverId} MCP connector. Each result carries a `
      + `resourceUri some tools return by reference; read it in full with ${readId}.`,
    inputSchema: listInputSchema, outputSchema: listOutputSchema,
    requiredPermissions: config.requiredPermissions, sideEffect: "none", timeoutMs: limits.timeoutMs,
    ...(config.origin ? { origin: toolOrigin(config.origin, "list_resources", listInputSchema, listOutputSchema) } : {}),
    validateArguments: (rawArguments) => validateAgainstSchema(listInputSchema, rawArguments, listId),
    execute: async (invocation: ToolInvocation, signal) => {
      const args = isRecord(invocation.arguments) ? invocation.arguments : {};
      const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
      const page = await config.withClient(invocation, signal, async (client) => {
        if (!client.listResources) throw new AgenticError("permanent", `MCP server ${serverId} does not support resources/list`);
        return client.listResources(cursor);
      });
      for (const resource of page.resources) {
        const scheme = schemeOf(resource.uri);
        if (scheme) config.knownSchemes.add(scheme);
      }
      return boundedJson(
        { resources: page.resources, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) },
        `MCP list_resources ${serverId}`, limits.maxResultBytes,
      );
    },
  };

  const readInputSchema: JsonValue = {
    type: "object",
    properties: { uri: { type: "string", maxLength: MAX_URI_LENGTH } },
    required: ["uri"], additionalProperties: false,
  };
  const readOutputSchema: JsonValue = {};
  const readDefinition: ToolDefinition = {
    id: readId, version: "1.0.0",
    description: `Reads the full content of one resource from the ${serverId} MCP connector by the `
      + `resourceUri a tool result (or ${listId}) returned.`,
    inputSchema: readInputSchema, outputSchema: readOutputSchema,
    requiredPermissions: config.requiredPermissions, sideEffect: "none", timeoutMs: limits.timeoutMs,
    ...(config.origin ? { origin: toolOrigin(config.origin, "read_resource", readInputSchema, readOutputSchema) } : {}),
    validateArguments: (rawArguments) => validateAgainstSchema(readInputSchema, rawArguments, readId),
    execute: async (invocation: ToolInvocation, signal) => {
      const args = isRecord(invocation.arguments) ? invocation.arguments : {};
      const uri = args.uri;
      if (typeof uri !== "string" || !uri || uri.length > MAX_URI_LENGTH) {
        throw new AgenticError("validation", `${readId}: uri must be a non-empty string of at most ${MAX_URI_LENGTH} characters`);
      }
      const scheme = schemeOf(uri);
      if (!scheme) throw new AgenticError("denied", "MCP resource URI scheme is not allowed: (unparsable)");
      if (!config.knownSchemes.has(scheme)) {
        // Fail-closed stays, but the caller is never required to have called list_resources
        // first: a resourceUri another tool just handed back is legitimate even with an empty
        // history, so learn the server's schemes on demand — bounded to exactly one lazy
        // resources/list attempt, never a retry loop. A server that cannot list (no support) is
        // silently `undefined` here, so the denial below still fires; a real operational failure
        // (the client actually throws) propagates as-is rather than being read as "not allowed".
        const page = await config.withClient(invocation, signal, (client) =>
          client.listResources ? client.listResources() : Promise.resolve(undefined));
        for (const resource of page?.resources ?? []) {
          const listedScheme = schemeOf(resource.uri);
          if (listedScheme) config.knownSchemes.add(listedScheme);
        }
      }
      if (!config.knownSchemes.has(scheme)) {
        throw new AgenticError("denied", `MCP resource URI scheme is not allowed: ${scheme}`);
      }
      const result = await config.withClient(invocation, signal, async (client) => {
        if (!client.readResource) throw new AgenticError("permanent", `MCP server ${serverId} does not support resources/read`);
        return client.readResource(uri);
      });
      return boundedJson(result, `MCP read_resource ${serverId}`, limits.maxResultBytes);
    },
  };

  return [listDefinition, readDefinition];
}
