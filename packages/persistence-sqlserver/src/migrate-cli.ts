import { migrateSqlServer } from "./migrate.js";

/**
 * Applies the schema as the service's own account.
 *
 * There is no separate administrative URL: this applies DDL and nothing else, and a deployment
 * whose database already exists never needs to run it. Principals and their rights are a
 * separate script, `grants/app-account.sql`, run by whoever owns the database.
 */
const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required");
const applied = await migrateSqlServer({ connectionString });
console.log(applied.length > 0 ? `Applied SQL Server migrations: ${applied.join(", ")}` : "SQL Server schema is up to date");
