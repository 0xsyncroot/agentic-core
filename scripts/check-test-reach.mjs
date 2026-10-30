import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SKIPPED_DIRECTORIES } from "./skipped-directories.mjs";

// Fails when a test file exists that no script runs. The root `test` script is a hand-kept list of
// commands; without this gate a new test file that nobody adds to it never runs and nothing says so.
//
// Limits, known and accepted. The gate reads script text and import text; it does not run anything.
// - A test file is found by name (isTestFile below). A node:test file with another name is invisible.
// - Any word with a script extension in a command counts as run, whatever the command: a file named only in `echo x.test.mjs` passes.
// - A Python module counts as run once a reached Python file imports it, whether or not it calls the module's checks.
// - Only relative imports, `import()` with a literal, and `new URL(literal, import.meta.url)` are followed; computed paths,
//   package names and tsconfig paths are not. Shell variables and quoting beyond a surrounding pair are not expanded.
// - `npm -w|--workspace|--workspaces|--prefix ... run x` is not followed: the script belongs to another package.

// Directory names skipped at any depth: the set check-docs.mjs shares, plus git worktrees and generated archives.
const SKIPPED = new Set([...SKIPPED_DIRECTORIES, ".claude", "dist-package", "artifacts"]);

// Scripts that may reach test files `npm test` must not run, each for an external need. A profile is
// checked only while its root directory exists: a one-product archive drops the roots it does not carry.
const PROFILES = [
  { script: "test:s3", root: "packages/adapter-s3", need: "an isolated S3-compatible service (TEST_S3_*)" },
  { script: "test:mysql", root: "packages/persistence-mysql", need: "a MySQL server" },
  { script: "test:postgres", root: "packages/persistence-postgres", need: "a PostgreSQL server (TEST_DATABASE_URL)" },
  { script: "test:sqlserver", root: "packages/persistence-sqlserver", need: "a SQL Server instance" },
  { script: "mcp:execution:test", root: "mcp-servers/agent-execution", need: "the agent-execution gateway dependencies (npm run mcp:execution:install)" },
];

// Test files no script runs, on purpose. Stale once the root exists and nothing matches.
const EXCLUSIONS = [
  { root: "mcp-servers/agent-execution", matches: (file) => file === "mcp-servers/agent-execution/test/integration.mjs", reason: "audits a running image (EXECUTION_TEST_URL, deploy/README.md), by hand" },
];

const isTestFile = (file) => /\.test\.[cm]?[jt]sx?$/u.test(file) || /(^|\/)selftest[^/]*\.py$/u.test(file) || /Test\.kt$/u.test(file)
  || /(^|\/)live-proof\/[^/]*selftest[^/]*\.mjs$/u.test(file) || /(^|\/)test\/integration\.mjs$/u.test(file);
const OPERAND = /\.(?:[cm]?[jt]sx?|py)$/u;
const SEPARATOR = /&&|\|\||;|\|/u;
const OTHER_PACKAGE = /^(?:-w|--workspaces?|--prefix)(?:=|$)/u;

/** Every file under `root` as a root-relative posix path. A nested directory with its own `.git` is another checkout. */
export function walk(root) {
  const files = [];
  const visit = (directory, relative) => {
    const entries = readdirSync(directory, { withFileTypes: true });
    if (relative && entries.some((entry) => entry.name === ".git")) return;
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) visit(resolve(directory, entry.name), path);
      } else if (entry.isFile()) files.push(path);
    }
  };
  visit(root, "");
  return files;
}

const globPattern = (glob) => new RegExp(`^${glob.split("/").map((segment) => segment
  .replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, "[^/]*").replace(/\?/gu, "[^/]")).join("/")}$`, "u");

/** File-like operands of an npm script, following `npm run <x>` and `cd <dir> &&`. `unknown` names scripts that `npm run` cannot find. */
export function scriptOperands(scripts, name, seen = new Set()) {
  const result = { operands: [], unknown: [] };
  if (seen.has(name)) return result;
  seen.add(name);
  if (typeof scripts[name] !== "string") {
    result.unknown.push(name);
    return result;
  }
  let directory = "";
  for (const command of scripts[name].split(SEPARATOR)) {
    const words = command.trim().split(/\s+/u).filter(Boolean).map((word) => word.replace(/^["']|["']$/gu, ""));
    if (words[0] === "cd" && words[1]) {
      directory = posix.normalize(posix.join(directory, words[1]));
      continue;
    }
    const run = words.indexOf("run");
    if (words[0] === "npm" && run > 0 && !words.some((word) => OTHER_PACKAGE.test(word)) && words[run + 1]) {
      const inner = scriptOperands(scripts, words[run + 1], seen);
      result.operands.push(...inner.operands);
      result.unknown.push(...inner.unknown);
    }
    for (const word of words) if (OPERAND.test(word) || /[*?]/u.test(word)) result.operands.push(posix.normalize(posix.join(directory, word)));
  }
  return result;
}

/** True for `{ type A, type B }`: every named specifier is type-only, so the statement is erased at build. */
const onlyTypeNames = (clause) => {
  const names = /^\{([^}]*)\}$/u.exec(clause?.trim() ?? "")?.[1]?.split(",").map((name) => name.trim()).filter(Boolean) ?? [];
  return names.length > 0 && names.every((name) => /^type\s/u.test(name));
};

/** Relative specifiers the file loads as values. `import type`, `export type` and a list of only `type` names are erased at build and do not count. */
function valueImports(file, source) {
  if (file.endsWith(".py")) {
    return [...source.matchAll(/^\s*(?:from\s+(\w+)\s+import|import\s+(\w+))/gmu)].map((match) => `./${match[1] ?? match[2]}.py`);
  }
  const specifiers = [];
  for (const match of source.matchAll(/(?:^|[\n;])\s*(?:import|export)\s+(type\s+)?(?:([^"';]*?)\sfrom\s+)?["']([^"']+)["']/gu)) {
    if (!match[1] && !onlyTypeNames(match[2])) specifiers.push(match[3]);
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu)) specifiers.push(match[1]);
  for (const match of source.matchAll(/new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/gu)) specifiers.push(match[1]);
  return specifiers.filter((specifier) => specifier.startsWith("./") || specifier.startsWith("../"));
}

function resolveImport(from, specifier, fileSet) {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stem = base.replace(/\.[cm]?js$/u, "");
  return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${base}.ts`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`]
    .find((candidate) => fileSet.has(candidate));
}

/** The files `starts` load, directly or through value imports. */
function closure(starts, root, fileSet) {
  const seen = new Set(starts);
  const pending = [...starts];
  while (pending.length > 0) {
    const file = pending.pop();
    if (!/\.(?:[cm]?[jt]sx?|py)$/u.test(file)) continue;
    for (const specifier of valueImports(file, readFileSync(resolve(root, file), "utf8"))) {
      const target = resolveImport(file, specifier, fileSet);
      if (target && !seen.has(target)) {
        seen.add(target);
        pending.push(target);
      }
    }
  }
  return seen;
}

/** Files a script's operands name. `problems` lists operands that name nothing (a shell passes an unmatched glob on as text) and scripts `npm run` cannot find. */
function filesOf(scripts, name, root, files, fileSet) {
  const { operands, unknown } = scriptOperands(scripts, name);
  const matched = new Set();
  const problems = unknown.map((script) => `script ${name}: npm script "${script}" is not defined`);
  for (const operand of operands) {
    const found = /[*?]/u.test(operand) ? files.filter((file) => globPattern(operand).test(file)) : existsSync(resolve(root, operand)) ? [operand] : [];
    if (found.length === 0) problems.push(`script ${name}: operand ${operand} matches no file`);
    for (const file of found) if (fileSet.has(file)) matched.add(file);
  }
  return { matched, problems };
}

/** Returns the failures found under `root` (empty when every test file is run by `test`, a profile, or an exclusion). */
export function checkTestReach(root) {
  const failures = [];
  const files = walk(root);
  const fileSet = new Set(files);
  const present = (directory) => files.some((file) => file.startsWith(`${directory}/`));
  const scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts ?? {};
  const tests = files.filter(isTestFile);

  const main = filesOf(scripts, "test", root, files, fileSet);
  failures.push(...main.problems);
  const reached = closure(main.matched, root, fileSet);

  for (const profile of PROFILES) {
    if (!present(profile.root)) continue;
    if (typeof scripts[profile.script] !== "string") {
      failures.push(`profile ${profile.script} (needs ${profile.need}) is not defined in package.json although ${profile.root}/ exists`);
      continue;
    }
    const own = filesOf(scripts, profile.script, root, files, fileSet);
    failures.push(...own.problems);
    const profileReached = closure(own.matched, root, fileSet);
    if (!tests.some((file) => profileReached.has(file))) failures.push(`stale profile ${profile.script}: reaches no test file although ${profile.root}/ exists`);
    for (const file of profileReached) reached.add(file);
  }

  const excluded = new Set();
  for (const exclusion of EXCLUSIONS) {
    const found = tests.filter(exclusion.matches);
    if (present(exclusion.root) && found.length === 0) failures.push(`stale exclusion under ${exclusion.root}: matches no test file (${exclusion.reason})`);
    for (const file of found) excluded.add(file);
  }

  for (const file of tests) {
    if (!reached.has(file) && !excluded.has(file)) failures.push(`${file}: no test script runs this file; add it to \`test\` (or to a profile or exclusion in scripts/check-test-reach.mjs, with the reason)`);
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const failures = checkTestReach(root);
  if (failures.length > 0) {
    console.error(`check:test-reach failed (${failures.length}):\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
    process.exit(1);
  }
  console.log("check:test-reach OK");
}
