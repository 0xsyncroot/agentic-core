import { Readable } from "node:stream";
import { readSetting, type SettingLog, type SettingsEnv } from "@0xsyncroot/env-settings";
import { Client } from "minio";

/** S3-compatible byte storage. Callers own content validation, authorization and key-prefix policy; the adapter preserves bytes and declared content types. */
export interface S3Config {
  readonly endPoint: string;
  readonly port?: number;
  readonly useSSL: boolean;
  readonly accessKey: string;
  readonly secretKey: string;
  /** SigV4 signing region. AWS requires the bucket region; compatible deployments commonly use us-east-1. */
  readonly region: string;
  readonly bucket: string;
  /** Selects path-style (endpoint/bucket/key) or virtual-hosted (bucket.endpoint/key) addressing. The endpoint supplies a default that deployments may override. */
  readonly pathStyle: boolean;
}

export interface S3ObjectInfo {
  readonly key: string;
  readonly size: number;
  readonly lastModified?: Date;
  readonly etag?: string;
}

export interface S3ObjectStat {
  readonly size: number;
  readonly contentType?: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface PutObjectOptions {
  /** Content type supplied by the caller, never inferred from a filename extension. */
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Normalize nonempty key prefixes with a trailing slash so sibling names cannot match accidentally. */
export function normalizeKeyPrefix(value: string | undefined): string {
  const trimmed = (value ?? "").trim().replace(/^\/+/u, "");
  return trimmed && !trimmed.endsWith("/") ? `${trimmed}/` : trimmed;
}

/** Shared S3 settings and supported legacy aliases. Conflicting current and legacy values are rejected; migration warnings never include credentials. */
export const S3_ENV_PREFIX = "S3";
export const RETIRED_S3_ENV_PREFIXES: readonly string[] = Object.freeze(["AGENTIC_KNOWLEDGE_S3", "AGENTIC_S3"]);

export interface S3ConfigOptions {
  /** Receives legacy-setting warnings; defaults to the process logger. */
  readonly log?: SettingLog;
}

/** Read the supplied environment object. Return undefined only when entirely unconfigured; partial configuration fails closed. Custom prefixes describe independent stores. */
export function s3Config(env: SettingsEnv, requested = S3_ENV_PREFIX, options: S3ConfigOptions = {}): S3Config | undefined {
  const shared = requested === S3_ENV_PREFIX || RETIRED_S3_ENV_PREFIXES.includes(requested);
  const prefix = shared ? S3_ENV_PREFIX : requested;
  const retired = shared ? [...new Set([requested, ...RETIRED_S3_ENV_PREFIXES])].filter((name) => name !== S3_ENV_PREFIX) : [];
  const read = (name: string) => readSetting(env, `${prefix}_${name}`, {
    legacy: retired.map((old) => `${old}_${name}`), ...(options.log ? { log: options.log } : {}),
  });
  const endpoint = read("ENDPOINT");
  const bucket = read("BUCKET");
  const accessKey = read("ACCESS_KEY");
  const secretKey = read("SECRET_KEY");
  if (!endpoint && !bucket && !accessKey && !secretKey) return undefined;

  const missing = [["ENDPOINT", endpoint], ["BUCKET", bucket], ["ACCESS_KEY", accessKey], ["SECRET_KEY", secretKey]]
    .filter(([, value]) => !value).map(([name]) => `${prefix}_${name}`);
  if (missing.length > 0) throw new Error(`Object storage is partly configured; missing ${missing.join(", ")}`);
  // A folder is a key prefix, not part of the bucket name; fail with an actionable configuration error.
  if (bucket!.includes("/")) {
    const [name, ...path] = bucket!.split("/");
    throw new Error(`${prefix}_BUCKET must be a bucket name only, got "${bucket}"; `
      + `set ${prefix}_BUCKET=${name} and ${prefix}_PREFIX=${normalizeKeyPrefix(path.join("/"))}`);
  }

  // Accept explicit schemes and host:port endpoints while keeping URL parsing unambiguous.
  const hasScheme = /^https?:\/\//u.test(endpoint!);
  const url = hasScheme ? new URL(endpoint!) : new URL(`https://${endpoint}`);
  const port = url.port ? Number(url.port) : undefined;
  const isAws = /(^|\.)amazonaws\.com$/u.test(url.hostname);

  // Default schemeless endpoints to TLS unless explicitly local; never silently send credentials over remote plaintext.
  const localHost = /^(localhost|127(\.\d+){3}|\[::1\]|0\.0\.0\.0)$/u.test(url.hostname);
  const useSSL = read("USE_SSL") ? read("USE_SSL") === "true"
    : hasScheme ? url.protocol === "https:" : !localHost;

  const pathStyleSetting = read("PATH_STYLE");
  return {
    endPoint: url.hostname,
    ...(port !== undefined ? { port } : {}),
    useSSL,
    accessKey: accessKey!, secretKey: secretKey!,
    region: read("REGION") ?? "us-east-1",
    bucket: bucket!,
    // Use virtual-hosted addressing for AWS and path-style for compatible endpoints unless explicitly overridden.
    pathStyle: pathStyleSetting ? pathStyleSetting === "true" : !isAws,
  };
}

export class S3ObjectStore {
  readonly #client: Client;
  readonly #bucket: string;
  readonly #region: string;

  constructor(config: S3Config) {
    this.#client = new Client({
      endPoint: config.endPoint, useSSL: config.useSSL, accessKey: config.accessKey, secretKey: config.secretKey,
      region: config.region, pathStyle: config.pathStyle,
      ...(config.port !== undefined ? { port: config.port } : {}),
    });
    this.#bucket = config.bucket;
    this.#region = config.region;
  }

  get bucket(): string { return this.#bucket; }

  /** Create the bucket only at an operator's explicit request. Ordinary writes must not silently create a misspelled destination or require administrative permissions. */
  async ensureBucket(): Promise<void> {
    if (await this.#client.bucketExists(this.#bucket)) return;
    await this.#client.makeBucket(this.#bucket, this.#region);
  }

  /** List objects beneath a prefix in deterministic key order. */
  async list(prefix = ""): Promise<readonly S3ObjectInfo[]> {
    const found: S3ObjectInfo[] = [];
    for await (const item of this.#client.listObjectsV2(this.#bucket, prefix, true)) {
      const entry = item as { name?: string; size?: number; lastModified?: Date; etag?: string };
      if (!entry.name) continue;
      found.push({
        key: entry.name, size: entry.size ?? 0,
        ...(entry.lastModified ? { lastModified: entry.lastModified } : {}),
        ...(entry.etag ? { etag: entry.etag } : {}),
      });
    }
    return found.sort((left, right) => left.key.localeCompare(right.key));
  }

  /** Return original object bytes, enforcing maxBytes while reading rather than after buffering the entire object. */
  async get(key: string, maxBytes = 25 * 1024 * 1024): Promise<Buffer> {
    const stream = await this.#client.getObject(this.#bucket, key);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) throw new Error(`Object ${key} exceeds ${maxBytes} bytes`);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  async getText(key: string, maxBytes?: number): Promise<string> {
    return (await this.get(key, maxBytes)).toString("utf8");
  }

  async put(key: string, body: Buffer | Readable, options: PutObjectOptions = {}): Promise<void> {
    const headers: Record<string, string> = { ...(options.metadata ?? {}) };
    if (options.contentType) headers["Content-Type"] = options.contentType;
    const size = Buffer.isBuffer(body) ? body.length : undefined;
    await this.#client.putObject(this.#bucket, key, body, size, headers);
  }

  /**
   * Content type and user metadata of one object, or `undefined` when it does not exist — the
   * caller decides whether a missing object is an error. Metadata keys arrive lowercased, without
   * the `x-amz-meta-` prefix.
   */
  async stat(key: string): Promise<S3ObjectStat | undefined> {
    try {
      const info = await this.#client.statObject(this.#bucket, key);
      const metadata: Record<string, string> = {};
      let contentType: string | undefined;
      for (const [name, value] of Object.entries(info.metaData ?? {})) {
        const lower = name.toLowerCase();
        if (lower === "content-type") contentType = String(value);
        else metadata[lower.replace(/^x-amz-meta-/u, "")] = String(value);
      }
      return { size: info.size, ...(contentType ? { contentType } : {}), metadata };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "NotFound" || code === "NoSuchKey") return undefined;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await this.#client.removeObject(this.#bucket, key);
  }
}
