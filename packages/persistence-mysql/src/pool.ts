import { createPool, type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";

export type MySqlPersistenceEvent =
  | { readonly event: "mysql.pool.measured"; readonly level: "info"; readonly coldConnectMs: number; readonly warmPingMs: number;
      readonly waitTimeoutSeconds: number | null; readonly idleTimeoutMs: number; readonly keepWarmEveryMs: number }
  | { readonly event: "mysql.pool.keep-warm-failed"; readonly level: "warn"; readonly reason: string }
  | { readonly event: "mysql.pool.keep-warm-recovered"; readonly level: "info"; readonly failedTicks: number }
  | { readonly event: "mysql.append-stamp.enabled"; readonly level: "info" }
  | { readonly event: "mysql.append-stamp.disabled"; readonly level: "warn"; readonly reason: string };

const DEFAULT_POOL_SIZE = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const MIN_IDLE_TIMEOUT_MS = 30_000;
const MAX_IDLE_TIMEOUT_MS = 600_000;
/** How long before the server's `wait_timeout` the pool lets go of a connection, so it is never the server that does. */
const IDLE_MARGIN_MS = 30_000;
const MAX_KEEP_WARM_EVERY_MS = 30_000;
/** Longest `SELECT 1` on a connection already open may take; the bound covers the query only, acquiring is bounded by the connect timeout. */
const KEEP_WARM_QUERY_TIMEOUT_MS = 5_000;

function defaultLog(event: MySqlPersistenceEvent): void {
  (event.level === "warn" ? console.warn : console.info)(JSON.stringify(event));
}

/**
 * How long the pool keeps a connection idle, and how often the one warm connection is touched.
 *
 * The server closes a connection that has been idle for `wait_timeout` (28,800 s by default, far
 * less behind some proxies), so the pool must let go of its own first — 30 s early — and a
 * minute-long constant was only ever a guess at that number. Capped at 10 minutes so a very large
 * `wait_timeout` does not keep every burst's connections for hours, and at least 30 s so a tiny
 * one does not turn the pool into a handshake per request. A value the server did not report
 * leaves the previous minute in place.
 */
export function warmSettings(waitTimeoutSeconds: number | undefined): { readonly idleTimeoutMs: number; readonly keepWarmEveryMs: number } {
  const idleTimeoutMs = waitTimeoutSeconds !== undefined && Number.isFinite(waitTimeoutSeconds) && waitTimeoutSeconds > 0
    ? Math.max(MIN_IDLE_TIMEOUT_MS, Math.min(MAX_IDLE_TIMEOUT_MS, waitTimeoutSeconds * 1000 - IDLE_MARGIN_MS))
    : DEFAULT_IDLE_TIMEOUT_MS;
  return { idleTimeoutMs, keepWarmEveryMs: Math.min(MAX_KEEP_WARM_EVERY_MS, idleTimeoutMs / 2) };
}

export interface PoolKeepWarm {
  /** One bounded ping; never rejects. A ping already running is shared, not doubled. */
  ping(): Promise<void>;
  /** Stops the timer and waits for the ping in flight, so the pool can end without a query racing it. */
  stop(): Promise<void>;
}

/**
 * Keeps one pooled connection alive across any idle length.
 *
 * mysql2 drops every free connection idle longer than `idleTimeout`, so without this the first
 * turn after a quiet minute pays a whole handshake — seconds on a shared MySQL. The pool's free
 * list is last-in-first-out, so each ping takes the newest connection and puts it back newest:
 * exactly one stays warm and the rest age out as before. A failed ping destroys its connection (a
 * query timeout is not fatal, and would leave the slot busy), is logged once per streak and once
 * on recovery, and never escapes the timer.
 */
export function keepPoolWarm(pool: Pick<Pool, "getConnection">, everyMs: number, log: (event: MySqlPersistenceEvent) => void): PoolKeepWarm {
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  let failedTicks = 0;
  const run = async (): Promise<void> => {
    let connection: PoolConnection | undefined;
    try {
      connection = await pool.getConnection();
      await connection.query({ sql: "SELECT 1", timeout: KEEP_WARM_QUERY_TIMEOUT_MS });
      connection.release();
      connection = undefined;
      if (failedTicks > 0) log({ event: "mysql.pool.keep-warm-recovered", level: "info", failedTicks });
      failedTicks = 0;
    } catch (error) {
      connection?.destroy();
      failedTicks += 1;
      if (failedTicks === 1) {
        const code = (error as { code?: unknown } | undefined)?.code;
        log({ event: "mysql.pool.keep-warm-failed", level: "warn", reason: typeof code === "string" ? code : error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      }
    }
  };
  const ping = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    inFlight ??= run().finally(() => { inFlight = undefined; });
    return inFlight;
  };
  const timer = setInterval(() => { void ping(); }, everyMs);
  timer.unref();
  return {
    ping,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}

export interface MySqlPoolOptions {
  /** Connections the pool may open (default 10). */
  readonly poolSize?: number;
  readonly log?: (event: MySqlPersistenceEvent) => void;
}

export interface OpenedMySqlPool<T> {
  readonly pool: Pool;
  /** What `inspect` learned from the boot connection. */
  readonly inspected: T;
  readonly log: (event: MySqlPersistenceEvent) => void;
  close(): Promise<void>;
}

/**
 * Opens a pool, measures its first connection and keeps one connection warm. `inspect` runs on that first connection after
 * the measurement, so a store can learn what the account may do without a second handshake; a failure there destroys the
 * connection and ends the pool. Opens with whatever account the connection string names: narrowing the account is
 * configured in MySQL, not asserted here.
 */
export async function openMySqlPool<T>(connectionString: string, options: MySqlPoolOptions, inspect: (connection: PoolConnection) => Promise<T>): Promise<OpenedMySqlPool<T>> {
  const url = new URL(connectionString);
  if (url.protocol !== "mysql:") throw new Error("MySQL connection string must use mysql://");
  const connectionLimit = options.poolSize ?? DEFAULT_POOL_SIZE;
  if (!Number.isInteger(connectionLimit) || connectionLimit < 1) throw new Error("MySQL pool size must be a positive integer");
  const log = options.log ?? defaultLog;
  const pool = createPool({
    uri: connectionString, connectionLimit, timezone: "Z", supportBigNumbers: true, bigNumberStrings: true,
    // An idle connection is what a firewall or NAT drops without telling either end, and the OS
    // default sends its first keepalive after two hours. Probe after 30 s so the path stays open.
    // mysql2 closes a free connection idle longer than `idleTimeout` even when the pool holds no
    // more than `maxIdle` of them, so these two do not keep a warm set: the keep-warm ping below
    // does, and the boot query sets `idleTimeout` from the server's `wait_timeout`.
    enableKeepAlive: true, keepAliveInitialDelay: 30_000, maxIdle: 2, idleTimeout: DEFAULT_IDLE_TIMEOUT_MS,
  });
  try {
    const startedAt = performance.now();
    const connection = await pool.getConnection();
    const coldConnectMs = Math.round(performance.now() - startedAt);
    let waitTimeoutSeconds: number | undefined;
    let warmPingMs: number;
    let inspected: T;
    try {
      const [version] = await connection.query<RowDataPacket[]>("SELECT VERSION() AS version, @@session.wait_timeout AS waitTimeout");
      if (Number(String(version[0]?.version ?? "0").split(".")[0]) < 8) throw new Error("MySQL 8 or newer is required");
      const reported = Number(version[0]?.waitTimeout);
      waitTimeoutSeconds = Number.isFinite(reported) && reported > 0 ? reported : undefined;
      const pingStartedAt = performance.now();
      await connection.query({ sql: "SELECT 1", timeout: KEEP_WARM_QUERY_TIMEOUT_MS });
      warmPingMs = Math.round(performance.now() - pingStartedAt);
      inspected = await inspect(connection);
    } catch (error) {
      connection.destroy();
      throw error;
    }
    connection.release();
    const { idleTimeoutMs, keepWarmEveryMs } = warmSettings(waitTimeoutSeconds);
    // The pool reads this on every sweep; it is the only way to apply a value learned from the
    // first connection without paying a second handshake for a throwaway one.
    pool.pool.config.idleTimeout = idleTimeoutMs;
    log({ event: "mysql.pool.measured", level: "info", coldConnectMs, warmPingMs, waitTimeoutSeconds: waitTimeoutSeconds ?? null, idleTimeoutMs, keepWarmEveryMs });
    // Last, so nothing after the timer starts can throw and leave it running.
    const warm = keepPoolWarm(pool, keepWarmEveryMs, log);
    return { pool, inspected, log, close: async () => { await warm.stop(); await pool.end(); } };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
