import { DEFAULT_SHARD_ID, reviewIdentifier, type ShardDirectory, type ShardEntry } from "@0xsyncroot/contracts";
import type { Pool, RowDataPacket } from "mysql2/promise";

/** Shard routing as the control plane records it; a tenant without a routing row, and every tenant before any shard is registered, is in the default shard. */
export class MySqlShardDirectory implements ShardDirectory {
  constructor(private readonly pool: Pool) {}

  async shards(): Promise<readonly ShardEntry[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>("SELECT shard_id, dsn_ref, status, weight FROM agentic_shard ORDER BY shard_id");
    if (rows.length === 0) return [{ shardId: DEFAULT_SHARD_ID, status: "active", weight: 100 }];
    return rows.map((row) => ({ shardId: String(row.shard_id), dsnRef: String(row.dsn_ref), status: String(row.status), weight: Number(row.weight) }));
  }

  async shardOf(tenantId: string): Promise<string> {
    const [rows] = await this.pool.execute<RowDataPacket[]>("SELECT shard_id FROM agentic_shard_map WHERE tenant_id = ?", [reviewIdentifier(tenantId, "tenantId", 191)]);
    return rows[0] ? String(rows[0].shard_id) : DEFAULT_SHARD_ID;
  }

  async mapVersion(): Promise<number> {
    const [rows] = await this.pool.execute<RowDataPacket[]>("SELECT map_version FROM agentic_shard_map_version WHERE map_name = 'routing'");
    return rows[0] ? Number(rows[0].map_version) : 0;
  }
}
