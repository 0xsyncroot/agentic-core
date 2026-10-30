import { randomUUID } from "node:crypto";
import {
  AgenticError, checkedLeaseFence, checkedProjectionCursor, checkedProjectionWatermark, checkedReviewAccess, checkedReviewEntries, checkedReviewSession,
  checkedReviewSessionQuery, reviewIdentifier, type LeaseFence, type ProjectionCursor, type ProjectionWatermark, type ReviewAccessRecord,
  type ReviewProjectionStore, type ReviewQueryStore, type ReviewSessionCursor, type ReviewSessionPage, type ReviewSessionQuery,
  type ReviewSessionRecord, type ReviewSessionSummary, type ReviewTranscriptEntry,
} from "@0xsyncroot/contracts";
import { freezeDeep } from "./freeze.js";
import type { InMemoryWorkerLeaseStore } from "./worker-lease.js";

export interface InMemoryReviewStoreOptions {
  /** The leases fenced writes are checked against. */
  readonly leases: InMemoryWorkerLeaseStore;
  /** Tenant display names, read on every query, as a tenant's stored profile would give them. */
  readonly tenantNames?: ReadonlyMap<string, string>;
}

const key = (...parts: readonly (string | number)[]) => JSON.stringify(parts);
const descending = (left: ReviewSessionCursor, right: ReviewSessionCursor): number => {
  for (const field of ["startedAt", "tenantId", "sessionId"] as const) if (left[field] !== right[field]) return left[field] > right[field] ? -1 : 1;
  return 0;
};

/**
 * The review projection and the console's reads of it, in one process. A replace checks the fence and every entry before it
 * changes anything, so a refused replace leaves the store as it was, as the database engines' transaction does.
 */
export class InMemoryReviewStore implements ReviewProjectionStore, ReviewQueryStore {
  readonly #headers = new Map<string, ReviewSessionRecord>();
  readonly #entries = new Map<string, ReviewTranscriptEntry>();
  readonly #cursors = new Map<string, ProjectionCursor>();
  readonly #watermarks = new Map<string, ProjectionWatermark>();
  readonly #access: { readonly accessId: string; readonly record: ReviewAccessRecord }[] = [];
  constructor(private readonly options: InMemoryReviewStoreOptions) {}

  async cursor(tenantId: string, sessionId: string, projectorId: string): Promise<ProjectionCursor | undefined> {
    return this.#cursors.get(key(reviewIdentifier(tenantId, "tenantId", 191), reviewIdentifier(sessionId, "sessionId", 191), reviewIdentifier(projectorId, "projectorId", 64)));
  }

  async replace(session: ReviewSessionRecord, entries: readonly ReviewTranscriptEntry[], cursor: ProjectionCursor, fence: LeaseFence): Promise<void> {
    const header = checkedReviewSession(session);
    const checkedEntries = checkedReviewEntries(entries);
    const checkedCursor = checkedProjectionCursor(cursor, header);
    this.#assertFence(fence);
    const missing: [string, ReviewTranscriptEntry][] = [];
    for (const entry of checkedEntries) {
      const entryKey = key(header.tenantId, header.sessionId, entry.maskVersion, entry.entrySeq);
      const stored = this.#entries.get(entryKey);
      if (!stored) missing.push([entryKey, freezeDeep(entry)]);
      else if (JSON.stringify(stored) !== JSON.stringify(entry)) throw new AgenticError("conflict", `Entry ${entry.entrySeq} of mask version ${entry.maskVersion} is stored with different content`);
    }
    const headerKey = key(header.tenantId, header.sessionId);
    const previous = this.#headers.get(headerKey);
    this.#headers.set(headerKey, freezeDeep(previous ? { ...header, startedAt: previous.startedAt } : header));
    for (const [entryKey, entry] of missing) this.#entries.set(entryKey, entry);
    this.#cursors.set(key(checkedCursor.tenantId, checkedCursor.sessionId, checkedCursor.projectorId), freezeDeep(checkedCursor));
  }

  async watermark(projectorId: string): Promise<ProjectionWatermark | undefined> {
    return this.#watermarks.get(reviewIdentifier(projectorId, "projectorId", 64));
  }

  async saveWatermark(watermark: ProjectionWatermark, fence: LeaseFence): Promise<void> {
    const checked = checkedProjectionWatermark(watermark);
    this.#assertFence(fence);
    this.#watermarks.set(checked.projectorId, freezeDeep(checked));
  }

  async listSessions(query: ReviewSessionQuery): Promise<ReviewSessionPage> {
    const checked = checkedReviewSessionQuery(query);
    const matching = [...this.#headers.values()].filter((header) =>
      (checked.agentId === undefined || header.agentId === checked.agentId) && (checked.tenantId === undefined || header.tenantId === checked.tenantId) &&
      (checked.from === undefined || header.startedAt >= checked.from) && (checked.to === undefined || header.startedAt < checked.to) &&
      (checked.sessionIdPrefix === undefined || header.sessionId.startsWith(checked.sessionIdPrefix)) &&
      (checked.after === undefined || descending(header, checked.after) > 0)).sort(descending);
    const page = matching.slice(0, checked.limit);
    const items = page.map((header) => {
      const summary = this.#summary(header);
      const preview = this.#preview(header, checked.previewChars);
      return freezeDeep(preview === undefined ? summary : { ...summary, preview });
    });
    const last = page.at(-1);
    return freezeDeep(matching.length > checked.limit && last ? { items, next: { startedAt: last.startedAt, tenantId: last.tenantId, sessionId: last.sessionId } } : { items });
  }

  async session(tenantId: string, sessionId: string): Promise<ReviewSessionSummary | undefined> {
    const header = this.#headers.get(key(reviewIdentifier(tenantId, "tenantId", 191), reviewIdentifier(sessionId, "sessionId", 191)));
    return header && freezeDeep(this.#summary(header));
  }

  async transcript(tenantId: string, sessionId: string, maskVersion: string): Promise<readonly ReviewTranscriptEntry[]> {
    const tenant = reviewIdentifier(tenantId, "tenantId", 191); const session = reviewIdentifier(sessionId, "sessionId", 191);
    const mask = reviewIdentifier(maskVersion, "maskVersion", 32);
    return this.#transcript(tenant, session, mask);
  }

  async recordAccess(record: ReviewAccessRecord): Promise<string> {
    const checked = freezeDeep(checkedReviewAccess(record));
    const accessId = randomUUID();
    this.#access.push({ accessId, record: checked });
    return accessId;
  }

  /** The access rows recorded for the tenant, oldest first. */
  accessLog(tenantId: string): readonly ReviewAccessRecord[] {
    return this.#access.filter((row) => row.record.tenantId === tenantId).map((row) => row.record);
  }

  #assertFence(fence: LeaseFence): void {
    const checked = checkedLeaseFence(fence);
    if (!this.options.leases.holds(checked)) throw new AgenticError("conflict", `The ${checked.workerKind} lease is not held under fencing token ${checked.fencingToken}`);
  }

  #summary(header: ReviewSessionRecord): ReviewSessionSummary {
    const tenantName = this.options.tenantNames?.get(header.tenantId);
    return tenantName === undefined ? { ...header } : { ...header, tenantName };
  }

  #transcript(tenantId: string, sessionId: string, maskVersion: string): ReviewTranscriptEntry[] {
    const prefix = key(tenantId, sessionId, maskVersion).slice(0, -1);
    return [...this.#entries].filter(([entryKey]) => entryKey.startsWith(`${prefix},`)).map(([, entry]) => entry).sort((left, right) => left.entrySeq - right.entrySeq);
  }

  /** The first characters of the first user entry of the header's mask version, counted in code points as the database does. */
  #preview(header: ReviewSessionRecord, chars: number): string | undefined {
    if (header.transcriptMaskVersion === undefined) return undefined;
    const first = this.#transcript(header.tenantId, header.sessionId, header.transcriptMaskVersion).find((entry) => entry.role === "user");
    return first && [...first.body].slice(0, chars).join("");
  }
}
