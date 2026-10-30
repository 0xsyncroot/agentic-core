import {
  OPEN_TURN_FACT_PAGE_MAX, REVIEW_LIMITS, type ChangedSessionCursor, type OpenTurnFact, type LeaseFence, type ReviewJournalSource, type ReviewProjectionStore, type ReviewQueryStore,
  type ReviewSessionRecord, type SessionEvent, type ShardStream, type StreamKeyCursor, type UsageProjectionStore, type WorkerLease,
  type WorkerLeaseStore,
} from "@0xsyncroot/contracts";
import type { CompiledPersonalFields } from "../masking/config.js";
import type { ActorPseudonyms } from "../pseudonym.js";
import { extractTurnFacts } from "../stats/turn-facts.js";
import { chooseMaskVersion } from "./mask-version.js";
import { buildTranscript, type TranscriptWording } from "./transcript.js";

/** Streams stamped this long before the watermark are read again, so an append committed late is never skipped. */
export const PROJECTION_OVERLAP_MS = 10 * 60 * 1000;
const EPOCH = "1970-01-01T00:00:00.000Z";

/** One shard's ports, as the projector reads and writes them. */
export interface ShardProjectionPorts {
  readonly journal: ReviewJournalSource;
  readonly projection: ReviewProjectionStore;
  readonly query: ReviewQueryStore;
  readonly leases: WorkerLeaseStore;
  readonly usage: UsageProjectionStore;
}

export interface ProjectorOptions {
  readonly projectorId: string;
  /** From `projectorRevision`: a stored cursor or watermark of another revision is rebuilt from the start. */
  readonly revision: string;
  /** This process, as the lease names its holder. */
  readonly owner: string;
  readonly leaseTtlMs: number;
  /** The agent a session belongs to when its stream records none. */
  readonly defaultAgentId: string;
  readonly pseudonyms: ActorPseudonyms;
  readonly fields: CompiledPersonalFields;
  readonly wording: TranscriptWording;
  /** Streams per `changedSince` page (1 to 1000). */
  readonly pageSize?: number;
  /** A turn without a close whose own last event is this old (ms, 0 or more) is abandoned; a younger one is saved as open. */
  readonly abandonAfterMs: number;
  /** The clock that decides whether a turn's last event is past the threshold; the system clock when absent. */
  readonly now?: () => Date;
}

/** A stream a run could not project; nothing of it was written, so its cursor is where it was. */
export interface StreamFailure {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly reason: string;
}

export interface ProjectionRun {
  /** False when another worker held the shard's lease, so nothing was read. */
  readonly leased: boolean;
  readonly seen: number;
  readonly rebuilt: number;
  /** False when the lease was lost part way; the next run resumes from the saved watermark. */
  readonly completed: boolean;
  /**
   * Streams skipped by this run; the watermark stays at the earliest of them, so the next run tries them again. A skipped
   * stream never stamped saves no watermark, so the next run reads the shard by key again.
   */
  readonly failed: readonly StreamFailure[];
}

const fenceOf = (lease: WorkerLease): LeaseFence => ({ workerKind: lease.workerKind, fencingToken: lease.fencingToken });

/** The agent a stream ran: the stream's own record, or the runtime binding of its first turn. */
function agentOf(changed: ShardStream, events: readonly SessionEvent[], fallback: string): string {
  if (changed.agentProfileId) return changed.agentProfileId;
  for (const event of events) {
    const binding = event.type === "turn/start" ? (event.payload as { runtimeBinding?: { agentProfileId?: unknown } } | null)?.runtimeBinding : undefined;
    if (typeof binding?.agentProfileId === "string" && binding.agentProfileId) return binding.agentProfileId;
  }
  return fallback;
}

/**
 * Keeps one shard's review tables in step with its journal. Each run holds the shard's projector lease, walks the streams
 * stamped since the watermark less the overlap, and rebuilds a stream whose journal moved past its cursor or whose cursor
 * has another revision. A rebuild reads the whole stream, because masking needs every tool result of the session; the
 * cursor only decides whether to rebuild. The same rebuild saves a usage fact for every turn of the stream before it moves
 * the cursor, so facts ride the same cursor and a crash in between saves them again. A turn without a close is saved as
 * `open` at its last event, and a completed run closes every open fact whose last event passed the threshold as
 * `abandoned`, so a hung turn is closed even when its stream never moves again; a close appended later rebuilds the stream
 * and replaces the fact. Writes carry the lease's fence, so a worker that lost the lease writes nothing.
 * A stream that fails is reported and skipped, and the run goes on with the rest. A run with no watermark of its revision
 * first walks every stream by key and projects those never stamped, which the stamp walk cannot list; the stamp walk from
 * the epoch that follows covers the rest, including a stream stamped while the key walk ran.
 */
export class ReviewProjector {
  readonly #workerKind: string;

  constructor(private readonly options: ProjectorOptions) {
    const page = options.pageSize ?? REVIEW_LIMITS.maxChangedPage;
    if (!Number.isInteger(page) || page < 1 || page > REVIEW_LIMITS.maxChangedPage) throw new RangeError("pageSize must be 1 to 1000");
    if (!Number.isSafeInteger(options.abandonAfterMs) || options.abandonAfterMs < 0) throw new RangeError("abandonAfterMs must be a whole number of ms, 0 or more");
    this.#workerKind = `review-projector:${options.projectorId}`;
  }

  async runOnce(shard: ShardProjectionPorts): Promise<ProjectionRun> {
    const acquired = await shard.leases.acquire(this.#workerKind, this.options.owner, this.options.leaseTtlMs);
    if (!acquired) return { leased: false, seen: 0, rebuilt: 0, completed: false, failed: [] };
    let lease: WorkerLease = acquired;
    let seen = 0;
    let rebuilt = 0;
    const failed: StreamFailure[] = [];
    let earliestFailure: string | undefined;
    let unstampedFailed = false;
    const end = (completed: boolean): ProjectionRun => ({ leased: true, seen, rebuilt, completed, failed });
    const keep = async (): Promise<boolean> => {
      const renewed = await shard.leases.renew(lease, this.options.leaseTtlMs);
      if (renewed) lease = renewed;
      return renewed !== undefined;
    };
    /** Projects one stream; false when the lease was lost, which ends the run. */
    const visit = async (stream: ShardStream): Promise<boolean> => {
      seen += 1;
      try {
        if (await this.#project(shard, stream, fenceOf(lease))) rebuilt += 1;
        return true;
      } catch (error) {
        // A write refused because the lease moved on is the run's end, not this stream's failure.
        if (!(await keep())) return false;
        failed.push({ tenantId: stream.tenantId, sessionId: stream.sessionId, reason: error instanceof Error ? error.message : String(error) });
        if (stream.lastAppendedAt === null) unstampedFailed = true;
        else if (earliestFailure === undefined || Date.parse(stream.lastAppendedAt) < Date.parse(earliestFailure)) earliestFailure = stream.lastAppendedAt;
        return true;
      }
    };
    try {
      const { projectorId, revision } = this.options;
      const stored = await shard.projection.watermark(projectorId);
      const mark = stored?.projectorRevision === revision ? stored : undefined;
      const limit = this.options.pageSize ?? REVIEW_LIMITS.maxChangedPage;
      if (!mark) {
        for (let after: StreamKeyCursor | undefined; ;) {
          const page = await shard.journal.streamsByKey(limit, after);
          for (const stream of page) if (stream.lastAppendedAt === null && !(await visit(stream))) return end(false);
          if (!(await keep())) return end(false);
          const last = page.at(-1);
          if (page.length < limit || !last) break;
          after = { tenantId: last.tenantId, sessionId: last.sessionId };
        }
      }
      const since = mark ? new Date(Date.parse(mark.watermarkAt) - PROJECTION_OVERLAP_MS).toISOString() : EPOCH;
      let newest = mark?.watermarkAt;
      for (let after: ChangedSessionCursor | undefined; ;) {
        const page = await shard.journal.changedSince(since, limit, after);
        for (const changed of page) {
          if (!(await visit(changed))) return end(false);
          if (newest === undefined || Date.parse(changed.lastAppendedAt) > Date.parse(newest)) newest = changed.lastAppendedAt;
        }
        if (!(await keep())) return end(false);
        const last = page.at(-1);
        if (page.length < limit || !last) break;
        after = { lastAppendedAt: last.lastAppendedAt, tenantId: last.tenantId, sessionId: last.sessionId };
      }
      // A shard with no stamped stream still saves the epoch, so the key walk is not repeated.
      if (!unstampedFailed) {
        await shard.projection.saveWatermark({ projectorId, watermarkAt: earliestFailure ?? newest ?? EPOCH, projectorRevision: revision }, fenceOf(lease));
      }
      return end(await this.#abandonOldOpenTurns(shard.usage, () => fenceOf(lease), keep));
    } finally {
      await shard.leases.release(lease);
    }
  }

  /** Rebuilds one stream when its cursor is behind or of another revision; true when it wrote. */
  async #project(shard: ShardProjectionPorts, changed: ShardStream, fence: LeaseFence): Promise<boolean> {
    const { projectorId, revision } = this.options;
    const cursor = await shard.projection.cursor(changed.tenantId, changed.sessionId, projectorId);
    if (cursor && cursor.projectorRevision === revision && cursor.projectedSeq >= changed.currentSeq) return false;
    const events = await this.#allEvents(shard.journal, changed);
    const first = events[0];
    if (!first) return false;
    const built = buildTranscript(events, this.options.fields, this.options.wording);
    const header = await shard.query.session(changed.tenantId, changed.sessionId);
    const storedVersion = header?.transcriptMaskVersion;
    const stored = storedVersion
      ? { version: storedVersion, entries: await shard.query.transcript(changed.tenantId, changed.sessionId, storedVersion) }
      : undefined;
    const maskVersion = chooseMaskVersion(revision, built.entries, stored);
    const agentId = agentOf(changed, events, this.options.defaultAgentId);
    const session: ReviewSessionRecord = {
      tenantId: changed.tenantId, sessionId: changed.sessionId, agentId, channel: "live",
      actorKey: this.options.pseudonyms.actorKey(changed.tenantId, changed.ownerActorId ?? first.actorId),
      actorKeyVersion: this.options.pseudonyms.version, startedAt: built.startedAt, lastTurnAt: built.lastTurnAt, answers: built.answers,
      transcriptMaskVersion: maskVersion,
    };
    const facts = extractTurnFacts(events, {
      tenantId: changed.tenantId, sessionId: changed.sessionId, defaultAgentId: agentId, pseudonyms: this.options.pseudonyms,
      idleBefore: this.#idleBefore(),
    });
    const projectedSeq = events.at(-1)?.seq ?? 0;
    await shard.usage.saveTurnFacts(facts, revision, fence);
    await shard.projection.replace(session, built.entries.map((entry) => ({ ...entry, maskVersion })),
      { tenantId: changed.tenantId, sessionId: changed.sessionId, projectorId, projectedSeq, projectorRevision: revision }, fence);
    return true;
  }

  /**
   * Abandons every open fact of the shard whose last event passed the threshold, a page at a time; false when the lease was
   * lost. Runs after the watermark is saved, so a refused sweep never holds back the streams' progress. A fact the store
   * leaves open (it closed or moved since it was listed) is not listed again, because each page starts after the last one.
   */
  async #abandonOldOpenTurns(usage: UsageProjectionStore, fence: () => LeaseFence, keep: () => Promise<boolean>): Promise<boolean> {
    const before = this.#idleBefore();
    for (let after: OpenTurnFact | undefined; ;) {
      const page = await usage.listOpenTurnFacts({ before, limit: OPEN_TURN_FACT_PAGE_MAX, ...(after ? { after } : {}) });
      try {
        if (page.length > 0) await usage.abandonOpenTurnFacts(page, before, this.options.revision, fence());
      } catch (error) {
        if (!(await keep())) return false;
        throw error;
      }
      if (!(await keep())) return false;
      const last = page.at(-1);
      if (page.length < OPEN_TURN_FACT_PAGE_MAX || !last) return true;
      after = last;
    }
  }

  /** The instant a turn's last event must precede for the turn to count as abandoned. */
  #idleBefore(): string {
    return new Date((this.options.now ?? (() => new Date()))().getTime() - this.options.abandonAfterMs).toISOString();
  }

  async #allEvents(journal: ReviewJournalSource, changed: ShardStream): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for (let afterSeq = 0; ;) {
      const page = await journal.eventsAfter(changed.tenantId, changed.sessionId, afterSeq, REVIEW_LIMITS.maxEventPage);
      events.push(...page);
      const last = page.at(-1);
      if (page.length < REVIEW_LIMITS.maxEventPage || !last) return events;
      afterSeq = last.seq;
    }
  }
}
