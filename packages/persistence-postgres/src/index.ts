import { Pool } from "pg";
import type { BlindIndexEncoder, PayloadProtector } from "@0xsyncroot/contracts";
import { PostgresActorSettingStore } from "./actor-setting-store.js";
import { PostgresMemoryService } from "./memory-service.js";
import { PostgresSessionStore } from "./session-store.js";

export { PostgresActorSettingStore } from "./actor-setting-store.js";
export { migratePostgres, type MigrationOptions } from "./migrate.js";
export { PostgresMemoryService } from "./memory-service.js";
export { PostgresSessionStore } from "./session-store.js";

export interface PostgresPersistence {
  readonly sessions: PostgresSessionStore;
  readonly memory: PostgresMemoryService;
  readonly settings: PostgresActorSettingStore;
  close(): Promise<void>;
}

export interface PostgresPersistenceOptions {
  readonly payloadProtector?: PayloadProtector;
  readonly blindIndex?: BlindIndexEncoder;
}

export async function createPostgresPersistence(connectionString: string, options: PostgresPersistenceOptions = {}): Promise<PostgresPersistence> {
  const pool = new Pool({ connectionString, max: 10 });
  const role = await pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolname, rolsuper, rolbypassrls
       FROM pg_roles
      WHERE rolname = current_user`,
  );
  const current = role.rows[0];
  if (!current) {
    await pool.end();
    throw new Error("Unable to verify PostgreSQL application role");
  }
  if (current.rolsuper || current.rolbypassrls) {
    await pool.end();
    throw new Error(`Unsafe PostgreSQL application role ${current.rolname}: superuser/BYPASSRLS is forbidden`);
  }
  return {
    sessions: new PostgresSessionStore(pool, options.payloadProtector),
    memory: new PostgresMemoryService(pool, options.payloadProtector, options.blindIndex),
    settings: new PostgresActorSettingStore(pool),
    close: () => pool.end(),
  };
}
