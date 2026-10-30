#!/usr/bin/env node
/**
 * Transfer files to and from an S3-compatible object store.
 *
 * node scripts/s3.mjs push <local-path> [<prefix>] [--content-type=...] [--ensure-bucket] [--dry-run] [--prune]
 * node scripts/s3.mjs pull <prefix> <local-directory>
 * node scripts/s3.mjs ls [<prefix>]
 *
 * Uses S3_* settings, or --env-prefix=<PREFIX> for a separate store.
 * An omitted upload prefix uses the same configured prefix as the runtime reader.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { RETIRED_S3_ENV_PREFIXES, S3ObjectStore, S3_ENV_PREFIX, normalizeKeyPrefix, s3Config } from "@0xsyncroot/adapter-s3";
import { readSetting } from "@0xsyncroot/env-settings";

// Common MIME defaults, not a file-type allowlist. Explicit flags override them.
const CONTENT_TYPES = {
  ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".json": "application/json", ".csv": "text/csv; charset=utf-8", ".pdf": "application/pdf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function flag(args, name) {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : undefined;
}

async function filesUnder(path) {
  const info = await stat(path);
  if (info.isFile()) return [{ absolute: path, relative: basename(path) }];
  const collected = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      for (const nested of await filesUnder(child)) collected.push({ absolute: nested.absolute, relative: `${entry.name}/${nested.relative}` });
    } else if (entry.isFile()) collected.push({ absolute: child, relative: entry.name });
  }
  return collected.sort((left, right) => left.relative.localeCompare(right.relative));
}

const [command, ...rest] = process.argv.slice(2);
const args = rest.filter((arg) => !arg.startsWith("--"));
const requestedPrefix = flag(rest, "env-prefix") ?? S3_ENV_PREFIX;
// Retired prefixes select the shared store; other prefixes select a separate store.
const envPrefix = RETIRED_S3_ENV_PREFIXES.includes(requestedPrefix) ? S3_ENV_PREFIX : requestedPrefix;
let config;
try { config = s3Config(process.env, requestedPrefix); } catch (error) { console.error(`Configuration error: ${error.message}`); process.exit(2); }
if (!config) {
  console.error(`Object storage requires ${envPrefix}_ENDPOINT, _BUCKET, _ACCESS_KEY, _SECRET_KEY.`);
  process.exit(2);
}
const store = new S3ObjectStore(config);
const defaultKeyPrefix = normalizeKeyPrefix(envPrefix === S3_ENV_PREFIX
  ? readSetting(process.env, "S3_PREFIX", { legacy: ["AGENTIC_KNOWLEDGE_S3_PREFIX", "AGENTIC_S3_PREFIX"] })
  : process.env[`${envPrefix}_PREFIX`]);

// Report actionable storage errors without a library stack trace.
process.on("uncaughtException", (error) => {
  const code = error?.code ?? error?.name;
  const guidance = {
    NoSuchBucket: `bucket "${config.bucket}" does not exist; check the name or opt in to creation with --ensure-bucket.`,
    NotFound: `bucket "${config.bucket}" does not exist; check the name or opt in to creation with --ensure-bucket.`,
    ECONNREFUSED: `Cannot connect to ${config.endPoint}:${config.port ?? (config.useSSL ? 443 : 80)} — check the endpoint and network.`,
    EPROTO: `TLS handshake failed with ${config.endPoint} — for a plain HTTP store, set ${envPrefix}_USE_SSL=false or use an explicit http:// endpoint.`,
    AccessDenied: "Access denied; check ACCESS_KEY/SECRET_KEY and bucket permissions.",
    SignatureDoesNotMatch: "Signature mismatch; check SECRET_KEY and REGION.",
  }[code];
  console.error(`Error: ${guidance ?? error?.message ?? String(error)}`);
  process.exit(1);
});

if (command === "push") {
  const [localPath, explicitPrefix] = args;
  const keyPrefix = explicitPrefix === undefined ? defaultKeyPrefix : normalizeKeyPrefix(explicitPrefix);
  if (!localPath) { console.error("push requires <local-path> [<prefix>]"); process.exit(2); }
  const dryRun = rest.includes("--dry-run");
  // Bucket creation requires explicit opt-in; a typo must not create a new bucket.
  if (rest.includes("--ensure-bucket") && !dryRun) await store.ensureBucket();
  const override = flag(rest, "content-type");
  const files = await filesUnder(resolve(localPath));
  const pushed = [];
  console.log(`${dryRun ? "[dry run] " : ""}${config.bucket} · ${config.endPoint}${config.pathStyle ? " (path-style)" : ""}`);
  for (const file of files) {
    const key = `${keyPrefix}${file.relative}`;
    const extension = file.relative.slice(file.relative.lastIndexOf("."));
    const contentType = override ?? CONTENT_TYPES[extension];
    const body = await readFile(file.absolute);
    if (!dryRun) await store.put(key, body, contentType ? { contentType } : {});
    pushed.push({ key, size: body.length });
    console.log(`  ${dryRun ? "·" : "↑"} ${key}  (${body.length} B${contentType ? `, ${contentType}` : ""})`);
  }
  if (dryRun) {
    console.log(`\n[dry run] ${files.length} files would be uploaded; no objects were written.`);
  } else {
    // Read back object sizes to verify uploads instead of trusting successful writes alone.
    const listed = new Map((await store.list(keyPrefix)).map((item) => [item.key, item.size]));
    const mismatches = pushed.filter((item) => listed.get(item.key) !== item.size);
    if (mismatches.length > 0) {
      console.error(`\nVERIFICATION FAILED: ${mismatches.length} files have unexpected sizes after upload:`);
      for (const item of mismatches) console.error(`  ${item.key}: uploaded ${item.size} B, on store ${listed.get(item.key) ?? "(missing)"}`);
      process.exit(1);
    }
    console.log(`\nUploaded and verified ${pushed.length} files by size in ${config.bucket}.`);
    // Report stale remote objects, but delete them only when --prune was explicitly requested.
    const staleKeys = [...listed.keys()].filter((key) => !pushed.some((item) => item.key === key));
    if (staleKeys.length > 0) {
      const prune = rest.includes("--prune");
      console.log(`\n${staleKeys.length} remote files are absent locally:`);
      for (const key of staleKeys) console.log(`  ${prune ? "✗" : "!"} ${key}`);
      if (prune) {
        for (const key of staleKeys) await store.remove(key);
        const remainingKeys = new Set((await store.list(keyPrefix)).map((item) => item.key));
        const undeletedKeys = staleKeys.filter((key) => remainingKeys.has(key));
        if (undeletedKeys.length > 0) {
          console.error(`\nDELETION FAILED: ${undeletedKeys.join(", ")}`);
          process.exit(1);
        }
        console.log(`Deleted ${staleKeys.length} stale files and verified their removal.`);
      } else {
        console.log("Run again with --prune to remove these objects, or retain them if intentional.");
      }
    }
  }
} else if (command === "pull") {
  const [keyPrefix = "", localDir] = args;
  if (!localDir) { console.error("pull requires <prefix> <local-directory>"); process.exit(2); }
  for (const object of await store.list(keyPrefix)) {
    const target = resolve(localDir, object.key.slice(keyPrefix.length));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await store.get(object.key));
    console.log(`  ↓ ${object.key}`);
  }
} else if (command === "ls") {
  for (const object of await store.list(args[0] ?? defaultKeyPrefix)) console.log(`  ${String(object.size).padStart(9)}  ${object.key}`);
} else {
  console.error("Commands: push | pull | ls — see the usage comment at the top of this file.");
  process.exit(2);
}
