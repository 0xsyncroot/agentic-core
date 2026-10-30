import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { AgenticError, DEPENDENCY_FAILURE_REASON } from "@0xsyncroot/contracts";
import { SdkError, SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { createHttpClientFactory } from "../src/http-client.js";
import { PrincipalClientPool } from "../src/principal-client-pool.js";
import { McpToolRefusal } from "../src/shared.js";
import { mcpTransportError, mcpToolFailure } from "../src/transport-error.js";

const security = { tenantId: "tenant", actorId: "actor", permissions: new Set<string>(), correlationId: "test", purpose: "test" };
const refused = () => new TypeError("fetch failed", { cause: Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }) });
const unavailable = (error: unknown): boolean => error instanceof AgenticError && error.code === "transient" &&
  error.retryable && error.reason === DEPENDENCY_FAILURE_REASON.UNAVAILABLE;

test("SDK negotiation preserves a typed network cause instead of reporting a permanent file error", () => {
  const wrapped = new SdkError(SdkErrorCode.EraNegotiationFailed, "Version negotiation probe failed", { cause: refused() });
  assert.ok(unavailable(mcpTransportError(wrapped)));
  const schema = new AgenticError("permanent", "Use the actual header row");
  assert.equal(mcpTransportError(schema), schema);
  const protocol = new SdkError(SdkErrorCode.EraNegotiationFailed, "No compatible protocol version");
  assert.equal(mcpTransportError(protocol), protocol);
  const forbidden = mcpTransportError(new SdkHttpError(SdkErrorCode.ClientHttpForbidden, "Forbidden", { status: 403 }));
  assert.equal((forbidden as AgenticError).code, "denied");
  assert.ok(unavailable(mcpTransportError(new SdkHttpError(SdkErrorCode.SendFailed, "Unavailable", { status: 503 }))));
});

test("actual SDK and native fetch classify an unreachable local MCP endpoint", async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await assert.rejects(createHttpClientFactory(new URL(`http://127.0.0.1:${port}/mcp`))({ partition: "test" }), unavailable);
});

function poolFixture(failures: number) {
  let connections = 0, calls = 0, closed = 0;
  const pool = new PrincipalClientPool("docs", "http://127.0.0.1/mcp", { resolve: async () => ({ partition: "actor" }) }, async () => {
    connections += 1;
    return { listTools: async () => ({ tools: [] }), callTool: async () => {
      calls += 1;
      if (calls <= failures) throw refused();
      return { rows: ["Nguồn đã đọc"] };
    }, close: async () => { closed += 1; } };
  }, 60_000, 4);
  return { pool, counts: () => ({ connections, calls, closed }) };
}

test("a trusted read reconnects and resumes the same page inside one call", async () => {
  const fixture = poolFixture(1);
  const args = { sheet: "Biểu bất kỳ", offset: 137 };
  const received: unknown[] = [];
  try {
    const result = await fixture.pool.use({ security }, new AbortController().signal,
      client => { received.push(args); return client.callTool("read_document", args, new AbortController().signal); }, true);
    assert.deepEqual(result, { rows: ["Nguồn đã đọc"] });
    assert.deepEqual(received, [args, args]);
    assert.deepEqual(fixture.counts(), { connections: 2, calls: 2, closed: 1 });
  } finally { await fixture.pool.close(); }
});

test("an unavailable reader has a bounded retry budget and a write is never replayed", async () => {
  const read = poolFixture(Infinity), write = poolFixture(Infinity);
  try {
    await assert.rejects(read.pool.use({ security }, new AbortController().signal,
      client => client.callTool("read", {}, new AbortController().signal), true), unavailable);
    assert.equal(read.counts().calls, 3);
    await assert.rejects(write.pool.use({ security }, new AbortController().signal,
      client => client.callTool("write", {}, new AbortController().signal)), unavailable);
    assert.equal(write.counts().calls, 1);
  } finally { await read.pool.close(); await write.pool.close(); }
});

test("cancellation interrupts recovery backoff without another connection", async () => {
  const fixture = poolFixture(Infinity), controller = new AbortController();
  const reason = new AgenticError("cancelled", "Đã dừng");
  const timer = setTimeout(() => controller.abort(reason), 25);
  try {
    await assert.rejects(fixture.pool.use({ security }, controller.signal,
      client => client.callTool("read", {}, controller.signal), true), error => error === reason);
    assert.equal(fixture.counts().connections, 1);
  } finally { clearTimeout(timer); await fixture.pool.close(); }
});

test("a tool's own refusal keeps the pooled client; any other failure retires it", async () => {
  let connections = 0, closed = 0, mode: "refuse" | "break" | "ok" = "refuse";
  const pool = new PrincipalClientPool("docs", "http://127.0.0.1/mcp", { resolve: async () => ({ partition: "actor" }) }, async () => {
    connections += 1;
    return { listTools: async () => ({ tools: [] }), callTool: async () => {
      if (mode === "refuse") throw new McpToolRefusal("read_table", { isError: true, content: [{ type: "text", text: "headerRow 9999 is not a row" }] });
      if (mode === "break") throw new AgenticError("permanent", "broken pipe");
      return { kind: "completed" as const, result: {} };
    }, close: async () => { closed += 1; } };
  }, 60_000, 4);
  const call = () => pool.use({ security }, new AbortController().signal, client => client.callTool("read_table", {}, new AbortController().signal), true);
  try {
    await assert.rejects(call(), /headerRow 9999/u);
    await assert.rejects(call(), /headerRow 9999/u);
    mode = "ok";
    await call();
    assert.deepEqual({ connections, closed }, { connections: 1, closed: 0 }, "three calls, one connection");
    mode = "break";
    await assert.rejects(call(), /broken pipe/u);
    mode = "ok";
    await call();
    assert.deepEqual({ connections, closed }, { connections: 2, closed: 1 }, "a non-refusal failure retires the client");
  } finally { await pool.close(); }
});

test("a disconnected mutation has unknown outcome and never advertises a safe retry", () => {
  const error = mcpToolFailure(refused(), "idempotent");
  assert.ok(error instanceof AgenticError);
  assert.equal(error.code, "unknown-outcome");
  assert.equal(error.retryable, false);
  assert.equal(error.reason, DEPENDENCY_FAILURE_REASON.UNAVAILABLE);
  assert.ok(unavailable(mcpToolFailure(refused(), "none")));
});
