import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_EXECUTION_RESPONSE_PROTOCOL, type ChatMessage, type ToolDefinition } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { InMemorySessionStore } from "@0xsyncroot/persistence-memory";
import { createSystemPromptPlugin } from "@0xsyncroot/plugins-base";
import { ConversationProjector, earlierTurnImageText } from "../src/agent/conversation-projector.js";
import { ContextWindowPolicy } from "../src/agent/context-window-policy.js";
import { modelContextSize } from "../src/agent/llm-model-context.js";
import { SpyStore, activeHost, answer, calls, scriptedModel, security, toolPlugin } from "./turn-harness.js";

test("binary tool images survive the live step, durable journal and later projection without consuming text budget", async () => {
  const image = { mediaType: "image/png", data: Buffer.alloc(2 * 1024 * 1024).toString("base64") };
  const tool: ToolDefinition = { id: "read_image", version: "1", description: "Reads image bytes", inputSchema: { type: "object" }, outputSchema: {},
    requiredPermissions: [], sideEffect: "none", timeoutMs: 1000, execute: async () => ({
      protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "completed", result: { kind: "image", name: "page.png" }, images: [image],
    }) };
  const model = scriptedModel([calls([{ id: "c", name: tool.id, args: {} }]), answer("Read")]);
  const { router, host } = await activeHost(model.adapter, [toolPlugin("image", [tool]), createSystemPromptPlugin()]);
  const store = new SpyStore();
  try {
    const result = await new DefaultAgentLoop(router, store, { maxToolResultChars: 1000, maxContextChars: 100000 }).runTurn({
      sessionId: "images", content: "Read the image", security: security(),
    });
    assert.equal(result.outcome, "completed");
    const sent = model.requests[1]!.messages.find((message) => message.role === "tool");
    assert.deepEqual(sent?.images, [image]);
    assert.ok(sent!.content!.length < 1000);
    const projected = new ConversationProjector().project(result.events);
    assert.deepEqual(projected.find((message) => message.role === "tool")?.images, [image]);
    assert.ok(modelContextSize(projected) < 100000);
  } finally { await host.shutdown(); }
});

test("clearing an old image result removes the binary bytes and tells the model to read again", () => {
  const image = { mediaType: "image/png", data: Buffer.alloc(10000).toString("base64") };
  const window = new ContextWindowPolicy(6000).apply([
    { role: "assistant", content: null, toolCalls: [{ id: "c", name: "read_image", arguments: "{}" }] },
    { role: "tool", toolCallId: "c", content: "Image", images: [image] },
    { role: "user", content: "Next request" },
  ]);
  const cleared = window.messages.find((message) => message.role === "tool");
  assert.equal(cleared?.images, undefined);
  assert.match(cleared!.content!, /Call the tool again/);
});

test("a fresh image remains visible with Sample App's full prompt and tool catalogue budget", () => {
  const image = { mediaType: "image/png", data: Buffer.alloc(2 * 1024 * 1024).toString("base64") };
  // Observed deployment: 120k fallback window, ~53.6k tool schemas, ~49k required prompt.
  const window = new ContextWindowPolicy(66000).apply([
    { role: "system", content: "x".repeat(49000), context: { trust: "instruction", retention: "required", provenance: "runtime-system-prompt" } },
    { role: "user", content: "Read the attached image" },
    { role: "assistant", content: null, toolCalls: [{ id: "c", name: "read_image", arguments: "{}" }] },
    { role: "tool", toolCallId: "c", content: "Image metadata", images: [image] },
  ]);
  assert.deepEqual(window.messages.find((message) => message.role === "tool")?.images, [image]);
  assert.equal(window.clearedResults, 0);
  assert.ok(modelContextSize(window.messages) < 66000);
});

/**
 * An image travels as base64 in every request that projects it, and a provider spends time on those bytes before its first
 * token each time. The turn that read it keeps it from step to step; a later turn reads a line saying how to see it again.
 */
test("an image read in an earlier turn is a line of text in later turns, and stays whole across the steps of its own", async () => {
  const image = { mediaType: "image/png", data: Buffer.alloc(300 * 1024).toString("base64") };
  const tool: ToolDefinition = { id: "read_image", version: "1", description: "Reads image bytes", inputSchema: { type: "object" }, outputSchema: {},
    requiredPermissions: [], sideEffect: "none", timeoutMs: 1000, execute: async () => ({
      protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "completed", result: { kind: "image", name: "screen.png", documentId: "doc-1" }, images: [image],
    }) };
  const model = scriptedModel([
    calls([{ id: "c1", name: tool.id, args: { documentId: "doc-1" } }]), calls([{ id: "c2", name: tool.id, args: { documentId: "doc-1", page: 2 } }]),
    answer("A table"), answer("Still a table"),
  ]);
  const { router, host } = await activeHost(model.adapter, [toolPlugin("image", [tool]), createSystemPromptPlugin()]);
  try {
    const loop = new DefaultAgentLoop(router, new InMemorySessionStore(), { maxContextChars: 400_000 });
    await loop.runTurn({ sessionId: "earlier-images", content: "What is in the image?", security: security() });
    await loop.runTurn({ sessionId: "earlier-images", content: "And the third column?", security: security() });
    const toolMessages = (index: number) => model.requests[index]!.messages.filter((message) => message.role === "tool");
    assert.deepEqual(toolMessages(1).map((message) => message.images), [[image]], "the step after the read sees the image");
    assert.deepEqual(toolMessages(2).map((message) => message.images), [[image], [image]], "every step of the turn that read it does");
    const later = toolMessages(3);
    assert.deepEqual(later.map((message) => message.images), [undefined, undefined], "the next turn sends no image bytes");
    for (const message of later) {
      assert.match(message.content!, /doc-1/, "the result's own text still names what was read");
      assert.ok(message.content!.endsWith(earlierTurnImageText("read_image", 1)), message.content!);
    }
    assert.ok(JSON.stringify(model.requests[3]).length < JSON.stringify(model.requests[2]).length / 10);
  } finally { await host.shutdown(); }
});

test("the projector keeps images of the named turns, replaces the rest, and keeps all when no turn is named", () => {
  const image = { mediaType: "image/png", data: Buffer.alloc(30).toString("base64") };
  const at = (seq: number, turnId: string, type: string, payload: Record<string, unknown>) =>
    ({ eventId: `e${seq}`, seq, sessionId: "s", turnId, type, payload, classification: "internal", occurredAt: new Date(seq).toISOString() }) as never;
  const events = [
    at(1, "t1", "user/input", { content: "Read it" }),
    at(2, "t1", "assistant/message", { content: null, toolCalls: [{ id: "c", name: "read_image", arguments: "{}" }] }),
    at(3, "t1", "tool/result", { callId: "c", toolId: "read_image", result: { name: "a.png" }, images: [image, image] }),
    at(4, "t1", "tool/result", { callId: "lost", toolId: "read_image", result: { name: "b.png" }, images: [image] }),
  ];
  const projector = new ConversationProjector();
  const imagesOf = (messages: readonly ChatMessage[]) => messages.map((message) => message.images?.length ?? 0);
  assert.deepEqual(imagesOf(projector.project(events)), [0, 0, 2, 1]);
  assert.deepEqual(imagesOf(projector.project(events, undefined, undefined, new Set(["t1"]))), [0, 0, 2, 1]);
  const later = projector.project(events, undefined, undefined, new Set(["t2"]));
  assert.deepEqual(imagesOf(later), [0, 0, 0, 0]);
  assert.ok(later[2]!.content!.endsWith(earlierTurnImageText("read_image", 2)));
  assert.match(later[2]!.content!, /The 2 images this call returned are not attached again/);
  assert.ok(later[3]!.content!.endsWith(earlierTurnImageText("read_image", 1)), "a result whose call is gone is told the same way");
});
