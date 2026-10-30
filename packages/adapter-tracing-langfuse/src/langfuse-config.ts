import { readFile } from "node:fs/promises";
import { parse } from "yaml";

/**
 * How much of a model call is allowed to leave the service.
 *
 * `metadata-only` is the default, and the default matters: an agent that reads payroll would
 * otherwise copy salaries, names and identifiers into a second system the moment tracing is
 * switched on. Shape, timing, token counts and the request's own content hash answer almost
 * every question an engineer asks of a trace — which step was slow, which one looped, whether
 * two runs saw the same input — without moving the data itself.
 */
export type LangfuseCapture = "metadata-only" | "full";

export interface LangfuseConfig {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly publicKeyEnv: string;
  readonly secretKeyEnv: string;
  readonly capture: LangfuseCapture;
  readonly environment: string;
  readonly release?: string;
  readonly batch: { readonly maxEvents: number; readonly flushIntervalMs: number };
  readonly queue: { readonly maxEvents: number };
  readonly timeoutMs: number;
  readonly retry: { readonly attempts: number; readonly baseDelayMs: number };
  readonly allowInsecureInternal: boolean;
  readonly tags: readonly string[];
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a mapping`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, pattern?: RegExp): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  const resolved = value.trim();
  if (pattern && !pattern.test(resolved)) throw new Error(`${name} is invalid`);
  return resolved;
}

function integer(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be true or false`);
  return value;
}

export function parseLangfuseConfig(source: string): LangfuseConfig {
  let document: unknown;
  try { document = parse(source); } catch (error) {
    throw new Error(`langfuse.yaml is not valid YAML: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const root = record(document, "langfuse.yaml");
  for (const forbidden of ["publicKey", "secretKey", "apiKey", "password"]) {
    if (root[forbidden] !== undefined) {
      throw new Error(`langfuse.yaml must not contain a literal ${forbidden}; use ${forbidden}Env to name an environment variable`);
    }
  }
  const allowInsecureInternal = boolean(root.allowInsecureInternal, "allowInsecureInternal", false);
  let parsedUrl: URL;
  try { parsedUrl = new URL(text(root.baseUrl, "baseUrl")); } catch { throw new Error("baseUrl is not a valid URL"); }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") throw new Error("baseUrl must be http:// or https://");
  if (parsedUrl.protocol === "http:" && !allowInsecureInternal) {
    throw new Error("baseUrl must be https:// unless allowInsecureInternal is explicitly enabled");
  }
  if (parsedUrl.username || parsedUrl.password) throw new Error("baseUrl must not embed credentials");
  const batch = record(root.batch, "batch");
  const retry = record(root.retry, "retry");
  const tags = root.tags === undefined ? [] : (() => {
    if (!Array.isArray(root.tags)) throw new Error("tags must be a sequence");
    return root.tags.map((item, index) => text(item, `tags[${index}]`, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u));
  })();
  return Object.freeze({
    enabled: boolean(root.enabled, "enabled", true),
    baseUrl: parsedUrl.href.replace(/\/+$/u, ""),
    publicKeyEnv: text(root.publicKeyEnv, "publicKeyEnv", /^[A-Z][A-Z0-9_]{0,63}$/u),
    secretKeyEnv: text(root.secretKeyEnv, "secretKeyEnv", /^[A-Z][A-Z0-9_]{0,63}$/u),
    capture: root.capture === undefined
      ? "metadata-only" : text(root.capture, "capture", /^(metadata-only|full)$/u) as LangfuseCapture,
    environment: text(root.environment ?? "development", "environment", /^[a-z0-9][a-z0-9._-]{0,63}$/u),
    ...(root.release === undefined ? {} : { release: text(root.release, "release") }),
    batch: Object.freeze({
      maxEvents: integer(batch.maxEvents, "batch.maxEvents", 100, 1, 5_000),
      flushIntervalMs: integer(batch.flushIntervalMs, "batch.flushIntervalMs", 3_000, 100, 600_000),
    }),
    queue: Object.freeze({ maxEvents: integer(record(root.queue, "queue").maxEvents, "queue.maxEvents", 5_000, 10, 1_000_000) }),
    timeoutMs: integer(root.timeoutMs, "timeoutMs", 5_000, 250, 60_000),
    retry: Object.freeze({
      attempts: integer(retry.attempts, "retry.attempts", 3, 1, 10),
      baseDelayMs: integer(retry.baseDelayMs, "retry.baseDelayMs", 200, 10, 60_000),
    }),
    allowInsecureInternal,
    tags: Object.freeze(tags),
  });
}

export async function loadLangfuseConfig(path: string): Promise<LangfuseConfig | undefined> {
  let source: string;
  try { source = await readFile(path, "utf8"); }
  catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseLangfuseConfig(source);
}

export function langfuseAuthorizationHeader(config: LangfuseConfig, env: NodeJS.ProcessEnv): string {
  const publicKey = env[config.publicKeyEnv]?.trim();
  const secretKey = env[config.secretKeyEnv]?.trim();
  if (!publicKey || !secretKey) {
    throw new Error(`${config.publicKeyEnv} and ${config.secretKeyEnv} must both be set for Langfuse tracing`);
  }
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`, "utf8").toString("base64")}`;
}
