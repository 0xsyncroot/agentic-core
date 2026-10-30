import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { commentFindings, commentViolations } from "./comment-gate.mjs";

// Every fixture tree lives under the OS temp directory; nothing here writes into the repository.
const temporary = [];
after(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const tree = (files) => {
  const root = mkdtempSync(join(tmpdir(), "comment-gate-"));
  temporary.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

const kinds = (comment, allowed) => commentFindings(comment, allowed).map((finding) => finding.kind);

describe("commentFindings", () => {
  test("a calendar day in any common form is a date", () => {
    for (const comment of [
      "// Fixed live on 2026-10-14.",
      "/* Seen at 2026-10-14T09:12:00Z. */",
      "// Ngày 15/10/2026 bảng bị khóa.",
      "// Reproduced 1.10.2026 on the tenant.",
      "// Since 14 Oct 2026 the gateway answers late.",
      "// Since October 14, 2026 the gateway answers late.",
    ]) assert.deepEqual(kinds(comment), ["date"], comment);
  });

  test("a month alone, a version and a number are not dates", () => {
    for (const comment of [
      "// A month is written with or without its leading zero (\"09/2026\", \"9/2026\").",
      "// The period is October 2026 in every case.",
      "// Needs Node 20.10 or later; the limit is 2026 characters.",
      "// Hash prefix a2026-10-14b is opaque.",
    ]) assert.deepEqual(kinds(comment), [], comment);
  });

  test("an incident link is the way to history and is not a date", () => {
    assert.deepEqual(kinds("// Why: docs/incidents/2026-10-12-core-silent-model-calls.md"), []);
    assert.deepEqual(kinds("// (products/sample-app/docs/incidents/2026-10-10-false-empty-list.md)"), []);
    assert.deepEqual(kinds("// docs/incidents/2026-10-12-core-silent-model-calls.md, again on 2026-10-13"), ["date"]);
  });

  test("a quote of the owner is flagged with or without a date", () => {
    assert.deepEqual(kinds("// Owner: \"không được lỗi\" — so the menu hides the entry."), ["quote of the owner"]);
    assert.deepEqual(kinds("// theo chủ dự án: \"mặc định phải lấy danh mục active\""), ["quote of the owner"]);
    assert.deepEqual(kinds("// owner, 2026-10-16: \"nhấn dừng cái sao mất hết chat?\""), ["date", "quote of the owner"]);
    assert.deepEqual(kinds("// Extends the owner's lease; false once the operation is no longer this owner's to run."), []);
    assert.deepEqual(kinds("// Checks the sid against the document's actual owner, not just \"does this handle exist\"."), []);
  });

  test("names of review rounds and the run a finding came from are flagged", () => {
    assert.deepEqual(kinds("// It stalls (audit probe B)."), ["review round name"]);
    assert.deepEqual(kinds("// Review probe: an earlier task's file."), ["review round name"]);
    assert.deepEqual(kinds("// A refusal names what to fix (probe P1-c)."), ["review round name"]);
    assert.deepEqual(kinds("// Following the cursor was the model's job: live (P6-23..25) it sent a continuation."), ["review round name"]);
    assert.deepEqual(kinds("// A connectivity probe only; one probe call is let through after the cool-down."), []);
    assert.deepEqual(kinds("// A control that picked before still picks (critic-r4 r1 N7)."), ["review round name"]);
    assert.deepEqual(kinds("// Counted as unmet, per critic r2."), ["review round name"]);
    assert.deepEqual(kinds("// The forms of .wave/open-items/evidence/base.log the runner could not answer."), ["review round name"]);
    assert.deepEqual(kinds("// A critic of the answer reads it whole; the wave/ folder and x.wave/ are names."), []);
  });

  test("an audit or QA finding id, an audit's own name and a run name are review round names", () => {
    for (const comment of [
      "// refusing it there is what left a 32-step turn (QA K11) with an empty chat",
      "// ---- E1 (QA lượt 2, K11): a turn that used every step must still answer. ----",
      "// QA E2: the widget's Enter while the agent worked had no route on this API at all.",
      "// A terminal tool row crosses (audit P1-2's own fix: the filter already drops the rest).",
      "// Audit P2-3: the model called a tool on the step that had to answer.",
      "// audit-r1 P2-1: only a point inside the sticky element's own box is the table's own scrolling.",
      "/* \"Khoản\" not \"Số tài khoản\" (auditA), \"Hệ số\" not \"Truy thu > Hệ số\" (audit16). */",
      "// instead of sending it back to retract or rephrase (P0-6: a retraction loop nobody can win).",
      "// DeepSeek, replayed on K11-run10's real last request.",
    ]) assert.deepEqual(kinds(comment), ["review round name"], comment);
  });

  test("ids that are data, spec items or plain words are not review round names", () => {
    for (const comment of [
      "// A bracket is a formula's punctuation too: `(A1)*(B1)` is a product, not a pair.",
      "// read through an in-process copy (L1) and a Redis cache",
      "// a group without a grader of its own (P1) is graded on the flow alone",
      "// ---- G4 writes: the reconciliation fixes employee data through the payroll write tools ----",
      "// R1, the per-sheet review loop: each sheet opened by its ID",
      "// AC-F3 (the `option` rule in UI_HANDLERS.md): a choice the screen cannot make is refused.",
      "// K20/K21: a fake payroll shaped like the reconciliation case.",
      "// QA fixture shaped like the payroll software, for the scenarios with a real chat.",
      "// The audit trail keeps every verdict; the auditor and the audited answer are named.",
      "// The completion audit of the answer reads it whole, as the review does.",
      "// P6 runs looped that way; level P2 is a priority, not a finding.",
    ]) assert.deepEqual(kinds(comment), [], comment);
  });

  test("an allowed passage is removed before the check, and only that passage", () => {
    const comment = "// Protocol revision 2026-07-28 requires a resultType.";
    assert.deepEqual(kinds(comment, ["Protocol revision 2026-07-28"]), []);
    assert.deepEqual(kinds(`${comment} Added on 2026-10-14.`, ["Protocol revision 2026-07-28"]), ["date"]);
  });
});

describe("commentViolations over a tree", () => {
  const anecdote = [
    "export const LIMIT = 3;",
    "",
    "// Raised after the 2026-10-14 run went to 151 calls.",
    "export const CAP = 4;",
    "",
  ].join("\n");
  const data = [
    "export const START = \"2026-09-01\";",
    "export const NOTE = `audit probe B, 2026-10-14`;",
    "export const LABEL = \"owner: \\\"mặc định\\\"\";",
    "",
  ].join("\n");

  test("a dated comment fails and a dated string does not", () => {
    const root = tree({ "packages/core/src/anecdote.ts": anecdote, "packages/core/src/data.ts": data });
    const { violations } = commentViolations(root, []);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /^packages\/core\/src\/anecdote\.ts:3 comment carries a date \("2026-10-14"\)/u);
  });

  test("dates in test names and fixtures are code", () => {
    const testFile = [
      "import { test } from \"node:test\";",
      "test(\"2026-10-14: a refused read is retried\", () => {",
      "  const row = { StartDate: \"2026-09-01\" };",
      "  return row;",
      "});",
      "",
    ].join("\n");
    const root = tree({ "products/demo/backend/test/case.test.ts": testFile });
    assert.deepEqual(commentViolations(root, []).violations, []);
  });

  test("leading, trailing and end-of-file comments are all read", () => {
    const source = [
      "const a = 1; // trailing, 2026-10-14",
      "export function f(x: number) {",
      "  return x /* inline, 2026-10-15 */ + a;",
      "}",
      "// last line, 2026-10-16",
      "",
    ].join("\n");
    const root = tree({ "apps/x/src/f.ts": source });
    const lines = commentViolations(root, []).violations.map((violation) => violation.split(" ")[0]);
    assert.deepEqual(lines, ["apps/x/src/f.ts:1", "apps/x/src/f.ts:3", "apps/x/src/f.ts:5"]);
  });

  test("a comment with no node after it, only punctuation, is read", () => {
    const source = [
      "export function f() { /* empty since 2026-10-14 */ }",
      "export const xs = [",
      "  // emptied on 2026-10-15",
      "];",
      "export const call = f(/* none as of 2026-10-16 */);",
      "",
    ].join("\n");
    const root = tree({ "apps/x/src/g.ts": source });
    const lines = commentViolations(root, []).violations.map((violation) => violation.split(" ")[0]);
    assert.deepEqual(lines, ["apps/x/src/g.ts:1", "apps/x/src/g.ts:3", "apps/x/src/g.ts:5"]);
  });

  test("a regex literal ending in an escaped slash does not open a comment", () => {
    const source = "const slash = /a\\//; const when = \"2026-10-14\";\nexport { slash, when };\n";
    const root = tree({ "scripts/slash.mjs": source });
    assert.deepEqual(commentViolations(root, []).violations, []);
  });

  test("the line reported is the line of the token inside a block comment", () => {
    const source = "/**\n * The rule.\n *\n * Seen live (2026-10-14) on the tenant.\n */\nexport const x = 1;\n";
    const root = tree({ "mcp-servers/x/src/x.mjs": source });
    assert.match(commentViolations(root, []).violations.join("\n"), /^mcp-servers\/x\/src\/x\.mjs:4 comment carries a date/u);
  });

  test("an exception keeps its passage and is reported once no comment holds it", () => {
    const source = "// Protocol revision 2026-07-28 requires a resultType.\nexport const x = 1;\n";
    const root = tree({ "packages/adapter-x/test/server.mjs": source });
    const exceptions = [
      { path: "packages/adapter-x/test/server.mjs", passage: "Protocol revision 2026-07-28", reason: "spec revision name" },
      { path: "packages/adapter-x/test/server.mjs", passage: "gone on 2026-10-20", reason: "no comment holds it" },
    ];
    const result = commentViolations(root, exceptions);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.unused.map((exception) => exception.passage), ["gone on 2026-10-20"]);
  });

  test("only the six source trees are read, and never dependencies or build output", () => {
    const dated = "// Fixed on 2026-10-14.\nexport const x = 1;\n";
    const root = tree({
      "docs/example.ts": dated,
      "packages/core/node_modules/dep/index.js": dated,
      "packages/core/dist/index.js": dated,
      "demo/ext/src/a.js": dated,
    });
    const files = commentViolations(root, []).violations.map((violation) => violation.split(":")[0]);
    assert.deepEqual(files, ["demo/ext/src/a.js"]);
  });

  test("in a git checkout, what .gitignore keeps out is not read", () => {
    const dated = "// Fixed on 2026-10-14.\nexport const x = 1;\n";
    const root = tree({
      ".gitignore": "products/demo/frontend/types/\n",
      "products/demo/frontend/types/generated.d.ts": dated,
      "products/demo/frontend/src/untracked.ts": dated,
    });
    execFileSync("git", ["init", "-q"], { cwd: root });
    const files = commentViolations(root, []).violations.map((violation) => violation.split(":")[0]);
    assert.deepEqual(files, ["products/demo/frontend/src/untracked.ts"]);
  });
});
