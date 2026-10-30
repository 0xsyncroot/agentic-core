import { readFile } from "node:fs/promises";
import { after, before, describe } from "node:test";
import { Pool } from "pg";
import { actorSettingConformance } from "../../contracts/test/actor-setting-store-conformance.js";
import { PostgresActorSettingStore } from "../src/actor-setting-store.js";
import { migratePostgres } from "../src/migrate.js";

// The same cases every engine passes, as the application role under row-level security, after the shipped migration and grants.
const appUrl = process.env.TEST_DATABASE_URL?.trim();
const ownerUrl = process.env.TEST_POSTGRES_OWNER_URL?.trim();

describe("postgres actor setting store", { skip: appUrl && ownerUrl ? false : "TEST_DATABASE_URL and TEST_POSTGRES_OWNER_URL are not set" }, () => {
  let pool: Pool | undefined;
  before(async () => {
    await migratePostgres({ connectionString: ownerUrl! });
    const owner = new Pool({ connectionString: ownerUrl!, max: 1 });
    try { await owner.query(await readFile(new URL("../grants/app-account.sql", import.meta.url), "utf8")); }
    finally { await owner.end(); }
  });
  after(async () => { await pool?.end(); });
  actorSettingConformance("postgres", () => new PostgresActorSettingStore(pool ??= new Pool({ connectionString: appUrl!, max: 4 })));
});
