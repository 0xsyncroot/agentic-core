import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpPrincipalAuthorizationResolver } from "@0xsyncroot/adapter-mcp";
import { createMcpPlugins } from "../src/composition/providers/mcp-plugin-catalog.js";
import { readRuntimeConfig } from "../src/composition/runtime-config.js";

function baseSecrets() {
  return {
    mcpBearerTokens: {} as Readonly<Record<string, string>>,
    persistenceUrls: {},
    dataEncryptionKeyId: "local-v1",
  } satisfies Parameters<typeof createMcpPlugins>[1];
}

test("createMcpPlugins forwards the extended per-connector limits into the plugin descriptor", () => {
  const config = readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([{
      id: "example", endpoint: "https://mcp.example/mcp", authMode: "delegated", authProfileRef: "corp-oauth",
      timeoutMs: 15_000, maxTools: 40, maxResultBytes: 262_144, idleTtlMs: 120_000, maxConnections: 25,
      failureMode: "fail", elicitation: { enabled: false }, resources: { enabled: false },
      riskOverrides: { create_spending_template: "nonIdempotent" },
    }]),
  });
  const resolver: McpPrincipalAuthorizationResolver = { resolve: async () => ({ partition: "anonymous" }) };
  const [descriptor] = createMcpPlugins(config, baseSecrets(), {
    authorizationResolvers: { "corp-oauth": resolver },
  });
  assert.ok(descriptor);
  const pluginConfig = descriptor.config as Record<string, unknown>;
  assert.equal(pluginConfig.timeoutMs, 15_000);
  assert.equal(pluginConfig.maxTools, 40);
  assert.equal(pluginConfig.maxResultBytes, 262_144);
  assert.equal(pluginConfig.idleTtlMs, 120_000);
  assert.equal(pluginConfig.maxConnections, 25);
  assert.equal(pluginConfig.failureMode, "fail");
  assert.equal(pluginConfig.elicitationEnabled, false);
  assert.equal(pluginConfig.resourcesEnabled, false);
});

test("createMcpPlugins still resolves a delegated auth profile without any of the new fields", () => {
  const config = readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([{
      id: "example", endpoint: "https://mcp.example/mcp", authMode: "delegated", authProfileRef: "corp-oauth",
    }]),
  });
  const resolver: McpPrincipalAuthorizationResolver = { resolve: async () => ({ partition: "anonymous" }) };
  const [descriptor] = createMcpPlugins(config, baseSecrets(), {
    authorizationResolvers: { "corp-oauth": resolver },
  });
  assert.ok(descriptor);
  assert.throws(() => createMcpPlugins(config, baseSecrets(), {}), /MCP auth profile is unavailable: corp-oauth/);
});

test("createMcpPlugins routes a stdio server to the stdio plugin and enforces the command allowlist dependency", () => {
  const config = readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([{
      id: "example-docs", transport: "stdio", command: "/usr/bin/python3", args: ["-m", "example_docs"],
      envPassthrough: ["PYTHONPATH"],
    }]),
  });
  // No stdioCommandAllowlist dependency at all: fails closed, never falls back to trusting the config.
  assert.throws(() => createMcpPlugins(config, baseSecrets(), {}), /not on the configured allowlist/i);
  // An allowlist that does not name this command: still refused.
  assert.throws(
    () => createMcpPlugins(config, baseSecrets(), { stdioCommandAllowlist: ["/usr/bin/node"] }),
    /not on the configured allowlist/i,
  );
  const [descriptor] = createMcpPlugins(config, baseSecrets(), { stdioCommandAllowlist: ["/usr/bin/python3"] });
  assert.ok(descriptor);
  const pluginConfig = descriptor.config as Record<string, unknown>;
  assert.equal(pluginConfig.command, "/usr/bin/python3");
  assert.deepEqual(pluginConfig.args, ["-m", "example_docs"]);
  assert.deepEqual(pluginConfig.envPassthrough, ["PYTHONPATH"]);
  assert.equal(pluginConfig.authMode, "none");
});

test("stdioCommandPaths says where an allowlisted command lives on this host, and relocates nothing the allowlist refuses", () => {
  const config = readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "docs", transport: "stdio", command: "/usr/bin/python3", args: ["server.py"] }]),
  });
  const elsewhere = "C:\\Python312\\python.exe";
  const [descriptor] = createMcpPlugins(config, baseSecrets(), {
    stdioCommandAllowlist: ["/usr/bin/python3"], stdioCommandPaths: { "/usr/bin/python3": elsewhere },
  });
  assert.equal((descriptor?.config as Record<string, unknown>).command, elsewhere);
  // A path for a command the allowlist does not name is not a way around the allowlist.
  assert.throws(
    () => createMcpPlugins(config, baseSecrets(), { stdioCommandAllowlist: ["/usr/bin/node"], stdioCommandPaths: { "/usr/bin/python3": elsewhere } }),
    /not on the configured allowlist: \/usr\/bin\/python3/,
  );
  // Nor is the config naming the relocated path itself: it still has to name the allowlisted command.
  const direct = readRuntimeConfig({ AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "docs", transport: "stdio", command: elsewhere }]) });
  assert.throws(
    () => createMcpPlugins(direct, baseSecrets(), { stdioCommandAllowlist: ["/usr/bin/python3"], stdioCommandPaths: { "/usr/bin/python3": elsewhere } }),
    /not on the configured allowlist/,
  );
});

test("a stdio server reads envPassthrough from the runtime's environment, not process.env", async () => {
  const { PluginHost, PermissionToolExecutionPolicy, resolveContextualTools } = await import("@0xsyncroot/core");
  const fixture = new URL("../../../packages/adapter-mcp/test/fixtures/stdio-fixture-server.mjs", import.meta.url).pathname;
  const config = readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "docs", transport: "stdio", command: process.execPath, args: [fixture], envPassthrough: ["DOCUMENT_SOURCE_BASE_URL"] }]),
  });
  delete process.env.DOCUMENT_SOURCE_BASE_URL;
  // What a product composition derives (EXAMPLE: the document source defaults to its backend URL)
  // lives only in the environment it hands the runtime; it has to reach the child from there.
  const plugins = createMcpPlugins(config, baseSecrets(), {
    stdioCommandAllowlist: [process.execPath],
    stdioEnvironment: { DOCUMENT_SOURCE_BASE_URL: "http://127.0.0.1:5081", DATABASE_URL: "mysql://secret" },
  });
  const security = { tenantId: "t", actorId: "a", permissions: new Set(["mcp.docs.invoke"]), correlationId: "c", purpose: "test" };
  const host = new PluginHost();
  await host.activate(plugins, { security, verifyArtifact: async () => true });
  const lease = host.acquireSnapshot();
  try {
    const tools = await resolveContextualTools(lease.capabilities, { security, runtime: lease.snapshot, sessionId: "s", turnId: "t" },
      new PermissionToolExecutionPolicy(), new AbortController().signal);
    const envTool = tools.find((tool) => tool.id === "mcp_docs_env")!;
    const read = async (name: string) => {
      const result = await envTool.execute({ callId: "c", sessionId: "s", turnId: "t", stepId: "x", arguments: { name }, security, idempotencyKey: "i" } as never,
        new AbortController().signal) as { content: [{ text: string }] };
      return JSON.parse(result.content[0].text) as { value: string | null };
    };
    assert.deepEqual(await read("DOCUMENT_SOURCE_BASE_URL"), { value: "http://127.0.0.1:5081" });
    assert.deepEqual(await read("DATABASE_URL"), { value: null });
  } finally {
    lease.release();
    await host.shutdown();
  }
});

test("a stdio server's literal env from the config reaches the child without being listed in envPassthrough", async () => {
  const { PluginHost, PermissionToolExecutionPolicy, resolveContextualTools } = await import("@0xsyncroot/core");
  const fixture = new URL("../../../packages/adapter-mcp/test/fixtures/stdio-fixture-server.mjs", import.meta.url).pathname;
  const config = readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "docs", transport: "stdio", command: process.execPath, args: [fixture], env: { DOCUMENT_SOURCE_BASE_URL: "http://example-host:5081" } }]),
  });
  const plugins = createMcpPlugins(config, baseSecrets(), {
    stdioCommandAllowlist: [process.execPath],
    stdioEnvironment: { DOCUMENT_SOURCE_BASE_URL: "http://overridden-by-the-file", DATABASE_URL: "mysql://secret" },
  });
  const security = { tenantId: "t", actorId: "a", permissions: new Set(["mcp.docs.invoke"]), correlationId: "c", purpose: "test" };
  const host = new PluginHost();
  await host.activate(plugins, { security, verifyArtifact: async () => true });
  const lease = host.acquireSnapshot();
  try {
    const tools = await resolveContextualTools(lease.capabilities, { security, runtime: lease.snapshot, sessionId: "s", turnId: "t" },
      new PermissionToolExecutionPolicy(), new AbortController().signal);
    const envTool = tools.find((tool) => tool.id === "mcp_docs_env")!;
    const read = async (name: string) => {
      const result = await envTool.execute({ callId: "c", sessionId: "s", turnId: "t", stepId: "x", arguments: { name }, security, idempotencyKey: "i" } as never,
        new AbortController().signal) as { content: [{ text: string }] };
      return JSON.parse(result.content[0].text) as { value: string | null };
    };
    assert.deepEqual(await read("DOCUMENT_SOURCE_BASE_URL"), { value: "http://example-host:5081" });
    assert.deepEqual(await read("DATABASE_URL"), { value: null });
  } finally {
    lease.release();
    await host.shutdown();
  }
});

test("the connector that archives or receives attachments is the one that reads them; others do not claim to", async () => {
  const { PluginHost } = await import("@0xsyncroot/core");
  const { CONTEXTUAL_TOOL_SOURCE_CAPABILITY } = await import("@0xsyncroot/plugin-sdk");
  const config = readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([
      { id: "reader", endpoint: "https://reader.example/mcp", authMode: "anonymous", attachmentStorage: { s3EnvPrefix: "S3", keyPrefix: "attachments/" } },
      { id: "crm", endpoint: "https://crm.example/mcp", authMode: "anonymous" },
    ]),
  });
  const descriptors = createMcpPlugins(config, baseSecrets(), {});
  assert.deepEqual(descriptors.map((descriptor) => (descriptor.config as Record<string, unknown>).readsAttachments), [true, undefined]);
  const host = new PluginHost();
  const security = { tenantId: "t", actorId: "a", permissions: new Set<string>(), correlationId: "c", purpose: "test" };
  await host.activate(descriptors, { security, verifyArtifact: async () => true });
  const lease = host.acquireSnapshot();
  try {
    assert.deepEqual(Object.fromEntries(lease.capabilities.all(CONTEXTUAL_TOOL_SOURCE_CAPABILITY).map((source) => [source.id, source.readsAttachments ?? false])),
      { mcp_reader: true, mcp_crm: false });
  } finally { lease.release(); await host.shutdown(); }
});
