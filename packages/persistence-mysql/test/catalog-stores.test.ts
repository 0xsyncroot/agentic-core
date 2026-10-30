import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Pool } from "mysql2/promise";
import { catalogStoreConformance } from "../../contracts/test/catalog-store-conformance.js";
import { MySqlCatalogBuildRegistry, MySqlCatalogReader, MySqlCatalogStore } from "../src/index.js";
import { ADMIN_PASSWORD, ADMIN_USER, appUrl, openPool, ownerUrl, provision, urlAs } from "./mysql-fixture.js";

const TABLES = ["catalog_agent", "catalog_item", "catalog_item_revision", "catalog_release", "catalog_release_item", "catalog_release_check", "catalog_channel",
  "catalog_build", "generation_status"].map((name) => `agentic_${name}`);
/** A column of each table to name in a statement that must be refused before it runs. */
const keyColumn = (table: string) => (table === "agentic_catalog_build" ? "build_digest" : "agent_id");
/** What the agent's account reads in a release; the draft table is the console's alone. */
const AGENT_READS = TABLES.filter((name) => name !== "agentic_catalog_item");

const refused = (pool: Pool, errno: number) => async (statement: string) =>
  assert.rejects(pool.query(statement), (error: { errno?: number }) => error.errno === errno, statement);

describe("mysql catalog stores", { skip: appUrl && ownerUrl ? false : "TEST_MYSQL_URL and TEST_MYSQL_OWNER_URL are not set" }, () => {
  let app: Pool; let admin: Pool; let owner: Pool;
  before(async () => {
    await provision();
    app = openPool(appUrl!); admin = openPool(urlAs(appUrl!, ADMIN_USER, ADMIN_PASSWORD)); owner = openPool(ownerUrl!);
  });
  after(async () => { await Promise.all([app?.end(), admin?.end(), owner?.end()]); });

  // The console edits with its own account and the agent reads with its own; the build rows are written by the owner here,
  // because no shipped account is granted them until the service that writes them exists.
  catalogStoreConformance("mysql", async () => ({
    editor: new MySqlCatalogStore(admin), builds: new MySqlCatalogBuildRegistry(owner), reader: new MySqlCatalogReader(app),
  }));

  test("the console's account deletes nothing and updates only the columns that change", async () => {
    const denied = refused(admin, 1142); const deniedColumn = refused(admin, 1143);
    for (const table of TABLES) await denied(`DELETE FROM ${table} WHERE 1 = 0`);
    for (const table of TABLES) await admin.query(`SELECT 1 FROM ${table} LIMIT 1`);
    await deniedColumn("UPDATE agentic_catalog_agent SET product_id = product_id WHERE 1 = 0");
    await deniedColumn("UPDATE agentic_catalog_item SET item_id = item_id WHERE 1 = 0");
    await deniedColumn("UPDATE agentic_catalog_release SET manifest_hash = manifest_hash WHERE 1 = 0");
    await deniedColumn("UPDATE agentic_catalog_release SET release_no = release_no WHERE 1 = 0");
    await deniedColumn("UPDATE agentic_catalog_channel SET agent_id = agent_id WHERE 1 = 0");
    for (const table of ["catalog_item_revision", "catalog_release_item", "catalog_release_check", "catalog_build", "generation_status"].map((name) => `agentic_${name}`)) {
      await denied(`UPDATE ${table} SET ${keyColumn(table)} = ${keyColumn(table)} WHERE 1 = 0`);
    }
    await denied("INSERT INTO agentic_catalog_build (build_digest) VALUES ('x')");
    await denied("INSERT INTO agentic_generation_status (agent_id) VALUES ('x')");
    await denied("REPLACE INTO agentic_catalog_channel (agent_id) VALUES ('x')");
  });

  test("the agent's account reads releases and writes nothing in the catalog", async () => {
    const denied = refused(app, 1142);
    for (const table of AGENT_READS) await app.query(`SELECT 1 FROM ${table} LIMIT 1`);
    await denied("SELECT 1 FROM agentic_catalog_item LIMIT 1");
    for (const table of TABLES) {
      await denied(`DELETE FROM ${table} WHERE 1 = 0`);
      await denied(`INSERT INTO ${table} (${keyColumn(table)}) VALUES ('x')`);
    }
    await denied("UPDATE agentic_catalog_channel SET release_id = release_id WHERE 1 = 0");
    await denied("UPDATE agentic_catalog_release SET status = status WHERE 1 = 0");
  });
});
