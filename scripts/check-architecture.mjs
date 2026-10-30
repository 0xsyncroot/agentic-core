import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { commentViolations } from "./comment-gate.mjs";

const root = resolve(import.meta.dirname, "..");
const productBiasPattern = /sample-app|government|hồ sơ|thủ tục|phê duyệt|ký số/iu;
/**
 * Files allowed past the source line limit, each with the reason it cannot be split.
 *
 * An exception is only honest while it is still needed, so an entry whose file has gone or has
 * come back under the limit is itself a violation: the list cannot quietly become the place
 * where the limit goes to die.
 */
const sourceLimitExceptions = new Map([
  ["apps/widget/src/core/widget.ts",
    "Predates the 300-line rule; builder rule 6 exempts only this file, and only to shrink — new "
    + "widget logic goes in new modules, never back into this one."],
]);
const concreteCoreBiasPattern = /deepseek|openai|anthropic|plan_update|plan_mark|knowledge_search|memory_search|skill_load/iu;

/**
 * Every Vietnamese letter that only exists with a diacritic — the alphabet's own tone/quality
 * marks, not the broader Latin-1/Extended-A accent set other languages also use. Precise on
 * purpose: this gates owner rule 3 ("chat shows only Vietnamese business sentences, and those
 * live in products/sample-app"; core and plugins-base write English), so a false positive on some
 * unrelated accented Latin letter would be its own kind of unreliable gate.
 */
const VIETNAMESE_DIACRITIC = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ]/u;
/**
 * String literals a caller may legitimately need to flag as an exception to `VIETNAMESE_DIACRITIC`
 * (§3.6: "scripts/check-architecture.mjs gains a Vietnamese-diacritics scan over packages/core and
 * packages/plugins-base src"), each with the reason the text belongs there anyway.
 */
const diacriticExceptions = new Map([
  ["packages/core/src/agent/human-interaction-validator.ts",
    "SENSITIVE_FIELD (the secret-field detector) matches the Vietnamese spelling of \"mật khẩu\" "
    + "(password) too, so a field asking for it in either language is refused as external-only — "
    + "the one runtime string that has to contain the word, in whichever language names it."],
]);

/**
 * First/second-person Vietnamese persona markers: the agent calling itself "Em" and addressing the
 * user as "anh/chị" — Sample App's own voice, which owner rule 5 and the labels contract (spec §3.7
 * item 5) require the widget to receive from the host, never write itself. The widget's existing,
 * pre-wave Vietnamese UI chrome (button labels, validation sentences, pagination, "Xem lại", "Bỏ
 * qua", …) is neutral instructions, not persona, and is not what this pattern looks for.
 */
const PERSONA_PATTERN = /em\s+sẽ|giúp\s+em|anh\s*\/\s*chị/iu;

/**
 * Passages a comment may keep, each with the reason: a fact the code depends on, an example of the data it reads, or a
 * name the code takes as data that looks like a review round.
 * The rest of the comment is still checked, and a passage no comment holds any more is itself a violation.
 */
const commentExceptions = [
  { path: "packages/adapter-mcp/test/fixtures/stdio-fixture-server.mjs", passage: "Protocol revision 2026-07-28",
    reason: "The protocol revision is a wire identifier used by the fixture." },
];

async function exists(path) {
  try { await readFile(path); return true; } catch { return false; }
}

/**
 * Discover every workspace package, including grouped package directories and packages nested inside a
 * product (products/<name>/admin-api): a nested package is its own record, checked against its own layer.
 */
async function discoverPackages(path) {
  const manifestPath = resolve(path, "package.json");
  const found = await exists(manifestPath) ? [{ path, manifestPath }] : [];
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); }
  catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return found;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === "dist") continue;
    found.push(...await discoverPackages(resolve(path, entry.name)));
  }
  return found;
}

async function sourceFiles(path) {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(child));
    else if (entry.isFile() && /\.(?:ts|js|vue)$/u.test(entry.name)) files.push(child);
  }
  return files;
}

/** A `/` right after one of these (the last non-space character emitted so far) divides; anywhere else it opens a regex literal. */
const DIVISION_PRECEDING = /[A-Za-z0-9_$)\]]$/u;

/**
 * Drops comments while leaving string/template/regex literal content untouched, so a hygiene scan
 * sees runtime-authored text but not developer prose that happens to quote or describe it (this
 * file's own comments explain the persona pattern using the very words it looks for). Regex
 * literals need their own case, not just strings: one written with a backtick or quote inside a
 * character class (this repo has `/^\s*```/`, a Markdown-fence test) desyncs a walker that only
 * knows about quotes, and everything after it reads as one giant, wrong "string".
 */
function stripComments(source) {
  let result = "";
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === "//") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    const char = source[index];
    if (char === "\"" || char === "'" || char === "`") {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== char) {
        cursor += source[cursor] === "\\" ? 2 : 1;
      }
      result += source.slice(index, Math.min(cursor + 1, source.length));
      index = cursor + 1;
      continue;
    }
    if (char === "/" && !DIVISION_PRECEDING.test(result.replace(/\s+$/u, ""))) {
      let cursor = index + 1;
      let inClass = false;
      while (cursor < source.length && source[cursor] !== "\n") {
        const current = source[cursor];
        if (current === "\\") { cursor += 2; continue; }
        if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) break;
        cursor += 1;
      }
      if (cursor < source.length && source[cursor] === "/") {
        cursor += 1;
        while (cursor < source.length && /[a-zA-Z]/u.test(source[cursor])) cursor += 1;
        result += source.slice(index, cursor);
        index = cursor;
        continue;
      }
      // No closing "/" before end-of-line: not a regex literal after all (division, or the
      // scan is mid-token from an already-corrupt position) — fall through and copy one char.
    }
    result += char;
    index += 1;
  }
  return result;
}

function policyFor(packagePath, implementationNames) {
  if (packagePath === "packages/contracts") return { allowed: new Set(), shared: true };
  if (packagePath === "packages/plugin-sdk") return { allowed: new Set(["@0xsyncroot/contracts"]), shared: true };
  // Product-neutral Redis client factory (single node, Cluster, Sentinel) that Redis-backed adapters,
  // persistence packages and product backends share instead of each building its own client.
  if (packagePath === "packages/redis-connection") return { allowed: new Set(["@0xsyncroot/env-settings"]), shared: true };
  // Product-neutral reader of named settings (retired-name fallback, conflict refusal, the runtime
  // profile) that the harness, adapters and every product share, so a renamed setting is honoured
  // the same way everywhere. It depends on nothing.
  if (packagePath === "packages/env-settings") return { allowed: new Set(), shared: true, vietnameseFree: true };
  if (packagePath === "packages/core") {
    return { allowed: new Set(["@0xsyncroot/contracts", "@0xsyncroot/plugin-sdk"]), shared: true, neutralCore: true, vietnameseFree: true };
  }
  if (packagePath === "packages/plugins-base") {
    return { allowed: new Set(["@0xsyncroot/contracts", "@0xsyncroot/plugin-sdk"]), shared: true, vietnameseFree: true };
  }
  if (packagePath === "packages/agent-api") {
    // Neutral HTTP/SSE delivery shared by apps/web and every MCP-based product backend: routes,
    // streaming, resumable stream registry, history/projection, identity resolution, error
    // mapping. It ships no product's own business copy — a product supplies its Vietnamese
    // sentences through the package's businessMessages/attachmentOnlyContent options, never by
    // editing this package. @0xsyncroot/plugins-base is allowed (not @0xsyncroot/plugin-sdk, and never
    // @0xsyncroot/core: a delivery layer speaks contracts, not the agent implementation) so this
    // package can re-export AsyncLocalPrincipalCredentialScope rather than every product
    // re-implementing the same PrincipalCredentialScope by hand.
    return { allowed: new Set(["@0xsyncroot/contracts", "@0xsyncroot/plugins-base"]), shared: true, vietnameseFree: true };
  }
  if (/^packages\/(?:adapter-|adapters\/)/u.test(packagePath)) {
    return { allowed: new Set(["@0xsyncroot/contracts", "@0xsyncroot/plugin-sdk", "@0xsyncroot/redis-connection", "@0xsyncroot/env-settings"]), shared: true };
  }
  // Neutral admin-plane handlers (conversation review, masking, statistics, catalog editing) every product's admin-api
  // composes; contracts only, so the admin plane never reaches the kernel or an adapter.
  if (packagePath === "packages/control-api") return { allowed: new Set(["@0xsyncroot/contracts"]), shared: true, vietnameseFree: true };
  if (/^packages\/(?:persistence-|persistence\/)/u.test(packagePath)) {
    return { allowed: new Set(["@0xsyncroot/contracts", "@0xsyncroot/redis-connection", "@0xsyncroot/env-settings"]), shared: true };
  }
  if (packagePath === "apps/harness") return { allowed: new Set(implementationNames), shared: false };
  // Deliberately no "@0xsyncroot/agent-api/fastify" here: apps/web is the plain node:http dev/demo
  // harness and stays that way (spec: "apps/web keeps working on the plain handler"). A product
  // backend opts into the Fastify binding on its own, from the products/* policy below.
  if (packagePath === "apps/web") return { allowed: new Set(["@0xsyncroot/contracts", "@0xsyncroot/harness", "@0xsyncroot/agent-api"]), shared: false };
  if (packagePath === "apps/widget") return { allowed: new Set(), shared: false, personaCheck: true };
  // The admin plane of a product: its own deployable, a composition root that talks to the shared database and the
  // neutral admin handlers. It never imports the product's agent backend (products/<name>/backend) or the kernel.
  if (/^products\/[^/]+\/admin-api$/u.test(packagePath)) {
    return {
      allowed: new Set(["@0xsyncroot/contracts", "@0xsyncroot/control-api", "@0xsyncroot/env-settings", "@0xsyncroot/redis-connection", "@0xsyncroot/persistence-mysql"]),
      shared: false, product: true, sourceRoots: ["src"],
    };
  }
  // The admin UI of a product: a static browser app that only speaks HTTP to its admin-api.
  if (/^products\/[^/]+\/admin-web$/u.test(packagePath)) return { allowed: new Set(), shared: false, product: true, sourceRoots: ["src"] };
  if (packagePath.startsWith("products/")) {
    // "@0xsyncroot/agent-api/fastify" is a distinct import string from "@0xsyncroot/agent-api" as far as this
    // check's exact-match scan is concerned (a subpath export, not a separate package) — listed
    // explicitly so a product can opt into the Fastify HTTP binding (fast-json-stringify on the
    // JSON routes, Fastify's own hardening options) without this check flagging it as a forbidden
    // dependency. The framework choice is the delivery package's own implementation detail; the
    // routing, validation and projection it wraps are the same framework-free code either binding
    // calls into (see packages/agent-api/src/fastify/'s own doc comments).
    return {
      allowed: new Set([
        "@0xsyncroot/contracts", "@0xsyncroot/harness", "@0xsyncroot/plugin-sdk", "@0xsyncroot/agent-api", "@0xsyncroot/agent-api/fastify", "@0xsyncroot/redis-connection",
        "@0xsyncroot/env-settings",
      ]),
      shared: false, product: true,
    };
  }
  return undefined;
}

const discovered = [
  ...await discoverPackages(resolve(root, "packages")),
  ...await discoverPackages(resolve(root, "apps")),
  ...await discoverPackages(resolve(root, "products")),
];
const records = await Promise.all(discovered.map(async (item) => ({
  ...item,
  packagePath: relative(root, item.path).replaceAll("\\", "/"),
  manifest: JSON.parse(await readFile(item.manifestPath, "utf8")),
})));
const packageNames = new Map();
const exercisedExceptions = new Set();
const exercisedDiacriticExceptions = new Set();
const violations = [];
for (const record of records) {
  if (packageNames.has(record.manifest.name)) {
    violations.push(`Duplicate workspace package name ${record.manifest.name}`);
  } else {
    packageNames.set(record.manifest.name, record.packagePath);
  }
}
const implementationNames = records
  .filter((record) => record.packagePath.startsWith("packages/"))
  .map((record) => record.manifest.name);
for (const record of records) {
  const policy = policyFor(record.packagePath, implementationNames);
  if (!policy) {
    violations.push(`${record.packagePath} has no architecture layer classification`);
    continue;
  }
  for (const dependency of Object.keys(record.manifest.dependencies ?? {})) {
    if (dependency.startsWith("@0xsyncroot/") && !policy.allowed.has(dependency)) {
      violations.push(`${record.packagePath}/package.json declares forbidden dependency ${dependency}`);
    }
  }
  const sourceRoots = (policy.sourceRoots ?? (policy.product ? ["backend/src", "frontend"] : ["src"])).map((root) => resolve(record.path, root));
  for (const file of (await Promise.all(sourceRoots.map(sourceFiles))).flat()) {
    const source = await readFile(file, "utf8");
    const lines = source.split("\n");
    const testSource = relative(record.path, file).split(/[\\/]/u).includes("test");
    const relativePath = relative(root, file).replaceAll("\\", "/");
    if (!testSource && policy.sourceLineLimit !== false && lines.length > 300) {
      if (sourceLimitExceptions.has(relativePath)) exercisedExceptions.add(relativePath);
      else violations.push(`${relativePath} has ${lines.length} lines (limit: 300)`);
    } else if (sourceLimitExceptions.has(relativePath)) {
      violations.push(`${relativePath} no longer needs its source-limit exception; remove it from check-architecture.mjs`);
    }
    if (policy.shared && productBiasPattern.test(source)) {
      violations.push(`${relative(root, file)} contains product/domain-specific language in a shared package`);
    }
    if (policy.neutralCore && concreteCoreBiasPattern.test(source)) {
      violations.push(`${relative(root, file)} contains a concrete provider/base-tool identifier in neutral core`);
    }
    if (policy.vietnameseFree) {
      if (VIETNAMESE_DIACRITIC.test(source)) {
        if (diacriticExceptions.has(relativePath)) exercisedDiacriticExceptions.add(relativePath);
        else violations.push(`${relativePath} contains Vietnamese text; core and plugins-base are business-language-free (owner rule: product copy lives only in products/sample-app)`);
      } else if (diacriticExceptions.has(relativePath)) {
        violations.push(`${relativePath} no longer needs its Vietnamese-diacritics exception; remove it from check-architecture.mjs`);
      }
    }
    if (policy.personaCheck && PERSONA_PATTERN.test(stripComments(source))) {
      violations.push(`${relativePath} contains a first/second-person persona literal; the widget is a generic layer and takes persona copy only through the labels contract`);
    }
    if (policy.product && /(?:@0xsyncroot\/web|(?:^|["'/])apps\/web(?:["'/]|$))/mu.test(source)) {
      violations.push(`${relative(root, file)} depends on the demo web application`);
    }
    for (const match of source.matchAll(/(?:from\s+|import\s*)["'](@0xsyncroot\/[^"']+)["']/g)) {
      if (!policy.allowed.has(match[1])) {
        violations.push(`${relative(root, file)} imports forbidden dependency ${match[1]}`);
      }
    }
  }
}

/**
 * An exception can go unexercised two ways, and only one means it is stale: the file shrank
 * under the limit (worth flagging), versus this checkout not carrying that product at all — a
 * sparse clone, or a `--product` handover from scripts/package-source.mjs (not a reason to touch
 * a file this run cannot see).
 */
async function belongsToAbsentProduct(path) {
  const product = /^products\/([^/]+)\//u.exec(path)?.[1];
  return product !== undefined && !(await exists(resolve(root, "products", product)));
}

const comments = commentViolations(root, commentExceptions);
violations.push(...comments.violations);
for (const { path, passage } of comments.unused) {
  if (await belongsToAbsentProduct(path)) continue;
  violations.push(`${path} has a comment exception for ${JSON.stringify(passage)} that no comment holds; remove it from check-architecture.mjs`);
}
for (const [path] of sourceLimitExceptions) {
  if (exercisedExceptions.has(path) || await belongsToAbsentProduct(path)) continue;
  violations.push(`${path} has a source-limit exception but was not found; remove it from check-architecture.mjs`);
}
for (const [path] of diacriticExceptions) {
  if (exercisedDiacriticExceptions.has(path) || await belongsToAbsentProduct(path)) continue;
  violations.push(`${path} has a Vietnamese-diacritics exception but was not found; remove it from check-architecture.mjs`);
}
if (violations.length > 0) {
  console.error(`Architecture boundary violations:\n${violations.map((item) => `- ${item}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Architecture boundaries: OK (${records.length} workspace packages classified)`);
}
