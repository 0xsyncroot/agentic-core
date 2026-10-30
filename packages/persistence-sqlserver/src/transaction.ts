import { AgenticError, type SecurityContext } from "@0xsyncroot/contracts";
import sql from "mssql";
import type { ConnectionPool, Transaction } from "mssql";

const MAX_TRANSACTION_ATTEMPTS = 3;

function isRetryableTransactionError(error: unknown): boolean {
  const candidate = error as { number?: unknown; originalError?: { info?: { number?: unknown } } } | undefined;
  const number = candidate?.number ?? candidate?.originalError?.info?.number;
  return number === 1205 || number === 3960;
}

async function retryDelay(attempt: number): Promise<void> {
  const delayMs = 10 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 20);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export async function withTenantTransaction<T>(
  pool: ConnectionPool,
  security: SecurityContext,
  operation: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  if (!security.tenantId.trim() || !security.actorId.trim()) throw new Error("Tenant and actor identity are required");
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await transaction.request()
        .input("tenant_id", sql.NVarChar(191), security.tenantId)
        .input("actor_id", sql.NVarChar(191), security.actorId)
        .input("purpose", sql.NVarChar(191), security.purpose)
        .query(`EXEC sys.sp_set_session_context @key=N'tenant_id', @value=@tenant_id;
                EXEC sys.sp_set_session_context @key=N'actor_id', @value=@actor_id;
                EXEC sys.sp_set_session_context @key=N'purpose', @value=@purpose;`);
      const result = await operation(transaction);
      await clearContext(transaction);
      await transaction.commit();
      return result;
    } catch (error) {
      await clearContext(transaction).catch(() => undefined);
      await transaction.rollback().catch(() => undefined);
      if (!isRetryableTransactionError(error)) throw error;
      if (attempt === MAX_TRANSACTION_ATTEMPTS) {
        throw new AgenticError("transient", "SQL Server transaction contention exceeded its retry budget", true, { cause: error });
      }
    }
    await retryDelay(attempt);
  }
  throw new AgenticError("transient", "SQL Server transaction retry budget exhausted", true);
}

async function clearContext(transaction: Transaction): Promise<void> {
  await transaction.request().query(`EXEC sys.sp_set_session_context @key=N'tenant_id', @value=NULL;
    EXEC sys.sp_set_session_context @key=N'actor_id', @value=NULL;
    EXEC sys.sp_set_session_context @key=N'purpose', @value=NULL;`);
}
