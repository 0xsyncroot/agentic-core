import assert from "node:assert/strict";
import test from "node:test";
import type { SecurityContext, ToolInvocation } from "@0xsyncroot/contracts";
import { PermissionToolExecutionPolicy, PluginHost, resolveContextualToolSurface } from "@0xsyncroot/core";
import { CONTEXTUAL_TOOL_SOURCE_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { createMcpContextualHttpToolsPlugin, type McpClientPort } from "@0xsyncroot/adapter-mcp";
import { MCP_READ_RECOVERY_DELAYS_MS } from "../src/read-recovery.js";

/**
 * Discovery runs at the start of every turn, and a down connector's read retries (0.5 s + 1.5 s) would add 2.0 s before each
 * first model call: the connector is not asked to wait again once it is known to be down.
 */
const bootstrap: SecurityContext = { tenantId: "t", actorId: "bootstrap", permissions: new Set(["mcp.docs.invoke"]), correlationId: "c", purpose: "test" };
const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
const FULL_SCHEDULE_MS = MCP_READ_RECOVERY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);

/** A connector that is up, down (nothing answers) or forbids; `failNext` connections fail once each. Attempts count what reached it. */
function fakeConnector() {
  const state = { mode: "up" as "up" | "down" | "forbidden", failNext: 0, attempts: 0, toolFailures: 0, calls: 0 };
  const refusing = (): boolean => {
    if (state.mode === "down") return true;
    if (state.failNext === 0) return false;
    state.failNext -= 1;
    return true;
  };
  const client = (): McpClientPort => ({
    listTools: async () => {
      state.attempts += 1;
      if (refusing()) throw refused();
      return { tools: [{ name: "read_document", inputSchema: { type: "object" } }] };
    },
    callTool: async () => { state.calls += 1; if (state.toolFailures > 0) { state.toolFailures -= 1; throw refused(); } return { content: [] }; },
    close: async () => undefined,
  });
  const clientFactory = async (): Promise<McpClientPort> => {
    if (state.mode === "forbidden") { state.attempts += 1; throw new SdkHttpError(SdkErrorCode.ClientHttpForbidden, "Forbidden", { status: 403 }); }
    if (state.mode === "down") { state.attempts += 1; throw refused(); }
    return client();
  };
  return { state, clientFactory };
}

async function withSource<T>(clientFactory: () => Promise<McpClientPort>, run: (discover: () => ReturnType<typeof resolveContextualToolSurface>, lease: { snapshot: never; capabilities: never }) => Promise<T>): Promise<T> {
  const host = new PluginHost();
  await host.activate([createMcpContextualHttpToolsPlugin({
    serverId: "docs", endpoint: "https://mcp.example/mcp", authorizationResolver: { resolve: async () => ({ partition: "anonymous" }) },
    riskOverrides: { read_document: "none" }, clientFactory,
  })], { security: bootstrap, verifyArtifact: async () => true });
  const lease = host.acquireSnapshot();
  const discover = () => resolveContextualToolSurface(lease.capabilities, { security: bootstrap, runtime: lease.snapshot, sessionId: "s", turnId: "t" },
    new PermissionToolExecutionPolicy(), new AbortController().signal);
  try { return await run(discover, lease as never); } finally { lease.release(); await host.shutdown(); }
}

async function timed<T>(run: () => Promise<T>): Promise<{ readonly value: T; readonly ms: number }> {
  const started = performance.now();
  const value = await run();
  return { value, ms: performance.now() - started };
}

test("a connector never seen down is retried on its schedule; once known unreachable a discovery makes one attempt with no delay", async () => {
  const { state, clientFactory } = fakeConnector();
  state.mode = "down";
  await withSource(clientFactory, async (discover) => {
    const boot = await timed(discover);
    assert.equal(state.attempts, 3, "boot state: not known unreachable, so today's schedule: the attempt and two retries");
    assert.ok(boot.ms >= FULL_SCHEDULE_MS - 50, `the schedule's ${FULL_SCHEDULE_MS} ms were waited (${Math.round(boot.ms)} ms)`);
    assert.equal(boot.value.unavailable?.sources.length, 1);

    state.attempts = 0;
    const known = await timed(discover);
    assert.equal(state.attempts, 1, "one attempt");
    assert.ok(known.ms < MCP_READ_RECOVERY_DELAYS_MS[0]!, `no retry delay (${Math.round(known.ms)} ms)`);
    assert.deepEqual(known.value.tools, []);
    assert.equal(known.value.unavailable?.sources.length, 1, "reported unavailable exactly as the final failure of the schedule is");
  });
});

test("one successful discovery clears the state: the schedule applies again", async () => {
  const { state, clientFactory } = fakeConnector();
  state.mode = "down";
  await withSource(clientFactory, async (discover) => {
    await discover();
    state.mode = "up";
    const back = await discover();
    assert.deepEqual(back.tools.map((tool) => tool.id), ["mcp_docs_read_document"]);
    state.attempts = 0; state.failNext = 1;
    const transient = await timed(discover);
    assert.equal(state.attempts, 2, "a transient failure is retried again");
    assert.ok(transient.ms >= MCP_READ_RECOVERY_DELAYS_MS[0]! - 50, "after the first delay");
    assert.deepEqual(transient.value.tools.map((tool) => tool.id), ["mcp_docs_read_document"]);
  });
});

test("an answer that is not 'unreachable' (denied) never sets the state", async () => {
  const { state, clientFactory } = fakeConnector();
  state.mode = "forbidden";
  await withSource(clientFactory, async (discover) => {
    const denied = await discover();
    assert.equal(state.attempts, 1, "a denial is not retried");
    assert.equal(denied.unavailable?.sources.length, 1);
    state.attempts = 0; state.mode = "up"; state.failNext = 1;
    const transient = await discover();
    assert.equal(state.attempts, 2, "the schedule still applies: the connector was never known unreachable");
    assert.deepEqual(transient.tools.map((tool) => tool.id), ["mcp_docs_read_document"]);
  });
});

test("tool execution keeps its read retries while discovery is on one attempt", async () => {
  const { state, clientFactory } = fakeConnector();
  await withSource(clientFactory, async (discover) => {
    const surface = await discover();
    const tool = surface.tools.find((candidate) => candidate.id === "mcp_docs_read_document")!;
    state.mode = "down";
    await discover();
    state.attempts = 0;
    const known = await timed(discover);
    assert.equal(state.attempts, 1, "known unreachable: discovery makes one attempt");
    assert.ok(known.ms < MCP_READ_RECOVERY_DELAYS_MS[0]!);
    // The call's own reads go on retrying: the connector answers again, its first call fails once.
    state.mode = "up"; state.toolFailures = 1; state.calls = 0;
    const invocation = { toolId: tool.id, arguments: {}, security: bootstrap, sessionId: "s", turnId: "t", stepId: "p", callId: "c" } as unknown as ToolInvocation;
    const run = await timed(() => tool.execute(invocation, new AbortController().signal));
    assert.equal(state.calls, 2, "the failed call was retried once");
    assert.ok(run.ms >= MCP_READ_RECOVERY_DELAYS_MS[0]! - 50, "after the first delay");
  });
});
