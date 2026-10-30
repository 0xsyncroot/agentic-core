import assert from "node:assert/strict";
import { test } from "node:test";
import type { SecurityContext, ToolInvocation } from "@0xsyncroot/contracts";
import { PermissionToolExecutionPolicy, PluginHost, resolveContextualTools } from "@0xsyncroot/core";
import { createMcpStdioToolsPlugin, type McpClientPort, type McpStdioToolsPluginConfig } from "@0xsyncroot/adapter-mcp";

const bootstrap: SecurityContext = { tenantId: "t", actorId: "bootstrap", permissions: new Set(["mcp.docs.invoke"]), correlationId: "c", purpose: "test" };

function fixturePlugin(overrides: Partial<McpStdioToolsPluginConfig> = {}) {
  return createMcpStdioToolsPlugin({
    serverId: "docs", command: "fake", commandAllowlist: ["fake"],
    ...overrides,
  } as McpStdioToolsPluginConfig);
}

async function discoverTools(host: PluginHost, signal: AbortSignal = new AbortController().signal) {
  const lease = host.acquireSnapshot();
  try {
    return await resolveContextualTools(lease.capabilities, {
      security: bootstrap, runtime: lease.snapshot, sessionId: "s", turnId: "t",
    }, new PermissionToolExecutionPolicy(), signal);
  } finally {
    lease.release();
  }
}

function invocation(args: unknown): ToolInvocation {
  return { callId: "c", sessionId: "s", turnId: "t", stepId: "x", arguments: args as ToolInvocation["arguments"], security: bootstrap, idempotencyKey: "i" };
}

test("a call whose signal aborts (a timeout) only abandons that call, never the shared process for other callers", async () => {
  let closeCalls = 0;
  const client: McpClientPort = {
    listTools: async () => ({ tools: [
      { name: "slow", inputSchema: { type: "object" } }, { name: "fast", inputSchema: { type: "object" } },
    ] }),
    callTool: async (name, _args, signal) => {
      if (name === "slow") {
        // A real client (http/stdio) checks `signal.aborted` up front, same as everywhere else in
        // this codebase that races a signal — a listener added after the event already fired never
        // runs it retroactively.
        return new Promise((_resolve, reject) => {
          if (signal.aborted) { reject(signal.reason); return; }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
    close: async () => { closeCalls += 1; },
  };
  const descriptor = fixturePlugin({ clientFactory: async () => client });
  const host = new PluginHost();
  await host.activate([descriptor], { security: bootstrap, verifyArtifact: async () => true });
  const tools = await discoverTools(host);
  const slow = tools.find((tool) => tool.id === "mcp_docs_slow")!;
  const fast = tools.find((tool) => tool.id === "mcp_docs_fast")!;

  const controller = new AbortController();
  const timedOut = slow.execute(invocation({}), controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 5)); // let the call actually start before abandoning it
  controller.abort(new Error("timed out"));
  await assert.rejects(() => timedOut);

  // The shared process must still serve a subsequent caller normally, not be torn down.
  const result = await fast.execute(invocation({}), new AbortController().signal);
  assert.deepEqual(result, { content: [{ type: "text", text: "ok" }] });
  assert.equal(closeCalls, 0, "one abandoned call must never close the process every other caller shares");
  await host.shutdown();
});

test("a late close from an already-replaced generation does not evict the current client or force a needless respawn", async () => {
  let spawnCount = 0;
  const hooksByGeneration: Array<{ onUnexpectedClose(): void }> = [];
  const descriptor = fixturePlugin({
    maxRestarts: 10,
    clientFactory: async (hooks) => {
      hooksByGeneration.push(hooks);
      spawnCount += 1;
      return {
        listTools: async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" } }] }),
        callTool: async () => ({ content: [] }),
        close: async () => undefined,
      };
    },
  });
  const host = new PluginHost();
  await host.activate([descriptor], { security: bootstrap, verifyArtifact: async () => true });

  await discoverTools(host); // spawns generation 0
  hooksByGeneration[0]!.onUnexpectedClose(); // generation 0 "crashes"
  await discoverTools(host); // respawns generation 1
  hooksByGeneration[0]!.onUnexpectedClose(); // a stale close from the already-dead generation 0 arrives late

  assert.deepEqual(await descriptor.plugin.health?.(), { healthy: true });
  await discoverTools(host); // must reuse generation 1, not spawn a third time
  assert.equal(spawnCount, 2, "a stale close from a replaced generation must not evict the current client");
  await host.shutdown();
});

test("use() honors the caller's signal while the connector is still connecting, and health() reports \"starting\" meanwhile", async () => {
  let releaseSpawn: (() => void) | undefined;
  const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
  const descriptor = fixturePlugin({
    clientFactory: async () => {
      await spawnGate; // simulates a slow handshake
      const client: McpClientPort = {
        listTools: async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" } }] }),
        callTool: async () => ({ content: [] }),
        close: async () => undefined,
      };
      return client;
    },
  });
  const host = new PluginHost();
  await host.activate([descriptor], { security: bootstrap, verifyArtifact: async () => true });

  const controller = new AbortController();
  const discovery = discoverTools(host, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 10)); // let the spawn actually start
  assert.deepEqual(await descriptor.plugin.health?.(), { healthy: true, detail: "starting" });

  controller.abort(new Error("caller gave up"));
  await assert.rejects(() => discovery, /caller gave up/);

  releaseSpawn!(); // the spawn itself is not cancelled; it keeps running and completes in the background
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await descriptor.plugin.health?.(), { healthy: true }); // "ready" now, no longer "starting"
  await host.shutdown();
});
