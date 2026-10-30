import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, LlmAdapter, SessionEvent, ToolDefinition } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { activeHost, answer, call, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/**
 * The runtime's final-budget step (no work tool offered by its own decision) asks the model without private reasoning;
 * every other step keeps it. "keep" leaves the closing step as every other step.
 */
const read: ToolDefinition = {
  id: "test_read", version: "1", description: "read", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {}, execute: async (invocation) => ({ rows: 3, page: (invocation.arguments as { page?: number }).page ?? 0 }) as JsonValue,
};
const ask: ToolDefinition = {
  id: "test_ask", version: "1", description: "ask the user", requiredPermissions: [], sideEffect: "none", timeoutMs: 100, asksUser: true,
  inputSchema: { type: "object" }, outputSchema: {}, execute: async () => ({ answer: "ok" }) as JsonValue,
};

function thinkingModel() {
  const reads = [1, 2, 3, 4].map((page) => call(`c${page}`, "test_read", { page }));
  const { adapter, requests } = scriptedModel([...reads, answer("Đã đọc 4 trang.")]);
  const model: LlmAdapter = { ...adapter, defaultParameters: { thinking: true }, plainParameters: { thinking: false } };
  return { model, requests };
}

const committed = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "llm/attempt-committed")
  .map((event) => (event.payload as { plain?: boolean }).plain === true);

test("the final-budget step asks without reasoning and the journal says so; work steps keep it", async () => {
  const { model, requests } = thinkingModel();
  const store = new SpyStore();
  const { host, router } = await activeHost(model, [toolPlugin("tools", [read, ask])]);
  try {
    await new DefaultAgentLoop(router, store, { maxToolCalls: 4 }).runTurn({ sessionId: "closing-plain", content: "đọc hết", security: security() });
    assert.deepEqual(requests.map((request) => request.parameters.thinking), [true, true, true, true, false]);
    assert.deepEqual(requests[4]!.tools.map((tool) => tool.name), ["test_ask"], "the plain step is the closing one");
    assert.deepEqual(committed(await store.inner.load("closing-plain", security())), [false, false, false, false, true]);
  } finally { await host.shutdown(); }
});

test("a composition that keeps reasoning on the closing step asks it as every other step", async () => {
  const { model, requests } = thinkingModel();
  const store = new SpyStore();
  const { host, router } = await activeHost(model, [toolPlugin("tools", [read, ask])]);
  try {
    await new DefaultAgentLoop(router, store, { maxToolCalls: 4, closingStepReasoning: "keep" })
      .runTurn({ sessionId: "closing-keep", content: "đọc hết", security: security() });
    assert.deepEqual(requests.map((request) => request.parameters.thinking), [true, true, true, true, true]);
    assert.deepEqual(committed(await store.inner.load("closing-keep", security())), [false, false, false, false, false]);
  } finally { await host.shutdown(); }
});

test("an adapter without plain parameters is asked the same way on the closing step", async () => {
  const { model, requests } = thinkingModel();
  const { plainParameters: _unused, ...withoutPlain } = model;
  const { host, router } = await activeHost(withoutPlain as LlmAdapter, [toolPlugin("tools", [read, ask])]);
  try {
    await new DefaultAgentLoop(router, new SpyStore(), { maxToolCalls: 4 }).runTurn({ sessionId: "closing-no-plain", content: "đọc hết", security: security() });
    assert.deepEqual(requests.map((request) => request.parameters.thinking), [true, true, true, true, true]);
  } finally { await host.shutdown(); }
});

test("closingStepReasoning accepts only plain or keep", () => {
  assert.throws(() => new DefaultAgentLoop({} as never, new SpyStore(), { closingStepReasoning: "off" as never }), /closingStepReasoning must be plain or keep/u);
});
