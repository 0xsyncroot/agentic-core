import { randomUUID } from "node:crypto";
import { actorSettingConflict, assertActorSettingInput, type ActorSetting, type ActorSettingScope, type ActorSettingStore } from "@0xsyncroot/contracts";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

interface SettingRow extends RowDataPacket { setting_value: string; revision: string; updated_at: Date | string }

const at = (value: Date | string): string => (value instanceof Date ? value : new Date(`${String(value).replace(" ", "T")}Z`)).toISOString();

/** Per-person settings in `agentic_actor_setting` (migration 0004), one row per person and key. */
export class MySqlActorSettingStore implements ActorSettingStore {
  constructor(private readonly pool: Pool) {}

  async get(scope: ActorSettingScope, key: string): Promise<ActorSetting | undefined> {
    assertActorSettingInput(scope, key);
    const [rows] = await this.pool.execute<SettingRow[]>(
      "SELECT setting_value, revision, updated_at FROM agentic_actor_setting WHERE tenant_id=? AND actor_id=? AND setting_key=?",
      [scope.tenantId, scope.actorId, key]);
    const row = rows[0];
    return row ? Object.freeze({ key, value: String(row.setting_value), revision: String(row.revision), updatedAt: at(row.updated_at) }) : undefined;
  }

  async put(scope: ActorSettingScope, key: string, value: string, expectedRevision?: string): Promise<ActorSetting> {
    assertActorSettingInput(scope, key, value, expectedRevision);
    const setting = Object.freeze({ key, value, revision: randomUUID(), updatedAt: new Date().toISOString() });
    const updatedAt = new Date(setting.updatedAt);
    if (expectedRevision === undefined) {
      await this.pool.execute(
        "INSERT INTO agentic_actor_setting(tenant_id,actor_id,setting_key,setting_value,revision,updated_at) VALUES (?,?,?,?,?,?) AS fresh "
        + "ON DUPLICATE KEY UPDATE setting_value=fresh.setting_value, revision=fresh.revision, updated_at=fresh.updated_at",
        [scope.tenantId, scope.actorId, key, value, setting.revision, updatedAt]);
      return setting;
    }
    const [result] = await this.pool.execute<ResultSetHeader>(
      "UPDATE agentic_actor_setting SET setting_value=?, revision=?, updated_at=? WHERE tenant_id=? AND actor_id=? AND setting_key=? AND revision=?",
      [value, setting.revision, updatedAt, scope.tenantId, scope.actorId, key, expectedRevision]);
    if (result.affectedRows !== 1) throw actorSettingConflict(key);
    return setting;
  }
}
