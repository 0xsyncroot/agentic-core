import { after, before, describe } from "node:test";
import { createPool, type Pool } from "mysql2/promise";
import { actorSettingConformance } from "../../contracts/test/actor-setting-store-conformance.js";
import { MySqlActorSettingStore } from "../src/actor-setting-store.js";
import { migrateMySql } from "../src/migrate.js";

// The same cases every engine passes, against a real MySQL (deploy/local: 8.0.33), with the migration that creates the table.
const url = process.env.TEST_MYSQL_URL;

describe("mysql actor setting store", { skip: url ? false : "TEST_MYSQL_URL is not set" }, () => {
  let pool: Pool | undefined;
  before(async () => { await migrateMySql({ connectionString: process.env.TEST_MYSQL_OWNER_URL ?? url! }); });
  after(async () => { await pool?.end(); });
  actorSettingConformance("mysql", () => new MySqlActorSettingStore(pool ??= createPool({ uri: url!, timezone: "Z", supportBigNumbers: true, bigNumberStrings: true })));
});
