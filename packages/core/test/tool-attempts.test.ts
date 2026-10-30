import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolDefinition } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { ToolAttemptLedger } from "../src/agent/tool-attempts.js";
import { SpyStore, activeHost, answer, call, scriptedModel, security, toolPlugin } from "./turn-harness.js";

/**
 * Repeating a failing call is answered by the runtime, for any tool: the second failure on the same
 * target asks for another approach, the third lists what failed, and each result records the target
 * and the reason in the journal so a stop gate can count the approaches tried. A changed page size
 * or screen revision is still the same target.
 */

function pressTool(): ToolDefinition {
  let presses = 0;
  return {
    id: "test_press", version: "1.0.0", description: "presses a control",
    inputSchema: { type: "object", properties: { label: { type: "string" }, revision: { type: "string" }, rowCount: { type: "integer" } }, required: ["label"], additionalProperties: false },
    outputSchema: {}, requiredPermissions: [], sideEffect: "none", timeoutMs: 1_000,
    execute: async (invocation) => {
      presses += 1;
      const label = (invocation.arguments as { label: string }).label;
      return label === "Xóa" && presses <= 2 ? { status: "stale", reasonCode: "target-covered" } : { status: "succeeded", pressed: label };
    },
  };
}

test("in a turn: the second failure on one target says to change approach, a success clears it, the journal counts", async () => {
  const { adapter, requests } = scriptedModel([
    call("c1", "test_press", { label: "Xóa", revision: "ui.1", rowCount: 10 }),
    call("c2", "test_press", { label: "Xóa", revision: "ui.2", rowCount: 20 }),
    call("c3", "test_press", { label: "Xóa", revision: "ui.3" }),
    answer("Đã xóa."),
  ]);
  const store = new SpyStore();
  const { host, router } = await activeHost(adapter, [toolPlugin("vn.test.press", [pressTool()])]);
  try {
    await new DefaultAgentLoop(router, store, {}).runTurn({ sessionId: "attempts", content: "xóa", security: security() });
    const results = (await store.load("attempts", security())).filter((event) => event.type === "tool/result").map((event) => event.payload as { note?: string; attempt?: { signature: string; failure?: string; failures: number } });
    assert.deepEqual(results.map((r) => r.attempt?.failures), [1, 2, 0], "one target despite changed revision and page size; a success clears it");
    assert.deepEqual(results.map((r) => r.attempt?.failure ?? null), ["target-covered", "target-covered", null]);
    assert.equal(new Set(results.map((r) => r.attempt?.signature)).size, 1);
    assert.equal(results[0]!.note, undefined, "one failure is just a result");
    assert.match(results[1]!.note ?? "", /failed twice \(target-covered\).*do what the refusal says to fix/u);
    assert.doesNotMatch(results[1]!.note ?? "", /another (control|path|tool)/u, "never steers away from the tool the procedure names (P6-14)");
    const seen = requests[2]!.messages.map((message) => message.content ?? "").join("\n");
    assert.match(seen, /failed twice/u, "the model reads the reminder in the next step");
  } finally { await host.shutdown(); }
});

test("the reminders escalate at the second, third and fifth failure, and any tool's error counts", () => {
  const ledger = new ToolAttemptLedger();
  const press = { id: "c", name: "ui_press", arguments: JSON.stringify({ label: "Lưu", expectedContextRevision: "ui.9" }) };
  const read = { id: "r", name: "read_table", arguments: JSON.stringify({ documentId: "d1", headerRow: 14 }) };
  const stale = { state: "succeeded", result: { status: "stale", reasonCode: "unknown-ref" } };
  const notes = [1, 2, 3, 4, 5].map(() => ledger.record(press, stale).note ?? "");
  assert.deepEqual(notes.map((note) => note.split(":")[0]), ["", "Runtime check", "Runtime check", "", "Runtime check"]);
  assert.match(notes[4]!, /5 failures on this call \(unknown-ref\); stop retrying it unchanged/u);
  const failedRead = ledger.record(read, { state: "succeeded", result: { type: "tool_error", code: "header_not_matched" } });
  assert.deepEqual([failedRead.attempt.failure, failedRead.attempt.failures], ["header_not_matched", 1]);
  const thrown = ledger.record(read, { state: "failed", error: { code: "permanent" } });
  assert.match(thrown.note ?? "", /failed twice \(permanent\)/u, "headerRow 14 then 6 is the same read: numbers are not the target");
});
