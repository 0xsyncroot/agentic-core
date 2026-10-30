import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { parseSqlServerUrl } from "./sql-server-config.js";

export interface SqlServerMigrationOptions {
  readonly connectionString: string;
}

function batches(source: string): readonly string[] {
  return source.split(/^\s*GO\s*$/gimu).map((batch) => batch.trim()).filter(Boolean);
}

/**
 * Applies the schema, and only the schema.
 *
 * Creating the application user and granting it rights used to happen here, which is why
 * migrating needed a second, administrative connection. Database principals belong to whoever
 * owns the database — `grants/app-account.sql` is that work, to run separately.
 */
export async function migrateSqlServer(options: SqlServerMigrationOptions): Promise<readonly string[]> {
  const pool = await new sql.ConnectionPool(parseSqlServerUrl(options.connectionString)).connect();
  const transaction = new sql.Transaction(pool);
  const applied: string[] = [];
  try {
    await transaction.begin();
    const lock = await transaction.request().query<{ result: number }>(`DECLARE @result int;
      EXEC @result=sys.sp_getapplock @Resource=N'agentic_migrations',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=30000;
      SELECT @result AS result;`);
    if ((lock.recordset[0]?.result ?? -999) < 0) throw new Error("Unable to acquire SQL Server migration lock");
    await transaction.request().query(`IF SCHEMA_ID(N'agentic') IS NULL EXEC(N'CREATE SCHEMA agentic AUTHORIZATION dbo');
      IF OBJECT_ID(N'agentic.schema_migration',N'U') IS NULL CREATE TABLE agentic.schema_migration(
        version nvarchar(255) NOT NULL PRIMARY KEY, applied_at datetime2(6) NOT NULL DEFAULT SYSUTCDATETIME()
      );`);
    const knownResult = await transaction.request().query<{ version: string }>("SELECT version FROM agentic.schema_migration;");
    const known = new Set(knownResult.recordset.map(({ version }) => version));
    const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
    const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const file of files) {
      if (known.has(file)) continue;
      for (const batch of batches(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"))) {
        await transaction.request().batch(batch);
      }
      await transaction.request().input("version", sql.NVarChar(255), file)
        .query("INSERT INTO agentic.schema_migration(version) VALUES (@version);");
      applied.push(file);
    }
    await transaction.commit();
    return applied;
  } catch (error) {
    await transaction.rollback().catch(() => undefined);
    throw error;
  } finally {
    await pool.close();
  }
}
