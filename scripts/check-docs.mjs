import { access, readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { SKIPPED_DIRECTORIES } from "./skipped-directories.mjs";

const root = resolve(import.meta.dirname, "..");

const requiredDocuments = [
  "README.md",
  // Coding agents load these on every session (Codex/Kilo read AGENTS.md, Claude Code reads
  // CLAUDE.md, which imports AGENTS.md); without them new code is written blind to the layers.
  "AGENTS.md",
  "CLAUDE.md",
  "docs/README.md",
  "specs/agentic-core-architecture.md",
  "docs/adr/0001-plugin-platform.md",
  "docs/adr/0002-multi-tenant-memory.md",
  "docs/architecture/code-organization.md",
  "docs/architecture/extension-guide.md",
  "docs/architecture/mcp-connectors.md",
  "docs/architecture/context-management.md",
  "docs/architecture/environment-settings.md",
  "docs/verification.md",
  "docs/adr/0003-durable-human-interaction.md",
  "docs/adr/0004-admin-plane.md",
];

const retiredDocuments = [];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function markdownFiles(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(child)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(child);
  }
  return files;
}

function localLinkTarget(raw) {
  const target = raw.trim().replace(/^<|>$/g, "").split(/[?#]/, 1)[0];
  if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(target)) return undefined;
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

const violations = [];
for (const document of requiredDocuments) {
  if (!(await exists(resolve(root, document)))) violations.push(`missing canonical document: ${document}`);
}
for (const document of retiredDocuments) {
  if (await exists(resolve(root, document))) violations.push(`retired document still exists: ${document}`);
}

const files = await markdownFiles(root);
for (const file of files) {
  const source = await readFile(file, "utf8");
  const display = relative(root, file);
  const withoutCodeFences = source.replace(/```[\s\S]*?```/gu, "");
  for (const match of withoutCodeFences.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu)) {
    const target = localLinkTarget(match[1]);
    if (target && !(await exists(resolve(dirname(file), target)))) {
      violations.push(`${display} has broken link: ${match[1]}`);
    }
  }
}

for (const document of ["README.md", ...requiredDocuments.filter((item) => item.startsWith("docs/") || item.startsWith("specs/"))]) {
  const source = await readFile(resolve(root, document), "utf8");
  if (/implementation approval pending|draft v0\.2/iu.test(source)) {
    violations.push(`${document} contains retired product-specific or draft architecture wording`);
  }
}

if (violations.length > 0) {
  console.error(`Documentation violations:\n${violations.map((item) => `- ${item}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation: OK (${files.length} Markdown files)`);
}
