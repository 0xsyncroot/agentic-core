import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SecurityContext, ToolInvocation } from "@0xsyncroot/contracts";
import { PermissionToolExecutionPolicy, PluginHost, resolveContextualTools } from "@0xsyncroot/core";
import { createMcpStdioToolsPlugin, type McpStdioToolsPluginConfig } from "@0xsyncroot/adapter-mcp";

const FIXTURE = fileURLToPath(new URL("./fixtures/stdio-fixture-server.mjs", import.meta.url));
const bootstrap: SecurityContext = { tenantId: "t", actorId: "bootstrap", permissions: new Set(["mcp.docs.invoke"]), correlationId: "c", purpose: "test" };
const signal = () => new AbortController().signal;

function fixturePlugin(overrides: Partial<McpStdioToolsPluginConfig> = {}) {
  return createMcpStdioToolsPlugin({
    serverId: "docs", command: process.execPath, args: [FIXTURE], commandAllowlist: [process.execPath],
    ...overrides,
  });
}

function invocation(sessionId: string, turnId: string, args: unknown): ToolInvocation {
  return { callId: "c", sessionId, turnId, stepId: "x", arguments: args as ToolInvocation["arguments"], security: bootstrap, idempotencyKey: "i" };
}

async function discover(host: PluginHost, sessionId: string, turnId: string) {
  const lease = host.acquireSnapshot();
  try {
    return await resolveContextualTools(lease.capabilities, {
      security: bootstrap, runtime: lease.snapshot, sessionId, turnId,
    }, new PermissionToolExecutionPolicy(), signal());
  } finally {
    lease.release();
  }
}

test("a stdio connector discovers real tools and calls one via a spawned process", async () => {
  const host = new PluginHost();
  await host.activate([fixturePlugin()], { security: bootstrap, verifyArtifact: async () => true });
  const tools = await discover(host, "s", "t");
  assert.deepEqual(tools.map((tool) => tool.id).sort(), ["mcp_docs_crash", "mcp_docs_echo", "mcp_docs_env"]);
  const echo = tools.find((tool) => tool.id === "mcp_docs_echo")!;
  const result = await echo.execute(invocation("s", "t", { message: "hi" }), signal());
  assert.deepEqual(result, { content: [{ type: "text", text: "hi" }] });
  await host.shutdown();
});

test("the env allowlist blocks a non-listed variable and passes through a listed one", async () => {
  const host = new PluginHost();
  await host.activate([fixturePlugin({
    envPassthrough: ["STDIO_TEST_ALLOWED"],
    env: { STDIO_TEST_ALLOWED: "visible", STDIO_TEST_BLOCKED: "should-not-leak" },
  })], { security: bootstrap, verifyArtifact: async () => true });
  const tools = await discover(host, "s", "t");
  const envTool = tools.find((tool) => tool.id === "mcp_docs_env")!;
  const read = async (name: string) => {
    const result = await envTool.execute(invocation("s", "t", { name }), signal()) as { content: [{ text: string }] };
    return JSON.parse(result.content[0].text) as { value: string | null };
  };
  assert.deepEqual(await read("STDIO_TEST_ALLOWED"), { value: "visible" });
  assert.deepEqual(await read("STDIO_TEST_BLOCKED"), { value: null });
  await host.shutdown();
});

test("a crash is surfaced through health, and the restart budget honours failureMode \"omit\"", async () => {
  const host = new PluginHost();
  const descriptor = fixturePlugin({ maxRestarts: 1, failureMode: "omit" });
  await host.activate([descriptor], { security: bootstrap, verifyArtifact: async () => true });
  const first = await discover(host, "s1", "t1");
  const crash = first.find((tool) => tool.id === "mcp_docs_crash")!;
  await assert.rejects(() => crash.execute(invocation("s1", "t1", {}), signal()));
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the transport's onclose propagate
  const health = await descriptor.plugin.health?.();
  assert.equal(health?.healthy, false);
  assert.match(health?.detail ?? "", /unexpectedly/);
  // The single restart in the budget was already spent by the first (successful) spawn: the next
  // discovery, which must respawn after the crash, is refused and degrades per failureMode "omit".
  const second = await discover(host, "s2", "t2");
  assert.deepEqual(second, []);
  await host.shutdown();
});

test("a crashed stdio connector fails the turn when failureMode is \"fail\"", async () => {
  const host = new PluginHost();
  const descriptor = fixturePlugin({ maxRestarts: 1, failureMode: "fail" });
  await host.activate([descriptor], { security: bootstrap, verifyArtifact: async () => true });
  const first = await discover(host, "s1", "t1");
  const crash = first.find((tool) => tool.id === "mcp_docs_crash")!;
  await assert.rejects(() => crash.execute(invocation("s1", "t1", {}), signal()));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const lease = host.acquireSnapshot();
  try {
    await assert.rejects(
      () => resolveContextualTools(lease.capabilities, {
        security: bootstrap, runtime: lease.snapshot, sessionId: "s2", turnId: "t2",
      }, new PermissionToolExecutionPolicy(), signal()),
      /exceeded 1 restarts/,
    );
  } finally {
    lease.release();
  }
  await host.shutdown();
});

test("a command outside the allowlist is refused at composition time", () => {
  assert.throws(
    () => createMcpStdioToolsPlugin({ serverId: "docs", command: "/usr/bin/rm", commandAllowlist: [process.execPath] }),
    /not on the configured allowlist/i,
  );
});
