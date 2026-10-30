import type { JsonValue } from "@0xsyncroot/contracts";
import { Client, isInputRequiredResult, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { McpClientPort, McpPrincipalAuthorization, McpRemoteResource, McpRemoteTool, McpResourceContent } from "./types.js";
import { McpToolRefusal } from "./shared.js";
import { mcpOperation } from "./transport-error.js";

export function createHttpClientFactory(
  endpoint: URL,
  fetchImplementation?: typeof globalThis.fetch,
  elicitationEnabled = true,
): (authorization: McpPrincipalAuthorization) => Promise<McpClientPort> {
  return async (authorization) => {
    const client = new Client({ name: "agentic-core", version: "0.1.0" }, {
      capabilities: { ...(elicitationEnabled ? { elicitation: { form: {}, url: {} } } : {}) },
      versionNegotiation: { mode: "auto" },
      inputRequired: { autoFulfill: false },
    });
    if (elicitationEnabled) client.setRequestHandler("elicitation/create", async () => ({ action: "cancel" }));
    const transport = new StreamableHTTPClientTransport(endpoint, {
      ...(authorization.authProvider ? { authProvider: authorization.authProvider } : {}),
      ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
    });
    try { await mcpOperation(() => client.connect(transport)); }
    catch (error) { await client.close().catch(() => undefined); throw error; }
    // Presence of listResources/readResource on the returned port *is* the resources-capability
    // signal the rest of the adapter reads (see shared.ts#resourcesCapability): only attach them
    // when the server actually advertised `resources` during connect.
    const resourcesSupported = client.getServerCapabilities()?.resources !== undefined;
    return {
      listTools: async (cursor) => {
        const page = await mcpOperation(() => client.listTools({ ...(cursor ? { cursor } : {}) }));
        return { tools: page.tools as McpRemoteTool[], ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      },
      ...(resourcesSupported ? {
        listResources: async (cursor?: string) => {
          const page = await mcpOperation(() => client.listResources({ ...(cursor ? { cursor } : {}) }));
          return { resources: page.resources as McpRemoteResource[], ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
        },
        readResource: async (uri: string) => {
          const result = await mcpOperation(() => client.readResource({ uri }));
          return { contents: result.contents as McpResourceContent[] };
        },
      } : {}),
      callTool: async (name, argumentsValue, signal, continuation) => {
        const params = {
          name, arguments: argumentsValue as Record<string, unknown>,
          ...(continuation ? { inputResponses: continuation.inputResponses, ...(continuation.requestState !== undefined ? { requestState: continuation.requestState } : {}) } : {}),
        };
        const result = await mcpOperation(() => client.callTool(params as Parameters<Client["callTool"]>[0], { signal, allowInputRequired: elicitationEnabled }));
        if (isInputRequiredResult(result)) return {
          kind: "input-required" as const,
          inputRequests: result.inputRequests as Record<string, JsonValue>,
          ...(result.requestState !== undefined ? { requestState: result.requestState } : {}),
        };
        if (result.isError) throw new McpToolRefusal(name, result);
        return { kind: "completed" as const, result: result as unknown as JsonValue };
      },
      close: () => client.close(),
    };
  };
}
