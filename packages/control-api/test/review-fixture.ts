import { AgenticError, DEFAULT_SHARD_ID, type AdminPrincipal, type AdminPrincipalSeed, type AdminPrincipalStore, type CatalogAuditRecord,
  type ChangedSession, type ChangedSessionCursor, type LeaseFence, type MemberRole, type ProjectionCursor, type ProjectionWatermark,
  type ReviewAccessRecord, type ReviewJournalSource, type ReviewProjectionStore, type ReviewQueryStore, type ReviewSessionPage,
  type ReviewSessionQuery, type ReviewSessionRecord, type ReviewTranscriptEntry, type SessionEvent, type ShardDirectory, type ShardEntry,
  type ShardStream, type StreamKeyCursor, type WorkerLease, type WorkerLeaseStore } from "@0xsyncroot/contracts";

/** In-test ports with the documented semantics, so projector and query tests run without a database. */

export function event(seq: number, type: string, payload: unknown, extra: Partial<SessionEvent> = {}): SessionEvent {
  return {
    eventId: `e${seq}`, sessionId: "s1", seq, occurredAt: new Date(Date.UTC(2026, 9, 1, 8, 0, seq)).toISOString(), recordedAt: "",
    tenantId: "t1", actorId: "actor-1", correlationId: "c", runtimeSnapshotId: "r", integrityHash: `h${seq}:${JSON.stringify(payload)}`,
    type, turnId: "turn-1", payload: payload as SessionEvent["payload"], ...extra,
  };
}

export class MemoryJournal implements ReviewJournalSource {
  readonly streams = new Map<string, { changed: ShardStream; events: SessionEvent[] }>();
  /** Sessions whose events cannot be read, as a stream with a broken row fails. */
  readonly failing = new Set<string>();
  put(changed: ShardStream, events: SessionEvent[]): void {
    this.streams.set(`${changed.tenantId}|${changed.sessionId}`, { changed, events });
  }
  async changedSince(sinceIso: string, limit: number, after?: ChangedSessionCursor): Promise<readonly ChangedSession[]> {
    const key = (c: ChangedSessionCursor) => `${c.lastAppendedAt}|${c.tenantId}|${c.sessionId}`;
    return [...this.streams.values()].map((stream) => stream.changed)
      .filter((changed): changed is ChangedSession => changed.lastAppendedAt !== null)
      .filter((changed) => changed.lastAppendedAt >= sinceIso && (!after || key(changed) > key(after)))
      .sort((a, b) => (key(a) < key(b) ? -1 : 1)).slice(0, limit);
  }
  async streamsByKey(limit: number, after?: StreamKeyCursor): Promise<readonly ShardStream[]> {
    const key = (c: StreamKeyCursor) => `${c.tenantId}|${c.sessionId}`;
    return [...this.streams.values()].map((stream) => stream.changed).filter((changed) => !after || key(changed) > key(after))
      .sort((a, b) => (key(a) < key(b) ? -1 : 1)).slice(0, limit);
  }
  async eventsAfter(tenantId: string, sessionId: string, afterSeq: number, limit: number): Promise<readonly SessionEvent[]> {
    if (this.failing.has(sessionId)) throw new AgenticError("permanent", `stream ${sessionId} is unreadable`);
    return (this.streams.get(`${tenantId}|${sessionId}`)?.events ?? []).filter((item) => item.seq > afterSeq).slice(0, limit);
  }
}

export class MemoryLeases implements WorkerLeaseStore {
  token = 0;
  held = new Map<string, WorkerLease>();
  loseOnRenew = false;
  async acquire(workerKind: string, owner: string): Promise<WorkerLease | undefined> {
    const current = this.held.get(workerKind);
    if (current && current.owner !== owner) return undefined;
    const lease = { workerKind, owner, fencingToken: String(++this.token), expiresAt: "2999-01-01T00:00:00.000Z" };
    this.held.set(workerKind, lease);
    return lease;
  }
  async renew(lease: WorkerLease): Promise<WorkerLease | undefined> {
    if (this.loseOnRenew) { this.held.delete(lease.workerKind); return undefined; }
    return this.held.get(lease.workerKind)?.fencingToken === lease.fencingToken ? lease : undefined;
  }
  async release(lease: WorkerLease): Promise<void> {
    if (this.held.get(lease.workerKind)?.fencingToken === lease.fencingToken) this.held.delete(lease.workerKind);
  }
  check(fence: LeaseFence): void {
    if (this.held.get(fence.workerKind)?.fencingToken !== fence.fencingToken) throw new AgenticError("conflict", "lease lost");
  }
}

export class MemoryReview implements ReviewProjectionStore, ReviewQueryStore {
  readonly sessions = new Map<string, ReviewSessionRecord>();
  readonly entries = new Map<string, ReviewTranscriptEntry>();
  readonly cursors = new Map<string, ProjectionCursor>();
  readonly marks = new Map<string, ProjectionWatermark>();
  readonly access: ReviewAccessRecord[] = [];
  readonly tenantNames = new Map<string, string>();
  writes = 0;
  constructor(private readonly leases: MemoryLeases) {}
  async cursor(tenantId: string, sessionId: string, projectorId: string) { return this.cursors.get(`${tenantId}|${sessionId}|${projectorId}`); }
  async replace(session: ReviewSessionRecord, entries: readonly ReviewTranscriptEntry[], cursor: ProjectionCursor, fence: LeaseFence) {
    this.leases.check(fence);
    for (const entry of entries) {
      const stored = this.entries.get(`${session.tenantId}|${session.sessionId}|${entry.maskVersion}|${entry.entrySeq}`);
      if (stored && JSON.stringify(stored) !== JSON.stringify(entry)) throw new AgenticError("conflict", "entry changed");
    }
    for (const entry of entries) this.entries.set(`${session.tenantId}|${session.sessionId}|${entry.maskVersion}|${entry.entrySeq}`, entry);
    this.sessions.set(`${session.tenantId}|${session.sessionId}`, session);
    this.cursors.set(`${cursor.tenantId}|${cursor.sessionId}|${cursor.projectorId}`, cursor);
    this.writes += 1;
  }
  async watermark(projectorId: string) { return this.marks.get(projectorId); }
  async saveWatermark(watermark: ProjectionWatermark, fence: LeaseFence) { this.leases.check(fence); this.marks.set(watermark.projectorId, watermark); }
  #summary(record: ReviewSessionRecord, previewChars: number) {
    const version = record.transcriptMaskVersion;
    const first = [...this.entries.entries()].filter(([key, entry]) => version !== undefined && key.startsWith(`${record.tenantId}|${record.sessionId}|${version}|`) && entry.role === "user")
      .map(([, entry]) => entry).sort((a, b) => a.entrySeq - b.entrySeq)[0];
    const name = this.tenantNames.get(record.tenantId);
    return { ...record, ...(name ? { tenantName: name } : {}), ...(first ? { preview: first.body.slice(0, previewChars) } : {}) };
  }
  async listSessions(query: ReviewSessionQuery): Promise<ReviewSessionPage> {
    const key = (r: { startedAt: string; tenantId: string; sessionId: string }) => `${r.startedAt}|${r.tenantId}|${r.sessionId}`;
    const rows = [...this.sessions.values()].filter((r) => (!query.agentId || r.agentId === query.agentId) && (!query.tenantId || r.tenantId === query.tenantId)
      && (!query.from || r.startedAt >= query.from) && (!query.to || r.startedAt < query.to)
      && (!query.sessionIdPrefix || r.sessionId.startsWith(query.sessionIdPrefix)) && (!query.after || key(r) < key(query.after)))
      .sort((a, b) => (key(a) < key(b) ? 1 : -1));
    const items = rows.slice(0, query.limit).map((r) => this.#summary(r, query.previewChars));
    const last = items.at(-1);
    return { items, ...(rows.length > query.limit && last ? { next: { startedAt: last.startedAt, tenantId: last.tenantId, sessionId: last.sessionId } } : {}) };
  }
  async session(tenantId: string, sessionId: string) {
    const record = this.sessions.get(`${tenantId}|${sessionId}`);
    return record ? this.#summary(record, 2000) : undefined;
  }
  async transcript(tenantId: string, sessionId: string, maskVersion: string) {
    return [...this.entries.entries()].filter(([key]) => key.startsWith(`${tenantId}|${sessionId}|${maskVersion}|`)).map(([, entry]) => entry)
      .sort((a, b) => a.entrySeq - b.entrySeq);
  }
  async recordAccess(record: ReviewAccessRecord) { this.access.push(record); return String(this.access.length); }
}

export class MemoryPrincipals implements AdminPrincipalStore {
  readonly principals = new Map<string, AdminPrincipal>();
  readonly grants = new Map<string, MemberRole[]>();
  readonly audits: CatalogAuditRecord[] = [];
  async ensureSeed(seed: AdminPrincipalSeed, roles: readonly MemberRole[]): Promise<AdminPrincipal> {
    const principal = this.principals.get(seed.principalId) ?? { ...seed, status: "active" as const };
    this.principals.set(seed.principalId, { ...principal, displayName: seed.displayName });
    this.grants.set(seed.principalId, [...roles]);
    return this.principals.get(seed.principalId) as AdminPrincipal;
  }
  async get(principalId: string) { return this.principals.get(principalId); }
  async roles(principalId: string) { return this.grants.get(principalId) ?? []; }
  async audit(record: CatalogAuditRecord) { this.audits.push(record); return String(this.audits.length); }
}

export class OneShard implements ShardDirectory {
  async shards(): Promise<readonly ShardEntry[]> { return [{ shardId: DEFAULT_SHARD_ID, status: "active", weight: 1 }]; }
  async shardOf(): Promise<string> { return DEFAULT_SHARD_ID; }
  async mapVersion(): Promise<number> { return 0; }
}
