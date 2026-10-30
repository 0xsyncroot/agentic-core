import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPool, type RowDataPacket } from "mysql2/promise";

export interface MySqlMigrationOptions {
  readonly connectionString: string;
}

/** A directory of ordered `.sql` files and the ledger table that records which of them a database has. */
interface MigrationSet {
  readonly directory: string;
  readonly ledger: string;
}

const SHARD_SET: MigrationSet = { directory: "migrations", ledger: "agentic_schema_migration" };
const CATALOG_SET: MigrationSet = { directory: "migrations-catalog", ledger: "agentic_catalog_schema_migration" };

/**
 * Applies the shard schema (sessions, memory, review projections), and only the schema.
 *
 * It runs as whoever the connection string names and never touches privileges: owning the accounts is the database team's
 * job, and the grants in `grants/` are applied by them after the tables exist.
 */
export async function migrateMySql(options: MySqlMigrationOptions): Promise<readonly string[]> {
  return applyMigrationSet(options.connectionString, SHARD_SET);
}

/** Applies the control-plane schema (operators, audit, shard routing) with its own ledger, so it can live in its own database. */
export async function migrateMySqlCatalog(options: MySqlMigrationOptions): Promise<readonly string[]> {
  return applyMigrationSet(options.connectionString, CATALOG_SET);
}

async function applyMigrationSet(connectionString: string, set: MigrationSet): Promise<readonly string[]> {
  const pool = createPool({ uri: connectionString, connectionLimit: 1, multipleStatements: true, timezone: "Z" });
  const connection = await pool.getConnection();
  const applied: string[] = [];
  try {
    const [versionRows] = await connection.query<RowDataPacket[]>("SELECT VERSION() AS version");
    const major = Number(String(versionRows[0]?.version ?? "0").split(".")[0]);
    if (major < 8) throw new Error("MySQL 8 or newer is required");
    const [lockRows] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK('agentic_migrations', 30) AS acquired");
    if (Number(lockRows[0]?.acquired) !== 1) throw new Error("Unable to acquire MySQL migration lock");
    await connection.query(`CREATE TABLE IF NOT EXISTS ${set.ledger}(version varchar(255) PRIMARY KEY, applied_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6))`);
    const [knownRows] = await connection.query<RowDataPacket[]>(`SELECT version FROM ${set.ledger}`);
    const known = new Set(knownRows.map((row) => String(row.version)));
    const directory = fileURLToPath(new URL(`../${set.directory}/`, import.meta.url));
    const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const file of files) {
      if (known.has(file)) continue;
      await connection.query(await readFile(new URL(`../${set.directory}/${file}`, import.meta.url), "utf8"));
      await connection.execute(`INSERT INTO ${set.ledger}(version) VALUES (?)`, [file]);
      applied.push(file);
    }
    return applied;
  } finally {
    await connection.query("SELECT RELEASE_LOCK('agentic_migrations')").catch(() => undefined);
    connection.release();
    await pool.end();
  }
}
