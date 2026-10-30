import assert from "node:assert/strict";
import test from "node:test";
import { AgenticError, type JsonValue, type SessionEvent, type ToolDefinition, type TurnControlPolicy } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { activeHost, answer, call, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/**
 * A failed step does not end the turn on a bare error, for any model or tool: the loop tries a fresh step, then
 * closes with a summary step, then with the product's sentence for unfinished work. And the tool-call ceiling is
 * one number, obeyed whether or not the work still progresses.
 */
const read = (id: string): ToolDefinition => ({
  id, version: "1", description: "read", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {}, execute: async (invocation) => ({ page: (invocation.arguments as { page?: number }).page ?? 0 }) as JsonValue,
});
const fail = (): never => { throw new AgenticError("permanent", "gateway refused the request"); };
const stopReason = (events: readonly SessionEvent[]) => (events.find((event) => event.type === "turn/end")?.payload as { reason?: string } | undefined)?.reason;
const policy = (fallback: string): TurnControlPolicy => ({
  id: "test", revision: "1", beforeModelStep: async () => ({}), reviewTerminal: async () => ({ decision: "accept", reason: "ok" }),
  fallbackText: (input) => input.kind === "step-failure" ? `${fallback}: ${input.remainingSteps.length}` : fallback,
});

test("one failed step is retried and the work goes on", async () => {
  const { adapter } = scriptedModel([call("c1", "test_read", { page: 1 }), fail, answer("Đã đọc xong.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("read", [read("test_read")])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxLlmAttempts: 1 }).runTurn({ sessionId: "retry", content: "đọc", security: security() });
    assert.equal(result.content, "Đã đọc xong.");
    assert.notEqual(result.outcome, "failed");
  } finally { await host.shutdown(); }
});

test("a step failing again is closed by a summary step without tools; if that fails too, the product's sentence ends it unfinished", async () => {
  const summary = scriptedModel([call("c1", "test_read", { page: 1 }), fail, fail, (request) => {
    assert.equal(request.tools.length, 0, "the closing step offers no tools");
    assert.match(request.messages.map((m) => m.content ?? "").join("\n"), /Runtime stop cause: step-failure:permanent\./u);
    return answer("Đã đọc trang 1; bước tiếp theo gặp sự cố.")();
  }]);
  const first = await activeHost(summary.adapter, [toolPlugin("read", [read("test_read")])]);
  try {
    const result = await new DefaultAgentLoop(first.router, new SpyStore(), { maxLlmAttempts: 1 }).runTurn({ sessionId: "close", content: "đọc", security: security() });
    assert.equal(result.content, "Đã đọc trang 1; bước tiếp theo gặp sự cố.");
    // One spelling of the failure's cause: the closing step's answer ends the turn with it, as the product's sentence does.
    assert.equal(stopReason(result.events), "step-failure:permanent");
  } finally { await first.host.shutdown(); }

  const broken = scriptedModel([call("c1", "test_read", { page: 1 }), fail, fail, fail]);
  const second = await activeHost(broken.adapter, [toolPlugin("read", [read("test_read")])]);
  try {
    const result = await new DefaultAgentLoop(second.router, new SpyStore(), { maxLlmAttempts: 1 }, { turnControlPolicy: policy("Em chưa làm xong") })
      .runTurn({ sessionId: "fallback", content: "đọc", security: security() });
    assert.equal(result.content, "Em chưa làm xong: 0");
    assert.equal(result.outcome, "partial", "unfinished, never failed: the user can continue");
    assert.equal(stopReason(result.events), "step-failure:permanent");
  } finally { await second.host.shutdown(); }
});

test("the tool-call ceiling is one number: a turn whose every step brings something new still closes there, without tools", async () => {
  const replies = Array.from({ length: 20 }, (_value, index) => call(`c${index}`, "test_read", { page: index + 1 }));
  const { adapter, requests } = scriptedModel([...replies.slice(0, 2), (request) => {
    assert.equal(request.tools.length, 0, "the configured two calls are spent: the step closes the turn");
    return answer("Đã đọc 2 trang, còn trang chưa đọc.")();
  }]);
  const { host, router } = await activeHost(adapter, [toolPlugin("read", [read("test_read")])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxToolCalls: 2, maxSteps: 48 }).runTurn({ sessionId: "hard-ceiling", content: "đọc", security: security() });
    assert.equal(result.content, "Đã đọc 2 trang, còn trang chưa đọc.");
    assert.equal(result.outcome, "partial");
    assert.equal((result.events.at(-1)!.payload as { reason?: string }).reason, "tool-call-limit");
    assert.equal(requests.length, 3);
  } finally { await host.shutdown(); }
});
