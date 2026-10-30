import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "@0xsyncroot/contracts";
import { boundToolResult } from "../src/agent/tool-result-bounds.js";

test("a list whose head is longer than its average is cut once, to as many entries as fit", () => {
  // A sheet read row by row: long texts in the first rows, short figures after. Cut by the average entry, the head kept
  // was several times the budget and needed round after round; a fourth was not always enough, and the result was refused.
  const cells = [
    ...Array.from({ length: 100 }, (_, i) => ({ row: 0, column: i, text: "Phụ cấp thâm niên vượt khung ".repeat(160) })),
    ...Array.from({ length: 9_900 }, (_, i) => ({ row: 1 + Math.floor(i / 100), column: i % 100, value: i })),
  ];
  const value = { status: "succeeded", data: { done: true, cells } } as unknown as JsonValue;
  const bounded = boundToolResult(value, 49_152);
  const size = JSON.stringify(bounded.value).length;
  assert.ok(size <= 49_152, `bounded to ${size}`);
  assert.equal(bounded.marks.length, 1, JSON.stringify(bounded.marks));
  const shown = bounded.marks[0]!.shown;
  const oneMore = { status: "succeeded", data: { done: true, cells: cells.slice(0, shown + 1) } };
  assert.ok(JSON.stringify(oneMore).length > 49_152, "no further entry would have fit");
});

test("a list under a key holding a dot or a bracket is cut where it is", () => {
  const rows = Array.from({ length: 2_000 }, (_, i) => ({ row: i, value: "x".repeat(40) }));
  const value = { sheets: { "P. GVHĐ - BHXH [2]": rows } } as unknown as JsonValue;
  const bounded = boundToolResult(value, 10_000);
  assert.ok(JSON.stringify(bounded.value).length <= 10_000);
  assert.equal(bounded.marks.length, 1);
  assert.deepEqual(Object.keys((bounded.value as { sheets: object }).sheets), ["P. GVHĐ - BHXH [2]"], "no stray key written beside it");
});

test("a cut names the whole list by its content: the same list cut twice has one digest, a changed list another", () => {
  const sheet = (last: number) => ({ data: { cells: Array.from({ length: 2_000 }, (_, i) => ({ row: i, value: i === 1_999 ? last : i })) } }) as unknown as JsonValue;
  const [first, again, changed] = [sheet(1), sheet(1), sheet(2)].map((value) => boundToolResult(value, 10_000).marks[0]!);
  assert.match(first.digest ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(again.digest, first.digest, "a read of the unchanged sheet hid the same entries");
  assert.notEqual(changed.digest, first.digest, "a change past the cut is a different list, though the shown head is the same");
  assert.equal(changed.shown, first.shown);
});
