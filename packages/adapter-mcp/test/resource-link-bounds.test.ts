import assert from "node:assert/strict";
import { test } from "node:test";
import type { SecurityContext } from "@0xsyncroot/contracts";
import { PluginHost } from "@0xsyncroot/core";
import { TOOL_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import { createMcpToolsPlugin, type McpClientPort } from "@0xsyncroot/adapter-mcp";

const bootstrap: SecurityContext = { tenantId: "t", actorId: "bootstrap", permissions: new Set(), correlationId: "c", purpose: "test" };

function readerClient(content: unknown[]): McpClientPort {
  return {
    listTools: async () => ({ tools: [{ name: "read", inputSchema: { type: "object" } }] }),
    callTool: async () => ({ content }),
    close: async () => undefined,
  };
}

async function firstTool(client: McpClientPort, maxResultBytes?: number) {
  const host = new PluginHost();
  await host.activate([createMcpToolsPlugin({
    serverId: "docs", clientFactory: async () => client, ...(maxResultBytes ? { maxResultBytes } : {}),
  })], { security: bootstrap, verifyArtifact: async () => true });
  const lease = host.acquireSnapshot();
  const tool = lease.capabilities.all(TOOL_CAPABILITY)[0]!;
  const call = () => tool.execute({
    callId: "c", sessionId: "s", turnId: "t", stepId: "x", arguments: {}, security: bootstrap, idempotencyKey: "i",
  }, new AbortController().signal);
  return { call, release: async () => { lease.release(); await host.shutdown(); } };
}

test("an oversized resource_link uri is rejected rather than accepted (not exempted from bounding)", async () => {
  const client = readerClient([{ type: "resource_link", uri: `document://x/${"a".repeat(3000)}`, name: "doc" }]);
  const { call, release } = await firstTool(client);
  try {
    await assert.rejects(call, /resource_link uri exceeds 2048 characters/);
  } finally {
    await release();
  }
});

test("an oversized resource_link name/description is rejected", async () => {
  const client = readerClient([{ type: "resource_link", uri: "document://x/1", name: "y".repeat(600) }]);
  const { call, release } = await firstTool(client);
  try {
    await assert.rejects(call, /resource_link name exceeds 500 characters/);
  } finally {
    await release();
  }
});

test("the overall result size cap still applies with a valid resource_link present", async () => {
  const client = readerClient([
    { type: "resource_link", uri: "document://x/1", name: "doc" },
    { type: "text", text: "y".repeat(5_000) },
  ]);
  const { call, release } = await firstTool(client, 200);
  try {
    await assert.rejects(call, /exceeds 200 bytes/);
  } finally {
    await release();
  }
});

test("more resource_link blocks than the cap in one result is rejected", async () => {
  const links = Array.from({ length: 101 }, (_, index) => ({ type: "resource_link", uri: `document://x/${index}` }));
  const client = readerClient(links);
  const { call, release } = await firstTool(client);
  try {
    await assert.rejects(call, /more than 100 resource_link blocks/);
  } finally {
    await release();
  }
});

test("a normal, small resource_link passes bounding and survives to the caller", async () => {
  const link = { type: "resource_link", uri: "document://x/1", name: "doc", description: "A short description." };
  const client = readerClient([link]);
  const { call, release } = await firstTool(client);
  try {
    const result = await call() as Record<string, unknown>;
    assert.deepEqual(result.content, [link]);
  } finally {
    await release();
  }
});
