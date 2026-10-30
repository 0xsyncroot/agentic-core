import { randomUUID } from "node:crypto";
import { actorSettingConflict, assertActorSettingInput, type ActorSetting, type ActorSettingScope, type ActorSettingStore, type SecurityContext } from "@0xsyncroot/contracts";
import type { ConnectionPool } from "mssql";
import { dateTime, request, text } from "./sql-request.js";
import { withTenantTransaction } from "./transaction.js";

interface SettingRow { setting_value: string; revision: string; updated_at: Date }

/** The session context the tenant security policy checks: the person whose settings these are, and nothing more. */
function principal(scope: ActorSettingScope): SecurityContext {
  return { tenantId: scope.tenantId, actorId: scope.actorId, permissions: new Set(), correlationId: randomUUID(), purpose: "actor-settings" };
}

/** Per-person settings in `agentic.actor_setting` (migration 0003), filtered by the tenant security policy. */
export class SqlServerActorSettingStore implements ActorSettingStore {
  constructor(private readonly pool: ConnectionPool) {}

  async get(scope: ActorSettingScope, key: string): Promise<ActorSetting | undefined> {
    assertActorSettingInput(scope, key);
    return withTenantTransaction(this.pool, principal(scope), async (transaction) => {
      const input = text(text(text(request(transaction), "tenant_id", scope.tenantId), "actor_id", scope.actorId), "setting_key", key, 64);
      const result = await input.query<SettingRow>(`SELECT setting_value, revision, updated_at FROM agentic.actor_setting
        WHERE tenant_id=@tenant_id AND actor_id=@actor_id AND setting_key=@setting_key;`);
      const row = result.recordset[0];
      return row ? Object.freeze({ key, value: row.setting_value, revision: row.revision, updatedAt: new Date(row.updated_at).toISOString() }) : undefined;
    });
  }

  async put(scope: ActorSettingScope, key: string, value: string, expectedRevision?: string): Promise<ActorSetting> {
    assertActorSettingInput(scope, key, value, expectedRevision);
    const setting = Object.freeze({ key, value, revision: randomUUID(), updatedAt: new Date().toISOString() });
    return withTenantTransaction(this.pool, principal(scope), async (transaction) => {
      const bind = () => dateTime(text(text(text(text(text(request(transaction), "tenant_id", scope.tenantId), "actor_id", scope.actorId),
        "setting_key", key, 64), "setting_value", value, 256), "revision", setting.revision, 64), "updated_at", new Date(setting.updatedAt));
      // UPDLOCK + HOLDLOCK keep the key locked to the end of the transaction, so the insert below cannot race another one.
      const updated = expectedRevision === undefined
        ? await bind().query(`UPDATE agentic.actor_setting WITH (UPDLOCK, HOLDLOCK)
            SET setting_value=@setting_value, revision=@revision, updated_at=@updated_at
            WHERE tenant_id=@tenant_id AND actor_id=@actor_id AND setting_key=@setting_key;`)
        : await text(bind(), "expected_revision", expectedRevision, 64).query(`UPDATE agentic.actor_setting
            SET setting_value=@setting_value, revision=@revision, updated_at=@updated_at
            WHERE tenant_id=@tenant_id AND actor_id=@actor_id AND setting_key=@setting_key AND revision=@expected_revision;`);
      if ((updated.rowsAffected[0] ?? 0) === 1) return setting;
      if (expectedRevision !== undefined) throw actorSettingConflict(key);
      await bind().query(`INSERT INTO agentic.actor_setting(tenant_id,actor_id,setting_key,setting_value,revision,updated_at)
        VALUES (@tenant_id,@actor_id,@setting_key,@setting_value,@revision,@updated_at);`);
      return setting;
    });
  }
}
