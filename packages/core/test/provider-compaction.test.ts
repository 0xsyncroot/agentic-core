import assert from "node:assert/strict";
import test from "node:test";
import type { PreparedLlmRequest, ToolDefinition, TurnControlPolicy } from "@0xsyncroot/contracts";
import { DeepSeekAdapter } from "@0xsyncroot/adapter-deepseek";
import { ConfiguredContextCompactionPolicy, DefaultAgentLoop, DeterministicConversationCompactor, InMemoryToolResultSpool } from "@0xsyncroot/core";
import { createSystemPromptPlugin } from "@0xsyncroot/plugins-base";
import { VIETNAMESE_MODEL_INSTRUCTIONS } from "./fixtures/vietnamese-model-instructions.js";
import { SpyStore, activeHost, security, toolPlugin } from "./turn-harness.js";

test("DeepSeek wire receives compacted context and the complete durable reading state in one uninterrupted turn", async () => {
  const bodies: Record<string, unknown>[] = [], prepared: PreparedLlmRequest[] = [];
  const model = new DeepSeekAdapter({ baseUrl: "https://model.example.test/v1", model: "example-model", apiKey: "test", thinking: "enabled",
    modelContext: { contextWindowTokens: 12_000, revision: "small-test-model" }, fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const offset = bodies.length - 1;
      const choice = offset < 6
        ? { finish_reason: "tool_calls", delta: { tool_calls: [{ index: 0, id: `page-${offset}`, function: { name: "read_page", arguments: JSON.stringify({ offset }) } }] } }
        : { finish_reason: "stop", delta: { content: "Đã xét đủ các trang." } };
      return new Response(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`);
    } });
  const adapter = { defaultParameters: model.defaultParameters, plainParameters: model.plainParameters, id: model.id, providerId: model.providerId, model: model.model, features: model.features,
    resolveModel: model.resolveModel.bind(model), stream(request: PreparedLlmRequest, signal: AbortSignal) {
      prepared.push(request); return model.stream(request, signal);
    } };
  const reader: ToolDefinition = {
    id: "read_page", version: "1", description: "Đọc trang", sideEffect: "none", requiredPermissions: [], timeoutMs: 1_000, retainResult: true,
    inputSchema: { type: "object", properties: { offset: { type: "integer" } }, required: ["offset"], additionalProperties: false }, outputSchema: {},
    execute: async invocation => ({ offset: (invocation.arguments as { offset: number }).offset, rows: "Nội dung nguồn ".repeat(400) }),
  };
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("model-pages", [reader])]);
  let keptEvidence = false;
  const policy: TurnControlPolicy = {
    id: "test.model-evidence", revision: "1", beforeModelStep: async state => {
      if (state.context.checkpoint && state.context.events.filter(event => event.type === "tool/result").length === 6) keptEvidence = true;
      return {};
    }, reviewTerminal: async () => ({ decision: "accept" }),
  };
  const agent = new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 8 }, {
    modelInstructions: VIETNAMESE_MODEL_INSTRUCTIONS, turnControlPolicy: policy, toolResultSpool: new InMemoryToolResultSpool(),
    conversationCompactor: new DeterministicConversationCompactor(2, "test-model-vi", VIETNAMESE_MODEL_INSTRUCTIONS.compaction),
    contextCompactionPolicy: new ConfiguredContextCompactionPolicy({ thresholdRatio: 0.01, retainRatio: 0.005 }),
    turnContextProvider: { id: "test.model-reading", revision: "1", prepare: async input => {
      const sources = input.events.filter(event => event.type === "tool/result").map(event => ({ seq: event.seq, callId: event.callId }));
      return { snapshot: { sources, archive: "Bản lưu nguyên vẹn" }, modelSnapshot: { sources, reviewedPages: sources.length }, classification: "confidential" };
    } },
  });
  try {
    const result = await agent.runTurn({ sessionId: "model-long-turn", content: "Đọc hết file, giữ các nhiệm vụ đã nhặt", security: security() });
    assert.equal(result.outcome, "completed");
    assert.equal(bodies.length, 7);
    assert.equal(result.events.filter(event => event.type === "turn/start").length, 1);
    assert.ok(result.events.filter(event => event.type === "context/checkpoint").length >= 3);
    assert.ok(keptEvidence, "source evidence remains complete after compaction");
    const finalWire = bodies.at(-1)!.messages as { role: string; content: string }[];
    assert.ok(finalWire.some(message => message.content?.includes('"reviewedPages":6')));
    assert.ok(finalWire.some(message => message.content?.includes("Đọc hết file")));
    assert.ok(!finalWire.some(message => message.content?.includes("Bản lưu nguyên vẹn")));
    assert.ok(prepared.at(-1)!.messages.some(message => message.context?.provenance === "context-checkpoint"));
    assert.ok(finalWire.at(-1)!.content.includes("tiếng Việt"));
    assert.equal((bodies.at(-1)!.thinking as { type: string }).type, "enabled");
  } finally { await host.shutdown(); }
});

test("a provider's refreshed context limit applies to recovery and later steps of the same turn", async () => {
  let accepted = 0, refused = 0, learnedWindow = 12_000;
  const bodies: { messages: { content: string }[] }[] = [];
  const model = new DeepSeekAdapter({ baseUrl: "https://model.example.test/v1", model: "example-model", apiKey: "test", modelContext: { contextWindowTokens: 12_000, revision: "stated-window" },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (JSON.stringify(body.messages).length > 12_000) {
        refused += 1;
        learnedWindow = 4_000;
        return Response.json({ error: { message: "This model's maximum context length is 4000 tokens" } }, { status: 400 });
      }
      const offset = accepted++;
      const choice = offset < 2 ? { finish_reason: "tool_calls", delta: { tool_calls: [{ index: 0, id: `page-${offset}`,
        function: { name: "read_page", arguments: JSON.stringify({ offset }) } }] } }
        : { finish_reason: "stop", delta: { content: "Đã xét hai trang." } };
      return new Response(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`);
    } });
  // A test-only metadata refresh models the provider-independent recovery contract.
  const refreshed = { id: model.id, providerId: model.providerId, model: model.model, features: model.features,
    stream: model.stream.bind(model),
    resolveModel: async () => ({ ...await model.resolveModel(), contextWindowTokens: learnedWindow, routeRevision: `window-${learnedWindow}` }),
  };
  const reader: ToolDefinition = {
    id: "read_page", version: "1", description: "Đọc trang", sideEffect: "none", requiredPermissions: [], timeoutMs: 1_000,
    inputSchema: { type: "object", properties: { offset: { type: "integer" } }, required: ["offset"], additionalProperties: false }, outputSchema: {},
    execute: async invocation => ({ offset: (invocation.arguments as { offset: number }).offset, rows: "Nguồn mới ".repeat(1_400) }),
  };
  const { host, router } = await activeHost(refreshed, [createSystemPromptPlugin(), toolPlugin("learned-window", [reader])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 5 }, {
      modelInstructions: VIETNAMESE_MODEL_INSTRUCTIONS,
      conversationCompactor: new DeterministicConversationCompactor(2, "learned-window", VIETNAMESE_MODEL_INSTRUCTIONS.compaction),
      contextCompactionPolicy: new ConfiguredContextCompactionPolicy(),
      turnContextProvider: { id: "test.window-progress", revision: "1", prepare: async input => ({
        snapshot: { pages: input.events.filter(event => event.type === "tool/result").length }, classification: "confidential",
      }) },
    }).runTurn({ sessionId: "model-learned-window", content: "Đọc hết hai trang và giữ tiến độ", security: security() });
    assert.equal(result.outcome, "completed");
    assert.equal(refused, 1, "a learned limit prevents repeating the same overflow on the following step");
    const requests = result.events.filter(event => event.type === "request/prepared");
    assert.equal((requests.at(-1)!.payload as { modelRoute: { contextWindowTokens: number } }).modelRoute.contextWindowTokens, 4_000);
    assert.equal(result.events.filter(event => event.type === "turn/start").length, 1);
    assert.equal(result.events.filter(event => event.type === "tool/result").length, 2);
    assert.ok(bodies.at(-1)!.messages.some(message => message.content?.includes('"pages":2')), "reading progress survives the smaller bound");
  } finally { await host.shutdown(); }
});
