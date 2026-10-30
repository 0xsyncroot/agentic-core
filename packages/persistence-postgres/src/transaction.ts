import { AgenticError, type SecurityContext } from "@0xsyncroot/contracts";
import type { Pool, PoolClient } from "pg";

const MAX_TRANSACTION_ATTEMPTS = 3;

function isRetryableTransactionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "40P01" || code === "40001";
}

async function retryDelay(attempt: number): Promise<void> {
  const delayMs = 10 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 20);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export async function withTenantTransaction<T>(
  pool: Pool,
  security: SecurityContext,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!security.tenantId.trim() || !security.actorId.trim()) throw new Error("Tenant and actor identity are required");
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true), set_config('app.purpose', $3, true)",
        [security.tenantId, security.actorId, security.purpose],
      );
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (!isRetryableTransactionError(error)) throw error;
      if (attempt === MAX_TRANSACTION_ATTEMPTS) {
        throw new AgenticError("transient", "PostgreSQL transaction contention exceeded its retry budget", true, { cause: error });
      }
    } finally {
      client.release();
    }
    await retryDelay(attempt);
  }
  throw new AgenticError("transient", "PostgreSQL transaction retry budget exhausted", true);
}
