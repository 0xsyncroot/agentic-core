import { AgenticError, type SecurityContext } from "@0xsyncroot/contracts";
import type { Pool, PoolConnection } from "mysql2/promise";

const MAX_TRANSACTION_ATTEMPTS = 3;

function isRetryableTransactionError(error: unknown): boolean {
  const candidate = error as { errno?: unknown; code?: unknown } | undefined;
  return candidate?.errno === 1213 || candidate?.errno === 1205 ||
    candidate?.code === "ER_LOCK_DEADLOCK" || candidate?.code === "ER_LOCK_WAIT_TIMEOUT";
}

async function retryDelay(attempt: number): Promise<void> {
  const delayMs = 10 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 20);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Attaches the failing statement to MySQL errors that do not name one.
 *
 * "Incorrect arguments to mysqld_stmt_execute" is the server's answer to several unrelated
 * mistakes — a bound parameter where the protocol forbids one, an `undefined` in the binds — and
 * it names neither the statement nor the parameter. With thirty-odd prepared statements behind
 * one agent turn, that error alone costs an afternoon; the first line of the SQL turns it into
 * one look. Only the statement text is added, never the bound values, because those carry
 * tenant data.
 */
function withStatementContext(connection: PoolConnection): PoolConnection {
  const describe = (sql: unknown): string =>
    typeof sql === "string" ? sql.replace(/\s+/gu, " ").trim().slice(0, 120) : "unknown statement";
  return new Proxy(connection, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if ((property !== "execute" && property !== "query") || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try { return await (value as (...input: unknown[]) => Promise<unknown>).apply(target, args); }
        catch (error) {
          if (error instanceof Error && !/ \| statement: /u.test(error.message)) {
            error.message = `${error.message} | statement: ${describe(args[0])}`;
          }
          throw error;
        }
      };
    },
  });
}

/** Longest a live connection could plausibly take to answer BEGIN, which touches no data. */
export const CONNECTION_CHECK_MS = 5_000;
const CONNECTION_FAILURE_CODES = new Set([
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "PROTOCOL_CONNECTION_LOST", "PROTOCOL_SEQUENCE_TIMEOUT", "CONNECTION_CHECK_TIMEOUT",
]);

function isConnectionFailure(error: unknown): boolean {
  const candidate = error as { code?: unknown; fatal?: unknown } | undefined;
  return candidate?.fatal === true || (typeof candidate?.code === "string" && CONNECTION_FAILURE_CODES.has(candidate.code));
}

/**
 * Opens the transaction, or finds out within seconds that this pooled connection is dead.
 *
 * A connection that sat idle in the pool can be cut by a firewall or NAT between the service and
 * MySQL without either end being told. The first statement on it then waits for TCP to give up —
 * minutes, ending in "read ETIMEDOUT" — while the person in the chat watches nothing happen. BEGIN
 * is the cheapest liveness check there is: it reads nothing and writes nothing, so abandoning it
 * loses nothing.
 */
async function begin(connection: PoolConnection): Promise<void> {
  const started = connection.beginTransaction();
  started.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([started, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(
        new Error(`MySQL connection did not answer BEGIN within ${CONNECTION_CHECK_MS}ms`), { code: "CONNECTION_CHECK_TIMEOUT" },
      )), CONNECTION_CHECK_MS);
    })]);
  } finally { clearTimeout(timer); }
}

export async function withTenantTransaction<T>(pool: Pool, security: SecurityContext, operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
  if (!security.tenantId.trim() || !security.actorId.trim()) throw new Error("Tenant and actor identity are required");
  return withTransaction(pool, operation);
}

/** One transaction with the retry and dead-connection rules above; the caller scopes every statement itself. */
export async function withTransaction<T>(pool: Pool, operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    let connection: PoolConnection | undefined;
    let broken = false;
    let started = false;
    try {
      connection = await pool.getConnection();
      await begin(connection);
      started = true;
      const result = await operation(withStatementContext(connection));
      await connection.commit();
      return result;
    } catch (error) {
      broken = isConnectionFailure(error);
      // A dead socket would only hang ROLLBACK as well; MySQL rolls back a vanished session itself.
      if (connection && !broken) await connection.rollback().catch(() => undefined);
      // Before BEGIN completed nothing ran, so another connection may simply try again. After it,
      // a lost connection leaves the outcome of any write unknown, and that is not ours to repeat.
      if (!isRetryableTransactionError(error) && !(broken && !started)) throw error;
      if (attempt === MAX_TRANSACTION_ATTEMPTS) {
        throw new AgenticError("transient", broken
          ? "MySQL connections kept failing before the transaction could start"
          : "MySQL transaction contention exceeded its retry budget", true, { cause: error });
      }
    } finally {
      // A broken connection returned to the pool is handed to the next request, which fails the same way.
      if (connection) { if (broken) connection.destroy(); else connection.release(); }
    }
    await retryDelay(attempt);
  }
  throw new AgenticError("transient", "MySQL transaction retry budget exhausted", true);
}
