import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue, ToolInvocation } from "@0xsyncroot/contracts";
import { InMemoryToolResultSpool } from "@0xsyncroot/core";
import { createCalculationTool } from "../src/index.js";

const scope = { tenantId: "t1", sessionId: "s1" };
const invocation = (args: Record<string, unknown>, sessionId = "s1"): ToolInvocation =>
  ({ arguments: args, security: { tenantId: "t1" }, sessionId } as unknown as ToolInvocation);

/** Two sources as their readers keep them: a file table and a spreadsheet page, with one repeated name. */
function sources() {
  const spool = new InMemoryToolResultSpool();
  const file = spool.put(scope, { toolId: "read_table", value: { rows: [
    ["Nguyễn Thị Mẫu", 9_448_400], ["Nguyễn  thị mẫu", 9_448_400], ["Nhân Viên Mẫu A", 22_033_500], ["Nhân Viên Mẫu B", 0],
  ] } as JsonValue });
  const screen = spool.put(scope, { toolId: "read_spreadsheet", value: { data: { rows: [
    { name: "Nguyen Thi Mau", net: 9_448_358 }, { name: "Nguyễn Thị Mẫu", net: 9_448_401 }, { name: "Nhân Viên Mẫu A", net: 22_033_527 }, { name: "Nhân Viên Mẫu B", net: 9_569_275 },
  ] } } as JsonValue });
  return { spool, file, screen };
}

test("matches rows by folded name with repeats kept apart and returns exact differences, unrounded", async () => {
  const { spool, file, screen } = sources();
  const tool = createCalculationTool(spool);
  const result = await tool.execute(invocation({
    inputs: { file: { resultId: file, path: "rows" }, screen: { resultId: screen, path: "data.rows" } },
    code: `
      const f = keys(inputs.file, (r) => fold(r[0])), s = keys(inputs.screen, (r) => fold(r.name));
      const byKey = new Map(inputs.file.map((r, i) => [f[i], r[1]]));
      const rows = inputs.screen.map((r, i) => ({ key: s[i], diff: r.net - byKey.get(s[i]) }));
      return { rows, total: sum(rows.map((r) => r.diff)) };`,
  })) as { value: { rows: { key: string; diff: number }[]; total: number }; inputs: unknown[] };
  assert.deepEqual(result.value.rows, [
    { key: "nguyenthimau", diff: -42 }, { key: "nguyenthimau#2", diff: 1 },
    { key: "nhanvienmaua", diff: 27 }, { key: "nhanvienmaub", diff: 9_569_275 },
  ]);
  assert.equal(result.value.total, 9_569_261);
  assert.equal(result.inputs.length, 2, "the inputs are recorded with the result, as its evidence");
});

test("numbers come back at Excel's 15 significant digits: binary noise goes, a real fraction stays", async () => {
  const { spool } = sources();
  const tool = createCalculationTool(spool);
  const result = await tool.execute(invocation({ code: "return [2530000 * 5.02, 0.1 + 0.2, 20515371.525, 9448358.5, exact(12700599.999999998)];" })) as { value: number[] };
  assert.deepEqual(result.value, [12_700_600, 0.3, 20_515_371.525, 9_448_358.5, 12_700_600]);
  const spoolWithNoise = new InMemoryToolResultSpool();
  const id = spoolWithNoise.put(scope, { toolId: "read_table", value: { rows: [12700599.999999998, 1265000] } as JsonValue });
  const summed = await createCalculationTool(spoolWithNoise).execute(invocation({ inputs: { t: { resultId: id, path: "rows" } }, code: "return sum(inputs.t);" })) as { value: number };
  assert.equal(summed.value, 13_965_600, "a stored 12700599.999999998 is read as the 12700600 the sheet shows");
});

test("the code reaches nothing outside its inputs", async () => {
  const { spool } = sources();
  const tool = createCalculationTool(spool);
  const result = await tool.execute(invocation({ inputs: {}, code: "return [typeof process, typeof require, typeof fetch, typeof globalThis.__dirname];" })) as { value: string[] };
  assert.deepEqual(result.value, ["undefined", "undefined", "undefined", "undefined"]);
});

test("a failing, endless or silent calculation is refused with what to fix, and states no figure", async () => {
  const { spool } = sources();
  const tool = createCalculationTool(spool, { timeoutMs: 300, memoryBytes: 32 * 1024 * 1024, maxOutputChars: 200 });
  await assert.rejects(tool.execute(invocation({ inputs: {}, code: "return inputs.missing.rows.length;" })), /did not run to the end — TypeError.*state no figure/u);
  await assert.rejects(tool.execute(invocation({ inputs: {}, code: "while (true) {}" })), /longer than 300 ms/u);
  await assert.rejects(tool.execute(invocation({ inputs: {}, code: "const x = 1;" })), /returned nothing/u);
  await assert.rejects(tool.execute(invocation({ inputs: {}, code: "return 'x'.repeat(500);" })), /at most 200/u);
});

test("a failed calculation names each input's shape as the code read it: the whole stored result, structuredContent included", async () => {
  const spool = new InMemoryToolResultSpool();
  const doc = spool.put(scope, { toolId: "read_doc", value: { content: [{ type: "text", text: "cut" }], structuredContent: { preview: { rows: [1, 2] } } } as JsonValue });
  const tool = createCalculationTool(spool);
  await assert.rejects(tool.execute(invocation({ inputs: { doc: { resultId: doc }, rows: { resultId: doc, path: "structuredContent.preview.rows" } }, code: "return inputs.doc.preview.rows.length;" })),
    /did not run to the end — TypeError.*state no figure from this attempt\. inputs\.doc is object \{content: array of 1, structuredContent: object\}; inputs\.rows is array of 2\.$/u);
  await assert.rejects(tool.execute(invocation({ inputs: { doc: { resultId: doc, path: "preview.rows" } }, code: "return 1;" })),
    /no value at "preview\.rows".*The stored result is object \{content: array of 1, structuredContent: object\}\.$/u);
  assert.match(tool.description, /whole tool result as stored, structuredContent included/u);
});

test("an input from another session, or no longer stored, is refused by name", async () => {
  const { spool, file } = sources();
  const tool = createCalculationTool(spool);
  await assert.rejects(tool.execute(invocation({ inputs: { file: { resultId: file } }, code: "return 1;" }, "s2")), /Input "file".*not stored/u);
  await assert.rejects(tool.execute(invocation({ inputs: { file: { resultId: file, path: "nope" } }, code: "return 1;" })), /no value at "nope"/u);
  await assert.rejects(tool.execute(invocation({ inputs: { "bad-name": { resultId: file } }, code: "return 1;" })), /JavaScript identifier/u);
});

test("table helpers: pages of cells become rows, columns are found by header path, two lists are matched", async () => {
  const spool = new InMemoryToolResultSpool();
  const paths = [{ column: 0, path: ["STT"] }, { column: 1, path: ["Họ và tên (*)"] }, { column: 34, path: ["Lương", "Thực lĩnh"] }, { column: 231, path: ["Thực lĩnh"] }];
  const page1 = spool.put(scope, { toolId: "read_spreadsheet", value: { data: { columnPaths: paths, cells: [
    { row: 3, column: 0, value: 1 }, { row: 3, column: 1, value: "Nguyễn Thị Mẫu Ba" }, { row: 3, column: 231, value: 24_485_504 },
    { row: 4, column: 0, value: 2 }, { row: 4, column: 1, value: "Nguyễn Thị Mẫu" }, { row: 4, column: 231, value: 9_448_358 },
  ] } } as JsonValue });
  const page2 = spool.put(scope, { toolId: "read_spreadsheet", value: { data: { cells: [
    { row: 5, column: 0, value: 3 }, { row: 5, column: 1, value: "Nguyễn Thị Mẫu" }, { row: 5, column: 231, value: 9_448_401 },
  ] } } as JsonValue });
  const file = spool.put(scope, { toolId: "read_table", value: { rows: [
    { TT: "A", "Họ và tên": "Biên chế" }, { TT: 6, "Họ và tên": "NguyễnThị Mẫu Ba", "Tổng lĩnh": 23_655_500 },
    { TT: 25, "Họ và tên": "Nguyễn Thị Mẫu", "Tổng lĩnh": 9_448_400 }, { TT: 26, "Họ và tên": "Nguyễn Thị  Mẫu", "Tổng lĩnh": 9_448_400 },
    { TT: "B", "Họ và tên": "Hợp đồng bảo vệ" }, { TT: 1, "Họ và tên": "Lê Thị Lý", "Tổng lĩnh": 4_752_450 },
  ] } as JsonValue });
  const tool = createCalculationTool(spool);
  const result = await tool.execute(invocation({
    inputs: { p1: { resultId: page1, path: "data" }, p2: { resultId: page2, path: "data" }, f: { resultId: file, path: "rows" } },
    code: `
      const net = columnOf(inputs.p1.columnPaths, "Thực lĩnh");
      const pm = rowsOf([...inputs.p1.cells, ...inputs.p2.cells]).filter((r) => typeof r.values[0] === "number").map((r) => ({ name: r.values[1], net: r.values[net] }));
      let block = "";
      const file = inputs.f.filter((r) => { if (typeof r.TT === "string" && /^[A-Z]$/.test(r.TT)) { block = r.TT; return false; } return block === "A"; });
      const m = match(pm, file, (r) => r.name, (r) => r["Họ và tên"]);
      return { net, pairs: m.pairs.map((p) => [p.key, p.left.net - p.right["Tổng lĩnh"]]), onlyLeft: m.onlyLeft.length, onlyRight: m.onlyRight.length };`,
  })) as { value: { net: number; pairs: [string, number][]; onlyLeft: number; onlyRight: number } };
  assert.equal(result.value.net, 231, "\"Thực lĩnh\" alone is the column whose path ends with it — not \"Lương > Thực lĩnh\"");
  assert.deepEqual(result.value.pairs, [["nguyenthimauba", 830_004], ["nguyenthimau", -42], ["nguyenthimau#2", 1]]);
  assert.equal(result.value.onlyLeft + result.value.onlyRight, 0, "block B is out of scope and the joined name still matches");
  await assert.rejects(tool.execute(invocation({ inputs: { p1: { resultId: page1, path: "data" } }, code: `return columnOf(inputs.p1.columnPaths, "Tổng");` })),
    /columnOf\(Tổng\): 0 columns match/u);
});

test("an input is also readable by its own name, unless the name would shadow something", async () => {
  // Models write `gateway.data.cells` for an input named gateway; that spelling must not fail as "'gateway' is not defined".
  const { spool, screen } = sources();
  const tool = createCalculationTool(spool);
  const named = await tool.execute(invocation({ inputs: { gateway: { resultId: screen, path: "data.rows" } }, code: "return gateway.length + inputs.gateway.length;" })) as { value: number };
  assert.equal(named.value, 8);
  const shadowing = await tool.execute(invocation({ inputs: { sum: { resultId: screen, path: "data.rows" } }, code: "return typeof sum;" })) as { value: string };
  assert.equal(shadowing.value, "function", "the prelude's helper keeps its name; the input stays at inputs.sum");
});

test("an input read through a product's view is the value that view returns; an unknown view is refused by name", async () => {
  // Code must not depend on how a source was stored: a product offers one shape for any source.
  const { spool, screen } = sources();
  const views = { table: { describe: "the table as rows.", read: () => ({ rows: [{ row: 1, cells: { A: 2 } }, { row: 2, cells: { A: 3 } }] }) as JsonValue } };
  const tool = createCalculationTool(spool, undefined, { views });
  assert.match(tool.description, /With view "table" an input is the table as rows\./u);
  const out = await tool.execute(invocation({ inputs: { t: { resultId: screen, view: "table" } }, code: "return sum(inputs.t.rows.map(r => r.cells.A));" })) as { value: number; inputs: { view?: string }[] };
  assert.deepEqual([out.value, out.inputs[0]!.view], [5, "table"]);
  await assert.rejects(tool.execute(invocation({ inputs: { t: { resultId: screen, view: "grid" } }, code: "return 1;" })), /no view "grid"; views: table/u);
  assert.ok(!JSON.stringify(createCalculationTool(spool).inputSchema).includes("view"), "without views the schema is unchanged");
});
