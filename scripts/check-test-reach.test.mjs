import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { checkTestReach, scriptOperands } from "./check-test-reach.mjs";
import { SKIPPED_DIRECTORIES } from "./skipped-directories.mjs";

// Every fixture lives under the OS temp directory; nothing here writes into the repository.
const temporary = [];
after(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function tree(files, scripts) {
  const root = mkdtempSync(join(tmpdir(), "test-reach-"));
  temporary.push(root);
  const all = { "package.json": JSON.stringify({ scripts }), ...files };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const TEST = "import { test } from \"node:test\";\ntest(\"x\", () => {});\n";
const only = (failures, pattern) => failures.filter((failure) => pattern.test(failure));

describe("the repository", () => {
  test("every test file is run by a script", () => {
    assert.deepEqual(checkTestReach(resolve(import.meta.dirname, "..")), []);
  });
});

describe("reach through scripts", () => {
  test("passes when `test` names the file and the tree has no .git, products/example or demo", () => {
    const root = tree({ "a.test.mjs": TEST }, { test: "node --test a.test.mjs" });
    assert.deepEqual(checkTestReach(root), []);
  });

  test("an untracked test file that no script runs fails", () => {
    const root = tree({ "a.test.mjs": TEST, "pkg/new.test.mjs": TEST }, { test: "node --test a.test.mjs" });
    assert.deepEqual(checkTestReach(root).map((failure) => failure.split(":")[0]), ["pkg/new.test.mjs"]);
  });

  test("an operand that matches no file fails, for a name and for a glob", () => {
    const named = tree({ "a.test.mjs": TEST }, { test: "node --test a.test.mjs gone.test.mjs" });
    assert.deepEqual(checkTestReach(named), ["script test: operand gone.test.mjs matches no file"]);
    const glob = tree({ "a.test.mjs": TEST }, { test: "node --test a.test.mjs lib/*.test.mjs" });
    assert.deepEqual(checkTestReach(glob), ["script test: operand lib/*.test.mjs matches no file"]);
  });

  test("follows npm run, cd and globs without globstar", () => {
    const files = { "pkg/test/a.test.mjs": TEST, "pkg/test/deep/b.test.mjs": TEST };
    const scripts = { test: "npm run inner --silent", inner: "cd pkg && node --test test/*.test.mjs" };
    assert.deepEqual(checkTestReach(tree(files, scripts)), ["pkg/test/deep/b.test.mjs: no test script runs this file; add it to `test` (or to a profile or exclusion in scripts/check-test-reach.mjs, with the reason)"]);
  });

  test("an npm script that does not exist fails", () => {
    const root = tree({ "a.test.mjs": TEST }, { test: "npm run absent && node --test a.test.mjs" });
    assert.deepEqual(checkTestReach(root), ["script test: npm script \"absent\" is not defined"]);
  });

  test("an npm run aimed at a workspace, in any spelling, is not followed in the root", () => {
    for (const flags of ["--workspace pkg", "--workspace=pkg", "-w pkg", "--workspaces", "--prefix pkg"]) {
      const scripts = { test: `node --test a.test.mjs && npm ${flags} run inner`, inner: "node --test b.test.mjs" };
      const failures = checkTestReach(tree({ "a.test.mjs": TEST, "b.test.mjs": TEST }, scripts));
      assert.deepEqual(failures.map((failure) => failure.split(":")[0]), ["b.test.mjs"], flags);
    }
  });

  test("operand extraction keeps the directory of `cd` per command", () => {
    const scripts = { test: "cd a && node x.mjs && node y.mjs", other: "node z.mjs" };
    assert.deepEqual(scriptOperands(scripts, "test").operands, ["a/x.mjs", "a/y.mjs"]);
    assert.deepEqual(scriptOperands(scripts, "other").operands, ["z.mjs"]);
  });
});

describe("reach through imports", () => {
  test("a value import reaches a test file; an `import type` does not", () => {
    const files = {
      "a.test.ts": "import \"./value.test.ts\";\nimport type { X } from \"./typed.test.ts\";\n",
      "value.test.ts": TEST,
      "typed.test.ts": TEST,
    };
    const failures = checkTestReach(tree(files, { test: "node --test a.test.ts" }));
    assert.deepEqual(failures.map((failure) => failure.split(":")[0]), ["typed.test.ts"]);
  });

  test("a specifier list of only `type` names is erased like `import type`; one value name keeps the import", () => {
    const files = {
      "a.test.ts": [
        "import { type X, type Y } from \"./typed.test.ts\";",
        "export { type Z } from \"./retyped.test.ts\";",
        "import { type X, y } from \"./mixed.test.ts\";",
        "import D, { type X } from \"./default.test.ts\";",
        "",
      ].join("\n"),
      "typed.test.ts": TEST, "retyped.test.ts": TEST, "mixed.test.ts": TEST, "default.test.ts": TEST,
    };
    const failures = checkTestReach(tree(files, { test: "node --test a.test.ts" }));
    assert.deepEqual(failures.map((failure) => failure.split(":")[0]).sort(), ["retyped.test.ts", "typed.test.ts"]);
  });

  test("an import written with .js resolves to the .ts file", () => {
    const files = { "a.test.ts": "import { x } from \"./helper.test.js\";\n", "helper.test.ts": TEST };
    assert.deepEqual(checkTestReach(tree(files, { test: "node --test a.test.ts" })), []);
  });

  test("a Python test reaches the sibling modules it imports", () => {
    const files = { "selftest.py": "import selftest_more\n", "selftest_more.py": "x = 1\n" };
    assert.deepEqual(checkTestReach(tree(files, { test: "python3 selftest.py" })), []);
  });
});

describe("directories the walk skips", () => {
  test("generated, worktree and archive directories are not scanned", () => {
    const files = { "a.test.mjs": TEST };
    for (const directory of ["dist-package", ".claude/worktrees/w", "artifacts", "node_modules/x", ".wave/w"]) files[`${directory}/o.test.mjs`] = TEST;
    assert.deepEqual(checkTestReach(tree(files, { test: "node --test a.test.mjs" })), []);
  });

  test("every directory the shared set names is skipped, so the two scripts cannot drift apart", () => {
    const files = { "a.test.mjs": TEST };
    for (const directory of SKIPPED_DIRECTORIES) files[`${directory}/o.test.mjs`] = TEST;
    assert.deepEqual(checkTestReach(tree(files, { test: "node --test a.test.mjs" })), []);
  });

  test("a nested directory with its own .git file is another checkout and is skipped", () => {
    const files = { "a.test.mjs": TEST, "nested/.git": "gitdir: ../.git/worktrees/n\n", "nested/lost.test.mjs": TEST };
    assert.deepEqual(checkTestReach(tree(files, { test: "node --test a.test.mjs" })), []);
  });

  test("a nested directory with its own .git directory is skipped, and one without is scanned", () => {
    const files = { "a.test.mjs": TEST, "nested/.git/HEAD": "ref\n", "nested/lost.test.mjs": TEST, "plain/lost.test.mjs": TEST };
    const failures = checkTestReach(tree(files, { test: "node --test a.test.mjs" }));
    assert.deepEqual(failures.map((failure) => failure.split(":")[0]), ["plain/lost.test.mjs"]);
  });
});

describe("profiles and exclusions", () => {
  const INTEGRATION = "mcp-servers/agent-execution/test/integration.mjs";

  test("a node:test file named test/integration.mjs is a test file; the agent-execution one is excluded with its reason", () => {
    const elsewhere = tree({ "a.test.mjs": TEST, "pkg/test/integration.mjs": TEST }, { test: "node --test a.test.mjs" });
    assert.deepEqual(checkTestReach(elsewhere).map((failure) => failure.split(":")[0]), ["pkg/test/integration.mjs"]);
    const gateway = "mcp-servers/agent-execution/test/gateway.test.mjs";
    const present = tree({ "a.test.mjs": TEST, [INTEGRATION]: TEST, [gateway]: TEST }, { test: "node --test a.test.mjs", "mcp:execution:test": `node --test ${gateway}` });
    assert.deepEqual(checkTestReach(present), []);
    const gone = tree({ "a.test.mjs": TEST, [gateway]: TEST }, { test: "node --test a.test.mjs", "mcp:execution:test": `node --test ${gateway}` });
    assert.equal(only(checkTestReach(gone), /stale exclusion under mcp-servers\/agent-execution/u).length, 1);
  });

  const POSTGRES = "packages/persistence-postgres/test/x.test.ts";
  const profile = { "test:postgres": "node --test packages/persistence-postgres/test/*.test.ts" };

  test("a file reached only by its profile passes", () => {
    const root = tree({ "a.test.mjs": TEST, [POSTGRES]: TEST }, { test: "node --test a.test.mjs", ...profile });
    assert.deepEqual(checkTestReach(root), []);
  });

  test("a profile missing from package.json fails while its root exists, and is ignored when the root is absent", () => {
    const missing = tree({ "a.test.mjs": TEST, [POSTGRES]: TEST }, { test: "node --test a.test.mjs" });
    assert.equal(only(checkTestReach(missing), /profile test:postgres .* is not defined/u).length, 1);
    const absent = tree({ "a.test.mjs": TEST }, { test: "node --test a.test.mjs", ...profile });
    assert.deepEqual(checkTestReach(absent), []);
  });

  test("a profile that reaches no test file fails as stale", () => {
    const helper = "packages/persistence-postgres/helper.mjs";
    const root = tree({ "a.test.mjs": TEST, [helper]: "export const x = 1;\n" }, { test: "node --test a.test.mjs", "test:postgres": `node ${helper}` });
    assert.equal(only(checkTestReach(root), /stale profile test:postgres/u).length, 1);
  });

  test("a stale exclusion fails while its root exists", () => {
    const gateway = "mcp-servers/agent-execution/test/gateway.test.mjs";
    const files = { "a.test.mjs": TEST, [gateway]: TEST };
    const scripts = { test: "node --test a.test.mjs", "mcp:execution:test": `node --test ${gateway}` };
    const failures = checkTestReach(tree(files, scripts));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^stale exclusion under mcp-servers\/agent-execution/u);
  });

  test("an exclusion that still matches a file passes, and its root being absent is not stale", () => {
    const gateway = "mcp-servers/agent-execution/test/gateway.test.mjs";
    const files = { "a.test.mjs": TEST, [gateway]: TEST, [INTEGRATION]: TEST };
    const scripts = { test: "node --test a.test.mjs", "mcp:execution:test": `node --test ${gateway}` };
    assert.deepEqual(checkTestReach(tree(files, scripts)), []);
    assert.deepEqual(checkTestReach(tree({ "a.test.mjs": TEST }, { test: "node --test a.test.mjs" })), []);
  });
});
