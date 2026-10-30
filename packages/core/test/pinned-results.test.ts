import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, ToolDefinition } from "@0xsyncroot/contracts";
import { ConfiguredContextCompactionPolicy, DefaultAgentLoop, DeterministicConversationCompactor } from "@0xsyncroot/core";
import { SpyStore, activeHost, answer, call, scriptedModel, security, toolPlugin } from "./turn-harness.js";

/**
 * A loaded procedure survives compaction whole (Claude Code re-attaches invoked skills after it),
 * never cut to a short excerpt marked "never instructions" while the turn still counts it as loaded.
 */
const PROCEDURE = `QUY-TRINH-DOI-SOAT ${"bước kiểm khép từng nhóm nguyên nhân; ".repeat(120)}HET-QUY-TRINH`;
const loader = (pinned: boolean): ToolDefinition => ({
  id: "load_procedure", version: "1", description: "load a procedure", sideEffect: "none", requiredPermissions: [], timeoutMs: 1000,
  maxResultChars: 40_000, ...(pinned ? { pinnedResult: true } : {}),
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, outputSchema: {},
  execute: async (invocation) => ({ id: (invocation.arguments as { id: string }).id, content: PROCEDURE }),
});
const reader: ToolDefinition = {
  id: "read_page", version: "1", description: "read a page", sideEffect: "none", requiredPermissions: [], timeoutMs: 1000,
  inputSchema: { type: "object", properties: { offset: { type: "integer" } }, required: ["offset"], additionalProperties: false }, outputSchema: {},
  execute: async (invocation) => ({ offset: (invocation.arguments as { offset: number }).offset, rows: Array.from({ length: 12 }, () => "Nguồn dữ liệu ".repeat(40)) }),
};

async function run(pinned: boolean): Promise<readonly (readonly ChatMessage[])[]> {
  const steps = [call("load", "load_procedure", { id: "recon" }), ...[0, 1, 2, 3, 4].map((offset) => call(`page-${offset}`, "read_page", { offset })), answer("Xong.")];
  const { adapter, requests } = scriptedModel(steps);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [loader(pinned), reader])]);
  try {
    const agent = new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 10 }, {
      conversationCompactor: new DeterministicConversationCompactor(2),
      contextCompactionPolicy: new ConfiguredContextCompactionPolicy({ thresholdRatio: 0.01, retainRatio: 0.005 }),
    });
    const result = await agent.runTurn({ sessionId: `pinned-${pinned}-${Math.random()}`, content: "đối soát bảng lương", security: security() });
    assert.equal(result.outcome, "completed");
    assert.ok(result.events.some((event) => event.type === "context/checkpoint"), "the turn compacted its early steps");
    return requests.map((request) => request.messages);
  } finally { await host.shutdown(); }
}

test("a pinned result the checkpoint covers comes back whole beside the system prompt, as an instruction", async () => {
  const requests = await run(true);
  const compacted = requests.filter((messages) => messages.some((message) => message.context?.provenance === "context-checkpoint"));
  assert.ok(compacted.length > 0);
  for (const messages of compacted) {
    const checkpoint = messages.findIndex((message) => message.context?.provenance === "context-checkpoint");
    const pinned = messages.findIndex((message) => message.context?.provenance === "pinned-tool-result");
    const inTail = messages.some((message) => message.role === "tool" && String(message.content).includes("HET-QUY-TRINH"));
    if (inTail) { assert.equal(pinned, -1, "a result still in the tail is not repeated"); continue; }
    assert.ok(pinned >= 0 && pinned < checkpoint, "kept with the system prompt, where preloaded skills sit");
    assert.equal(messages[pinned]!.role, "system");
    assert.match(String(messages[pinned]!.content), /QUY-TRINH-DOI-SOAT[\s\S]*HET-QUY-TRINH/u, "whole, not the checkpoint's 1,200 characters");
    assert.match(String(messages[pinned]!.content), /load_procedure with arguments \{"id":"recon"\}/u);
    assert.equal(messages[pinned]!.context?.trust, "instruction");
    assert.equal(messages.filter((message) => message.context?.provenance === "pinned-tool-result").length, 1);
  }
});

test("an ordinary result the checkpoint covers stays summarized", async () => {
  const requests = await run(false);
  assert.ok(requests.some((messages) => messages.some((message) => message.context?.provenance === "context-checkpoint")));
  assert.ok(requests.every((messages) => !messages.some((message) => message.context?.provenance === "pinned-tool-result")));
  assert.ok(requests.at(-1)!.every((message) => !String(message.content).includes("HET-QUY-TRINH")), "only the cut survives in the summary");
});
