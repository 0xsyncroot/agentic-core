import { randomUUID } from "node:crypto";
import { actorSettingConflict, assertActorSettingInput, type ActorSetting, type ActorSettingScope, type ActorSettingStore, type SecurityContext } from "@0xsyncroot/contracts";
import type { Pool } from "pg";
import { withTenantTransaction } from "./transaction.js";

interface SettingRow { setting_value: string; revision: string; updated_at: Date | string }

/** The transaction identity row-level security checks: the person whose settings these are, and nothing more. */
function principal(scope: ActorSettingScope): SecurityContext {
  return { tenantId: scope.tenantId, actorId: scope.actorId, permissions: new Set(), correlationId: randomUUID(), purpose: "actor-settings" };
}

function setting(key: string, row: SettingRow): ActorSetting {
  return Object.freeze({ key, value: row.setting_value, revision: row.revision, updatedAt: new Date(row.updated_at).toISOString() });
}

/** Per-person settings in `agentic.actor_setting` (migration 0008), each row visible to its own tenant and actor only. */
export class PostgresActorSettingStore implements ActorSettingStore {
  constructor(private readonly pool: Pool) {}

  async get(scope: ActorSettingScope, key: string): Promise<ActorSetting | undefined> {
    assertActorSettingInput(scope, key);
    return withTenantTransaction(this.pool, principal(scope), async (client) => {
      const result = await client.query<SettingRow>(
        "SELECT setting_value, revision, updated_at FROM agentic.actor_setting WHERE tenant_id=$1 AND actor_id=$2 AND setting_key=$3",
        [scope.tenantId, scope.actorId, key]);
      return result.rows[0] ? setting(key, result.rows[0]) : undefined;
    });
  }

  async put(scope: ActorSettingScope, key: string, value: string, expectedRevision?: string): Promise<ActorSetting> {
    assertActorSettingInput(scope, key, value, expectedRevision);
    const revision = randomUUID();
    const updatedAt = new Date();
    return withTenantTransaction(this.pool, principal(scope), async (client) => {
      const result = expectedRevision === undefined
        ? await client.query<SettingRow>(
          `INSERT INTO agentic.actor_setting(tenant_id, actor_id, setting_key, setting_value, revision, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id, actor_id, setting_key)
           DO UPDATE SET setting_value=EXCLUDED.setting_value, revision=EXCLUDED.revision, updated_at=EXCLUDED.updated_at
           RETURNING setting_value, revision, updated_at`,
          [scope.tenantId, scope.actorId, key, value, revision, updatedAt])
        : await client.query<SettingRow>(
          `UPDATE agentic.actor_setting SET setting_value=$4, revision=$5, updated_at=$6
            WHERE tenant_id=$1 AND actor_id=$2 AND setting_key=$3 AND revision=$7
           RETURNING setting_value, revision, updated_at`,
          [scope.tenantId, scope.actorId, key, value, revision, updatedAt, expectedRevision]);
      if (!result.rows[0]) throw actorSettingConflict(key);
      return setting(key, result.rows[0]);
    });
  }
}
