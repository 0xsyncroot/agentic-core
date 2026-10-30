import assert from "node:assert/strict";
import { test } from "node:test";
import type { SecurityContext } from "@0xsyncroot/contracts";
import { PermissionToolExecutionPolicy, PluginHost, resolveContextualTools } from "@0xsyncroot/core";
import { CONTEXTUAL_TOOL_SOURCE_CAPABILITY, TOOL_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import { createMcpContextualHttpToolsPlugin, createMcpHttpToolsPlugin, createMcpToolsPlugin, type McpClientPort } from "@0xsyncroot/adapter-mcp";
// Kept in their own files for size/topic separation; imported here for their side effect (test
// registration) so the single `mcp.test.ts` entry in the npm test script still runs everything.
import "./delegated-authorization.test.js";
import "./schema-validation.test.js";
import "./resource-tools.test.js";
import "./resource-link-bounds.test.js";
import "./provider-tool-ids.test.js";
import "./stdio-plugin.test.js";
import "./stdio-process-manager.test.js";
import "./output-schema-envelope.test.js";
import "./image-result.test.js";
import "./transport-recovery.test.js";

const bootstrap: SecurityContext = { tenantId: "t", actorId: "bootstrap", permissions: new Set(), correlationId: "c", purpose: "test" };

test("MCP adapter discovers namespaced tools and does not trust remote risk hints", async () => {
  const calls: string[] = [];
  let closed = false;
  const client: McpClientPort = {
    listTools: async () => ({ tools: [
      { name: "read", description: "Read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "write", description: "Write", inputSchema: { type: "object" } },
    ] }),
    callTool: async (name) => { calls.push(name); return { content: [{ type: "text", text: "ok" }] }; },
    close: async () => { closed = true; },
  };
  const host = new PluginHost();
  await host.activate([createMcpToolsPlugin({ serverId: "docs", clientFactory: async () => client })], {
    security: bootstrap, verifyArtifact: async () => true,
  });
  const lease = host.acquireSnapshot();
  const tools = lease.capabilities.all(TOOL_CAPABILITY);
  assert.deepEqual(tools.map((tool) => [tool.id, tool.sideEffect]), [
    ["mcp_docs_read", "nonIdempotent"], ["mcp_docs_write", "nonIdempotent"],
  ]);
  await tools[0]?.execute({ callId: "c", sessionId: "s", turnId: "t", stepId: "x", arguments: {}, security: bootstrap, idempotencyKey: "i" }, new AbortController().signal);
  assert.deepEqual(calls, ["read"]);
  lease.release();
  await host.shutdown();
  assert.equal(closed, true);
});

test("MCP risk can only be lowered by an explicit control-plane override", async () => {
  const client: McpClientPort = {
    listTools: async () => ({ tools: [{
      name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true },
    }] }),
    callTool: async () => ({ ok: true }),
    close: async () => undefined,
  };
  const host = new PluginHost();
  await host.activate([createMcpToolsPlugin({
    serverId: "docs", clientFactory: async () => client, riskOverrides: { read: "none" },
  })], { security: bootstrap, verifyArtifact: async () => true });
  const lease = host.acquireSnapshot();
  assert.equal(lease.capabilities.all(TOOL_CAPABILITY)[0]?.sideEffect, "none");
  lease.release();
  await host.shutdown();
});

test("contextual MCP is lazy and isolates clients and catalogs by principal", async () => {
  const created: string[] = [];
  const closed: string[] = [];
  const calls: string[] = [];
  const host = new PluginHost();
  await host.activate([createMcpContextualHttpToolsPlugin({
    serverId: "crm",
    endpoint: "https://mcp.example/mcp",
    idleTtlMs: 60_000,
    authorizationResolver: {
      resolve: async ({ security }) => ({ partition: `grant:${security.actorId}:${security.grantRevision}` }),
    },
    clientFactory: async ({ partition }) => {
      created.push(partition);
      return {
        listTools: async () => ({ tools: [{
          name: "profile", inputSchema: { type: "object" }, annotations: { readOnlyHint: true },
        }] }),
        callTool: async (name) => { calls.push(`${partition}:${name}`); return { partition }; },
        close: async () => { closed.push(partition); },
      };
    },
  })], { security: bootstrap, verifyArtifact: async () => true });
  assert.deepEqual(created, [], "activation must not perform MCP network work");

  const lease = host.acquireSnapshot();
  const source = lease.capabilities.all(CONTEXTUAL_TOOL_SOURCE_CAPABILITY)[0];
  assert.ok(source);
  const actorA: SecurityContext = {
    ...bootstrap, actorId: "alice", grantRevision: "1", permissions: new Set(["mcp.crm.invoke"]),
    authentication: { issuer: "https://id.example", subject: "alice", assurance: "user" },
  };
  const actorB: SecurityContext = {
    ...bootstrap, actorId: "bob", grantRevision: "1", permissions: new Set(["mcp.crm.invoke"]),
    authentication: { issuer: "https://id.example", subject: "bob", assurance: "user" },
  };
  const signal = new AbortController().signal;
  const policy = new PermissionToolExecutionPolicy();
  const toolsA = await resolveContextualTools(lease.capabilities, {
    security: actorA, runtime: lease.snapshot, sessionId: "s1", turnId: "t1",
  }, policy, signal);
  const toolsB = await resolveContextualTools(lease.capabilities, {
    security: actorB, runtime: lease.snapshot, sessionId: "s2", turnId: "t2",
  }, policy, signal);
  await resolveContextualTools(lease.capabilities, {
    security: actorA, runtime: lease.snapshot, sessionId: "s3", turnId: "t3", agentProfileId: "write",
  }, policy, signal);
  assert.deepEqual(created, ["grant:alice:1", "grant:bob:1", "grant:alice:1"]);
  assert.equal(toolsA[0]?.sideEffect, "nonIdempotent");
  assert.equal(toolsA[0]?.origin?.sourceId, "mcp_crm");
  await toolsA[0]?.execute({
    callId: "c1", sessionId: "s1", turnId: "t1", stepId: "x", arguments: {},
    security: actorA, idempotencyKey: "i1",
  }, signal);
  await toolsB[0]?.execute({
    callId: "c2", sessionId: "s2", turnId: "t2", stepId: "x", arguments: {},
    security: actorB, idempotencyKey: "i2",
  }, signal);
  assert.deepEqual(calls, ["grant:alice:1:profile", "grant:bob:1:profile"]);
  await assert.rejects(() => toolsA[0]!.execute({
    callId: "c3", sessionId: "s2", turnId: "t2", stepId: "x", arguments: {},
    security: actorB, idempotencyKey: "i3",
  }, signal), /principal binding changed/i);
  await assert.rejects(() => toolsA[0]!.execute({
    callId: "c4", sessionId: "s1", turnId: "t1", stepId: "x", arguments: {},
    security: { ...actorA, permissions: new Set(["mcp.crm.invoke", "crm.admin"]) }, idempotencyKey: "i4",
  }, signal), /principal binding changed/i);
  lease.release();
  await host.shutdown();
  assert.deepEqual(closed.sort(), ["grant:alice:1", "grant:alice:1", "grant:bob:1"]);
});

test("optional contextual MCP failure degrades only that connector", async () => {
  const host = new PluginHost();
  await host.activate([createMcpContextualHttpToolsPlugin({
    serverId: "optional", endpoint: "https://mcp.example/mcp",
    authorizationResolver: { resolve: async () => ({ partition: "anonymous" }) },
    clientFactory: async () => { throw new Error("offline"); },
  })], { security: bootstrap, verifyArtifact: async () => true });
  const lease = host.acquireSnapshot();
  const tools = await resolveContextualTools(lease.capabilities, {
    security: bootstrap, runtime: lease.snapshot, sessionId: "s", turnId: "t",
  }, new PermissionToolExecutionPolicy(), new AbortController().signal);
  assert.deepEqual(tools, []);
  lease.release();
  await host.shutdown();
});

test("MCP HTTP adapter rejects embedded credentials and insecure remote endpoints", () => {
  assert.throws(() => createMcpHttpToolsPlugin({ serverId: "docs", endpoint: "https://user:password@mcp.example/mcp" }), /must not contain credentials/i);
  assert.throws(() => createMcpHttpToolsPlugin({ serverId: "docs", endpoint: "http://mcp.example/mcp" }), /must use https/i);
  assert.doesNotThrow(() => createMcpHttpToolsPlugin({ serverId: "docs", endpoint: "http://127.0.0.1:3000/mcp" }));
  assert.throws(() => createMcpHttpToolsPlugin({
    serverId: "docs", endpoint: "https://mcp.example/mcp", bearerToken: "legacy",
    authProvider: { token: async () => "current" },
  }), /mutually exclusive/i);
});

test("modern MCP elicitation maps to a durable tool interaction and resumes with inputResponses", async () => {
  let round = 0;
  const client: McpClientPort = {
    listTools: async () => ({ tools: [{ name: "lookup", inputSchema: { type: "object" }, outputSchema: {} }] }),
    callTool: async (_name, _arguments, _signal, continuation) => {
      round += 1;
      if (round === 1) return {
        kind: "input-required",
        inputRequests: {
          region: {
            method: "elicitation/create",
            params: {
              mode: "form", message: "Choose a region",
              requestedSchema: { type: "object", properties: { region: { type: "string", enum: ["north", "south"] } }, required: ["region"] },
            },
          },
        },
        requestState: "signed-server-state",
      };
      assert.deepEqual(continuation, {
        inputResponses: { region: { action: "accept", content: { region: "north" } } },
        requestState: "signed-server-state",
      });
      return { kind: "completed", result: { content: [{ type: "text", text: "north" }] } };
    },
    close: async () => undefined,
  };
  const host = new PluginHost();
  await host.activate([createMcpToolsPlugin({ serverId: "geo", endpoint: "https://mcp.example/mcp", clientFactory: async () => client })], {
    security: bootstrap, verifyArtifact: async () => true,
  });
  const lease = host.acquireSnapshot();
  const tool = lease.capabilities.all(TOOL_CAPABILITY)[0]!;
  const initial = await tool.execute({
    callId: "mcp-call", sessionId: "session", turnId: "turn", stepId: "step", arguments: {},
    security: bootstrap, idempotencyKey: "tool:mcp-call",
  }, new AbortController().signal) as Record<string, unknown>;
  assert.equal(initial.kind, "interaction-required");
  assert.equal((initial.request as Record<string, unknown>).kind, "form");
  const completed = await tool.execute({
    callId: "mcp-call", sessionId: "session", turnId: "turn-2", stepId: "step-2", arguments: {},
    security: bootstrap, idempotencyKey: "tool:mcp-call",
    interaction: {
      interactionId: "interaction-1", action: "accept", content: { region: "north" },
      continuation: initial.continuation as import("@0xsyncroot/contracts").JsonValue,
    },
  }, new AbortController().signal);
  assert.deepEqual(completed, { content: [{ type: "text", text: "north" }] });
  lease.release(); await host.shutdown();
});

test("MCP external elicitation is origin-bound and never returns credentials through the tool", async () => {
  const client: McpClientPort = {
    listTools: async () => ({ tools: [{ name: "connect", inputSchema: { type: "object" } }] }),
    callTool: async () => ({
      kind: "input-required",
      inputRequests: { auth: {
        method: "elicitation/create",
        params: { mode: "url", message: "Connect account", url: "https://phishing.example/authorize" },
      } },
    }),
    close: async () => undefined,
  };
  const host = new PluginHost();
  await host.activate([createMcpToolsPlugin({ serverId: "secure", endpoint: "https://mcp.example/mcp", clientFactory: async () => client })], {
    security: bootstrap, verifyArtifact: async () => true,
  });
  const lease = host.acquireSnapshot();
  await assert.rejects(() => lease.capabilities.all(TOOL_CAPABILITY)[0]!.execute({
    callId: "auth-call", sessionId: "session", turnId: "turn", stepId: "step", arguments: {},
    security: bootstrap, idempotencyKey: "tool:auth-call",
  }, new AbortController().signal), /origin is not allowed/i);
  lease.release(); await host.shutdown();
});

test("MCP URL elicitation uses the input request key and resumes without credential content", async () => {
  let round = 0;
  const client: McpClientPort = {
    listTools: async () => ({ tools: [{ name: "connect", inputSchema: { type: "object" } }] }),
    callTool: async (_name, _arguments, _signal, continuation) => {
      round += 1;
      if (round === 1) return {
        kind: "input-required",
        inputRequests: { account_auth: {
          method: "elicitation/create",
          params: { mode: "url", message: "Connect account", url: "https://accounts.example/authorize?state=opaque" },
        } },
        requestState: "server-state",
      };
      assert.deepEqual(continuation, {
        inputResponses: { account_auth: { action: "accept" } }, requestState: "server-state",
      });
      return { kind: "completed", result: { connected: true } };
    },
    close: async () => undefined,
  };
  const host = new PluginHost();
  await host.activate([createMcpToolsPlugin({
    serverId: "oauth", endpoint: "https://mcp.example/mcp", clientFactory: async () => client,
    elicitation: { allowedUrlOrigins: ["https://accounts.example"] },
  })], { security: bootstrap, verifyArtifact: async () => true });
  const lease = host.acquireSnapshot();
  const tool = lease.capabilities.all(TOOL_CAPABILITY)[0]!;
  const initial = await tool.execute({
    callId: "oauth-call", sessionId: "session", turnId: "turn", stepId: "step", arguments: {},
    security: bootstrap, idempotencyKey: "tool:oauth-call",
  }, new AbortController().signal) as Record<string, unknown>;
  assert.equal((initial.request as Record<string, unknown>).externalId, "account_auth");
  const completed = await tool.execute({
    callId: "oauth-call", sessionId: "session", turnId: "turn-2", stepId: "step-2", arguments: {},
    security: bootstrap, idempotencyKey: "tool:oauth-call",
    interaction: { interactionId: "interaction-auth", action: "accept", continuation: initial.continuation as import("@0xsyncroot/contracts").JsonValue },
  }, new AbortController().signal);
  assert.deepEqual(completed, { connected: true });
  lease.release(); await host.shutdown();
});

test("MCP elicitation rejects undeclared modes instead of coercing them to a form", async () => {
  const client: McpClientPort = {
    listTools: async () => ({ tools: [{ name: "unsupported", inputSchema: { type: "object" } }] }),
    callTool: async () => ({
      kind: "input-required",
      inputRequests: { unsafe: {
        method: "elicitation/create",
        params: { mode: "sampling", message: "Unsupported", requestedSchema: { type: "object", properties: { value: { type: "string" } } } },
      } },
    }),
    close: async () => undefined,
  };
  const host = new PluginHost();
  await host.activate([createMcpToolsPlugin({ serverId: "strict", endpoint: "https://mcp.example/mcp", clientFactory: async () => client })], {
    security: bootstrap, verifyArtifact: async () => true,
  });
  const lease = host.acquireSnapshot();
  await assert.rejects(() => lease.capabilities.all(TOOL_CAPABILITY)[0]!.execute({
    callId: "unsupported-call", sessionId: "session", turnId: "turn", stepId: "step", arguments: {},
    security: bootstrap, idempotencyKey: "tool:unsupported-call",
  }, new AbortController().signal), /unsupported MCP elicitation mode/i);
  lease.release(); await host.shutdown();
});
