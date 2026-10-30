import assert from "node:assert/strict";
import test from "node:test";
import { parseModelImages } from "@0xsyncroot/contracts";
import { mcpCompletedResult } from "../src/image-result.js";
import { apiMessages } from "../../adapter-deepseek/src/image-messages.js";

test("MCP images use the binary channel while ordinary text results retain their existing shape", () => {
  const data = Buffer.alloc(2 * 1024 * 1024).toString("base64");
  const result = mcpCompletedResult({ content: [{ type: "image", mimeType: "image/png", data }], structuredContent: { kind: "image" } }, "image", 1000);
  assert.deepEqual(result, { protocol: "agentic.tool-execution/v1", kind: "completed",
    result: { content: [], structuredContent: { kind: "image" } }, images: [{ mediaType: "image/png", data }] });
  const text = { structuredContent: { rows: [1, 2] } };
  assert.deepEqual(mcpCompletedResult(text, "text", 1000), text);
  assert.throws(() => parseModelImages([{ mediaType: "image/png", data: "broken" }]), /Invalid/);
  assert.throws(() => parseModelImages([{ mediaType: "text/plain", data: "YQ==" }]), /Invalid/);
});

test("Chat Completions images follow every result in a parallel tool batch without breaking call pairing", () => {
  const images = [{ mediaType: "image/png", data: "YQ==" }];
  const messages = apiMessages([
    { role: "assistant", content: null, toolCalls: [{ id: "a", name: "read", arguments: "{}" }, { id: "b", name: "read", arguments: "{}" }] },
    { role: "tool", content: "first", toolCallId: "a", images },
    { role: "tool", content: "second", toolCallId: "b", images },
    { role: "user", content: "Explain" },
  ], (message) => ({ role: message.role, content: message.content, ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}) }));
  assert.deepEqual(messages.map((message) => message.role), ["assistant", "tool", "tool", "user", "user"]);
  const parts = messages[3]!.content as Array<{ type: string; image_url?: { url: string } }>;
  assert.equal(parts[2]!.image_url!.url, "data:image/png;base64,YQ==");
  assert.equal(parts[4]!.image_url!.url, "data:image/png;base64,YQ==");
  assert.equal(JSON.stringify(messages.slice(0, 3)).includes("YQ=="), false);
});
