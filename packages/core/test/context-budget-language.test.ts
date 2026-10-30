import assert from "node:assert/strict";
import test from "node:test";
import { ContextWindowPolicy } from "../src/agent/context-window-policy.js";
import { LlmStepExecutor } from "../src/agent/llm-step-executor.js";
import { ExponentialRetryPolicy } from "../src/agent/retry-policy.js";
import type { ChatMessage, LlmRequest } from "@0xsyncroot/contracts";
import { VIETNAMESE_MODEL_INSTRUCTIONS } from "./fixtures/vietnamese-model-instructions.js";

test("Vietnamese context cuts retain source endpoints without an English marker or blind reread instruction", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "Phân tích tài liệu" },
    { role: "assistant", content: `Đầu nguồn ${"Nội dung ".repeat(1500)} Kết quả cuối nguồn` }];
  const result = new ContextWindowPolicy(2_000, VIETNAMESE_MODEL_INSTRUCTIONS.contextBudget).apply(messages);
  const text = result.messages.map((message) => message.content).join("\n");
  assert.match(text, /Đầu nguồn/); assert.match(text, /Kết quả cuối nguồn/);
  assert.match(text, /không chép thông báo này/iu);
  assert.doesNotMatch(text, /content truncated|characters cut|older messages omitted/iu);
});

test("EXAMPLE language is applied to each model request after conversation and hard tool-choice instructions", async () => {
  let sent: LlmRequest | undefined;
  const executor = new LlmStepExecutor(12_000, new ExponentialRetryPolicy(1, 0), 1_000, VIETNAMESE_MODEL_INSTRUCTIONS);
  await executor.execute({ turnId: "turn", stepId: "step", runtimeSnapshotId: "runtime", tools: [],
    messages: [{ role: "user", content: "phân tích file" }], toolChoice: { name: "audit" },
    signal: new AbortController().signal, writer: { append: async () => [] } as never,
    resolvedModel: { modelId: "test" } as never,
    llm: { id: "test", features: { toolChoice: false }, stream: async function* (request: LlmRequest) {
      sent = request; yield { type: "final", content: "Đã đọc nguồn.", toolCalls: [] };
    } } as never,
  });
  assert.ok(sent);
  assert.match(String(sent.messages.at(-1)?.content), /toàn bộ.*tiếng Việt/u);
  assert.match(String(sent.messages.at(-2)?.content), /phải gọi công cụ/u);
  assert.equal(sent.messages.at(-1)?.context?.retention, "required");
  assert.doesNotMatch(sent.messages.map((message) => message.content).join("\n"), /This step must|content truncated/u);
});
