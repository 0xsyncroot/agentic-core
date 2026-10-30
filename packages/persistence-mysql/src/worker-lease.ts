import { checkedLeaseFence, checkedLeaseRequest, reviewIdentifier, type WorkerLease, type WorkerLeaseStore } from "@0xsyncroot/contracts";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { isoColumn } from "./mysql-time.js";
import { withTransaction } from "./transaction.js";

const ER_DUP_ENTRY = 1062;
const LEASE_COLUMNS = `worker_kind, lease_owner, CAST(fencing_token AS CHAR) AS fencing_token, ${isoColumn("lease_expires_at")} AS expires_at`;

async function readHeld(connection: PoolConnection, workerKind: string, owner: string, token?: string): Promise<WorkerLease | undefined> {
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT ${LEASE_COLUMNS} FROM agentic_worker_lease WHERE worker_kind = ?`, [workerKind]);
  const row = rows[0];
  if (!row || row.lease_owner !== owner || (token !== undefined && row.fencing_token !== token)) return undefined;
  return { workerKind, owner, fencingToken: String(row.fencing_token), expiresAt: String(row.expires_at) };
}

/**
 * One holder per worker kind in this shard, judged by the database clock. Each acquisition adds one to the token inside the
 * UPDATE that takes the row, so the token only grows and two workers can never hold the same one. The ttl is inlined after
 * validation as a whole number of microseconds. The row is created once
 * with no holder; a concurrent creator's duplicate key just means the row exists.
 */
export class MySqlWorkerLeaseStore implements WorkerLeaseStore {
  constructor(private readonly pool: Pool) {}

  async acquire(workerKind: string, owner: string, ttlMs: number): Promise<WorkerLease | undefined> {
    const request = checkedLeaseRequest(workerKind, owner, ttlMs);
    await this.#ensureRow(request.workerKind);
    return withTransaction(this.pool, async (connection) => {
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE agentic_worker_lease SET lease_owner = ?, fencing_token = fencing_token + 1,
                lease_expires_at = TIMESTAMPADD(MICROSECOND, ${request.ttlMs * 1000}, UTC_TIMESTAMP(6))
          WHERE worker_kind = ? AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at IS NULL OR lease_expires_at <= UTC_TIMESTAMP(6))`,
        [request.owner, request.workerKind, request.owner]);
      return result.affectedRows === 1 ? readHeld(connection, request.workerKind, request.owner) : undefined;
    });
  }

  async renew(lease: WorkerLease, ttlMs: number): Promise<WorkerLease | undefined> {
    const request = checkedLeaseRequest(lease.workerKind, lease.owner, ttlMs);
    const fence = checkedLeaseFence(lease);
    return withTransaction(this.pool, async (connection) => {
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE agentic_worker_lease SET lease_expires_at = TIMESTAMPADD(MICROSECOND, ${request.ttlMs * 1000}, UTC_TIMESTAMP(6))
          WHERE worker_kind = ? AND lease_owner = ? AND CAST(fencing_token AS CHAR) = ? AND lease_expires_at > UTC_TIMESTAMP(6)`,
        [request.workerKind, request.owner, fence.fencingToken]);
      return result.affectedRows === 1 ? readHeld(connection, request.workerKind, request.owner, fence.fencingToken) : undefined;
    });
  }

  async release(lease: WorkerLease): Promise<void> {
    const fence = checkedLeaseFence(lease);
    await this.pool.execute(
      "UPDATE agentic_worker_lease SET lease_owner = NULL, lease_expires_at = NULL WHERE worker_kind = ? AND lease_owner = ? AND CAST(fencing_token AS CHAR) = ?",
      [fence.workerKind, reviewIdentifier(lease.owner, "owner", 191), fence.fencingToken]);
  }

  async #ensureRow(workerKind: string): Promise<void> {
    const [rows] = await this.pool.execute<RowDataPacket[]>("SELECT 1 FROM agentic_worker_lease WHERE worker_kind = ?", [workerKind]);
    if (rows.length > 0) return;
    try {
      await this.pool.execute("INSERT INTO agentic_worker_lease (worker_kind) VALUES (?)", [workerKind]);
    } catch (error) {
      if ((error as { errno?: unknown }).errno !== ER_DUP_ENTRY) throw error;
    }
  }
}
