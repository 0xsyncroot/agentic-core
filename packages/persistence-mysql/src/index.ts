import type { BlindIndexEncoder, PayloadProtector } from "@0xsyncroot/contracts";
import { MySqlActorSettingStore } from "./actor-setting-store.js";
import { MySqlAdminPrincipalStore } from "./admin-principal.js";
import { MySqlCatalogStore } from "./catalog-store.js";
import { probeAppendStamp } from "./append-stamp.js";
import { MySqlMemoryService } from "./memory-service.js";
import { openMySqlPool, type MySqlPoolOptions } from "./pool.js";
import { MySqlReviewJournalSource } from "./review-journal.js";
import { MySqlReviewProjectionStore } from "./review-projection.js";
import { MySqlReviewQueryStore } from "./review-query.js";
import { MySqlSessionStore } from "./session-store.js";
import { MySqlShardDirectory } from "./shard-directory.js";
import { MySqlUsageStore } from "./usage-store.js";
import { MySqlWorkerLeaseStore } from "./worker-lease.js";

export { MySqlActorSettingStore } from "./actor-setting-store.js";
export { MySqlAdminPrincipalStore } from "./admin-principal.js";
export { MySqlCatalogBuildRegistry } from "./catalog-build.js";
export { MySqlCatalogReader } from "./catalog-rows.js";
export { MySqlCatalogStore } from "./catalog-store.js";
export { probeAppendStamp, type AppendStampProbe } from "./append-stamp.js";
export { migrateMySql, migrateMySqlCatalog, type MySqlMigrationOptions } from "./migrate.js";
export { MySqlMemoryService } from "./memory-service.js";
export { keepPoolWarm, warmSettings, type MySqlPersistenceEvent, type MySqlPoolOptions, type PoolKeepWarm } from "./pool.js";
export { MySqlReviewJournalSource } from "./review-journal.js";
export { MySqlReviewProjectionStore } from "./review-projection.js";
export { MySqlReviewQueryStore } from "./review-query.js";
export { MySqlSessionStore } from "./session-store.js";
export { MySqlShardDirectory } from "./shard-directory.js";
export { MySqlUsageStore } from "./usage-store.js";
export { MySqlWorkerLeaseStore } from "./worker-lease.js";

export interface MySqlPersistenceOptions extends MySqlPoolOptions {
  readonly payloadProtector?: PayloadProtector;
  readonly blindIndex?: BlindIndexEncoder;
}

export interface MySqlPersistence {
  readonly sessions: MySqlSessionStore; readonly memory: MySqlMemoryService; readonly settings: MySqlActorSettingStore; close(): Promise<void>;
}

/**
 * The agent's stores over one pool. A deployment passes the pool size it reads from AGENTIC_MYSQL_POOL_SIZE, since an adapter
 * never reads the environment. The boot connection also probes whether this account may stamp `last_appended_at`; appends
 * stamp it only when the probe passed, and the outcome is logged after the pool measurement.
 */
export async function createMySqlPersistence(connectionString: string, options: MySqlPersistenceOptions = {}): Promise<MySqlPersistence> {
  const opened = await openMySqlPool(connectionString, options, probeAppendStamp);
  const stamp = opened.inspected;
  opened.log(stamp.enabled ? { event: "mysql.append-stamp.enabled", level: "info" } : { event: "mysql.append-stamp.disabled", level: "warn", reason: stamp.reason });
  return {
    sessions: new MySqlSessionStore(opened.pool, options.payloadProtector, { stampAppends: stamp.enabled }),
    memory: new MySqlMemoryService(opened.pool, options.payloadProtector, options.blindIndex), settings: new MySqlActorSettingStore(opened.pool),
    close: opened.close,
  };
}

export interface MySqlReviewShardOptions extends MySqlPoolOptions {
  /** The protector the agent writes the journal with, so the projector can read the payloads it seals. */
  readonly payloadProtector?: PayloadProtector;
}

/** The console's stores over one shard, opened with the console's own account. */
export interface MySqlReviewShard {
  readonly journal: MySqlReviewJournalSource; readonly projection: MySqlReviewProjectionStore; readonly query: MySqlReviewQueryStore;
  readonly usage: MySqlUsageStore; readonly leases: MySqlWorkerLeaseStore; close(): Promise<void>;
}

export async function createMySqlReviewShard(connectionString: string, options: MySqlReviewShardOptions = {}): Promise<MySqlReviewShard> {
  const opened = await openMySqlPool(connectionString, options, async () => undefined);
  return {
    journal: new MySqlReviewJournalSource(opened.pool, options.payloadProtector), projection: new MySqlReviewProjectionStore(opened.pool),
    query: new MySqlReviewQueryStore(opened.pool), usage: new MySqlUsageStore(opened.pool), leases: new MySqlWorkerLeaseStore(opened.pool),
    close: opened.close,
  };
}

/** Operators, their audit, shard routing and the catalog editor, over the control plane's database. */
export interface MySqlControlPlane {
  readonly principals: MySqlAdminPrincipalStore; readonly shards: MySqlShardDirectory; readonly catalog: MySqlCatalogStore; close(): Promise<void>;
}

export async function createMySqlControlPlane(connectionString: string, options: MySqlPoolOptions = {}): Promise<MySqlControlPlane> {
  const opened = await openMySqlPool(connectionString, options, async () => undefined);
  return {
    principals: new MySqlAdminPrincipalStore(opened.pool), shards: new MySqlShardDirectory(opened.pool), catalog: new MySqlCatalogStore(opened.pool),
    close: opened.close,
  };
}
