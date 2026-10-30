import { checkedLeaseFence, checkedLeaseRequest, reviewIdentifier, reviewTime, type LeaseFence, type WorkerLease, type WorkerLeaseStore } from "@0xsyncroot/contracts";

interface LeaseRow { owner: string | undefined; token: bigint; expiresAtMs: number | undefined }

/**
 * One holder per worker kind, judged by `clock` (milliseconds since the epoch). Each acquisition adds one to the kind's token,
 * the holder's own included, so a token only grows; `holds` is the check a fenced write makes.
 */
export class InMemoryWorkerLeaseStore implements WorkerLeaseStore {
  readonly #rows = new Map<string, LeaseRow>();
  constructor(private readonly clock: () => number = Date.now) {}

  async acquire(workerKind: string, owner: string, ttlMs: number): Promise<WorkerLease | undefined> {
    const request = checkedLeaseRequest(workerKind, owner, ttlMs);
    const now = this.clock();
    const row = this.#rows.get(request.workerKind) ?? { owner: undefined, token: 0n, expiresAtMs: undefined };
    const free = row.owner === undefined || row.owner === request.owner || row.expiresAtMs === undefined || row.expiresAtMs <= now;
    if (!free) return undefined;
    Object.assign(row, { owner: request.owner, token: row.token + 1n, expiresAtMs: now + request.ttlMs });
    this.#rows.set(request.workerKind, row);
    return this.#lease(request.workerKind, row);
  }

  async renew(lease: WorkerLease, ttlMs: number): Promise<WorkerLease | undefined> {
    const request = checkedLeaseRequest(lease.workerKind, lease.owner, ttlMs);
    const fence = checkedLeaseFence(lease);
    const row = this.#rows.get(request.workerKind);
    if (!row || row.owner !== request.owner || !this.#current(row, fence)) return undefined;
    row.expiresAtMs = this.clock() + request.ttlMs;
    return this.#lease(request.workerKind, row);
  }

  async release(lease: WorkerLease): Promise<void> {
    const fence = checkedLeaseFence(lease);
    const row = this.#rows.get(fence.workerKind);
    if (row && row.owner === reviewIdentifier(lease.owner, "owner", 191) && row.token.toString() === fence.fencingToken) {
      row.owner = undefined;
      row.expiresAtMs = undefined;
    }
  }

  /** Whether `fence` is the current, unexpired lease of its kind. */
  holds(fence: LeaseFence): boolean {
    const checked = checkedLeaseFence(fence);
    const row = this.#rows.get(checked.workerKind);
    return row !== undefined && this.#current(row, checked);
  }

  #current(row: LeaseRow, fence: LeaseFence): boolean {
    return row.owner !== undefined && row.token.toString() === fence.fencingToken && row.expiresAtMs !== undefined && row.expiresAtMs > this.clock();
  }

  #lease(workerKind: string, row: LeaseRow): WorkerLease {
    return Object.freeze({ workerKind, owner: row.owner!, fencingToken: row.token.toString(), expiresAt: reviewTime(new Date(row.expiresAtMs!).toISOString(), "expiresAt") });
  }
}
