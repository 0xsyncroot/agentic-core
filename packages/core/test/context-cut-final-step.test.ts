import assert from "node:assert/strict";
import { test } from "node:test";
import { createEchoToolPlugin } from "@0xsyncroot/adapter-echo";
import type { ChatMessage, JsonValue, TurnControlPolicy, TurnControlState } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { ContextWindowPolicy } from "../src/agent/context-window-policy.js";
import { modelContextSize } from "../src/agent/llm-model-context.js";
import { scalarsFirst, toolResultContent } from "../src/agent/tool-result-bounds.js";
import { SpyStore, activeHost, answer, call, scriptedModel, security } from "./turn-harness.js";

/**
 * A message the context budget cannot hold keeps both ends. What says a result is partial — a
 * cursor, a done flag — is as likely to be written last as first, and a cut that kept only the
 * head took them: a 24 KiB spreadsheet page reached the model without its cursor.
 */

const request: ChatMessage = { role: "user", content: "đọc bảng lương" };
const read = (id: string, content: string): ChatMessage[] => [
  { role: "assistant", content: null, toolCalls: [{ id, name: "read", arguments: "{}" }] },
  { role: "tool", toolCallId: id, content },
];

test("a tool result over the budget keeps its start and its end, names the cut, and fits the serialized size", () => {
  const body = `HEAD-${"x".repeat(9_000)}-TAIL`;
  const window = new ContextWindowPolicy(3_000).apply([{ role: "system", content: "rules" }, request, ...read("c1", body)]);
  assert.ok(modelContextSize(window.messages) <= 3_000);
  const shown = window.messages.find((message) => message.role === "tool")!.content as string;
  assert.ok(shown.startsWith("HEAD-"), "the start is kept");
  assert.ok(shown.endsWith("-TAIL"), "the end is kept");
  assert.match(shown, /\[… \d+ characters cut to fit the context budget; the start and end are shown\. If the cut part is needed, call the tool again for a smaller part\.\]/u);
  const cut = Number(/(\d+) characters cut/u.exec(shown)![1]);
  const marker = shown.slice(shown.indexOf("\n[…"), shown.lastIndexOf("]\n") + 2);
  assert.equal(shown.length - marker.length, body.length - cut, "the cut count is the number of characters missing");
  assert.ok(shown.length < body.length);
});

test("the cut is fitted against the serialized size: quotes cost two", () => {
  const body = `{"a":"HEAD"${`,"k":"v"`.repeat(2_000)},"done":false,"cursor":"TAIL"}`;
  for (const limit of [1_500, 2_345, 4_000]) {
    const window = new ContextWindowPolicy(limit).apply([request, ...read("c1", body)]);
    assert.ok(modelContextSize(window.messages) <= limit, `limit ${limit}: ${modelContextSize(window.messages)}`);
    const shown = window.messages.find((message) => message.role === "tool")!.content as string;
    assert.ok(shown.endsWith(`"done":false,"cursor":"TAIL"}`.slice(-Math.min(60, shown.length))));
    assert.ok(shown.startsWith(`{"a":"HEAD"`));
  }
});

test("a required message is never cut, and a message that is not a tool result is not told to call a tool", () => {
  const required: ChatMessage = { role: "system", content: `${"r".repeat(800)}END`, context: { trust: "instruction", retention: "required", provenance: "test" } };
  const kept = new ContextWindowPolicy(1_500).apply([required, request, ...read("c1", "z".repeat(5_000))]);
  assert.equal(kept.messages.find((message) => message.context?.retention === "required")?.content, required.content);
  const pasted = new ContextWindowPolicy(2_000).apply([{ role: "system", content: "rules" }, { role: "user", content: `START-${"d".repeat(6_000)}-END` }]);
  const text = pasted.messages.find((message) => message.role === "user")!.content as string;
  assert.ok(text.startsWith("START-") && text.endsWith("-END"));
  assert.match(text, /characters cut to fit the context budget; the start and end are shown\.\]/u);
  assert.ok(!text.includes("call the tool again"));
  assert.ok(modelContextSize(pasted.messages) <= 2_000);
});

test("a limit too small for the marker falls back to the short suffix", () => {
  const window = new ContextWindowPolicy(130).apply([{ role: "user", content: "u".repeat(3_000) }]);
  const text = window.messages[0]!.content as string;
  assert.ok(text.endsWith("[content truncated by context budget]"));
  assert.ok(modelContextSize(window.messages) <= 130);
});

test("the cut never splits a surrogate pair", () => {
  const body = "😀".repeat(3_000);
  for (const limit of [1_900, 2_001, 2_222]) {
    const text = new ContextWindowPolicy(limit).apply([request, ...read("c1", body)]).messages.find((message) => message.role === "tool")!.content as string;
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text), `limit ${limit}`);
  }
});

/** What MySQL `json` does to a stored object: members ordered by key length, then by bytes. */
function mysqlSorted(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(mysqlSorted);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, member]) => [key, mysqlSorted(member)] as const));
}

test("a page read back from a key-sorting store still shows done, cursor and offset before its cells", () => {
  const cells = Array.from({ length: 700 }, (_, index) => ({ row: index, column: 20, value: 1_000_000 + index, text: "ô" }));
  const page: JsonValue = {
    sheetName: "PT CTX", area: "A3:AD84", offset: 0, scanned: 700, totalCells: 4_860, done: false, cursor: "cur-0123456789abcdef",
    columnPathsTruncated: false, range: { row: 3, rowCount: 81, column: 1, columnCount: 30 },
    columns: [{ column: 1, header: "Mã" }], columnPaths: [{ column: 7, path: "A" }], cells,
  };
  const stored = mysqlSorted(JSON.parse(JSON.stringify(page)) as JsonValue);
  const before = JSON.stringify(stored);
  assert.ok(before.indexOf('"cells"') < before.indexOf('"cursor"'), "the sorted store really does put cells first (precondition)");
  const shown = toolResultContent({ result: stored });
  assert.ok(shown.length > 20_000);
  for (const key of ["done", "cursor", "offset", "scanned", "totalCells"]) assert.ok(shown.indexOf(`"${key}"`) < 2_048, `${key} within the first 2 KB`);
  assert.ok(shown.indexOf('"cursor"') < shown.indexOf('"cells"') && shown.indexOf('"range"') < shown.indexOf('"columns"'));
  assert.ok(shown.indexOf('"columnPaths"') < shown.indexOf('"cells"'), "the largest list is last");
  assert.deepEqual(JSON.parse(shown), JSON.parse(before), "same value, only the order changes");
});

test("scalarsFirst orders members recursively and leaves arrays' own order alone", () => {
  const value: JsonValue = { z: [3, 1, 2], b: { y: [1], x: 1, w: { v: 1 } }, a: "s", big: [1, 2, 3, 4, 5, 6], n: null, small: [1], t: true };
  assert.deepEqual(Object.keys(scalarsFirst(value) as object), ["a", "n", "t", "b", "small", "z", "big"]);
  const inner = (scalarsFirst(value) as { b: object }).b;
  assert.deepEqual(Object.keys(inner), ["x", "w", "y"]);
  assert.deepEqual((scalarsFirst(value) as { z: number[] }).z, [3, 1, 2]);
  assert.equal(scalarsFirst("text"), "text");
  assert.equal(scalarsFirst(null), null);
});

/** A policy that records the state of every terminal review. */
function recordingPolicy(states: TurnControlState[]): TurnControlPolicy {
  return { id: "test.final", revision: "v1", beforeModelStep: async () => ({}), reviewTerminal: async (state) => { states.push(state); return { decision: "accept" }; } };
}

for (const [name, options, replies, reason] of [
  // The tool ceiling is one number, whether or not the work still moves: eight configured, eight run.
  ["the tool budget", { maxSteps: 48, maxToolCalls: 8 }, [..."abcdefgh"].map((value, index) => call(`c${index}`, "agentic_echo", { value })).concat(answer("eight read")), "tool-call-limit"],
  ["the step ceiling", { maxSteps: 3 }, [call("c1", "agentic_echo", { value: "a" }), call("c2", "agentic_echo", { value: "b" }), answer("two read")], "step-limit"],
] as const) {
  test(`the review of a step that ran without tools because of ${name} carries finalStep with the stop cause`, async () => {
    const states: TurnControlState[] = [];
    const { adapter, requests } = scriptedModel(replies);
    const { host, router } = await activeHost(adapter, [createEchoToolPlugin()]);
    try {
      const result = await new DefaultAgentLoop(router, new SpyStore(), options, { turnControlPolicy: recordingPolicy(states) })
        .runTurn({ sessionId: `final-${reason}`, content: "read", security: security() });
      assert.equal(result.outcome, "partial");
      assert.equal(states.length, 1);
      assert.deepEqual(states[0]!.finalStep, { reason });
      const last = requests.at(-1)!;
      assert.equal(last.tools.length, 0);
      assert.ok(last.messages.some((message) => message.content?.includes(`Runtime stop cause: ${reason}.`)), "the instruction states the same cause");
      assert.equal((result.events.at(-1)!.payload as Record<string, unknown>).reason, reason);
    } finally { await host.shutdown(); }
  });
}

test("a step that had its tools has no finalStep", async () => {
  const states: TurnControlState[] = [];
  const { adapter } = scriptedModel([call("c1", "agentic_echo", { value: "a" }), answer("done")]);
  const { host, router } = await activeHost(adapter, [createEchoToolPlugin()]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { turnControlPolicy: recordingPolicy(states) })
      .runTurn({ sessionId: "not-final", content: "read", security: security() });
    assert.equal(result.outcome, "completed");
    assert.equal(states.length, 1);
    assert.equal("finalStep" in states[0]!, false);
  } finally { await host.shutdown(); }
});
