import { migrateMySql, migrateMySqlCatalog } from "./migrate.js";

/**
 * Migrates the shard schema at DATABASE_URL and the control-plane schema at CATALOG_DATABASE_URL, which defaults to the same
 * database. Each runs as the account its URL names; a deployment that keeps DDL rights apart points the URLs at the owning
 * account for this one command.
 */
function mysqlUrl(name: string, value: string | undefined): string | undefined {
  const url = value?.trim();
  if (url && !url.startsWith("mysql:")) throw new Error(`${name} must be a mysql:// connection string`);
  return url || undefined;
}

const connectionString = mysqlUrl("DATABASE_URL", process.env.DATABASE_URL);
if (!connectionString) throw new Error("DATABASE_URL is required");
const catalogConnectionString = mysqlUrl("CATALOG_DATABASE_URL", process.env.CATALOG_DATABASE_URL) ?? connectionString;
const applied = await migrateMySql({ connectionString });
console.log(applied.length > 0 ? `Applied MySQL migrations: ${applied.join(", ")}` : "MySQL schema is up to date");
const catalogApplied = await migrateMySqlCatalog({ connectionString: catalogConnectionString });
console.log(catalogApplied.length > 0 ? `Applied MySQL catalog migrations: ${catalogApplied.join(", ")}` : "MySQL catalog schema is up to date");
