import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, ToolDefinition } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { activeHost, answer, call, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/**
 * A question the work needs is a form on every last step, also once the tool-call ceiling is reached: asking the user is
 * not work and never counts against it, so no turn ends on questions in prose with nothing to click.
 */
const read: ToolDefinition = {
  id: "test_read", version: "1", description: "read", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {}, execute: async (invocation) => ({ rows: 3, page: (invocation.arguments as { page?: number }).page ?? 0 }) as JsonValue,
};
let asked = 0;
const hand: ToolDefinition = {
  id: "test_hand", version: "1", description: "hand the result to the user", requiredPermissions: [], sideEffect: "none", timeoutMs: 100, asksUser: true,
  inputSchema: { type: "object" }, outputSchema: {}, execute: async () => ({ handed: true }) as JsonValue,
};
const ask: ToolDefinition = {
  id: "test_ask", version: "1", description: "ask the user", requiredPermissions: [], sideEffect: "none", timeoutMs: 100, asksUser: true,
  inputSchema: { type: "object" }, outputSchema: {}, execute: async () => { asked += 1; return { answer: "GVBC" } as JsonValue; },
};

test("past the tool-call ceiling the last step still offers the ask tool, and asking runs", async () => {
  asked = 0;
  // Four reads spend the configured four calls; the last step comes after them.
  const reads = [1, 2, 3, 4].map((page) => call(`c${page}`, "test_read", { page }));
  const { adapter, requests } = scriptedModel([...reads, call("c5", "test_ask", { question: "Sheet nào?" }), answer("Đối soát sheet GVBC.")]);
  const store = new SpyStore();
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read, ask])]);
  try {
    await new DefaultAgentLoop(router, store, { maxToolCalls: 4 }).runTurn({ sessionId: "ask-final", content: "đối soát", security: security() });
    const offered = requests[4]!.tools.map((tool) => tool.name);
    assert.deepEqual(offered, ["test_ask"], "only the ask tool on the last step");
    const instruction = requests[4]!.messages.map((message) => message.content ?? "").join("\n");
    assert.match(instruction, /The only tool still offered is test_ask: it puts something to the user, as its own description says;/u);
    assert.match(instruction, /through an offered tool whose description fits; when that description says it hands this work to the user, call it now/u);
    assert.equal(asked, 1, "the question ran despite the ceiling");
  } finally { await host.shutdown(); }
});

test("with two ask tools offered the last step names both, each by what it does", async () => {
  const reads = [1, 2, 3, 4].map((page) => call(`c${page}`, "test_read", { page }));
  const { adapter, requests } = scriptedModel([...reads, call("c5", "test_hand", {}), answer("Đã giao.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read, ask, hand])]);
  try {
    await new DefaultAgentLoop(router, new SpyStore(), { maxToolCalls: 4 }).runTurn({ sessionId: "ask-final-two", content: "đối soát", security: security() });
    assert.deepEqual(requests[4]!.tools.map((tool) => tool.name), ["test_ask", "test_hand"], "both ask tools on the last step");
    const instruction = requests[4]!.messages.map((message) => message.content ?? "").join("\n");
    assert.match(instruction, /The only tools still offered are test_ask, test_hand: each puts something to the user, as its own description says;/u);
    assert.doesNotMatch(instruction, /The only tool still offered is/u, "the plural sentence replaces the singular one");
  } finally { await host.shutdown(); }
});

test("with no ask tool the last step keeps the plain rule for asking", async () => {
  const reads = [1, 2, 3, 4].map((page) => call(`c${page}`, "test_read", { page }));
  const { adapter, requests } = scriptedModel([...reads, answer("Xong.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read])]);
  try {
    await new DefaultAgentLoop(router, new SpyStore(), { maxToolCalls: 4 }).runTurn({ sessionId: "ask-final-none", content: "đối soát", security: security() });
    const instruction = requests[4]!.messages.map((message) => message.content ?? "").join("\n");
    assert.match(instruction, /- ask the user something only if the work cannot go on without their answer\./u);
    assert.doesNotMatch(instruction, /through an offered tool/u);
  } finally { await host.shutdown(); }
});
