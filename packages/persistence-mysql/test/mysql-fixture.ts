import { readFile } from "node:fs/promises";
import type { RuntimeSnapshot, SecurityContext } from "@0xsyncroot/contracts";
import { createPool, type Pool } from "mysql2/promise";
import { migrateMySql, migrateMySqlCatalog } from "../src/migrate.js";

/**
 * The test server and its accounts. TEST_MYSQL_URL is the application account; TEST_MYSQL_OWNER_URL may create tables,
 * accounts and grants, and points only at the throwaway test server (the grant scripts revoke everything first).
 */
export const appUrl = process.env.TEST_MYSQL_URL?.trim() || undefined;
export const ownerUrl = process.env.TEST_MYSQL_OWNER_URL?.trim() || undefined;

/** The console's account, as deploy/local/mysql-init/002_admin_user.sql creates it. */
export const ADMIN_USER = "agentic_admin";
export const ADMIN_PASSWORD = "agentic_admin_api_dev";

export const runtime: RuntimeSnapshot = { id: "review-test", coreVersion: "1.0.0", pluginSetId: "mysql", policyRevision: "test", memoryPolicyRevision: "test", createdAt: new Date().toISOString() };

export function security(tenantId: string, actorId = "actor"): SecurityContext {
  return { tenantId, actorId, permissions: new Set(["*"]), correlationId: crypto.randomUUID(), purpose: "mysql-integration-test" };
}

export function openPool(uri: string): Pool {
  return createPool({ uri, connectionLimit: 4, timezone: "Z", supportBigNumbers: true, bigNumberStrings: true });
}

/** The same server and schema as `base`, as another account. */
export function urlAs(base: string, user: string, password: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  return url.toString();
}

async function runScript(uri: string, sql: string): Promise<void> {
  const pool = createPool({ uri, connectionLimit: 1, multipleStatements: true });
  try { await pool.query(sql); } finally { await pool.end(); }
}

/**
 * Migrates both schemas and, with an owner account, applies the shipped grant scripts the way a database owner would:
 * the application account first, then the console's account, created here because the test server booted before any
 * init script could know it.
 */
export async function provision(): Promise<void> {
  const ddl = ownerUrl ?? appUrl!;
  await migrateMySql({ connectionString: ddl });
  await migrateMySqlCatalog({ connectionString: ddl });
  if (!ownerUrl) return;
  await runScript(ownerUrl, await readFile(new URL("../grants/app-account.sql", import.meta.url), "utf8"));
  await runScript(ownerUrl, `CREATE USER IF NOT EXISTS '${ADMIN_USER}'@'%' IDENTIFIED BY '${ADMIN_PASSWORD}'`);
  await runScript(ownerUrl, await readFile(new URL("../grants/admin-account.sql", import.meta.url), "utf8"));
}

export async function ownerScript(sql: string): Promise<void> { await runScript(ownerUrl!, sql); }
