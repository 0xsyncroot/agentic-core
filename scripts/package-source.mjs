import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, posix, resolve } from "node:path";
import { promisify } from "node:util";

/**
 * Packs the source of this repository into one archive to hand over.
 *
 * The file list comes from git rather than from a directory walk, so everything `.gitignore`
 * already keeps out — `node_modules`, `dist`, generated types, `.env`, local index state — is
 * out by construction rather than by a pattern someone has to remember to update. Untracked
 * files that are not ignored are included: work that has not been committed yet is still the
 * source, and silently shipping an archive missing half of it is the worst outcome here.
 *
 * Build output is deliberately absent. The recipient runs `npm ci && npm run build`, which is
 * also the only way the artifacts are guaranteed to match the source they came with.
 *
 */

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

/** Paths kept out of the handover, each for a stated reason. */
const EXCLUDED = [
  // The output directory sits inside the tree being read; without this, tar would archive the
  // archive it is still writing.
  { prefix: "dist-package/", reason: "previous package output" },
  // Committed snapshots of earlier handovers. Shipping them would send an older copy of this
  // same repository inside the new one, which is confusing at best and misleading at worst.
  { prefix: "artifacts/", reason: "build archives and exported Docker images" },
];

/**
 * Files that must never travel, whatever git thinks.
 *
 * `.gitignore` already covers the ordinary cases; this catches the one that matters — a secret
 * that was force-added at some point and is therefore tracked. A refusal here costs a minute; a
 * key in an archive that has been emailed onward cannot be taken back.
 */
const FORBIDDEN_NAMES = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|.*\.keystore|.*\.jks|id_[rd]sa)$/u;
// Any `*.example` env template ships: it is the deployment contract and carries no values.
// `.env.production` without the suffix is still refused, which is the distinction that matters.
const ALLOWED_ENV = /(^|\/)\.env(\.[A-Za-z0-9_-]+)?\.example$/u;

/** Shapes that are a credential and nothing else, so a match is a finding rather than a guess. */
const SECRET_CONTENT = [
  { name: "private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u },
  { name: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: "Slack token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}/u },
  { name: "GitHub token", pattern: /\bgh[pousr]_[0-9A-Za-z]{36,}/u },
  { name: "Langfuse secret key", pattern: /\bsk-lf-[0-9a-f-]{20,}/u },
  { name: "OpenAI-style secret key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/u },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
];

const TEXT_SCAN_LIMIT = 2 * 1024 * 1024;

async function sourceFiles() {
  // Tracked plus untracked-but-not-ignored: exactly what a fresh clone would hold after this
  // work is committed, which is what the recipient is being handed. `-c` reports a path from the
  // index even when it was deleted from the working tree and never staged — a fresh clone after
  // committing that deletion would NOT have it, so it is dropped here rather than left for `tar`
  // or `copyFile` to fail on with an unrelated-looking ENOENT.
  const { stdout } = await run("git", ["ls-files", "-c", "-o", "--exclude-standard", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const candidates = stdout.split("\0").filter(Boolean).sort();
  const existing = await Promise.all(candidates.map(async (file) => (await stat(resolve(root, file)).catch(() => null)) ? file : null));
  return existing.filter((file) => file !== null);
}

function partition(files) {
  const included = [];
  const excluded = new Map();
  for (const file of files) {
    const rule = EXCLUDED.find((item) => file.startsWith(item.prefix));
    if (rule) {
      excluded.set(rule.reason, (excluded.get(rule.reason) ?? 0) + 1);
      continue;
    }
    included.push(file);
  }
  return { included, excluded };
}

async function auditSecrets(files) {
  const findings = [];
  for (const file of files) {
    if (FORBIDDEN_NAMES.test(file) && !ALLOWED_ENV.test(file)) {
      findings.push(`${file}: a file of this name never belongs in a handover`);
      continue;
    }
    let size;
    try { size = (await stat(resolve(root, file))).size; } catch { continue; }
    if (size > TEXT_SCAN_LIMIT) continue;
    let source;
    try { source = await readFile(resolve(root, file), "utf8"); } catch { continue; }
    // A NUL byte means binary: scanning it produces noise, never a finding. Written as an
    // escape rather than a literal so it survives a copy-paste through a terminal.
    if (source.includes("\u0000")) continue;
    for (const { name, pattern } of SECRET_CONTENT) {
      const match = pattern.exec(source);
      if (match) findings.push(`${file}: looks like a ${name} (${match[0].slice(0, 12)}…)`);
    }
  }
  return findings;
}

/**
 * Every relative link and path reference inside the package must resolve inside the package.
 *
 * Excluding a directory is the easy half; the half that bites is what still points at it. A
 * README linking to the demo, or a script reading one of its files, turns a clean archive into
 * one that fails on the recipient's first command — which is exactly how this check came to
 * exist. Cheaper to fail here than in their terminal.
 */
async function auditDanglingReferences(files) {
  const present = new Set(files);
  const findings = [];
  for (const file of files) {
    if (!/\.(?:md|mjs|js|json)$/u.test(file)) continue;
    let source;
    try { source = await readFile(resolve(root, file), "utf8"); } catch { continue; }
    const directory = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    const references = new Set();
    // `](target)` is a link only in Markdown; in code it is a call such as `adapter[name](...args)`.
    if (file.endsWith(".md")) for (const [, target] of source.matchAll(/\]\((\.[^)\s#]+)/gu)) references.add(target);
    for (const [, target] of source.matchAll(/new URL\("(\.\.?\/[^"]+)"/gu)) references.add(target);
    for (const target of references) {
      const path = posix.normalize(posix.join(directory, target));
      // A reference that climbs all the way back out to the package root resolves to "" here,
      // and the root always ships — there is no shallower path left to be missing.
      if (path === "") continue;
      // Paths that `npm ci` and `npm run build` create. Absent from the source by design, and
      // present by the time anything reads them.
      if (/(^|\/)(node_modules|dist|types)(\/|$)/u.test(path)) continue;
      // A directory reference resolves when anything inside it travelled.
      if (present.has(path) || [...present].some((item) => item.startsWith(`${path}/`))) continue;
      findings.push(`${file}: points at ${path}, which is not in the package`);
    }
  }
  return findings;
}

function archiveName(version, revision) {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `agentic-core-${version}-${day}-${revision}.tar.gz`;
}

async function revision() {
  try {
    const { stdout } = await run("git", ["rev-parse", "--short=9", "HEAD"], { cwd: root });
    const { stdout: status } = await run("git", ["status", "--porcelain"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    return `${stdout.trim()}${status.trim() ? "-dirty" : ""}`;
  } catch { return "nogit"; }
}

/**
 * The archive is built by GNU tar, and only GNU tar.
 *
 * `--transform`, `--sort` and `--mtime` are what make the output reproducible and give it a
 * single root directory; bsdtar — which is what `tar.exe` is on Windows — has none of them and
 * fails with an error about the options rather than about the situation. Saying so here costs
 * one command and replaces a confusing failure with an instruction.
 */
async function requireGnuTar() {
  let version = "";
  try { version = (await run("tar", ["--version"])).stdout; }
  catch { throw new Error("tar was not found on PATH. Package from Linux, macOS or WSL."); }
  if (!/GNU tar/u.test(version)) {
    throw new Error(
      `This packager needs GNU tar; found: ${version.split("\n")[0]}.\n`
      + "On Windows run it from WSL, or install GNU tar and put it ahead of tar.exe on PATH.");
  }
}

const rawArgs = process.argv.slice(2);
const argv = new Set(rawArgs);
await requireGnuTar();
const allowSuspicious = argv.has("--allow-suspicious");
const files = await sourceFiles();
const { included, excluded } = partition(files);
if (included.length === 0) throw new Error("No source files were selected; is this a git repository?");

const dangling = await auditDanglingReferences(included);
if (dangling.length > 0) {
  console.error(`References that would break in the package:\n${dangling.map((item) => `- ${item}`).join("\n")}`);
  console.error("\nRefusing to package. Either include what they point at, or stop pointing at it.");
  process.exit(1);
}

const findings = await auditSecrets(included);
if (findings.length > 0) {
  console.error(`Possible secrets in the archive contents:\n${findings.map((item) => `- ${item}`).join("\n")}`);
  if (!allowSuspicious) {
    console.error("\nRefusing to package. Remove them, or re-run with --allow-suspicious if every line above is a placeholder.");
    process.exit(1);
  }
  console.error("\nPackaging anyway because --allow-suspicious was given.\n");
}

const packageJsonRaw = await readFile(resolve(root, "package.json"), "utf8");
const manifest = JSON.parse(packageJsonRaw);
const head = await revision();
const output = resolve(root, "dist-package");
const archive = resolve(output, archiveName(manifest.version, head));
const listing = resolve(output, ".package-files");
if (output !== resolve(root, "dist-package")) throw new Error("Invalid package output path");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const stagedFiles = included;
const tarDirectory = root;
await writeFile(listing, `${stagedFiles.join("\n")}\n`, "utf8");

const prefix = basename(archive, ".tar.gz");
await run("tar", [
  "--create", "--gzip", "--file", archive,
  "--directory", tarDirectory,
  // Reproducible: same source, same bytes, so the digest below is worth comparing.
  "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
  "--transform", `s,^,${prefix}/,`,
  // `--no-recursion` is positional in GNU tar: it only affects the arguments after it, so it
  // has to precede the list it is meant to govern.
  "--no-recursion", "--files-from", listing,
], { maxBuffer: 64 * 1024 * 1024 });
await rm(listing, { force: true });

const bytes = (await stat(archive)).size;
const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
console.log(`Packaged ${stagedFiles.length} files into ${archive.replace(`${root}/`, "")}`);
console.log(`  size    ${(bytes / 1024 / 1024).toFixed(2)} MiB`);
console.log(`  sha256  ${digest}`);
console.log(`  root    ${prefix}/`);
for (const [reason, count] of excluded) console.log(`  omitted ${count} files: ${reason}`);
console.log("  omitted build output, dependencies and local secrets: everything .gitignore covers");
console.log("\nUnpack into an EMPTY directory (or run `npm run clean` first), then: npm ci && npm run build && npm test");
console.log("  Files carry mtime 1970 on purpose; over an old checkout `tsc -b` sees stale dist/ as up to date and fails with TS2305/TS2339.");
