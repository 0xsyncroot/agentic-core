import assert from "node:assert/strict";
import test from "node:test";
import type { JudgmentAnswer, SessionEvent, ToolNextCallReads } from "@0xsyncroot/contracts";
import { nextCallAsks, nextCallContext, nextCallRuns, type NextCallAsk } from "../src/agent/next-call-questions.js";

/** The five questions' states come from the journal and the tool's `reads` alone, and the read runs only when all clear. */
const input = (content: string, attachments?: readonly { id: string; name: string }[]): SessionEvent => ({
  type: "user/input", payload: { content, ...(attachments ? { attachments: attachments.map((file) => ({ ...file, mediaType: "text/csv", byteSize: 10 })) } : {}) },
} as unknown as SessionEvent);
const READS: ToolNextCallReads = { source: { id: "d1", name: "book.xlsx" }, unit: "sheet", catalog: [{ name: "A", rows: 3 }, { name: "B" }], target: "A", shown: { rows: 1, of: 3 } };
const answers = (...values: (number | undefined)[]): (JudgmentAnswer | undefined)[] => values.map((noul) => noul === undefined ? undefined : { type: "noul", noul });

test("the context reads the last three requests, oldest first, and every attached file once", () => {
  const events = [input("first", [{ id: "f1", name: "one.xlsx" }]), { type: "tool/result", payload: {} } as unknown as SessionEvent,
    input("second"), input("third", [{ id: "f2", name: "two.xlsx" }, { id: "f1", name: "one.xlsx" }]), input("fourth")];
  const context = nextCallContext(events, { screen: "the screen" });
  assert.equal(context.request, "second\nthird\nfourth");
  assert.deepEqual(context.messages, ["second", "third", "fourth"]);
  assert.deepEqual(context.attachments, [{ id: "f1", name: "one.xlsx" }, { id: "f2", name: "two.xlsx" }], "the file of a request no longer among the last three still counts");
  const long = nextCallContext([input("x".repeat(1_500)), input("y".repeat(1_500))], {});
  assert.equal(long.request.length, 2_000);
  assert.ok(long.request.endsWith("y".repeat(1_500)), "the latest characters are kept");
});

test("the states carry only what each question reads, with keys and wording in the source's own word for a part", () => {
  const context = nextCallContext([input("check page two", [{ id: "d1", name: "book.pdf" }])], { attachedFiles: "a product cannot rename the files", screen: "the screen" });
  const asks = nextCallAsks({ ...READS, unit: "page", catalog: [{ name: "one" }, { name: "two", heading: "Totals" }], target: "two" }, { text: "x" }, context);
  const byId = new Map(asks.map((ask) => [ask.id, ask]));
  assert.deepEqual([...byId.keys()], ["needsFile", "fileIsTarget", "pageIsTarget", "previewEnough", "userStopped"]);
  assert.deepEqual(byId.get("needsFile")!.state, { request: "check page two", sources: { attachedFiles: [{ id: "d1", name: "book.pdf" }], screen: "the screen" } });
  assert.deepEqual(byId.get("fileIsTarget")!.state, { request: "check page two", attachments: [{ id: "d1", name: "book.pdf" }], target: { id: "d1", name: "book.xlsx", pages: ["one", "two"] } });
  assert.deepEqual(byId.get("pageIsTarget")!.state, { request: "check page two", source: { name: "book.xlsx", pages: [{ name: "one" }, { name: "two", heading: "Totals" }] }, target: { page: "two" } });
  const part = byId.get("pageIsTarget")!.question as { instructions: string; criteria: Record<string, string> };
  assert.equal(part.instructions, "Of the pages in `source.pages`, is `target.page` the page the task in `request` asks to read?");
  assert.ok(![part.instructions, part.criteria.true, part.criteria.false].some((text) => text.includes("sheet")));
  assert.deepEqual(byId.get("userStopped")!.state, { messages: ["check page two"] });
  assert.deepEqual(asks.map((ask) => ask.wanted), [true, true, true, false, false]);
  const sheet = nextCallAsks(READS, null, context).find((ask) => ask.id === "sheetIsTarget")!.question as { instructions: string };
  assert.equal(sheet.instructions, "Of the sheets in `source.sheets`, is `target.sheet` the sheet the task in `request` asks to read?");
});

test("the result that named the call is read whole up to 6,000 characters of JSON, else as that much of its JSON", () => {
  const context = nextCallContext([input("total")], {});
  const readSoFar = (result: Parameters<typeof nextCallAsks>[1]) =>
    (nextCallAsks(READS, result, context).find((ask) => ask.id === "previewEnough")!.state as { readSoFar: { result: unknown; shown?: unknown } }).readSoFar;
  const small = { rows: [[1, 2]], totalRows: 3 };
  assert.deepEqual(readSoFar(small), { result: small, shown: { rows: 1, of: 3 } });
  const large = { rows: Array.from({ length: 2_000 }, (_, index) => [index]) };
  assert.equal(readSoFar(large).result, JSON.stringify(large).slice(0, 6_000));
  const { shown: _, ...unshown } = READS;
  assert.deepEqual((nextCallAsks(unshown, small, context)[3]!.state as { readSoFar: unknown }).readSoFar, { result: small }, "no shown, none invented");
});

test("the read runs only when every question is answered and clears: at least 0.9 for what it needs, at most 0.1 for what makes it needless", () => {
  const asks = nextCallAsks(READS, null, nextCallContext([input("total")], {})) as NextCallAsk[];
  assert.equal(nextCallRuns(asks, answers(0.9, 0.95, 0.99, 0.1, 0)), true);
  assert.equal(nextCallRuns(asks, answers(0.89, 0.95, 0.99, 0.1, 0)), false, "needs a file: not sure enough");
  assert.equal(nextCallRuns(asks, answers(0.9, 0.95, 0.99, 0.11, 0)), false, "the preview may already be enough");
  assert.equal(nextCallRuns(asks, answers(0.9, 0.95, 0.99, 0.1, 0.5)), false, "the user may have stopped");
  assert.equal(nextCallRuns(asks, answers(0.9, 0.95, undefined, 0.1, 0)), false, "a missing answer");
  assert.equal(nextCallRuns(asks, [...answers(0.9, 0.95, 0.99, 0.1), { type: "choice", choice: "x", probabilities: { x: 1 }, confidence: 1 }]), false, "an answer of another type");
  assert.equal(nextCallRuns(asks, answers(0.9, 0.95, 0.99, 0.1)), false, "fewer answers than questions");
  assert.equal(nextCallRuns([], []), false, "nothing asked is nothing cleared");
});
