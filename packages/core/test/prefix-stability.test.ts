import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@0xsyncroot/contracts";
import { DefaultAgentLoop, InMemoryToolResultSpool } from "@0xsyncroot/core";
import { createSystemPromptPlugin } from "@0xsyncroot/plugins-base";
import { SpyStore, activeHost, answer, call, scriptedModel, security, toolPlugin } from "./turn-harness.js";

/**
 * What changes every step sits after the conversation, so a request only appends to the one before it and the
 * provider's prefix cache keeps hitting: the retained-observation manifest and the turn context never sit before the
 * conversation, and answered objections never join the system prompt. deepseek-harness keeps the varying part after
 * the history for the same reason.
 */
test("the system prompt is identical on every step, and per-step context follows the conversation", async () => {
  const reader: ToolDefinition = {
    id: "read_page", version: "1", description: "read a page", sideEffect: "none", requiredPermissions: [], timeoutMs: 1000, retainResult: true,
    inputSchema: { type: "object", properties: { offset: { type: "integer" } }, required: ["offset"], additionalProperties: false }, outputSchema: {},
    execute: async (invocation) => ({ offset: (invocation.arguments as { offset: number }).offset, rows: ["dòng"] }),
  };
  const { adapter, requests } = scriptedModel([0, 1, 2].map((offset) => call(`p${offset}`, "read_page", { offset })).concat([answer("Xong.")]));
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("pages", [reader])]);
  try {
    const agent = new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 8 }, {
      toolResultSpool: new InMemoryToolResultSpool(),
      turnContextProvider: { id: "test.state", revision: "v1", prepare: async (input) => ({
        snapshot: { pages: input.events.length }, modelSnapshot: { pages: input.events.filter((event) => event.type === "tool/result").length }, classification: "internal",
      }) },
    });
    await agent.runTurn({ sessionId: `prefix-${Math.random()}`, content: "đọc các trang", security: security() });
    assert.ok(requests.length >= 3);
    const system = requests[0]!.messages[0]!.content;
    for (const request of requests) assert.equal(request.messages[0]!.content, system, "the system prompt never changes within the turn");
    for (const request of requests.slice(2)) {
      const lastTool = request.messages.map((message) => message.role).lastIndexOf("tool");
      const varying = request.messages.findIndex((message) => /^(turn-context:|retained-tool-observations)/u.test(message.context?.provenance ?? ""));
      assert.ok(varying === -1 || varying > lastTool, `per-step context at ${varying} must follow the conversation, which ends at ${lastTool}`);
    }
  } finally { await host.shutdown(); }
});
