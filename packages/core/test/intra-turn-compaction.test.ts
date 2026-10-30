import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition, TurnControlPolicy } from "@0xsyncroot/contracts";
import { ConfiguredContextCompactionPolicy, DefaultAgentLoop, DeterministicConversationCompactor, InMemoryToolResultSpool, validContextCheckpoint } from "@0xsyncroot/core";
import { createSystemPromptPlugin } from "@0xsyncroot/plugins-base";
import { SpyStore, activeHost, answer, call, scriptedModel, security, toolPlugin } from "./turn-harness.js";
import { VIETNAMESE_MODEL_INSTRUCTIONS } from "./fixtures/vietnamese-model-instructions.js";

test("a single long turn compacts completed steps while policies keep all original page evidence", async () => {
  const reader: ToolDefinition = {
    id: "read_page", version: "1", description: "read a page", sideEffect: "none", requiredPermissions: [], timeoutMs: 1000, retainResult: true,
    inputSchema: { type: "object", properties: { offset: { type: "integer" } }, required: ["offset"], additionalProperties: false }, outputSchema: {},
    execute: async (invocation) => ({ offset: (invocation.arguments as { offset: number }).offset, rows: Array.from({ length: 12 }, () => "Nguồn dữ liệu ".repeat(40)) }),
  };
  const { adapter, requests } = scriptedModel([0, 1, 2, 3, 4, 5].map((offset) => call(`page-${offset}`, "read_page", { offset })).concat([answer("Đã đọc hết.")]));
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("pages", [reader])]);
  const store = new SpyStore();
  const spool = new InMemoryToolResultSpool();
  let sawCompactedEvidence = false;
  const policy: TurnControlPolicy = {
    id: "test.reading", revision: "v1", beforeModelStep: async (state) => {
      const covered = Number((state.context.checkpoint?.payload as Record<string, unknown> | undefined)?.coveredThroughSeq ?? 0);
      if (covered > 0 && state.context.events.some((event) => event.type === "tool/result" && event.seq <= covered)) sawCompactedEvidence = true;
      return {};
    }, reviewTerminal: async () => ({ decision: "accept" }),
  };
  const agent = new DefaultAgentLoop(router, store, { maxSteps: 8 }, {
    turnControlPolicy: policy, toolResultSpool: spool, conversationCompactor: new DeterministicConversationCompactor(2, "test-vi", VIETNAMESE_MODEL_INSTRUCTIONS.compaction),
    modelInstructions: VIETNAMESE_MODEL_INSTRUCTIONS,
    turnContextProvider: { id: "test.pages", revision: "v1", prepare: async (input) => ({
      snapshot: { archive: "Bản lưu chính xác không gửi vào model", pages: input.events.filter((e) => e.type === "tool/result").length },
      modelSnapshot: { pages: input.events.filter((e) => e.type === "tool/result").length }, classification: "confidential",
    }) },
    contextCompactionPolicy: new ConfiguredContextCompactionPolicy({ thresholdRatio: 0.01, retainRatio: 0.005 }),
  });
  const result = await agent.runTurn({ sessionId: "one-long-turn", content: "Đọc toàn bộ các trang của file Đơn Vị Mẫu", security: security() });
  assert.equal(result.outcome, "completed");
  const checkpoints = result.events.filter((event) => event.type === "context/checkpoint");
  assert.ok(checkpoints.length >= 3, "a long active turn keeps compacting after its turn/start leaves the model tail");
  assert.ok(checkpoints.every(validContextCheckpoint));
  assert.ok(sawCompactedEvidence, "compaction never erases evidence from a trusted policy");
  assert.ok(requests.some((request) => request.messages.some((message) => message.context?.provenance === "context-checkpoint")));
  assert.ok(requests.at(-1)!.messages.some((message) => String(message.content).includes("Đọc toàn bộ các trang")), "the current objective survives compression");
  assert.equal(result.events.filter((event) => event.type === "tool/result").length, 6);
  const scope = { tenantId: security().tenantId, sessionId: "one-long-turn" };
  for (const event of result.events.filter((event) => event.type === "tool/result")) {
    const payload = event.payload as Record<string, unknown>;
    assert.equal(typeof payload.resultId, "string", "small complete source pages are recoverable too");
    assert.deepEqual(spool.get(scope, String(payload.resultId))?.value, payload.result);
  }
  assert.ok(requests.at(-1)!.messages.some((message) => message.context?.provenance === "retained-tool-observations"));
  const state = requests.at(-1)!.messages.find((message) => message.context?.provenance?.startsWith("turn-context:"));
  assert.ok(state); assert.match(String(state.content), /Trạng thái công việc đã lưu/u);
  assert.doesNotMatch(String(state.content), /Bản lưu chính xác|archive/u);
  assert.equal(state.context?.trust, "untrusted", "a product projection is data, never an instruction");
  const durable = result.events.find((event) => event.type === "extension/test.pages/task-snapshot");
  assert.equal((durable?.payload as { snapshot: { archive: string } }).snapshot.archive, "Bản lưu chính xác không gửi vào model");
  assert.ok(checkpoints.some((event) => String((event.payload as { summary: string }).summary).includes("Người dùng:")));
  await host.shutdown();
});
