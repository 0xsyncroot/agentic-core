import assert from "node:assert/strict";
import { test } from "node:test";
import { AgenticError, type SecurityContext, type ToolInvocation } from "@0xsyncroot/contracts";
import { PermissionToolExecutionPolicy, PluginHost, resolveContextualTools } from "@0xsyncroot/core";
import { CONTEXTUAL_TOOL_SOURCE_CAPABILITY, TOOL_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import {
  createMcpContextualHttpToolsPlugin, createMcpToolsPlugin, createResourceTools,
  type McpClientPort, type NormalizedMcpLimits,
} from "@0xsyncroot/adapter-mcp";

const bootstrap: SecurityContext = { tenantId: "t", actorId: "bootstrap", permissions: new Set(), correlationId: "c", purpose: "test" };
const RESOURCE = { uri: "example://document/1/extraction", name: "doc-1" };

function baseClient(withResources: boolean): McpClientPort {
  return {
    // A plugin whose manifest declares the tools capability must register at least one; carry a
    // trivial always-present tool so activation succeeds regardless of whether resources are on.
    listTools: async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" } }] }),
    ...(withResources ? {
      listResources: async () => ({ resources: [RESOURCE] }),
      readResource: async (uri: string) => ({ contents: [{ uri, text: "hello" }] }),
    } : {}),
    callTool: async () => ({ content: [] }),
    close: async () => undefined,
  };
}

function invocation(args: unknown): ToolInvocation {
  return { callId: "c", sessionId: "s", turnId: "t", stepId: "x", arguments: args as ToolInvocation["arguments"], security: bootstrap, idempotencyKey: "i" };
}

test("resource tools appear only when the server advertises resources", async () => {
  const without = new PluginHost();
  await without.activate([createMcpToolsPlugin({ serverId: "docs", clientFactory: async () => baseClient(false) })], {
    security: bootstrap, verifyArtifact: async () => true,
  });
  const withoutLease = without.acquireSnapshot();
  assert.deepEqual(withoutLease.capabilities.all(TOOL_CAPABILITY).map((tool) => tool.id), ["mcp_docs_ping"]);
  withoutLease.release();
  await without.shutdown();

  const withResources = new PluginHost();
  await withResources.activate([createMcpToolsPlugin({ serverId: "docs", clientFactory: async () => baseClient(true) })], {
    security: bootstrap, verifyArtifact: async () => true,
  });
  const withLease = withResources.acquireSnapshot();
  assert.deepEqual(
    withLease.capabilities.all(TOOL_CAPABILITY).map((tool) => tool.id).sort(),
    ["mcp_docs_list_resources", "mcp_docs_ping", "mcp_docs_read_resource"],
  );
  withLease.release();
  await withResources.shutdown();
});

test("resources can be opted out even when the server advertises them", async () => {
  const host = new PluginHost();
  await host.activate([createMcpToolsPlugin({
    serverId: "docs", clientFactory: async () => baseClient(true), resources: { enabled: false },
  })], { security: bootstrap, verifyArtifact: async () => true });
  const lease = host.acquireSnapshot();
  assert.deepEqual(lease.capabilities.all(TOOL_CAPABILITY).map((tool) => tool.id), ["mcp_docs_ping"]);
  lease.release();
  await host.shutdown();
});

test("read_resource lists lazily on the first call, with no prior list_resources needed, and still denies an unlisted scheme", async () => {
  const host = new PluginHost();
  await host.activate([createMcpToolsPlugin({ serverId: "docs", clientFactory: async () => baseClient(true) })], {
    security: bootstrap, verifyArtifact: async () => true,
  });
  const lease = host.acquireSnapshot();
  const read = lease.capabilities.all(TOOL_CAPABILITY).find((tool) => tool.id === "mcp_docs_read_resource")!;
  const signal = new AbortController().signal;

  // A resourceUri another tool just handed back is legitimate even with an empty call history —
  // the documented ResourceLink flow never calls list_resources first.
  const result = await read.execute(invocation({ uri: RESOURCE.uri }), signal) as Record<string, unknown>;
  assert.deepEqual(result.contents, [{ uri: RESOURCE.uri, text: "hello" }]);

  // The lazy list already ran; a scheme it never returned is still refused.
  await assert.rejects(() => read.execute(invocation({ uri: "https://evil.example/steal" }), signal), /scheme is not allowed/i);
  lease.release();
  await host.shutdown();
});

test("the lazy resources/list happens at most once per read_resource call, never a retry loop", async () => {
  let listCalls = 0;
  const client: McpClientPort = {
    listTools: async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" } }] }),
    listResources: async () => { listCalls += 1; return { resources: [] }; }, // never lists the requested scheme
    readResource: async (uri) => ({ contents: [{ uri, text: "hello" }] }),
    callTool: async () => ({ content: [] }),
    close: async () => undefined,
  };
  const host = new PluginHost();
  await host.activate([createMcpToolsPlugin({ serverId: "docs", clientFactory: async () => client })], {
    security: bootstrap, verifyArtifact: async () => true,
  });
  const lease = host.acquireSnapshot();
  const read = lease.capabilities.all(TOOL_CAPABILITY).find((tool) => tool.id === "mcp_docs_read_resource")!;
  await assert.rejects(() => read.execute(invocation({ uri: RESOURCE.uri }), new AbortController().signal), /scheme is not allowed/i);
  assert.equal(listCalls, 1, "exactly one lazy listing attempt, never zero and never a loop");
  lease.release();
  await host.shutdown();
});

test("read_resource denies cleanly, not with an unclassified error, when the client has no resources/list support", async () => {
  const limits: NormalizedMcpLimits = {
    timeoutMs: 30_000, maxTools: 100, maxResultBytes: 1_048_576,
    elicitationEnabled: true, resourcesEnabled: true, allowedUrlOrigins: [], resourcePinnedSchemes: [],
  };
  // Deliberately no `listResources`: createResourceTools itself must stay defensive even though
  // callers only ever wire this up behind resourcesCapability()'s "both or neither" gate today.
  const client = { readResource: async (uri: string) => ({ contents: [{ uri, text: "hello" }] }) } as McpClientPort;
  const [, read] = createResourceTools({
    serverId: "docs", limits, knownSchemes: new Set(), requiredPermissions: [],
    withClient: async (_invocation, _signal, operation) => operation(client),
  });
  await assert.rejects(
    () => read!.execute(invocation({ uri: RESOURCE.uri }), new AbortController().signal),
    (error: unknown) => error instanceof AgenticError && error.code === "denied" && /scheme is not allowed/.test(error.message),
  );
});

test("read_resource denies cleanly when resources/list returns nothing at all", async () => {
  // A server that cannot know who is asking (e.g. an unguessable-capability document server)
  // may legitimately publish no catalogue: resources/list answers empty rather than erroring.
  // The lazy-list path must degrade to the same clean denial as any other unlisted scheme.
  const client: McpClientPort = {
    listTools: async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" } }] }),
    listResources: async () => ({ resources: [] }),
    readResource: async (uri) => ({ contents: [{ uri, text: "hello" }] }),
    callTool: async () => ({ content: [] }),
    close: async () => undefined,
  };
  const host = new PluginHost();
  await host.activate([createMcpToolsPlugin({ serverId: "docs", clientFactory: async () => client })], {
    security: bootstrap, verifyArtifact: async () => true,
  });
  const lease = host.acquireSnapshot();
  const read = lease.capabilities.all(TOOL_CAPABILITY).find((tool) => tool.id === "mcp_docs_read_resource")!;
  await assert.rejects(() => read.execute(invocation({ uri: RESOURCE.uri }), new AbortController().signal), /scheme is not allowed/i);
  lease.release();
  await host.shutdown();
});

test("resources.allowedSchemes pins a scheme upfront, so a valid read needs no resources/list call at all", async () => {
  let listCalls = 0;
  const client: McpClientPort = {
    listTools: async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" } }] }),
    listResources: async () => { listCalls += 1; return { resources: [RESOURCE] }; },
    readResource: async (uri) => ({ contents: [{ uri, text: "hello" }] }),
    callTool: async () => ({ content: [] }),
    close: async () => undefined,
  };
  const host = new PluginHost();
  await host.activate([createMcpToolsPlugin({
    serverId: "docs", clientFactory: async () => client, resources: { allowedSchemes: ["example"] },
  })], { security: bootstrap, verifyArtifact: async () => true });
  const lease = host.acquireSnapshot();
  const read = lease.capabilities.all(TOOL_CAPABILITY).find((tool) => tool.id === "mcp_docs_read_resource")!;
  const result = await read.execute(invocation({ uri: RESOURCE.uri }), new AbortController().signal) as Record<string, unknown>;
  assert.deepEqual(result.contents, [{ uri: RESOURCE.uri, text: "hello" }]);
  assert.equal(listCalls, 0, "a pinned scheme is already known; no lazy listing was needed");
  lease.release();
  await host.shutdown();
});

test("resource tool results stay bounded by maxResultBytes", async () => {
  // No base "ping" tool here: at this cap even its trivial input schema would not fit, and the
  // point of this test is the resource tools' own bound, not the remote-schema bound.
  const resourceOnlyClient: McpClientPort = {
    listTools: async () => ({ tools: [] }),
    listResources: async () => ({ resources: [RESOURCE] }),
    readResource: async (uri) => ({ contents: [{ uri, text: "hello" }] }),
    callTool: async () => ({ content: [] }),
    close: async () => undefined,
  };
  const host = new PluginHost();
  await host.activate([createMcpToolsPlugin({ serverId: "docs", clientFactory: async () => resourceOnlyClient, maxResultBytes: 10 })], {
    security: bootstrap, verifyArtifact: async () => true,
  });
  const lease = host.acquireSnapshot();
  const list = lease.capabilities.all(TOOL_CAPABILITY).find((tool) => tool.id === "mcp_docs_list_resources")!;
  await assert.rejects(() => list.execute(invocation({}), new AbortController().signal), /exceeds 10 bytes/);
  lease.release();
  await host.shutdown();
});

test("contextual MCP resource tools persist known schemes across separate discovery calls", async () => {
  const actor: SecurityContext = { ...bootstrap, permissions: new Set(["mcp.docs.invoke"]) };
  const host = new PluginHost();
  await host.activate([createMcpContextualHttpToolsPlugin({
    serverId: "docs", endpoint: "https://mcp.example/mcp",
    authorizationResolver: { resolve: async () => ({ partition: "anonymous" }) },
    clientFactory: async () => baseClient(true),
  })], { security: bootstrap, verifyArtifact: async () => true });
  const lease = host.acquireSnapshot();
  const signal = new AbortController().signal;
  const policy = new PermissionToolExecutionPolicy();
  const source = lease.capabilities.all(CONTEXTUAL_TOOL_SOURCE_CAPABILITY)[0];
  assert.ok(source);

  const first = await resolveContextualTools(lease.capabilities, {
    security: actor, runtime: lease.snapshot, sessionId: "s1", turnId: "t1",
  }, policy, signal);
  const list = first.find((tool) => tool.id === "mcp_docs_list_resources")!;
  await list.execute({ ...invocation({}), sessionId: "s1", turnId: "t1", security: actor }, signal);

  // A brand-new discovery call (as a later turn triggers) must still remember the scheme.
  const second = await resolveContextualTools(lease.capabilities, {
    security: actor, runtime: lease.snapshot, sessionId: "s2", turnId: "t2",
  }, policy, signal);
  const read = second.find((tool) => tool.id === "mcp_docs_read_resource")!;
  const result = await read.execute({
    ...invocation({ uri: RESOURCE.uri }), sessionId: "s2", turnId: "t2", security: actor,
  }, signal) as Record<string, unknown>;
  assert.deepEqual(result.contents, [{ uri: RESOURCE.uri, text: "hello" }]);
  lease.release();
  await host.shutdown();
});
