import assert from "node:assert/strict";
import test from "node:test";
import { compilePersonalFields, SessionMasker, type PersonalFieldConfig } from "../src/masking/index.js";

const CONFIG: PersonalFieldConfig = {
  labels: { "person-name": "Name", money: "Amount", identifier: "Code", coefficient: "Rate" },
  money: { atLeast: 1000, units: [{ word: "million", factor: 1_000_000 }] },
  names: { honorifics: ["mr", "ms"], minWords: 2 },
  tools: {
    profile: { paths: { "**.FullName": "person-name", "**.Money": "money", "**.Code": "identifier", "**.SalaryCoefficient": "coefficient" } },
    sheet: {
      tables: [{
        cells: "data.cells", cell: { row: "row", column: "column", value: "value" },
        headers: { path: "data.columnPaths", key: "column", titles: "path" },
        firstRow: "data.rows.first", lastRow: "data.rows.last",
        columns: { "full name": "person-name", "account": "identifier", "stt": "none" }, numbers: "money",
      }],
    },
    table: { tables: [{ rows: "structuredContent.rows", columns: { "full name": "person-name" }, numbers: "money" }] },
    cells: { tables: [{ cells: "cells", cell: { address: "address", value: "value" }, columns: { "full name": "person-name" }, numbers: "money" }] },
  },
};

function masker(results: ReadonlyArray<[string, unknown]>): SessionMasker {
  const value = new SessionMasker(compilePersonalFields(CONFIG));
  for (const [toolId, result] of results) value.collect(toolId, result);
  return value;
}

test("a money value is masked in its vi-VN, en and plain forms, with or without a currency word", () => {
  const m = masker([["profile", { data: { allowance: [{ Money: 35776748 }] } }]]);
  for (const text of ["35.776.748 đ", "35,776,748 VNĐ", "35776748đ", "(35.776.748)."]) {
    const out = m.mask(text);
    assert.equal(out.text.includes("35"), false, text);
    assert.equal(out.replaced, 1, text);
  }
  assert.equal(m.mask("total 35.776.748 đ").text, "total [Amount 1] đ");
});

test("a whole money value written with zero decimals is masked as one value", () => {
  const m = masker([["profile", { data: { Money: 35776748 } }]]);
  for (const text of ["35.776.748,00", "35,776,748.00", "35776748,00"]) assert.deepEqual(m.mask(`sum ${text} đ`), { text: "sum [Amount 1] đ", replaced: 1 }, text);
});

test("a coefficient from a marked field is masked in its point and comma forms, whatever its size", () => {
  const m = masker([["profile", { data: { SalaryCoefficient: 5.7 } }]]);
  assert.deepEqual(m.mask("Hệ số lương cơ bản: 5.7"), { text: "Hệ số lương cơ bản: [Rate 1]", replaced: 1 });
  for (const text of ["5,7", "5.70", "5,70"]) assert.equal(m.mask(`hệ số ${text}.`).text, "hệ số [Rate 1].", text);
  const small = masker([["profile", { data: { SalaryCoefficient: 0.4401 } }]]);
  assert.equal(small.mask("rate 0,4401").text, "rate [Rate 1]");
});

test("a coefficient's neighbours, a whole coefficient without decimals and an unmarked number stay visible", () => {
  const m = masker([["profile", { data: { SalaryCoefficient: 5.7, Other: 4.98 } }]]);
  for (const text of ["15.7", "5.75", "5,77", "4.98", "5"]) assert.equal(m.mask(text).text, text, text);
  const whole = masker([["profile", { data: { SalaryCoefficient: 4 } }]]);
  assert.equal(whole.mask("tháng 4, hệ số 4,00").text, "tháng 4, hệ số [Rate 1]");
  assert.equal(masker([["profile", { data: { SalaryCoefficient: 0 } }]]).known, 0);
});

test("a number that only contains the value, or continues it, is not masked", () => {
  const m = masker([["profile", { Money: 35776748 }]]);
  for (const text of ["135.776.748", "35.776.7489", "35.776.748,5", "235776748"]) assert.equal(m.mask(text).replaced, 0, text);
});

test("a decimal value is masked as itself and as its truncated and rounded integers", () => {
  const m = masker([["profile", { Money: "22033527.62" }]]);
  for (const text of ["22.033.527,62", "22,033,527.62", "22033527.62", "22.033.527", "22.033.528 đ"]) {
    assert.equal(m.mask(text).replaced, 1, text);
  }
});

test("a scale word form is masked together with the word", () => {
  const m = masker([["profile", { Money: 12_500_000 }]]);
  assert.equal(m.mask("about 12,5 million each").text, "about [Amount 1] each");
  assert.equal(m.mask("about 12.5 million each").text, "about [Amount 1] each");
});

test("money below the configured minimum is not collected", () => {
  assert.equal(masker([["profile", { Money: 500 }]]).mask("500 and 500.0").replaced, 0);
});

test("a full name is masked in any case, and an honorific with the given name keeps the honorific", () => {
  const m = masker([["profile", { employees: [{ FullName: "Nguyễn Mẫu Một" }, { FullName: "Trần Mẫu Hai" }] }]]);
  assert.equal(m.mask("Nguyễn Mẫu Một and NGUYỄN MẪU MỘT").text, "[Name 1] and [Name 1]");
  assert.equal(m.mask("Mr Một asked ms Mẫu Hai").text, "Mr [Name 1] asked ms [Name 2]");
  assert.equal(m.mask("Một alone, Nguyễn Mẫu Mộtg").replaced, 0);
});

test("a given name two people share is one label of its own, apart from either full name", () => {
  const m = masker([["profile", { a: { FullName: "Lê Văn Nam" }, b: { FullName: "Phạm Nam" } }]]);
  const out = m.mask("Mr Nam; Lê Văn Nam; Phạm Nam");
  assert.equal(out.text, "Mr [Name 1]; [Name 2]; [Name 3]");
});

test("a one-word name value is not collected under minWords 2", () => {
  assert.equal(masker([["profile", { FullName: "Huy" }]]).mask("Huy is here").replaced, 0);
});

test("an identifier is masked exactly, not inside a longer code", () => {
  const m = masker([["profile", { Code: "NV001" }]]);
  assert.equal(m.mask("code NV001.").text, "code [Code 1].");
  assert.equal(m.mask("NV0012 and XNV001").replaced, 0);
});

test("labels are stable within the session and numbered by first appearance in the text", () => {
  const m = masker([["profile", { list: [{ FullName: "Đỗ Minh Anh", Money: 2_000_000 }, { FullName: "Vũ Hải Long", Money: 3_000_000 }] }]]);
  assert.equal(m.mask("Vũ Hải Long 3.000.000").text, "[Name 1] [Amount 1]");
  assert.equal(m.mask("Đỗ Minh Anh 2.000.000, Vũ Hải Long 3,000,000").text, "[Name 2] [Amount 2], [Name 1] [Amount 1]");
});

test("values of a tool or field without a mark stay visible", () => {
  const m = masker([["profile", { DepartmentName: "Phòng Kế toán Tổng hợp" }], ["other", { FullName: "Hoàng Văn Bình" }]]);
  assert.equal(m.mask("Phòng Kế toán Tổng hợp; Hoàng Văn Bình").replaced, 0);
});

test("a grid names columns by its headers, keeps to the data rows and masks numeric cells of other columns as money", () => {
  const m = masker([["sheet", { data: {
    columnPaths: [{ column: 0, path: ["STT"] }, { column: 1, path: ["Full name (*)"] }, { column: 2, path: ["Pay", "Amount [I]"] }, { column: 3, path: ["Account"] }],
    rows: { first: 1, last: 2 },
    cells: [
      { row: 0, column: 1, value: "Full name (*)" },
      { row: 1, column: 0, value: "1001" }, { row: 1, column: 1, value: "Bùi Thị Mai" }, { row: 1, column: 2, value: "4500000" }, { row: 1, column: 3, value: "0123456789" },
      { row: 2, column: 0, value: 1002 }, { row: 2, column: 1, value: "Lý Công Uẩn" }, { row: 2, column: 2, value: 5_500_000 },
      { row: 3, column: 1, value: "Grand total" }, { row: 3, column: 2, value: 10_000_000 },
    ],
  } }]]);
  const out = m.mask("Bùi Thị Mai 4.500.000 acct 0123456789; Lý Công Uẩn 5,500,000; Grand total 10.000.000; row 1001");
  assert.equal(out.text, "[Name 1] [Amount 1] acct [Code 1]; [Name 2] [Amount 2]; Grand total 10.000.000; row 1001");
});

test("a table of header-keyed rows names a column by its key, or by a heading cell above in the same column", () => {
  const m = masker([["table", { structuredContent: { rows: [
    { "Full name": "Đinh Bộ Lĩnh", Pay: 7_000_000 },
    { Caption: "Full name", Other: "x" },
    { Caption: "Ngô Quyền Văn", Other: 8_000_000 },
  ] } }]]);
  assert.equal(m.mask("Đinh Bộ Lĩnh 7.000.000, Ngô Quyền Văn 8.000.000").text, "[Name 1] [Amount 1], [Name 2] [Amount 2]");
});

test("cells addressed in A1 notation take their column heading from a cell above", () => {
  const m = masker([["cells", { cells: [{ address: "B2", value: "Full name" }, { address: "B3", value: "Phan Bội Châu" }, { address: "A3", value: "Phan Bội Châu x" }] }]]);
  assert.equal(m.mask("Phan Bội Châu").replaced, 1);
  assert.equal(m.mask("Phan Bội Châu x").text, "[Name 1] x");
});

test("an unknown kind, a bad path or a missing label is refused when the config is compiled", () => {
  assert.throws(() => compilePersonalFields({ ...CONFIG, tools: { t: { paths: { "a..b": "money" } } } }), /path/u);
  assert.throws(() => compilePersonalFields({ ...CONFIG, tools: { t: { paths: { a: "secret" as never } } } }), /kind/u);
  assert.throws(() => compilePersonalFields({ ...CONFIG, labels: { ...CONFIG.labels, money: "" } }), /label/u);
  assert.throws(() => compilePersonalFields({ ...CONFIG, labels: { ...CONFIG.labels, coefficient: "" } }), /labels\.coefficient/u);
});
