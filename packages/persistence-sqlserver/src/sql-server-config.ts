import type { config as SqlServerConfig } from "mssql";

function booleanOption(url: URL, name: string, fallback: boolean): boolean {
  const value = url.searchParams.get(name)?.trim().toLowerCase();
  if (value === null || value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function positiveInteger(url: URL, name: string, fallback: number): number {
  const value = url.searchParams.get(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function parseSqlServerUrl(connectionString: string): SqlServerConfig {
  const url = new URL(connectionString);
  if (url.protocol !== "sqlserver:" && url.protocol !== "mssql:") {
    throw new Error("SQL Server connection string must use sqlserver:// or mssql://");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !url.username || !database) {
    throw new Error("SQL Server URL requires host, username and database");
  }
  return {
    server: url.hostname,
    port: url.port ? Number(url.port) : 1433,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    connectionTimeout: positiveInteger(url, "connectionTimeout", 15_000),
    requestTimeout: positiveInteger(url, "requestTimeout", 30_000),
    pool: {
      max: positiveInteger(url, "poolMax", 10),
      min: 0,
      idleTimeoutMillis: positiveInteger(url, "poolIdleTimeout", 30_000),
    },
    options: {
      encrypt: booleanOption(url, "encrypt", true),
      trustServerCertificate: booleanOption(url, "trustServerCertificate", false),
      enableArithAbort: true,
    },
  };
}
