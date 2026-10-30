import assert from "node:assert/strict";
import { test } from "node:test";
import type { SecurityContext } from "@0xsyncroot/contracts";
import { AgenticError } from "@0xsyncroot/contracts";
import { PluginHost } from "@0xsyncroot/core";
import { TOOL_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import { createMcpToolsPlugin, validateAgainstSchema, type McpClientPort } from "@0xsyncroot/adapter-mcp";

const bootstrap: SecurityContext = { tenantId: "t", actorId: "bootstrap", permissions: new Set(), correlationId: "c", purpose: "test" };

test("schema validation passes a matching value", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string", minLength: 1, maxLength: 40 }, age: { type: "integer", minimum: 0, maximum: 150 } },
    required: ["name"], additionalProperties: false,
  };
  assert.doesNotThrow(() => validateAgainstSchema(schema, { name: "Alice", age: 30 }, "tool"));
});

test("schema validation rejects a type mismatch, a missing required field, and an unexpected property", () => {
  const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false };
  assert.throws(
    () => validateAgainstSchema(schema, { name: 5 }, "tool"),
    (error) => error instanceof AgenticError && error.code === "validation" && /must be of type string/.test(error.message),
  );
  assert.throws(() => validateAgainstSchema(schema, {}, "tool"), /missing required property "name"/);
  assert.throws(() => validateAgainstSchema(schema, { name: "a", extra: 1 }, "tool"), /unexpected property "extra"/);
});

test("schema validation enforces enum, const, numeric bounds, string length and pattern", () => {
  assert.throws(() => validateAgainstSchema({ enum: ["a", "b"] }, "c", "tool"), /not one of the allowed values/);
  assert.throws(() => validateAgainstSchema({ const: "x" }, "y", "tool"), /does not match const/);
  assert.throws(() => validateAgainstSchema({ type: "number", minimum: 10 }, 5, "tool"), /must be >= 10/);
  assert.throws(() => validateAgainstSchema({ type: "string", maxLength: 2 }, "abc", "tool"), /at most 2 characters/);
  assert.throws(() => validateAgainstSchema({ type: "string", pattern: "^[a-z]+$" }, "ABC", "tool"), /does not match the required pattern/);
  assert.doesNotThrow(() => validateAgainstSchema({ type: "string", pattern: "^[a-z]+$" }, "abc", "tool"));
});

test("schema validation enforces array bounds and validates items", () => {
  const schema = { type: "array", minItems: 1, maxItems: 2, items: { type: "string" } };
  assert.throws(() => validateAgainstSchema(schema, [], "tool"), /at least 1 items/);
  assert.throws(() => validateAgainstSchema(schema, ["a", "b", "c"], "tool"), /at most 2 items/);
  assert.throws(() => validateAgainstSchema(schema, [1], "tool"), /must be of type string/);
  assert.doesNotThrow(() => validateAgainstSchema(schema, ["a"], "tool"));
});

test("a catastrophic pattern does not hang because the input length is capped before matching", () => {
  const schema = { type: "string", pattern: "(a+)+$" }; // classic ReDoS shape
  const hostileInput = `${"a".repeat(50_000)}!`;
  const start = Date.now();
  assert.throws(() => validateAgainstSchema(schema, hostileInput, "tool"), /at most 4096 characters/);
  assert.ok(Date.now() - start < 1000, "an over-length pattern input must fail fast, never run the regex");
});

test("a schema/value nested far past the depth cap does not hang", () => {
  let schema: Record<string, unknown> = { type: "string" };
  let value: unknown = "leaf";
  for (let index = 0; index < 5000; index += 1) {
    schema = { type: "object", properties: { next: schema }, required: ["next"] };
    value = { next: value };
  }
  const start = Date.now();
  assert.doesNotThrow(() => validateAgainstSchema(schema, value as never, "tool"));
  assert.ok(Date.now() - start < 1000, "validation past the depth cap must stop recursing, not walk the whole tree");
});

test("a wide schema does not hang: the check budget bails out instead of walking every property", () => {
  const properties: Record<string, unknown> = {};
  for (let index = 0; index < 5000; index += 1) properties[`p${index}`] = { type: "string" };
  const schema = { type: "object", properties, required: Object.keys(properties) };
  const value = Object.fromEntries(Object.keys(properties).map((key) => [key, 1])); // every value has the wrong type
  const start = Date.now();
  try { validateAgainstSchema(schema, value as never, "tool"); } catch { /* may report the first mismatch found within budget, or none */ }
  assert.ok(Date.now() - start < 1000, "a 5000-property schema must not make validation itself expensive");
});

test("MCP tool definitions reject a malformed call via validateArguments, independently of execute", async () => {
  const calls: string[] = [];
  const client: McpClientPort = {
    listTools: async () => ({ tools: [{
      name: "search", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    }] }),
    callTool: async (name) => { calls.push(name); return { content: [] }; },
    close: async () => undefined,
  };
  const host = new PluginHost();
  await host.activate([createMcpToolsPlugin({ serverId: "search", clientFactory: async () => client })], {
    security: bootstrap, verifyArtifact: async () => true,
  });
  const lease = host.acquireSnapshot();
  const tool = lease.capabilities.all(TOOL_CAPABILITY).find((candidate) => candidate.id === "mcp_search_search")!;
  assert.throws(() => tool.validateArguments?.({ notQuery: 1 }, { security: bootstrap }), /missing required property "query"/);
  assert.doesNotThrow(() => tool.validateArguments?.({ query: "hello" }, { security: bootstrap }));
  assert.deepEqual(calls, [], "execute must never run just from calling validateArguments");
  lease.release();
  await host.shutdown();
});
