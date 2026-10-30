import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sql from "mssql";
import { migrateSqlServer, parseSqlServerUrl } from "../src/index.js";

const ownerUrl = process.env.TEST_SQLSERVER_OWNER_URL ?? process.env.ADMIN_SQLSERVER_URL;

test("the grants script repairs a broad denial and preserves the restricted permission boundary on reapply", { skip: !ownerUrl }, async () => {
  await migrateSqlServer({ connectionString: ownerUrl! });
  const owner = await new sql.ConnectionPool(parseSqlServerUrl(ownerUrl!)).connect();
  const principal = `grant_probe_${randomUUID().replaceAll("-", "")}`;
  const column = `${principal}_column`;
  const source = (await readFile(new URL("../grants/app-account.sql", import.meta.url), "utf8")).replaceAll("agentic_app", principal);
  const apply = async () => {
    for (const batch of source.split(/^\s*GO\s*$/gimu).filter(value => value.trim())) await owner.request().batch(batch);
  };
  // Each impersonation is bounded by one batch and reverts even when the nested statement fails.
  const asPrincipal = (statement: string) => owner.request().input("statement", sql.NVarChar(sql.MAX), statement).query(`
    EXECUTE AS USER=N'${principal}';
    BEGIN TRY
      EXEC sys.sp_executesql @statement;
      REVERT;
    END TRY
    BEGIN CATCH
      REVERT;
      THROW;
    END CATCH;`);
  try {
    await owner.request().batch(`CREATE USER [${principal}] WITHOUT LOGIN;`);
    await apply();
    await owner.request().batch(`DENY CONTROL ON SCHEMA::agentic TO [${principal}];`);
    await assert.rejects(asPrincipal("SELECT TOP (0) * FROM agentic.session_stream;"), /permission|denied/iu);
    await apply();
    await apply();
    await asPrincipal("SELECT TOP (0) * FROM agentic.session_stream; UPDATE agentic.session_stream SET current_seq=current_seq WHERE 1=0;");
    const rights = await asPrincipal(`SELECT
      IS_MEMBER('db_owner') AS owner_role, IS_MEMBER('db_securityadmin') AS security_role,
      HAS_PERMS_BY_NAME('agentic', 'SCHEMA', 'CONTROL') AS schema_control,
      HAS_PERMS_BY_NAME('agentic', 'SCHEMA', 'ALTER') AS schema_alter,
      HAS_PERMS_BY_NAME('agentic', 'SCHEMA', 'TAKE OWNERSHIP') AS schema_ownership;`);
    assert.deepEqual(rights.recordset[0], { owner_role: 0, security_role: 0, schema_control: 0, schema_alter: 0, schema_ownership: 0 });
    for (const denied of [
      "UPDATE agentic.session_event SET type=type WHERE 1=0;",
      "DELETE FROM agentic.session_event WHERE 1=0;",
      "UPDATE agentic.memory_revision SET content=content WHERE 1=0;",
      "DELETE FROM agentic.memory_revision WHERE 1=0;",
      "DELETE FROM agentic.actor_setting WHERE 1=0;",
      "SELECT * FROM agentic.schema_migration;",
      `ALTER TABLE agentic.session_event ADD [${column}] bit NULL;`,
    ]) await assert.rejects(asPrincipal(denied), /permission|denied/iu);
  } finally {
    try {
      await owner.request().batch(`IF COL_LENGTH('agentic.session_event', '${column}') IS NOT NULL
        ALTER TABLE agentic.session_event DROP COLUMN [${column}];
        IF DATABASE_PRINCIPAL_ID('${principal}') IS NOT NULL DROP USER [${principal}];`);
    } finally { await owner.close(); }
  }
});
