import { after, before, describe } from "node:test";
import sql from "mssql";
import { actorSettingConformance } from "../../contracts/test/actor-setting-store-conformance.js";
import { SqlServerActorSettingStore } from "../src/actor-setting-store.js";
import { migrateSqlServer } from "../src/migrate.js";
import { parseSqlServerUrl } from "../src/sql-server-config.js";

function sqlServerUrl(value: string | undefined): string | undefined {
  const source = value?.trim();
  return source?.startsWith("sqlserver:") || source?.startsWith("mssql:") ? source : undefined;
}

// The same cases every engine passes, under the tenant security policy, after the shipped migration.
const appUrl = sqlServerUrl(process.env.TEST_SQLSERVER_URL) ?? sqlServerUrl(process.env.DATABASE_URL);
const ownerUrl = sqlServerUrl(process.env.TEST_SQLSERVER_OWNER_URL) ?? sqlServerUrl(process.env.ADMIN_SQLSERVER_URL);

describe("sqlserver actor setting store", { skip: appUrl && ownerUrl ? false : "TEST_SQLSERVER_URL and TEST_SQLSERVER_OWNER_URL are not set" }, () => {
  let pool: sql.ConnectionPool | undefined;
  before(async () => {
    await migrateSqlServer({ connectionString: ownerUrl! });
    pool = await new sql.ConnectionPool(parseSqlServerUrl(appUrl!)).connect();
  });
  after(async () => { await pool?.close(); });
  actorSettingConformance("sqlserver", () => new SqlServerActorSettingStore(pool!));
});
