import { noticeOnce, readSetting, readSettingSource, type SettingLog, type SettingsEnv } from "@0xsyncroot/env-settings";
import { parseRedisUrl } from "./parse-url.js";

/**
 * Which Redis each concern talks to, read the same way by every product and the platform.
 *
 * Deployments differ on this and both answers are legitimate: one instance for everything on a
 * small install, or a separate instance per concern so a flood of stream journals cannot evict
 * another concern's leases. So a concern reads its own `<CONCERN>_REDIS_URL`, falls back to the
 * shared `REDIS_URL`, and an error says plainly which setting was missing — rather than a single
 * global client that forces one topology on every operator.
 *
 * The names are plain infrastructure names on purpose: a concern such as the stream journal or
 * turn admission exists in every product, and one `.env` serves them all. Key prefixes are what
 * keeps two products apart on one Redis, so each concern brings its own default prefix. The
 * product-prefixed names these replaced (`<PRODUCT>_REDIS_URL`, `<PRODUCT>_<CONCERN>_REDIS_URL`,
 * …) are still read, with one warning each, through the concern's `legacyPrefix`.
 */
export interface RedisEndpoint {
  readonly url: string;
  readonly keyPrefix: string;
  readonly allowInsecureInternal: boolean;
}

export interface RedisConcern {
  /** Lower-case concern id; `stream` reads `STREAM_REDIS_URL` and `STREAM_REDIS_KEY_PREFIX`. */
  readonly id: string;
  /** Key prefix when `<CONCERN>_REDIS_KEY_PREFIX` is unset. */
  readonly defaultKeyPrefix: string;
  /** Prefix of the retired names this concern still reads, e.g. `ACME` for `ACME_STREAM_REDIS_URL` and `ACME_REDIS_URL`. */
  readonly legacyPrefix?: string;
}

export interface RedisTopologyOptions {
  /** Where retired-name warnings and the development-default notice go; defaults to the process log. */
  readonly log?: SettingLog;
  /**
   * Development only, so a local start needs no Redis settings: a required concern with no URL
   * uses the local compose Redis (`LOCAL_DEVELOPMENT_REDIS_URL`, started by `npm run db:up`), and
   * a plaintext URL that names only loopback hosts needs no switch. Production never sets this:
   * there a missing URL is a refusal and plaintext is an explicit decision.
   */
  readonly development?: boolean;
}

/** The Redis `deploy/local/compose.yml` publishes on the host. */
export const LOCAL_DEVELOPMENT_REDIS_URL = "redis://127.0.0.1:56379/0";

const KEY_PREFIX = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/u;
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/u;

/** Plaintext to a process on this machine never crosses a network; anything else is a deployment decision. */
function loopbackPlaintext(url: string): boolean {
  try {
    const target = parseRedisUrl(url);
    return !target.tls && target.nodes.every((node) => LOOPBACK.test(node.host));
  } catch {
    return false;
  }
}

/** The setting names one concern reads, for messages and documentation. */
export function redisConcernSettings(concern: RedisConcern): { readonly url: string; readonly keyPrefix: string } {
  const name = concern.id.toUpperCase();
  return { url: `${name}_REDIS_URL`, keyPrefix: `${name}_REDIS_KEY_PREFIX` };
}

/**
 * The endpoint for one concern, or nothing when the deployment has not configured Redis at all.
 *
 * A missing URL is not an error here: whoever needs the concern says so at that point, where the
 * message can name the concern the operator forgot (`requiredRedisEndpoint`).
 */
export function redisEndpoint(env: SettingsEnv, concern: RedisConcern, options: RedisTopologyOptions = {}): RedisEndpoint | undefined {
  const names = redisConcernSettings(concern);
  const retired = (name: string): readonly string[] => concern.legacyPrefix ? [`${concern.legacyPrefix}_${name}`] : [];
  const log = options.log ? { log: options.log } : {};
  const read = (name: string, legacy: readonly string[]) => readSetting(env, name, { legacy, ...log });
  const url = read(names.url, retired(names.url)) ?? read("REDIS_URL", retired("REDIS_URL"));
  if (!url) return undefined;
  const keyPrefix = read(names.keyPrefix, retired(names.keyPrefix)) ?? concern.defaultKeyPrefix;
  if (!KEY_PREFIX.test(keyPrefix)) throw new Error(`${names.keyPrefix} is invalid`);
  // One plaintext switch for every concern. The retired per-concern switch still overrides the
  // retired shared one, as it did, until the operator moves to the single name.
  const insecureLegacy = [...retired(`${concern.id.toUpperCase()}_REDIS_ALLOW_INSECURE_INTERNAL`), ...retired("REDIS_ALLOW_INSECURE_INTERNAL")];
  const insecure = readSettingSource(env, "REDIS_ALLOW_INSECURE_INTERNAL", { legacy: insecureLegacy, ...log });
  const switchValue = insecure?.value.toLowerCase();
  if (switchValue !== undefined && switchValue !== "true" && switchValue !== "false") throw new Error(`${insecure!.name} must be true or false`);
  const allowInsecureInternal = switchValue === undefined
    ? options.development === true && loopbackPlaintext(url)
    : switchValue === "true";
  return Object.freeze({ url, keyPrefix, allowInsecureInternal });
}

/**
 * Like `redisEndpoint`, but a missing URL is a refusal naming the settings; `owner` names who
 * needs it. In development the local compose Redis stands in, with one notice in the log.
 */
export function requiredRedisEndpoint(
  env: SettingsEnv, concern: RedisConcern, owner: string, options: RedisTopologyOptions = {},
): RedisEndpoint {
  const endpoint = redisEndpoint(env, concern, options);
  if (endpoint) return endpoint;
  if (options.development) {
    noticeOnce("redis-development-default", `no REDIS_URL is set; development uses the local Redis at ${LOCAL_DEVELOPMENT_REDIS_URL} `
      + "(npm run db:up starts it)", options.log);
    return redisEndpoint({ ...env, REDIS_URL: LOCAL_DEVELOPMENT_REDIS_URL }, concern, options)!;
  }
  throw new Error(`${owner} requires Redis for ${concern.id}: set ${redisConcernSettings(concern).url} or REDIS_URL`);
}
