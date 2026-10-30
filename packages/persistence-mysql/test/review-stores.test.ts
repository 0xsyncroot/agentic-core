import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { AesGcmEnvelopeProtector, DerivedTenantKeyProvider } from "@0xsyncroot/adapter-crypto-node";
import { isProtectedDataEnvelope, type CatalogAuditRecord, type MemberRole, type ReviewAccessRecord } from "@0xsyncroot/contracts";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { controlPlaneConformance } from "../../contracts/test/control-plane-conformance.js";
import { reviewStoreConformance } from "../../contracts/test/review-store-conformance.js";
import {
  MySqlAdminPrincipalStore, MySqlReviewJournalSource, MySqlReviewProjectionStore, MySqlReviewQueryStore, MySqlSessionStore, MySqlShardDirectory,
  MySqlWorkerLeaseStore,
} from "../src/index.js";
import { ADMIN_PASSWORD, ADMIN_USER, appUrl, openPool, ownerScript, ownerUrl, provision, runtime, security, urlAs } from "./mysql-fixture.js";

/** Optional columns read back as absent, the way the ports return them. */
const present = <K extends string>(key: K, value: unknown): { [P in K]?: string } => (value === null ? {} : { [key]: String(value) }) as { [P in K]?: string };
const ISO = (column: string) => `DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%s.%fZ')`;

describe("mysql review and control-plane stores", { skip: appUrl && ownerUrl ? false : "TEST_MYSQL_URL and TEST_MYSQL_OWNER_URL are not set" }, () => {
  let app: Pool; let admin: Pool; let owner: Pool;
  before(async () => {
    await provision();
    app = openPool(appUrl!); admin = openPool(urlAs(appUrl!, ADMIN_USER, ADMIN_PASSWORD)); owner = openPool(ownerUrl!);
  });
  after(async () => { await Promise.all([app?.end(), admin?.end(), owner?.end()]); });

  const expire = async (workerKind: string) => {
    await admin.execute("UPDATE agentic_worker_lease SET lease_expires_at = TIMESTAMPADD(MICROSECOND, -1, UTC_TIMESTAMP(6)) WHERE worker_kind = ?", [workerKind]);
  };

  reviewStoreConformance("mysql", async () => ({
    sessions: new MySqlSessionStore(app, undefined, { stampAppends: true }), unstampedSessions: new MySqlSessionStore(app),
    journal: new MySqlReviewJournalSource(admin), projection: new MySqlReviewProjectionStore(admin), query: new MySqlReviewQueryStore(admin),
    leases: new MySqlWorkerLeaseStore(admin), expire,
    profile: async (tenantId, displayName) => {
      await owner.execute(
        `INSERT INTO agentic_tenant_profile (tenant_id, display_name, attributes, source, source_at) VALUES (?, ?, '{}', 'test', UTC_TIMESTAMP(6))
         ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), version = version + 1`, [tenantId, displayName]);
    },
    accessLog: async (tenantId) => {
      const [rows] = await admin.execute<RowDataPacket[]>(
        `SELECT tenant_id, principal_id, session_id, action, purpose, detail, ${ISO("at")} AS at FROM agentic_review_access WHERE tenant_id = ? ORDER BY at, access_id`, [tenantId]);
      return rows.map((row): ReviewAccessRecord => ({
        tenantId: row.tenant_id, principalId: row.principal_id, ...present("sessionId", row.session_id), action: row.action, purpose: row.purpose,
        ...present("detail", row.detail), at: row.at,
      }));
    },
  }));

  controlPlaneConformance("mysql", async () => ({
    leases: new MySqlWorkerLeaseStore(admin), principals: new MySqlAdminPrincipalStore(admin), expire,
    auditOf: async (principalId) => {
      const [rows] = await admin.execute<RowDataPacket[]>(
        `SELECT scope_kind, scope_id, principal_id, actor_scope, action, target_kind, target_id, before_hash, after_hash, detail, ${ISO("at")} AS at
           FROM agentic_catalog_audit WHERE principal_id = ? ORDER BY at, audit_id`, [principalId]);
      return rows.map((row): CatalogAuditRecord => ({
        scopeKind: row.scope_kind, scopeId: row.scope_id, principalId: row.principal_id, actorScope: row.actor_scope, action: row.action,
        targetKind: row.target_kind, targetId: row.target_id, ...present("beforeHash", row.before_hash), ...present("afterHash", row.after_hash),
        ...present("detail", row.detail), at: row.at,
      }));
    },
    disable: async (principalId: string, role?: MemberRole) => {
      if (role) {
        await admin.execute(
          "UPDATE agentic_catalog_member SET status = 'disabled', version = version + 1, updated_at = UTC_TIMESTAMP(6) WHERE scope_kind = ? AND scope_id = ? AND principal_id = ? AND role = ?",
          [role.scopeKind, role.scopeId, principalId, role.role]);
      } else {
        await admin.execute("UPDATE agentic_platform_principal SET status = 'disabled', version = version + 1, updated_at = UTC_TIMESTAMP(6) WHERE principal_id = ?", [principalId]);
      }
    },
  }));

  test("the console's account reads the journal and can neither write nor delete it, nor delete anything of its own", async () => {
    const [rows] = await admin.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM agentic_session_stream");
    assert.ok(Number(rows[0]!.n) >= 0);
    await admin.query("SELECT 1 FROM agentic_session_event LIMIT 1");
    const denied = (statement: string) => assert.rejects(admin.query(statement), (error: { errno?: number }) => error.errno === 1142, statement);
    await denied("INSERT INTO agentic_session_stream (tenant_id) VALUES ('x')");
    await denied("UPDATE agentic_session_stream SET current_seq = current_seq WHERE 1 = 0");
    for (const table of ["session_stream", "session_event", "session_turn_request", "review_session", "review_transcript", "review_access", "projection_cursor",
      "projection_watermark", "worker_lease", "tenant_profile", "platform_principal", "catalog_member", "catalog_audit", "shard", "shard_map"]) {
      await denied(`DELETE FROM agentic_${table} WHERE 1 = 0`);
    }
  });

  test("a journal reader without a protector passes an encrypted payload through as its envelope and still verifies plain rows", async () => {
    const tenant = `tenant-${crypto.randomUUID()}`; const context = { security: security(tenant, "owner-1"), runtime };
    const protector = new AesGcmEnvelopeProtector(new DerivedTenantKeyProvider(Buffer.alloc(32, 29), "review-test-v1"));
    const userInput = (content: string) => [{ type: "user/input", turnId: "t1", payload: { content, source: "test" } }];
    await new MySqlSessionStore(app).append("s", 0, userInput("plain"), "k-plain", context);
    await new MySqlSessionStore(app, protector).append("s", 1, userInput("secret"), "k-secret", context);
    const [plain, sealed] = await new MySqlReviewJournalSource(admin).eventsAfter(tenant, "s", 0, 10);
    assert.deepEqual(plain?.payload, { content: "plain", source: "test" });
    assert.ok(sealed && isProtectedDataEnvelope(sealed.payload), "the envelope arrives unchanged");
    assert.equal(JSON.stringify(sealed.payload).includes("secret"), false);
    const [hash] = await owner.query<RowDataPacket[]>("SELECT integrity_hash FROM agentic_session_event WHERE tenant_id = ? AND seq = 2", [tenant]);
    assert.equal(sealed.integrityHash, hash[0]!.integrity_hash);
    const decrypted = await new MySqlReviewJournalSource(admin, protector).eventsAfter(tenant, "s", 1, 10);
    assert.deepEqual(decrypted.map((event) => event.payload), [{ content: "secret", source: "test" }]);
    await owner.execute("UPDATE agentic_session_event SET integrity_hash = ? WHERE tenant_id = ? AND seq = 1", ["0".repeat(64), tenant]);
    await assert.rejects(new MySqlReviewJournalSource(admin).eventsAfter(tenant, "s", 0, 10), (error: { code?: string }) => error.code === "permanent");
  });

  test("shard routing reads registered shards in order, a tenant's routing row and the map version, defaulting to s0", async () => {
    const shards = new MySqlShardDirectory(admin);
    const tenant = `tenant-${crypto.randomUUID()}`;
    const [registered] = await owner.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM agentic_shard");
    if (Number(registered[0]!.n) === 0) assert.deepEqual(await shards.shards(), [{ shardId: "s0", status: "active", weight: 100 }]);
    assert.equal(await shards.shardOf(tenant), "s0");
    const [version] = await owner.query<RowDataPacket[]>("SELECT map_version FROM agentic_shard_map_version WHERE map_name = 'routing'");
    assert.equal(await shards.mapVersion(), version[0] ? Number(version[0].map_version) : 0);
    const ids = [`t-${crypto.randomUUID().slice(0, 8)}-b`, `t-${crypto.randomUUID().slice(0, 8)}-a`];
    try {
      for (const id of ids) {
        await owner.execute("INSERT INTO agentic_shard (shard_id, dsn_ref, status, weight, updated_at) VALUES (?, ?, 'active', 50, UTC_TIMESTAMP(6))", [id, `secret-${id}`]);
      }
      await owner.execute("INSERT INTO agentic_shard_map (tenant_id, shard_id, state, map_version, updated_by, updated_at) VALUES (?, ?, 'active', 1, ?, UTC_TIMESTAMP(6))",
        [tenant, ids[0]!, crypto.randomUUID()]);
      const listed = (await shards.shards()).filter((entry) => ids.includes(entry.shardId));
      assert.deepEqual(listed, [...ids].sort().map((id) => ({ shardId: id, dsnRef: `secret-${id}`, status: "active", weight: 50 })));
      assert.equal(await shards.shardOf(tenant), ids[0]);
    } finally {
      await ownerScript(`DELETE FROM agentic_shard_map WHERE tenant_id = '${tenant}'; DELETE FROM agentic_shard WHERE shard_id IN ('${ids.join("','")}')`);
    }
  });
});
