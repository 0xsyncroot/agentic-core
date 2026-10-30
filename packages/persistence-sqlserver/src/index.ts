import type { BlindIndexEncoder, PayloadProtector } from "@0xsyncroot/contracts";
import sql from "mssql";
import { SqlServerActorSettingStore } from "./actor-setting-store.js";
import { SqlServerMemoryService } from "./memory-service.js";
import { parseSqlServerUrl } from "./sql-server-config.js";
import { SqlServerSessionStore } from "./session-store.js";

export { SqlServerActorSettingStore } from "./actor-setting-store.js";
export { migrateSqlServer, type SqlServerMigrationOptions } from "./migrate.js";
export { SqlServerMemoryService } from "./memory-service.js";
export { parseSqlServerUrl } from "./sql-server-config.js";
export { SqlServerSessionStore } from "./session-store.js";

export interface SqlServerPersistenceOptions {
  readonly payloadProtector?: PayloadProtector;
  readonly blindIndex?: BlindIndexEncoder;
}

export interface SqlServerPersistence {
  readonly sessions: SqlServerSessionStore;
  readonly memory: SqlServerMemoryService;
  readonly settings: SqlServerActorSettingStore;
  close(): Promise<void>;
}

interface SqlServerRoleInfo extends Record<string, number> {
  major_version: number; engine_edition: number; is_sysadmin: number; is_securityadmin: number; is_db_owner: number;
  is_serveradmin: number; is_setupadmin: number; is_processadmin: number; is_diskadmin: number; is_dbcreator: number; is_bulkadmin: number;
  is_db_securityadmin: number; is_db_accessadmin: number; is_db_backupoperator: number; is_db_ddladmin: number;
  is_db_datareader: number; is_db_datawriter: number; controls_database: number;
}

export async function createSqlServerPersistence(connectionString: string, options: SqlServerPersistenceOptions = {}): Promise<SqlServerPersistence> {
  const pool = await new sql.ConnectionPool(parseSqlServerUrl(connectionString)).connect();
  try {
    const result = await pool.request().query<SqlServerRoleInfo>(`SELECT
      CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS major_version,
      CAST(SERVERPROPERTY('EngineEdition') AS int) AS engine_edition,
      ISNULL(IS_SRVROLEMEMBER('sysadmin'),0) AS is_sysadmin,
      ISNULL(IS_SRVROLEMEMBER('securityadmin'),0) AS is_securityadmin,
      ISNULL(IS_SRVROLEMEMBER('serveradmin'),0) AS is_serveradmin,
      ISNULL(IS_SRVROLEMEMBER('setupadmin'),0) AS is_setupadmin,
      ISNULL(IS_SRVROLEMEMBER('processadmin'),0) AS is_processadmin,
      ISNULL(IS_SRVROLEMEMBER('diskadmin'),0) AS is_diskadmin,
      ISNULL(IS_SRVROLEMEMBER('dbcreator'),0) AS is_dbcreator,
      ISNULL(IS_SRVROLEMEMBER('bulkadmin'),0) AS is_bulkadmin,
      ISNULL(IS_ROLEMEMBER('db_owner'),0) AS is_db_owner,
      ISNULL(IS_ROLEMEMBER('db_securityadmin'),0) AS is_db_securityadmin,
      ISNULL(IS_ROLEMEMBER('db_accessadmin'),0) AS is_db_accessadmin,
      ISNULL(IS_ROLEMEMBER('db_backupoperator'),0) AS is_db_backupoperator,
      ISNULL(IS_ROLEMEMBER('db_ddladmin'),0) AS is_db_ddladmin,
      ISNULL(IS_ROLEMEMBER('db_datareader'),0) AS is_db_datareader,
      ISNULL(IS_ROLEMEMBER('db_datawriter'),0) AS is_db_datawriter,
      ISNULL(HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CONTROL'),0) AS controls_database;`);
    const role = result.recordset[0];
    if (!role || (role.major_version < 15 && role.engine_edition !== 5 && role.engine_edition !== 8)) {
      throw new Error("SQL Server 2019 or newer, Azure SQL Database or Azure SQL Managed Instance is required");
    }
    const unsafe = [
      role.is_sysadmin, role.is_securityadmin, role.is_serveradmin, role.is_setupadmin, role.is_processadmin,
      role.is_diskadmin, role.is_dbcreator, role.is_bulkadmin, role.is_db_owner, role.is_db_securityadmin,
      role.is_db_accessadmin, role.is_db_backupoperator, role.is_db_ddladmin, role.is_db_datareader,
      role.is_db_datawriter, role.controls_database,
    ].some(Boolean);
    if (unsafe) {
      throw new Error("Unsafe SQL Server application principal: administrative privileges are forbidden");
    }
    return {
      sessions: new SqlServerSessionStore(pool, options.payloadProtector),
      memory: new SqlServerMemoryService(pool, options.payloadProtector, options.blindIndex),
      settings: new SqlServerActorSettingStore(pool),
      close: () => pool.close(),
    };
  } catch (error) {
    await pool.close();
    throw error;
  }
}
