import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import type { ToolDefinition } from "@0xsyncroot/contracts";
import { SignedHttpToolExecutionBroker } from "../src/index.js";

const secret = "tool-broker-test-secret-at-least-32-bytes";

test("signed HTTP tool broker sends an action-bound idempotent envelope", async () => {
  let verified = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const timestamp = String(request.headers["x-gateway-timestamp"]);
    const nonce = String(request.headers["x-gateway-nonce"]);
    const signature = createHmac("sha256", secret).update(`${timestamp}.${nonce}.${body}`).digest("base64url");
    assert.equal(request.url, "/v1/tools/dispatch");
    assert.equal(request.headers["x-gateway-signature"], signature);
    assert.equal(request.headers["x-gateway-idempotency-key"], "tool:execution-1");
    const payload = JSON.parse(body) as { tool: { id: string }; invocation: { security: { tenantId: string }; arguments: unknown } };
    assert.equal(payload.tool.id, "remote_tool");
    assert.equal(payload.invocation.security.tenantId, "tenant-a");
    assert.deepEqual(payload.invocation.arguments, { value: "x" });
    verified = true;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ result: { accepted: true } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  try {
    const broker = new SignedHttpToolExecutionBroker({
      baseUrl: `http://127.0.0.1:${address.port}`, secret, allowInsecureLoopback: true,
    });
    const definition: ToolDefinition = {
      id: "remote_tool", version: "1.0.0", description: "remote", inputSchema: {}, outputSchema: {},
      requiredPermissions: [], sideEffect: "none", timeoutMs: 100, execute: async () => { throw new Error("must stay remote"); },
    };
    const result = await broker.dispatch({ definition, invocation: {
      callId: "call-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1",
      arguments: { value: "x" }, idempotencyKey: "tool:execution-1",
      security: {
        tenantId: "tenant-a", actorId: "user-a", permissions: new Set(["tool.execute"]),
        correlationId: "correlation-1", purpose: "test", grantRevision: "grant-1",
      },
    } }, new AbortController().signal);
    assert.deepEqual(result, { accepted: true });
    assert.equal(verified, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("signed HTTP tool broker fails closed for weak secrets and insecure remote URLs", () => {
  assert.throws(() => new SignedHttpToolExecutionBroker({ baseUrl: "https://broker.example", secret: "short" }), /32 bytes/);
  assert.throws(() => new SignedHttpToolExecutionBroker({ baseUrl: "http://broker.example", secret }), /requires HTTPS/);
});
