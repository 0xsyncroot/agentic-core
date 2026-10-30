import assert from "node:assert/strict";
import { test } from "node:test";
import type { SecurityContext } from "@0xsyncroot/contracts";
import { PermissionToolExecutionPolicy, PluginHost, resolveContextualTools } from "@0xsyncroot/core";
import { TOOL_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import { createMcpContextualHttpToolsPlugin, createMcpToolsPlugin, type McpClientPort } from "@0xsyncroot/adapter-mcp";

const bootstrap: SecurityContext = { tenantId: "t", actorId: "bootstrap", permissions: new Set(["mcp.docs.invoke"]), correlationId: "c", purpose: "test" };
const PROVIDER_FUNCTION_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function toolClient(toolName: string): McpClientPort {
  return {
    listTools: async () => ({ tools: [{ name: toolName, inputSchema: { type: "object" } }] }),
    callTool: async () => ({ content: [] }),
    close: async () => undefined,
  };
}

test("a contextual MCP tool's id matches every major provider's function-name pattern", async () => {
  const host = new PluginHost();
  await host.activate([createMcpContextualHttpToolsPlugin({
    serverId: "docs", endpoint: "https://mcp.example/mcp",
    authorizationResolver: { resolve: async () => ({ partition: "anonymous" }) },
    clientFactory: async () => toolClient("search"),
  })], { security: bootstrap, verifyArtifact: async () => true });
  const lease = host.acquireSnapshot();
  const signal = new AbortController().signal;
  const tools = await resolveContextualTools(lease.capabilities, {
    security: bootstrap, runtime: lease.snapshot, sessionId: "s", turnId: "t",
  }, new PermissionToolExecutionPolicy(), signal);
  assert.equal(tools[0]?.id, "mcp_docs_search");
  assert.match(tools[0]!.id, PROVIDER_FUNCTION_NAME_PATTERN);
  lease.release();
  await host.shutdown();
});

test("a server id with a dot is rejected at composition time with a useful message", () => {
  assert.throws(
    () => createMcpToolsPlugin({ serverId: "example.docs", clientFactory: async () => toolClient("search") }),
    /Invalid MCP server id: example\.docs/,
  );
});

test("a remote tool name with a dot is rejected at discovery with a useful message", async () => {
  const host = new PluginHost();
  await assert.rejects(
    () => host.activate([createMcpToolsPlugin({ serverId: "docs", clientFactory: async () => toolClient("read.document") })], {
      security: bootstrap, verifyArtifact: async () => true,
    }),
    /MCP returned a tool name that is not a valid provider function name: read\.document/,
  );
});

test("an over-long composed id is rejected at discovery with a useful message", async () => {
  const longServerId = "a".repeat(62); // valid on its own: within validateServerId's own bound
  const host = new PluginHost();
  await assert.rejects(
    () => host.activate([createMcpToolsPlugin({ serverId: longServerId, clientFactory: async () => toolClient("search") })], {
      security: bootstrap, verifyArtifact: async () => true,
    }),
    /exceeds 64 characters/,
  );
});

test("resource tool ids also match the provider function-name pattern", async () => {
  const client: McpClientPort = {
    listTools: async () => ({ tools: [] }),
    listResources: async () => ({ resources: [] }),
    readResource: async (uri) => ({ contents: [{ uri, text: "" }] }),
    callTool: async () => ({ content: [] }),
    close: async () => undefined,
  };
  const host = new PluginHost();
  await host.activate([createMcpToolsPlugin({ serverId: "docs", clientFactory: async () => client })], {
    security: bootstrap, verifyArtifact: async () => true,
  });
  const lease = host.acquireSnapshot();
  const ids = lease.capabilities.all(TOOL_CAPABILITY).map((tool) => tool.id);
  assert.deepEqual(ids.sort(), ["mcp_docs_list_resources", "mcp_docs_read_resource"]);
  for (const id of ids) assert.match(id, PROVIDER_FUNCTION_NAME_PATTERN);
  lease.release();
  await host.shutdown();
});
