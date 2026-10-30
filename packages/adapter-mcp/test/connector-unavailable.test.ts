import assert from "node:assert/strict";
import { test } from "node:test";
import type { SecurityContext } from "@0xsyncroot/contracts";
import { PermissionToolExecutionPolicy, PluginHost, resolveContextualToolSurface } from "@0xsyncroot/core";
import { CONTEXTUAL_TOOL_SOURCE_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import { createMcpContextualHttpToolsPlugin, createMcpStdioToolsPlugin, type McpClientPort } from "@0xsyncroot/adapter-mcp";

/**
 * A connector configured to be omitted on failure says it is unavailable instead of offering an empty list, and logs the
 * change once each way: an empty list in silence leaves the turn unable to tell "down" from "offers nothing", and leaves the
 * log without a line about it.
 */
const bootstrap: SecurityContext = { tenantId: "t", actorId: "bootstrap", permissions: new Set(["mcp.docs.invoke"]), correlationId: "c", purpose: "test" };

function reader(): McpClientPort {
  return { listTools: async () => ({ tools: [{ name: "read_document", inputSchema: { type: "object" } }] }), callTool: async () => ({ content: [] }), close: async () => undefined };
}

async function capturedWarnings<T>(run: () => Promise<T>): Promise<{ readonly value: T; readonly lines: readonly Record<string, unknown>[] }> {
  const lines: Record<string, unknown>[] = [];
  const original = console.warn;
  console.warn = (line: unknown) => { lines.push(JSON.parse(String(line)) as Record<string, unknown>); };
  try { return { value: await run(), lines }; } finally { console.warn = original; }
}

test("an omitted HTTP connector that is down reports itself unavailable, and its going down and coming back are logged once each", async () => {
  let down = true;
  const host = new PluginHost();
  await host.activate([createMcpContextualHttpToolsPlugin({
    serverId: "docs", endpoint: "https://mcp.example/mcp?token=secret-value", readsAttachments: true,
    authorizationResolver: { resolve: async () => ({ partition: "anonymous" }) },
    clientFactory: async () => {
      if (down) throw Object.assign(new Error("connect ECONNREFUSED https://mcp.example/mcp?token=secret-value"), { code: "ECONNREFUSED" });
      return reader();
    },
  })], { security: bootstrap, verifyArtifact: async () => true });
  const lease = host.acquireSnapshot();
  try {
    const source = lease.capabilities.all(CONTEXTUAL_TOOL_SOURCE_CAPABILITY)[0]!;
    assert.equal(source.readsAttachments, true, "the source says it reads attached files");
    const discover = () => resolveContextualToolSurface(lease.capabilities, { security: bootstrap, runtime: lease.snapshot, sessionId: "s", turnId: "t" },
      new PermissionToolExecutionPolicy(), new AbortController().signal);
    const { value: [first, second], lines: failing } = await capturedWarnings(async () => [await discover(), await discover()] as const);
    assert.deepEqual(first.tools, []);
    assert.deepEqual(first.unavailable?.sources, [{ sourceId: "mcp_docs", readsAttachments: true }]);
    assert.deepEqual(second.unavailable?.sources, [{ sourceId: "mcp_docs", readsAttachments: true }]);
    assert.equal(failing.length, 1, "one line when it goes down, not one per turn");
    assert.equal(failing[0]!.event, "mcp.connector.unavailable");
    assert.equal(failing[0]!.serverId, "docs");
    assert.doesNotMatch(JSON.stringify(failing), /secret-value/u, "no credential reaches the log");
    down = false;
    const { value: back, lines: recovering } = await capturedWarnings(async () => [await discover(), await discover()] as const);
    assert.deepEqual(back[0].tools.map((tool) => tool.id), ["mcp_docs_read_document"]);
    assert.equal("unavailable" in back[0], false);
    assert.deepEqual(recovering, [{ event: "mcp.connector.recovered", serverId: "docs" }]);
  } finally { lease.release(); await host.shutdown(); }
});

test("a connector that never went down logs nothing, and one without readsAttachments does not claim it", async () => {
  const host = new PluginHost();
  await host.activate([createMcpContextualHttpToolsPlugin({
    serverId: "docs", endpoint: "https://mcp.example/mcp", authorizationResolver: { resolve: async () => ({ partition: "anonymous" }) },
    clientFactory: async () => reader(),
  })], { security: bootstrap, verifyArtifact: async () => true });
  const lease = host.acquireSnapshot();
  try {
    const source = lease.capabilities.all(CONTEXTUAL_TOOL_SOURCE_CAPABILITY)[0]!;
    assert.equal(source.readsAttachments, undefined);
    const { lines } = await capturedWarnings(() => source.discover({ security: bootstrap, runtime: lease.snapshot, sessionId: "s", turnId: "t" }, new AbortController().signal));
    assert.deepEqual(lines, []);
  } finally { lease.release(); await host.shutdown(); }
});

test("an omitted stdio connector that cannot start reports itself unavailable too", async () => {
  const host = new PluginHost();
  await host.activate([createMcpStdioToolsPlugin({
    serverId: "docs", command: process.execPath, commandAllowlist: [process.execPath], readsAttachments: true,
    clientFactory: async () => { throw new Error("spawn failed"); },
  })], { security: bootstrap, verifyArtifact: async () => true });
  const lease = host.acquireSnapshot();
  try {
    const { value: surface, lines } = await capturedWarnings(() => resolveContextualToolSurface(lease.capabilities, {
      security: bootstrap, runtime: lease.snapshot, sessionId: "s", turnId: "t",
    }, new PermissionToolExecutionPolicy(), new AbortController().signal));
    assert.deepEqual(surface.unavailable?.sources, [{ sourceId: "mcp_docs", readsAttachments: true }]);
    assert.equal(lines.length, 1);
  } finally { lease.release(); await host.shutdown(); }
});
