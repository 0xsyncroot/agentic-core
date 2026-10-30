import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIAdapter } from "@0xsyncroot/adapter-openai";

test("Responses sends tool images as input_image content and preserves the function call ID", async () => {
  let body: Record<string, unknown> | undefined;
  const adapter = new OpenAIAdapter({ apiKey: "test-only", fetch: async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed", output: [] } })}\n\n`);
  } });
  for await (const _ of adapter.stream({
    requestId: "r", attemptId: "a", turnId: "t", stepId: "s", runtimeSnapshotId: "rt",
    model: adapter.model, tools: [], parameters: {}, contentHash: "h", messages: [
      { role: "assistant", content: null, toolCalls: [{ id: "image-call", name: "read", arguments: "{}" }] },
      { role: "tool", content: "Image metadata", toolCallId: "image-call", images: [{ mediaType: "image/png", data: "YQ==" }] },
      { role: "user", content: "Compare", images: [{ mediaType: "image/jpeg", data: "Yg==" }] },
    ],
  }, new AbortController().signal)) { /* consume */ }
  const input = body!.input as Record<string, unknown>[];
  assert.deepEqual(input[1], { type: "function_call_output", call_id: "image-call", output: [
    { type: "input_text", text: "Image metadata" },
    { type: "input_image", image_url: "data:image/png;base64,YQ==", detail: "auto" },
  ] });
  assert.deepEqual(input[2], { role: "user", content: [
    { type: "input_text", text: "Compare" },
    { type: "input_image", image_url: "data:image/jpeg;base64,Yg==", detail: "auto" },
  ] });
});
