import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { checkIdentity, compare } from "./comment-identity.mjs";

// Every fixture repository lives under the OS temp directory; nothing here writes into the repository.
const temporary = [];
after(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const TS = `// Keeps the limit the loop reads.
export const LIMIT = 3; // trailing note

/** Doc comment. */
export function next(count: number): number {
  if (count > LIMIT) {
    return LIMIT;
  } // between if and else
  else {
    return count + 1;
  }
}
`;

// A regex literal ending in an escaped slash: a raw scanner reads its close plus the next slash as a line comment.
const JS = `const slash = /a\\//;
const after = "code after the regex"; // a comment
export const parts = [slash, after];
`;

describe("compare", () => {
  test("comment-only edits are IDENTICAL", () => {
    const edited = TS
      .replace("// Keeps the limit the loop reads.\n", "// The loop ends at this limit.\n// Second line of the rule.\n\n")
      .replace(" // trailing note", "")
      .replace("/** Doc comment. */", "/**\n * Rewritten doc.\n */")
      .replace("// between if and else", "/* moved note */");
    assert.equal(compare(TS, edited, "a.ts").status, "IDENTICAL");
    assert.equal(compare(JS, JS.replace("// a comment", "// another comment"), "b.mjs").status, "IDENTICAL");
  });

  test("a planted code change is DIFFERENT", () => {
    assert.equal(compare(TS, TS.replace("LIMIT = 3", "LIMIT = 4"), "a.ts").status, "DIFFERENT");
    assert.equal(compare(TS, TS.replace("count + 1", "count + 2"), "a.ts").status, "DIFFERENT");
    assert.equal(compare(TS, TS.replace("export const", "export let"), "a.ts").status, "DIFFERENT");
  });

  test("a type-only edit is DIFFERENT although the emit is the same", () => {
    const typed = `export interface Row {\n  // The person's id.\n  id: string;\n}\nexport type Kind = "a" | "b";\nexport function f(x: number): number { return x; }\n`;
    for (const edited of [
      typed.replace("f(x: number)", "f(x: string)"),
      typed.replace("): number {", "): unknown {"),
      typed.replace("id: string;", "id: number;"),
      typed.replace("id: string;", "id?: string;"),
      typed.replace(`"a" | "b"`, `"a"`),
    ]) {
      const result = compare(typed, edited, "t.ts");
      assert.equal(result.status, "DIFFERENT", edited);
      assert.match(result.detail, /^types: /u);
    }
    assert.equal(compare(typed, typed.replace("// The person's id.", "/** Who the row is about. */"), "t.ts").status, "IDENTICAL");
  });

  test("code after a regex ending in an escaped slash is code, not comment", () => {
    const result = compare(JS, JS.replace("code after the regex", "changed"), "b.mjs");
    assert.equal(result.status, "DIFFERENT");
    assert.match(result.detail, /changed/u);
  });

  test("a comment that swallows code is DIFFERENT", () => {
    assert.equal(compare(TS, TS.replace("export const LIMIT = 3;", "// export const LIMIT = 3;"), "a.ts").status, "DIFFERENT");
    assert.equal(compare(TS, TS.replace("/** Doc comment. */", "/** Doc comment."), "a.ts").status, "DIFFERENT");
  });

  test("tool directive comments count as code", () => {
    const directive = `// @ts-expect-error the value is untyped\nexport const x: number = "y";\n`;
    assert.equal(compare(directive, directive.replace("// @ts-expect-error the value is untyped\n", ""), "c.ts").status, "DIFFERENT");
    assert.equal(compare(directive, directive.replace("the value is untyped", "untyped value"), "c.ts").status, "DIFFERENT");
    const pure = `export const y = /* @__PURE__ */ make();\n`;
    assert.equal(compare(pure, pure.replace("/* @__PURE__ */ ", ""), "d.js").status, "DIFFERENT");
    const prose = `// The eslint rule set does not apply here.\nexport const z = 1;\n`;
    assert.equal(compare(prose, prose.replace("The eslint rule set", "Lint"), "e.ts").status, "IDENTICAL");
  });

  test("files outside TS/JS are SKIPPED; added and deleted code files fail", () => {
    assert.equal(compare("a", "b", "notes.md").status, "SKIPPED");
    assert.equal(compare(undefined, TS, "a.ts").status, "ADDED");
    assert.equal(compare(TS, undefined, "a.ts").status, "DELETED");
  });
});

describe("checkIdentity against a git base", () => {
  const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const repository = (files) => {
    const root = mkdtempSync(join(tmpdir(), "comment-identity-"));
    temporary.push(root);
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "test");
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");
    return root;
  };
  const statuses = (rows) => Object.fromEntries(rows.map((row) => [row.path, row.status]));

  test("a directory expands to its changed files and catches the one code edit", () => {
    const root = repository({ "pkg/src/a.ts": TS, "pkg/src/b.mjs": JS, "pkg/src/same.ts": TS, "pkg/README.md": "x" });
    writeFileSync(join(root, "pkg/src/a.ts"), TS.replace("// trailing note", "// rewritten note"));
    writeFileSync(join(root, "pkg/src/b.mjs"), JS.replace("[slash, after]", "[after, slash]"));
    writeFileSync(join(root, "pkg/README.md"), "y");
    writeFileSync(join(root, "pkg/src/new.ts"), "export const n = 1;\n");
    assert.deepEqual(statuses(checkIdentity(root, "HEAD", ["pkg"])), {
      "pkg/src/a.ts": "IDENTICAL",
      "pkg/src/b.mjs": "DIFFERENT",
      "pkg/src/new.ts": "ADDED",
    });
  });

  test("named files are compared as given, including a deleted one", () => {
    const root = repository({ "a.ts": TS, "b.mjs": JS });
    unlinkSync(join(root, "b.mjs"));
    assert.deepEqual(statuses(checkIdentity(root, "HEAD", ["a.ts", "b.mjs"])), { "a.ts": "IDENTICAL", "b.mjs": "DELETED" });
  });

  test("the command exits 1 on a planted change and 0 on a comment-only change", () => {
    const script = resolve(import.meta.dirname, "comment-identity.mjs");
    const root = repository({ "a.ts": TS });
    const run = () => {
      try {
        execFileSync(process.execPath, [script, "--base", "HEAD", "a.ts"], { cwd: root, encoding: "utf8", stdio: "pipe" });
        return 0;
      } catch (error) {
        return error.status;
      }
    };
    writeFileSync(join(root, "a.ts"), TS.replace("// trailing note", "// other"));
    assert.equal(run(), 0);
    writeFileSync(join(root, "a.ts"), TS.replace("LIMIT = 3", "LIMIT = 30"));
    assert.equal(run(), 1);
  });
});
