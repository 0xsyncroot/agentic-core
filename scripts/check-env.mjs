#!/usr/bin/env node
/**
 * Keeps environment variable names honest: the registry (scripts/env-registry.mjs), the code that
 * reads settings, and the `.env*.example` files must agree.
 *
 * Fails when
 *   - runtime code reads a name the registry does not know (a new setting nobody documented);
 *   - an example lists a name nothing reads (dead lines such as a removed provider credential), a
 *     retired name (examples teach the current names), or a name missing from the registry;
 *   - a registry entry is read by nothing (a stale entry) unless it says how it is read
 *     (`dynamic`: a computed name, a framework, a YAML file that names it);
 *   - a test-only setting does not start with TEST_ (or sits in an example).
 *
 * "Runtime code" is what a deployment runs: packages/apps/products sources, the .NET host, the
 * MCP services and the product config YAML. Scripts and tests read their own tooling variables and
 * are not scanned, so a test harness flag never has to be registered as a deployment setting.
 *
 *   node scripts/check-env.mjs           check (npm run check:env)
 *   node scripts/check-env.mjs --list    print every name the scan found, with one place it was read
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { REMOVED, SETTINGS } from "./env-registry.mjs";

const root = resolve(import.meta.dirname, "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "bin", "obj", "test", "tests", "__pycache__", ".venv", "fixtures"]);
const NAME = "[A-Z][A-Z0-9_]{2,}";

/** Where deployed code lives, and which files under it count. */
const RUNTIME_ROOTS = [
  { dir: "packages", match: /\/src\/.+\.ts$/u },
  { dir: "apps", match: /\/src\/.+\.ts$/u },
  { dir: "products", match: /\/(?:backend|admin-api)\/src\/.+\.ts$|\/host-dotnet\/.+\.cs$|\/backend\/config\/.+\.ya?ml$/u },
  { dir: "mcp-servers/document-readers", match: /^(?!.*\/(?:selftest[^/]*|wire_client|fixtures)\.py$).+\.py$/u },
  { dir: "mcp-servers/agent-execution", match: /\/http\/[^/]+\.mjs$|\/[^/]+\.py$/u },
];

/** How a setting is read, per file kind. Each pattern captures names in group 1 (a list where noted). */
const PATTERNS = {
  ts: [
    new RegExp(`process\\.env\\.(${NAME})`, "gu"),
    new RegExp(`process\\.env\\[\\s*["'\`](${NAME})["'\`]\\s*\\]`, "gu"),
    new RegExp(`\\benv\\??\\.(${NAME})`, "gu"),
    new RegExp(`\\benv\\[\\s*["'\`](${NAME})["'\`]\\s*\\]`, "gu"),
    new RegExp(`\\(\\s*(?:env|process\\.env|source|environment)\\s*,\\s*["'\`](${NAME})["'\`]`, "gu"),
    new RegExp(`\\bsetting\\(\\s*["'](${NAME})["']\\s*,\\s*["'](${NAME})["']`, "gu"),
  ],
  lists: [/legacy:\s*\[([^\]]*)\]/gu, /refuseUnreadSettings\(\s*\w+\s*,\s*\[([^\]]*)\]/gu],
  // Names checked only for presence, to say they are removed: they must be in REMOVED, and they are not reads.
  removedLists: [/noticeRemovedSettings\(\s*\w+\s*,\s*\[([^\]]*)\]/gu],
  py: [
    new RegExp(`os\\.environ(?:\\.get)?\\s*[([]\\s*["'](${NAME})["']`, "gu"),
    new RegExp(`os\\.getenv\\(\\s*["'](${NAME})["']`, "gu"),
    new RegExp(`read_setting\\(\\s*["'](${NAME})["']`, "gu"),
  ],
  pyLists: [/read_setting\(\s*["'][A-Z0-9_]+["']\s*,\s*\(([^)]*)\)/gu],
  cs: [new RegExp(`(?:Configuration|configuration)\\[\\s*"(${NAME})"\\s*\\]`, "gu"), new RegExp(`GetEnvironmentVariable\\(\\s*"(${NAME})"`, "gu")],
  yaml: [new RegExp(`\\w*Env\\s*:\\s*["']?(${NAME})\\b`, "gu"), new RegExp(`\\$\\{(${NAME})(?::?-[^}]*)?\\}`, "gu")],
};

async function filesUnder(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const entry of entries) {
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) found.push(...await filesUnder(join(dir, entry.name))); }
    else if (entry.isFile()) found.push(join(dir, entry.name));
  }
  return found;
}

function stripLineComments(source, kind) {
  // Comments describe settings (often retired ones); only code reads them.
  if (kind === "py" || kind === "yaml") return source.split("\n").map((line) => line.replace(/(^|\s)#.*$/u, "$1")).join("\n");
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").split("\n").map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/u, "$1")).join("\n");
}

/** Removed names runtime code checks only to say they are ignored (noticeRemovedSettings), with where. */
const noticed = new Map();

/** Every name runtime code reads, with the first place each was seen. */
async function scanRuntime() {
  const reads = new Map();
  noticed.clear();
  const note = (name, where) => { if (!reads.has(name)) reads.set(name, where); };
  for (const { dir, match } of RUNTIME_ROOTS) {
    for (const file of await filesUnder(join(root, dir))) {
      const path = relative(root, file).replaceAll("\\", "/");
      if (!match.test(path)) continue;
      const kind = path.endsWith(".py") ? "py" : path.endsWith(".cs") ? "cs" : /\.ya?ml$/u.test(path) ? "yaml" : "ts";
      const source = stripLineComments(await readFile(file, "utf8"), kind);
      const lineOf = (index) => source.slice(0, index).split("\n").length;
      for (const pattern of PATTERNS[kind]) {
        for (const match of source.matchAll(pattern)) {
          for (const name of match.slice(1).filter(Boolean)) note(name, `${path}:${lineOf(match.index)}`);
        }
      }
      for (const pattern of kind === "ts" ? PATTERNS.lists : kind === "py" ? PATTERNS.pyLists : []) {
        for (const match of source.matchAll(pattern)) {
          for (const name of match[1].matchAll(new RegExp(`["'\`](${NAME})["'\`]`, "gu"))) note(name[1], `${path}:${lineOf(match.index)}`);
        }
      }
      for (const pattern of kind === "ts" ? PATTERNS.removedLists : []) {
        for (const match of source.matchAll(pattern)) {
          for (const name of match[1].matchAll(new RegExp(`["'\`](${NAME})["'\`]`, "gu"))) noticed.set(name[1], `${path}:${lineOf(match.index)}`);
        }
      }
    }
  }
  return reads;
}

const EXAMPLES = [
  ".env.example", ".env.production.example", "products/sample-app/backend/.env.example",
  "products/example/backend/.env.example", "products/example/backend/.env.production.example",
  "products/example/host-dotnet/.env.example", "products/example/host-dotnet/.env.production.example",
];

/** Names an example sets, commented out or not (`# NAME=value` documents a setting too). */
async function exampleNames(path) {
  let source;
  try { source = await readFile(join(root, path), "utf8"); } catch { return []; }
  return source.split("\n").flatMap((line, index) => {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]{2,})=/u.exec(line);
    return match ? [{ name: match[1], where: `${path}:${index + 1}` }] : [];
  });
}

const reads = await scanRuntime();
if (process.argv.includes("--list")) {
  for (const [name, where] of [...reads].sort()) console.log(`${name}\t${where}`);
  process.exit(0);
}

const violations = [];
const byName = new Map(SETTINGS.map((setting) => [setting.name, setting]));
const retired = new Map(SETTINGS.flatMap((setting) => (setting.legacy ?? []).map((old) => [old, setting.name])));
const removed = new Map(REMOVED.map((entry) => [entry.name, entry.reason]));
for (const setting of SETTINGS) {
  if (byName.get(setting.name) !== setting) violations.push(`registry lists ${setting.name} twice`);
  if (setting.owner === "test" && !setting.name.startsWith("TEST_")) violations.push(`test-only setting ${setting.name} must start with TEST_`);
}

for (const [name, where] of reads) {
  if (byName.has(name) || retired.has(name)) continue;
  violations.push(`${where} reads ${name}, which scripts/env-registry.mjs does not list`);
}
for (const [name, where] of noticed) {
  if (!removed.has(name)) violations.push(`${where} names ${name} as removed, but REMOVED in scripts/env-registry.mjs does not list it`);
}
for (const setting of SETTINGS) {
  if (reads.has(setting.name) || setting.dynamic) continue;
  violations.push(`registry lists ${setting.name} but no runtime code reads it (remove it, or say how it is read with dynamic)`);
}
for (const path of EXAMPLES) {
  for (const { name, where } of await exampleNames(path)) {
    if (retired.has(name)) violations.push(`${where} uses the retired name ${name}; write ${retired.get(name)}`);
    else if (removed.has(name)) violations.push(`${where} lists ${name}, which nothing reads (${removed.get(name)})`);
    else if (!byName.has(name)) violations.push(`${where} lists ${name}, which scripts/env-registry.mjs does not list`);
    else if (byName.get(name).owner === "test") violations.push(`${where} lists the test-only setting ${name}`);
    else if (!reads.has(name) && !byName.get(name).dynamic) violations.push(`${where} lists ${name}, which nothing reads`);
  }
}

if (violations.length > 0) {
  console.error(`Environment settings check failed:\n${violations.map((item) => `- ${item}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Environment settings: OK (${SETTINGS.length} settings, ${retired.size} retired names, ${reads.size} names read by runtime code)`);
}
