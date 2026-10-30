import assert from "node:assert/strict";
import test from "node:test";
import { compilePersonalFields, SessionMasker, type PersonalFieldConfig } from "../src/masking/index.js";

const COLUMNS = { "stt": "sequence", "tt": "sequence", "full name": "person-name", "account": "identifier", "amount": "money", "coefficient": "coefficient" } as const;
const CONFIG: PersonalFieldConfig = {
  labels: { "person-name": "Name", money: "Amount", identifier: "Code", coefficient: "Rate" },
  money: { atLeast: 10000 },
  names: { honorifics: [], minWords: 2 },
  tools: {
    grid: { tables: [{ rows: "preview.rows", columns: COLUMNS, numbers: "money" }] },
    keyed: { tables: [{ rows: "rows", columns: COLUMNS, numbers: "money" }] },
    screen: {
      tables: [{
        cells: "**.nodes", cell: { address: "label", addressPattern: "^Cell ([A-Z]+[0-9]+) ·", value: "value" },
        numberFormat: { group: ".", decimal: "," }, columns: COLUMNS, numbers: "money",
      }],
    },
  },
};

function masker(results: ReadonlyArray<[string, unknown]>): SessionMasker {
  const value = new SessionMasker(compilePersonalFields(CONFIG));
  for (const [toolId, result] of results) value.collect(toolId, result);
  return value;
}

test("positional rows take headings from a row above and keep only rows numbered in the sequence column", () => {
  const m = masker([["grid", { preview: { rows: [
    ["Payment list for October"],
    ["STT", "Full name", "Bank", null, "Amount"],
    [null, null, "Account", "Bank name"],
    [null, "Grand total", null, null, 47_211_000],
    ["I", "Civil servants", null, null, 47_211_000],
    [1, "Nhân Viên Mẫu A", "0000000001", "Bank A", 22_033_500],
    [2, "Nhân Viên Mẫu C", "0000000002", "Bank A", 25_177_500],
  ] } }]]);
  const out = m.mask("Nhân Viên Mẫu A 22.033.500 acct 0000000001; Nhân Viên Mẫu C; Grand total 47.211.000 of Civil servants at Bank A");
  assert.equal(out.text, "[Name 1] [Amount 1] acct [Code 1]; [Name 2]; Grand total 47.211.000 of Civil servants at Bank A");
});

test("header-keyed rows skip heading rows when the table has a sequence column, and keep every row when it has none", () => {
  const numbered = masker([["keyed", { rows: [
    { TT: "A", "Full name": "Permanent staff" }, { TT: 1, "Full name": "Nhân Viên Mẫu B", Amount: 9_569_274 }, { "Full name": "Total sum", Amount: 9_569_274 },
  ] }]]);
  assert.equal(numbered.mask("Nhân Viên Mẫu B 9.569.274, Permanent staff, Total sum").text, "[Name 1] [Amount 1], Permanent staff, Total sum");
  const unnumbered = masker([["keyed", { rows: [{ "Full name": "Nhân Viên Mẫu D", Amount: 9_508_816 }] }]]);
  assert.equal(unnumbered.mask("Nhân Viên Mẫu D 9.508.816").text, "[Name 1] [Amount 1]");
});

test("a screen cell takes its address from a pattern over its label and its number from the configured separators", () => {
  const m = masker([["screen", { data: { observation: { nodes: [
    { role: "cell", label: "Cell A1 · STT", value: "STT" }, { role: "cell", label: "Cell B1 · Full name (*)", value: "Full name (*)" },
    { role: "cell", label: "Cell Y2 · Amount", value: "Amount" },
    { role: "cell", label: "Cell A4 · 1", value: "1" }, { role: "cell", label: "Cell B4 · Bùi Thị Quyên", value: "Bùi Thị Quyên" },
    { role: "cell", label: "Cell J4 · 22,0", value: "22,0" }, { role: "cell", label: "Cell Y4 · 12.700.600", value: "12.700.600" },
    { role: "cell", label: "Cell AH4 · 1.333.563,5", value: "1.333.563,5" },
    { role: "cell", label: "Cell B5 · Grand total", value: "Grand total" }, { role: "cell", label: "Cell Y5 · 99.000.000", value: "99.000.000" },
    { role: "button", label: "Save", value: "Lý Công Uẩn" },
  ] } } }]]);
  assert.equal(m.mask("Bùi Thị Quyên 12.700.600 and 1.333.563,5 over 22 days; Grand total 99.000.000; Lý Công Uẩn").text,
    "[Name 1] [Amount 1] and [Amount 2] over 22 days; Grand total 99.000.000; Lý Công Uẩn");
});

test("an address pattern without one group, or separators that are equal, are refused when the config is compiled", () => {
  const screen = (CONFIG.tools.screen?.tables ?? [])[0];
  if (!screen) throw new Error("fixture");
  const bad = (rule: typeof screen) => () => compilePersonalFields({ ...CONFIG, tools: { t: { tables: [rule] } } });
  assert.throws(bad({ ...screen, cell: { ...screen.cell, value: "value", addressPattern: "^Cell [A-Z]+[0-9]+" } }), /group/u);
  assert.throws(bad({ ...screen, cell: { ...screen.cell, value: "value", addressPattern: "(" } }), /invalid addressPattern/u);
  assert.throws(bad({ ...screen, numberFormat: { group: ",", decimal: "," } }), /separator/u);
});

test("a tool key ending in * marks every tool id it starts, and an exact tool key wins over it", () => {
  const fields = compilePersonalFields({ ...CONFIG, tools: {
    "screen_*": { paths: { "data.who": "person-name" } },
    "screen_list_*": { paths: { "data.code": "identifier" } },
    screen_read: { paths: { "data.amount": "money" } },
  } });
  const m = new SessionMasker(fields);
  m.collect("screen_open", { data: { who: "Trần Văn Hùng", code: "CB0042" } });
  m.collect("screen_list_staff", { data: { who: "Phạm Thị Lan", code: "CB0043" } });
  m.collect("screen_read", { data: { who: "Đỗ Minh Khôi", amount: 15_000_000 } });
  m.collect("screenshot", { data: { who: "Vũ Thị Mai" } });
  assert.equal(m.mask("Trần Văn Hùng CB0042 / Phạm Thị Lan CB0043 / Đỗ Minh Khôi 15.000.000 / Vũ Thị Mai").text,
    "[Name 1] CB0042 / Phạm Thị Lan [Code 1] / Đỗ Minh Khôi [Amount 1] / Vũ Thị Mai");
  assert.throws(() => compilePersonalFields({ ...CONFIG, tools: { "*": { paths: {} } } }), /prefix/u);
});

test("a coefficient column is read as numbers in the table's format and masks below the money minimum", () => {
  const m = masker([["screen", { nodes: [
    { label: "Cell A1 · heading", value: "STT" }, { label: "Cell B1 · heading", value: "Coefficient" },
    { label: "Cell A2 · data", value: "1" }, { label: "Cell B2 · data", value: "4,98" },
  ] }]]);
  assert.equal(m.mask("coefficient 4,98 or 4.98, not 4,99").text, "coefficient [Rate 1] or [Rate 1], not 4,99");
});
