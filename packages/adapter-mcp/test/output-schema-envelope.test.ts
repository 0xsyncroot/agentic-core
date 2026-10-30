import assert from "node:assert/strict";
import { test } from "node:test";
import type { SecurityContext } from "@0xsyncroot/contracts";
import { JsonSchemaToolInputValidator, PluginHost } from "@0xsyncroot/core";
import { TOOL_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import { createMcpToolsPlugin, type McpClientPort } from "@0xsyncroot/adapter-mcp";

// An MCP `outputSchema` describes `structuredContent`; the tool result this adapter returns is the
// whole call result around it. The two were registered as if they were the same object, so the
// loop's output check rejected every valid result from every server that declared an output schema
// — and left the servers that declared none unchecked. These run the real validator over the real
// envelope rather than inspecting the schema the adapter just wrote, because a shape assertion
// here would have agreed with the broken version just as readily.

const security: SecurityContext = {
  tenantId: "t", actorId: "a", permissions: new Set(["mcp.catalog.invoke"]), correlationId: "c", purpose: "test",
};

const unitsSchema = {
  type: "object",
  properties: { units: { type: "array", items: { type: "object", properties: { unitId: { type: "string" } }, required: ["unitId"] } } },
  required: ["units"],
} as const;

function catalogClient(result: unknown): McpClientPort {
  return {
    listTools: async () => ({ tools: [{ name: "list_units", inputSchema: { type: "object" }, outputSchema: unitsSchema }] }),
    callTool: async () => result,
    close: async () => {},
  };
}

async function runTool(result: unknown): Promise<{ outputSchema: unknown; value: unknown }> {
  const host = new PluginHost();
  await host.activate([createMcpToolsPlugin({ serverId: "catalog", clientFactory: async () => catalogClient(result) })], {
    security, verifyArtifact: async () => true,
  });
  const lease = host.acquireSnapshot();
  const tool = lease.capabilities.all(TOOL_CAPABILITY).find((candidate) => candidate.id === "mcp_catalog_list_units");
  assert.ok(tool, "the catalog tool should be registered");
  const value = await tool.execute(
    { callId: "c", sessionId: "s", turnId: "t", stepId: "x", arguments: {}, security, idempotencyKey: "i" },
    new AbortController().signal,
  );
  const outputSchema = tool.outputSchema;
  lease.release();
  await host.shutdown();
  return { outputSchema, value };
}

test("a result carrying the structured payload the server promised passes the loop's output check", async () => {
  const { outputSchema, value } = await runTool({
    content: [{ type: "text", text: "{}" }],
    structuredContent: { units: [{ unitId: "u-1" }] },
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "catalog", version: "1.0" } },
  });
  new JsonSchemaToolInputValidator().validate(outputSchema as never, value as never, "tool output");
});

test("a structured payload that breaks the server's own promise is still rejected", async () => {
  const { outputSchema, value } = await runTool({
    content: [{ type: "text", text: "{}" }],
    structuredContent: { units: [{ name: "no id here" }] },
  });
  assert.throws(() => new JsonSchemaToolInputValidator().validate(outputSchema as never, value as never, "tool output"),
    /unitId|required/u);
});

test("a tool error carrying no structured payload is delivered, not turned into a schema error", async () => {
  const { outputSchema, value } = await runTool({
    content: [{ type: "text", text: "the catalogue is unavailable" }], isError: true,
  });
  new JsonSchemaToolInputValidator().validate(outputSchema as never, value as never, "tool output");
});

test("a server that declares no output schema stays unconstrained", async () => {
  const host = new PluginHost();
  const client: McpClientPort = {
    listTools: async () => ({ tools: [{ name: "anything", inputSchema: { type: "object" } }] }),
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    close: async () => {},
  };
  await host.activate([createMcpToolsPlugin({ serverId: "catalog", clientFactory: async () => client })], {
    security, verifyArtifact: async () => true,
  });
  const lease = host.acquireSnapshot();
  const tool = lease.capabilities.all(TOOL_CAPABILITY).find((candidate) => candidate.id === "mcp_catalog_anything");
  assert.deepEqual(tool?.outputSchema, {});
  lease.release();
  await host.shutdown();
});

test("a result's text block that only repeats its structuredContent is dropped, so the model is not sent it twice", async () => {
  const { PluginHost } = await import("@0xsyncroot/core");
  const { TOOL_CAPABILITY } = await import("@0xsyncroot/plugin-sdk");
  const { createMcpToolsPlugin } = await import("@0xsyncroot/adapter-mcp");
  const bootstrap = { tenantId: "t", actorId: "bootstrap", permissions: new Set<string>(), correlationId: "c", purpose: "test" };
  const run = async (result: unknown) => {
    const host = new PluginHost();
    await host.activate([createMcpToolsPlugin({
      serverId: "docs",
      clientFactory: async () => ({ listTools: async () => ({ tools: [{ name: "read", inputSchema: { type: "object" } }] }), callTool: async () => result as never, close: async () => undefined }),
    })], { security: bootstrap, verifyArtifact: async () => true });
    const lease = host.acquireSnapshot();
    try {
      return await lease.capabilities.all(TOOL_CAPABILITY)[0]!.execute(
        { callId: "c", sessionId: "s", turnId: "t", stepId: "x", arguments: {}, security: bootstrap, idempotencyKey: "i" }, new AbortController().signal);
    } finally { lease.release(); await host.shutdown(); }
  };
  const structuredContent = { documentId: "d1", kind: "workbook", sheets: [{ name: "18-TH chi", rowCount: 40 }] };
  // The way a server sends it: the same JSON once as data and once as text, keys in its own order.
  const echoed = await run({ content: [{ type: "text", text: JSON.stringify({ kind: "workbook", sheets: structuredContent.sheets, documentId: "d1" }) }], structuredContent });
  assert.deepEqual(echoed, { content: [], structuredContent }, "one copy reaches the model, and it is the structured one");
  // Text that says something of its own stays, beside the data and without it.
  const said = { content: [{ type: "text", text: "3 sheets were skipped: they are images." }], structuredContent };
  assert.deepEqual(await run(said), said);
  const refusal = { content: [{ type: "text", text: JSON.stringify({ error: "document d1 was not found", code: "document_not_found" }) }], isError: true };
  assert.deepEqual(await run(refusal), refusal, "a refusal has no structured copy: its text is all there is, and it is kept");
});
