import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export interface ElkAuthConfig {
  readonly kind: "none" | "api-key" | "basic";
  /** Name of the environment variable holding the credential, never the credential itself. */
  readonly apiKeyEnv?: string;
  readonly usernameEnv?: string;
  readonly passwordEnv?: string;
}

export interface ElkConfig {
  readonly enabled: boolean;
  readonly endpoint: string;
  /**
   * How a batch is framed on the wire.
   *
   * `bulk` is Elasticsearch's `_bulk`: ndjson where every document is preceded by its own
   * action line. `ndjson` is the same documents with no action lines, one per line, which is
   * what Logstash's `http` input reads with `codec => json_lines` and what most collectors in
   * front of Elasticsearch expect. Sending `bulk` at Logstash would feed it the action lines as
   * if they were events; sending a single wrapped JSON array would make one batch arrive as one
   * event and need a `split` filter to undo.
   */
  readonly mode: "bulk" | "ndjson";
  readonly dataStream: string;
  readonly auth: ElkAuthConfig;
  readonly batch: { readonly maxEvents: number; readonly maxBytes: number; readonly flushIntervalMs: number };
  readonly queue: { readonly maxEvents: number };
  readonly timeoutMs: number;
  readonly retry: { readonly attempts: number; readonly baseDelayMs: number };
  readonly allowInsecureInternal: boolean;
  /** Static fields stamped on every document, for example service name and environment. */
  readonly fields: Readonly<Record<string, string>>;
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

/**
 * Credentials are named, never written down.
 *
 * A config file lives in the repository, in an image layer and in whatever ticket someone
 * pasted it into. So this accepts the *name* of an environment variable and refuses a literal
 * secret outright: a rejected deploy is a much cheaper way to find that out than a log
 * shipper's password in a git history.
 */
function auth(value: unknown): ElkAuthConfig {
  const source = record(value, "auth");
  for (const forbidden of ["apiKey", "api_key", "username", "password", "token"]) {
    if (source[forbidden] !== undefined) {
      throw new Error(`elk.yaml must not contain a literal ${forbidden}; use ${forbidden}Env to name an environment variable`);
    }
  }
  const kind = source.kind === undefined ? "none" : text(source.kind, "auth.kind", /^(none|api-key|basic)$/u);
  if (kind === "api-key") {
    return Object.freeze({ kind, apiKeyEnv: text(source.apiKeyEnv, "auth.apiKeyEnv", /^[A-Z][A-Z0-9_]{0,63}$/u) });
  }
  if (kind === "basic") {
    return Object.freeze({
      kind,
      usernameEnv: text(source.usernameEnv, "auth.usernameEnv", /^[A-Z][A-Z0-9_]{0,63}$/u),
      passwordEnv: text(source.passwordEnv, "auth.passwordEnv", /^[A-Z][A-Z0-9_]{0,63}$/u),
    });
  }
  return Object.freeze({ kind: "none" });
}

function endpoint(value: unknown, allowInsecureInternal: boolean): string {
  const raw = text(value, "endpoint");
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("endpoint is not a valid URL"); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("endpoint must be http:// or https://");
  if (parsed.protocol === "http:" && !allowInsecureInternal) {
    throw new Error("endpoint must be https:// unless allowInsecureInternal is explicitly enabled");
  }
  if (parsed.username || parsed.password) throw new Error("endpoint must not embed credentials");
  return parsed.href;
}

/**
 * Static stamps copied onto every document. The adapter gives no field a meaning.
 * An empty or whitespace-only value (a copied template often leaves one blank) is not stamped;
 * a non-string value or an invalid field name is still refused.
 */
function fields(value: unknown): Readonly<Record<string, string>> {
  const source = record(value, "fields");
  const resolved: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(key)) throw new Error(`fields.${key} is not a valid field name`);
    if (typeof item === "string" && item.trim() === "") continue;
    resolved[key] = text(item, `fields.${key}`).slice(0, 256);
  }
  return Object.freeze(resolved);
}

export function parseElkConfig(source: string): ElkConfig {
  let document: unknown;
  try { document = parse(source); } catch (error) {
    throw new Error(`elk.yaml is not valid YAML: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const root = record(document, "elk.yaml");
  const enabled = boolean(root.enabled, "enabled", true);
  const allowInsecureInternal = boolean(root.allowInsecureInternal, "allowInsecureInternal", false);
  const batch = record(root.batch, "batch");
  const retry = record(root.retry, "retry");
  return Object.freeze({
    enabled,
    endpoint: endpoint(root.endpoint, allowInsecureInternal),
    mode: root.mode === undefined ? "bulk" : text(root.mode, "mode", /^(bulk|ndjson)$/u) as "bulk" | "ndjson",
    dataStream: text(root.dataStream ?? "gateway-agent-logs", "dataStream", /^[a-z0-9][a-z0-9._-]{0,127}$/u),
    auth: auth(root.auth),
    batch: Object.freeze({
      maxEvents: integer(batch.maxEvents, "batch.maxEvents", 200, 1, 10_000),
      maxBytes: integer(batch.maxBytes, "batch.maxBytes", 1024 * 1024, 4_096, 64 * 1024 * 1024),
      flushIntervalMs: integer(batch.flushIntervalMs, "batch.flushIntervalMs", 5_000, 100, 600_000),
    }),
    queue: Object.freeze({ maxEvents: integer(record(root.queue, "queue").maxEvents, "queue.maxEvents", 10_000, 10, 1_000_000) }),
    timeoutMs: integer(root.timeoutMs, "timeoutMs", 5_000, 250, 60_000),
    retry: Object.freeze({
      attempts: integer(retry.attempts, "retry.attempts", 3, 1, 10),
      baseDelayMs: integer(retry.baseDelayMs, "retry.baseDelayMs", 200, 10, 60_000),
    }),
    allowInsecureInternal,
    fields: fields(root.fields),
  });
}

/** Reads the file, or reports that it is absent rather than guessing a default endpoint. */
export async function loadElkConfig(path: string): Promise<ElkConfig | undefined> {
  let source: string;
  try { source = await readFile(path, "utf8"); }
  catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseElkConfig(source);
}

export function elkAuthorizationHeader(config: ElkConfig, env: NodeJS.ProcessEnv): string | undefined {
  if (config.auth.kind === "api-key") {
    const key = env[config.auth.apiKeyEnv!]?.trim();
    if (!key) throw new Error(`${config.auth.apiKeyEnv} is not set, and elk.yaml selects api-key authentication`);
    return `ApiKey ${key}`;
  }
  if (config.auth.kind === "basic") {
    const username = env[config.auth.usernameEnv!]?.trim();
    const password = env[config.auth.passwordEnv!] ?? "";
    if (!username) throw new Error(`${config.auth.usernameEnv} is not set, and elk.yaml selects basic authentication`);
    return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  }
  return undefined;
}
