/**
 * Redis URL forms accepted by every Redis setting:
 *
 *   redis://[user:pass@]host[:port][/db]                              one node
 *   redis+cluster://[user:pass@]h1:6379,h2:6379[,...]                 Redis Cluster root nodes
 *   redis+sentinel://[user:pass@]s1:26379,s2:26379/<master>[?db=N]    Redis Sentinel
 *
 * Each form also exists with TLS: rediss://, rediss+cluster://, rediss+sentinel://.
 * Credentials apply to the data nodes. Sentinels use their own, optional, credentials from the
 * query parameters `sentinelUsername` and `sentinelPassword`, because a sentinel often has no
 * password at all and an AUTH sent to such a node fails the connection.
 */
export type RedisMode = "standalone" | "cluster" | "sentinel";

export interface RedisHostPort { readonly host: string; readonly port: number }

export interface RedisTarget {
  readonly mode: RedisMode;
  readonly tls: boolean;
  /** Standalone: the normalized `redis://` / `rediss://` URL. */
  readonly url?: string;
  /** Cluster root nodes, or sentinel nodes. */
  readonly nodes: readonly RedisHostPort[];
  readonly username?: string;
  readonly password?: string;
  /** Sentinel only. */
  readonly masterName?: string;
  readonly database?: number;
  readonly sentinelUsername?: string;
  readonly sentinelPassword?: string;
}

export const REDIS_URL_FORMS =
  "redis://host:6379, redis+cluster://h1:6379,h2:6379,h3:6379 or redis+sentinel://s1:26379,s2:26379/<masterName> "
  + "(use rediss, rediss+cluster, rediss+sentinel for TLS)";

const SCHEME = /^(rediss?)(\+cluster|\+sentinel)?:\/\//i;

/** True when the text starts with one of the Redis URL schemes above. */
export function isRedisUrl(value: string): boolean { return SCHEME.test(value.trim()); }

function fail(detail: string): never { throw new Error(`Redis URL is invalid: ${detail}. Expected ${REDIS_URL_FORMS}`); }

function decode(value: string): string | undefined {
  if (value === "") return undefined;
  try { return decodeURIComponent(value); } catch { return fail("credentials are not valid percent-encoding"); }
}

function parseHost(text: string): RedisHostPort {
  const match = /^(\[[0-9a-fA-F:.]+\]|[^\s:/?#@\[\],]+)(?::(\d{1,5}))?$/.exec(text);
  if (!match) return fail(`"${text}" is not host or host:port`);
  const host = match[1]!.replace(/^\[|\]$/g, "");
  const port = match[2] === undefined ? undefined : Number(match[2]);
  if (port !== undefined && (port < 1 || port > 65_535)) return fail(`port ${port} is out of range`);
  return { host, port: port ?? 0 };
}

export function parseRedisUrl(input: string): RedisTarget {
  const text = input.trim();
  const scheme = SCHEME.exec(text);
  if (!scheme) return fail("scheme must be redis or rediss, optionally with +cluster or +sentinel");
  const tls = scheme[1]!.toLowerCase() === "rediss";
  const suffix = (scheme[2] ?? "").toLowerCase();
  if (text.includes("#")) return fail("a fragment is not allowed");

  if (suffix === "") {
    let parsed: URL;
    try { parsed = new URL(text); } catch { return fail("the single-node form could not be parsed"); }
    if (!parsed.hostname) return fail("the host is missing");
    return { mode: "standalone", tls, url: parsed.href, nodes: [{ host: parsed.hostname, port: Number(parsed.port) || 6379 }] };
  }

  const rest = text.slice(scheme[0].length);
  const authorityEnd = rest.search(/[/?]/);
  const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  const tail = authorityEnd < 0 ? "" : rest.slice(authorityEnd);
  const at = authority.lastIndexOf("@");
  const credentials = at < 0 ? "" : authority.slice(0, at);
  const hostList = at < 0 ? authority : authority.slice(at + 1);
  const colon = credentials.indexOf(":");
  const username = decode(colon < 0 ? credentials : credentials.slice(0, colon));
  const password = colon < 0 ? undefined : decode(credentials.slice(colon + 1));
  const defaultPort = suffix === "+cluster" ? 6379 : 26379;
  if (hostList === "") return fail("the host list is missing");
  const nodes = hostList.split(",").map((part) => { const node = parseHost(part); return { ...node, port: node.port || defaultPort }; });
  const base = {
    tls, nodes, ...(username !== undefined ? { username } : {}), ...(password !== undefined ? { password } : {}),
  };

  if (suffix === "+cluster") {
    if (tail !== "" && tail !== "/") return fail("the cluster form takes only a host list, without path or query");
    return { mode: "cluster", ...base };
  }

  const queryAt = tail.indexOf("?");
  const path = queryAt < 0 ? tail : tail.slice(0, queryAt);
  const query = new URLSearchParams(queryAt < 0 ? "" : tail.slice(queryAt + 1));
  const masterName = decode(path.replace(/^\//, ""));
  if (!masterName || masterName.includes("/")) return fail("the sentinel form needs the master name as the path");
  for (const key of query.keys()) {
    if (key !== "db" && key !== "sentinelUsername" && key !== "sentinelPassword") return fail(`query parameter "${key}" is not supported`);
  }
  const db = query.get("db");
  if (db !== null && !/^\d{1,4}$/.test(db)) return fail("db must be a non-negative integer");
  const sentinelUsername = query.get("sentinelUsername") || undefined;
  const sentinelPassword = query.get("sentinelPassword") || undefined;
  return {
    mode: "sentinel", ...base, masterName,
    ...(db !== null ? { database: Number(db) } : {}),
    ...(sentinelUsername ? { sentinelUsername } : {}), ...(sentinelPassword ? { sentinelPassword } : {}),
  };
}
