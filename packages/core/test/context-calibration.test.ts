import assert from "node:assert/strict";
import test from "node:test";
import { AgenticError, TOOL_EXECUTION_RESPONSE_PROTOCOL, type ContextCompactionPolicy, type LlmAdapter, type LlmStreamEvent, type ToolDefinition } from "@0xsyncroot/contracts";
import { ConfiguredContextCompactionPolicy, DefaultAgentLoop } from "@0xsyncroot/core";
import { InMemorySessionStore } from "@0xsyncroot/persistence-memory";
import { activeHost, security, toolPlugin } from "./turn-harness.js";

/**
 * The context budget is counted in characters and turned into tokens by an estimate, which can say a request fits a
 * window it overflows; and a step that overflowed and was trimmed again must not reuse its journal key. The provider's
 * own counts correct the estimate.
 */
const route = { providerId: "test", adapterId: "calibrated", modelId: "calibrated-model", routeRevision: "r1", metadataSource: "adapter-catalog" as const, contextWindowTokens: 100_000, estimatedCharsPerToken: 3 };
const sent = (request: Parameters<LlmAdapter["stream"]>[0]) => JSON.stringify({ messages: request.messages, tools: request.tools }).length;

function recording(): { policy: ContextCompactionPolicy; ratios: (number | undefined)[] } {
  const delegate = new ConfiguredContextCompactionPolicy();
  const ratios: (number | undefined)[] = [];
  return { ratios, policy: { assess: (input) => { ratios.push(input.estimatedCharsPerToken); return delegate.assess(input); } } };
}

test("what each response cost teaches the real characters per token, and the next turn's budget uses it", async () => {
  const adapter: LlmAdapter = {
    id: "calibrated", providerId: "test", model: "calibrated-model", resolveModel: async () => route,
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      // Dense text: one token for every 1.5 characters sent.
      yield { type: "final", content: "xong", toolCalls: [], finishReason: "stop", usage: { inputTokens: Math.round(sent(request) / 1.5) } };
    },
  };
  const { host, router } = await activeHost(adapter, []);
  const { policy, ratios } = recording();
  try {
    const loop = new DefaultAgentLoop(router, new InMemorySessionStore(), {}, { contextCompactionPolicy: policy });
    await loop.runTurn({ sessionId: "calibrate", content: "một", security: security() });
    await loop.runTurn({ sessionId: "calibrate", content: "hai", security: security() });
    assert.equal(ratios[0], 3, "the adapter's estimate before anything was measured");
    assert.ok(Math.abs(ratios.at(-1)! - 1.35) < 0.02, `the measured ratio with its margin, across turns: ${ratios.at(-1)}`);
  } finally { await host.shutdown(); }
});

test("a refusal that counts the request's tokens corrects the estimate before the retry; trimming twice in one step is no journal conflict", async () => {
  let calls = 0;
  const adapter: LlmAdapter = {
    id: "calibrated", providerId: "test", model: "calibrated-model", resolveModel: async () => ({ ...route, contextWindowTokens: 2_000 }),
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      calls += 1;
      if (calls === 3) throw new AgenticError("context-overflow", "The input is longer than the model's context length.", false, { inputTokens: Math.round(sent(request) / 1.2) });
      yield { type: "final", content: calls === 1 ? "b".repeat(7_000) : calls === 2 ? "c".repeat(600) : "đã thử lại", toolCalls: [], finishReason: "stop" };
    },
  };
  const { host, router } = await activeHost(adapter, []);
  const { policy, ratios } = recording();
  try {
    const loop = new DefaultAgentLoop(router, new InMemorySessionStore(), { maxContextChars: 6_000 }, { contextCompactionPolicy: policy });
    await loop.runTurn({ sessionId: "overflow", content: "một", security: security() });
    await loop.runTurn({ sessionId: "overflow", content: "hai", security: security() });
    const result = await loop.runTurn({ sessionId: "overflow", content: "ba", security: security() });
    assert.equal(result.content, "đã thử lại");
    assert.ok(Math.abs(ratios.at(-1)! - 1.08) < 0.02, `the refusal's own count sets the ratio for the retry: ${ratios.at(-1)}`);
    const trims = result.events.filter((event) => event.type === "context/trimmed");
    assert.ok(trims.length >= 1, "the history was trimmed to fit");
  } finally { await host.shutdown(); }
});

test("the densest request seen sets the ratio; a lighter one raises it only a tenth of the way", async () => {
  const { ContextCalibration } = await import("../src/agent/context-calibration.js");
  const calibration = new ContextCalibration();
  const dense = calibration.learn(route, 1_500, 1_000);
  assert.ok(Math.abs(dense.estimatedCharsPerToken! - 1.35) < 1e-9);
  const light = calibration.learn(route, 3_000, 1_000);
  assert.ok(Math.abs(light.estimatedCharsPerToken! - (1.35 + (2.7 - 1.35) * 0.1)) < 1e-9, "one easy step does not undo the dense one");
});

test("an image's reserve in the budget is not read as text: a request carrying one teaches no lighter ratio than the text's own", async () => {
  // The provider counts the text at 1.5 characters a token and each image by its pixels (252 tokens, as one route reported
  // for a 237 KB screenshot); the budget reserves 6,144 characters an image, which set against those tokens read as text
  // of 24 characters a token.
  const image = { mediaType: "image/png", data: Buffer.alloc(64 * 1024).toString("base64") };
  const tool: ToolDefinition = { id: "read_image", version: "1", description: "Reads image bytes", inputSchema: { type: "object" }, outputSchema: {},
    requiredPermissions: [], sideEffect: "none", timeoutMs: 1000,
    execute: async () => ({ protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "completed", result: { kind: "image" }, images: [image] }) };
  let step = 0;
  const adapter: LlmAdapter = {
    id: "calibrated", providerId: "test", model: "calibrated-model", resolveModel: async () => route,
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      step += 1;
      const images = request.messages.reduce((total, message) => total + (message.images?.length ?? 0), 0);
      const text = JSON.stringify({ messages: request.messages.map(({ images: _images, ...message }) => message), tools: request.tools }).length;
      const usage = { inputTokens: Math.round(text / 1.5) + 252 * images };
      yield step === 1
        ? { type: "final", content: null, toolCalls: [{ id: "c", name: tool.id, arguments: "{}" }], finishReason: "tool_calls", usage }
        : { type: "final", content: "xong", toolCalls: [], finishReason: "stop", usage };
    },
  };
  const { host, router } = await activeHost(adapter, [toolPlugin("image", [tool])]);
  const { policy, ratios } = recording();
  try {
    const loop = new DefaultAgentLoop(router, new InMemorySessionStore(), {}, { contextCompactionPolicy: policy });
    await loop.runTurn({ sessionId: "calibrate-image", content: "đọc ảnh", security: security() });
    await loop.runTurn({ sessionId: "calibrate-image", content: "tiếp", security: security() });
    assert.ok(step >= 3, "the image went out with a request whose cost was counted");
    assert.ok(ratios.at(-1)! <= 1.351, `the text's own ratio, or a little under it for the image's tokens: ${ratios.at(-1)}`);
  } finally { await host.shutdown(); }
});
