import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, ToolDefinition } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { activeHost, answer, call, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/**
 * A refusal that says what to change is feedback, not circling: a no-op click, then one click whose label was not
 * echoed exactly, must not end a turn as "progress stalled" when the next click would succeed.
 */
const read: ToolDefinition = {
  id: "test_read", version: "1", description: "read", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {}, execute: async (invocation) => ({ page: (invocation.arguments as { page?: number }).page ?? 0 }) as JsonValue,
};
const click: ToolDefinition = {
  id: "test_click", version: "1", description: "click", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {},
  execute: async (invocation) => {
    const label = (invocation.arguments as { label?: string }).label ?? "";
    if (label === "icon-eye") return { status: "succeeded", screen: "detail" };
    if (label.startsWith("row")) return { status: "succeeded", screen: "list" };
    return { status: "rejected", reasonCode: "label-mismatch", message: "Ref e80 is \"icon-eye\"." };
  },
  // What the screen shows: a refused click leaves the list as it was, as the live observation review judged it.
  observationKey: (result) => ({ screen: (result as { screen?: string }).screen ?? "list" }),
};
const options = { maxSteps: 48, initialStepBudget: 3, stepBudgetExtension: 1 };

test("a step whose only call was refused with a reason keeps the next step's tools", async () => {
  // The list (new), a click on the row that changes nothing (a stall), a mislabelled click refused, then the right one.
  const { adapter, requests } = scriptedModel([call("c1", "test_click", { label: "row (look)" }), call("c2", "test_click", { label: "row" }),
    call("c3", "test_click", { label: "Open detail" }), call("c4", "test_click", { label: "icon-eye" }), answer("Đã mở bảng chi tiết.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read, click])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), options).runTurn({ sessionId: "refused", content: "mở bảng", security: security() });
    assert.ok(requests[3]!.tools.length > 0, "the step after the refusal can still click");
    assert.equal(result.content, "Đã mở bảng chi tiết.");
  } finally { await host.shutdown(); }
});

test("refusals in a row stop being refunded after three; a model that only gets refused still ends", async () => {
  const wrong = Array.from({ length: 12 }, (_value, index) => call(`w${index}`, "test_click", { label: `guess ${index}` }));
  const { adapter, requests } = scriptedModel([call("c1", "test_read", { page: 1 }), ...wrong, answer("Chưa mở được bảng.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read, click])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), options).runTurn({ sessionId: "refused-loop", content: "mở bảng", security: security() });
    assert.equal(result.outcome, "partial");
    assert.ok(requests.length < wrong.length + 1, `ends before the guesses run out: ${requests.length} model steps`);
    assert.equal(requests.at(-1)!.tools.length, 0, "the last step closes the turn without tools");
  } finally { await host.shutdown(); }
});
