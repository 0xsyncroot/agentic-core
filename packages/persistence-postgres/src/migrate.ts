import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

export interface MigrationOptions {
  readonly connectionString: string;
}

/**
 * Applies the schema, and only the schema.
 *
 * This used to also re-grant a narrow application role, which is why migrating needed a second,
 * administrative connection string. Owning database roles belongs to whoever owns the database:
 * they may already have the role, may provision it from their own tooling, or may run the SQL
 * in `migrations/` by hand against a database that already exists. So this runs as whoever the
 * connection string names and never touches privileges — `grants/app-account.sql` is the grant
 * set, to run separately.
 */
export async function migratePostgres(options: MigrationOptions): Promise<readonly string[]> {
  const pool = new Pool({ connectionString: options.connectionString, max: 1 });
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('agentic_migrations'))");
    const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
    const files = (await readdir(migrationDirectory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    const tableResult = await client.query<{ exists: string | null }>(
      "SELECT to_regclass('agentic.schema_migration')::text AS exists",
    );
    const hasTable = tableResult.rows[0]?.exists !== null;
    const known = new Set<string>();
    if (hasTable) {
      const result = await client.query<{ version: string }>("SELECT version FROM agentic.schema_migration");
      for (const row of result.rows) known.add(row.version);
    }

    for (const file of files) {
      if (known.has(file)) continue;
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO agentic.schema_migration(version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('agentic_migrations'))").catch(() => undefined);
    client.release();
    await pool.end();
  }
}
