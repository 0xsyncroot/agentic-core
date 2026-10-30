import assert from "node:assert/strict";
import test from "node:test";
import { AgenticError, MODEL_LIMIT_REASON, type EventDraft, type PreparedLlmRequest } from "@0xsyncroot/contracts";
import { DeepSeekAdapter } from "@0xsyncroot/adapter-deepseek";
import { LlmStepExecutor } from "../src/agent/llm-step-executor.js";
import { ExponentialRetryPolicy } from "../src/agent/retry-policy.js";

function stream(chunks: unknown[]): Response {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
}
async function run(maxAttempts = 3, plain = true, alwaysOverflow = false) {
  const requests: Record<string, unknown>[] = [], events: EventDraft[] = [];
  const adapter = new DeepSeekAdapter({ apiKey: "test", thinking: "enabled", maxReasoningContentChars: 3,
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1 || alwaysOverflow ? stream([{ choices: [{ delta: { reasoning_content: "long" } }] }])
        : stream([{ choices: [{ finish_reason: "tool_calls", delta: { tool_calls: [{ index: 0, id: "audit-call",
          function: { name: "audit", arguments: '{"operation":"rows"}' } }] } }] }]);
    } });
  const executor = new LlmStepExecutor(10_000, new ExponentialRetryPolicy(maxAttempts, 0), 1_000);
  const llm = plain ? adapter : { id: adapter.id, model: adapter.model, features: adapter.features,
    defaultParameters: adapter.defaultParameters, stream: adapter.stream.bind(adapter) };
  const execute = () => executor.execute({ turnId: "same-turn", stepId: "same-step", runtimeSnapshotId: "rt", tools: [],
    messages: [{ role: "user", content: "Xét tiếp trang đang mở" },
      { role: "user", content: '{"reviewedRows":50,"draftTasks":22,"currentSource":{"startIndex":50}}',
        context: { trust: "untrusted", retention: "required", provenance: "saved-progress" } }],
    signal: new AbortController().signal, writer: { append: async (drafts: EventDraft[]) => { events.push(...drafts); return []; } } as never,
    resolvedModel: { modelId: adapter.model } as never, llm });
  return { execute, requests, events };
}
test("a real DeepSeek reasoning cap retries only the unfinished generation in plain mode with the same durable progress", async () => {
  const { execute, requests, events } = await run();
  const result = await execute();
  assert.equal(result.final.toolCalls[0]?.id, "audit-call");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]?.thinking, { type: "enabled" });
  assert.deepEqual(requests[1]?.thinking, { type: "disabled" });
  assert.deepEqual(requests[0]?.messages, requests[1]?.messages);
  const failed = events.find(event => event.type === "llm/attempt-failed");
  assert.equal((failed?.payload as Record<string, unknown>).reason, MODEL_LIMIT_REASON.REASONING);
  assert.equal((failed?.payload as Record<string, unknown>).recovery, "plain-parameters");
  assert.equal(events.filter(event => event.type === "llm/attempt-committed").length, 1);
  assert.equal(events.filter(event => event.type === "tool/intent").length, 0);
  assert.equal(new Set(events.map(event => event.turnId)).size, 1);
  assert.equal(new Set(events.map(event => event.stepId)).size, 1);
});
test("reasoning recovery is bounded and respects the configured attempt budget and adapter capability", async () => {
  for (const options of [[1, true, false], [3, false, false], [3, true, true]] as const) {
    const { execute, requests } = await run(...options);
    await assert.rejects(execute, (error: unknown) => error instanceof AgenticError && error.reason === MODEL_LIMIT_REASON.REASONING);
    assert.equal(requests.length, options[2] ? 2 : 1);
  }
});
