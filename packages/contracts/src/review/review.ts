import type { SessionEvent } from "../sessions/session.js";

/**
 * Review ports: the read side an operator console builds over the session journal.
 *
 * Every read or write names its tenant, except `ReviewJournalSource.changedSince` and `streamsByKey`, which walk one shard's
 * streams by the time they were last appended to and by key. None of these checks a session owner: an operator reads conversations they do not own,
 * and the caller is responsible for having authorised that before it calls. Times are ISO 8601 UTC with microseconds at most;
 * stores return them with exactly six fractional digits (`reviewTime`), and refuse input outside the rules in `rules.ts`.
 */

/** A stream whose journal moved, as the projector finds it. `lastAppendedAt` is the stamp the append path writes. */
export interface ChangedSession {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly ownerActorId: string | null;
  readonly agentProfileId: string | null;
  readonly currentSeq: number;
  readonly lastAppendedAt: string;
}

/** Keyset position in `changedSince`: the last item of the previous page. Order is (lastAppendedAt, tenantId, sessionId). */
export type ChangedSessionCursor = Pick<ChangedSession, "lastAppendedAt" | "tenantId" | "sessionId">;

/** A stream as `streamsByKey` lists it; `lastAppendedAt` is null for a stream never stamped. */
export type ShardStream = Omit<ChangedSession, "lastAppendedAt"> & { readonly lastAppendedAt: string | null };

/** Keyset position in `streamsByKey`: the last stream of the previous page. Order is (tenantId, sessionId), the primary key. */
export type StreamKeyCursor = Pick<ShardStream, "tenantId" | "sessionId">;

/**
 * Read-only access to the raw journal of one shard. Payloads arrive decoded and integrity-checked, as `SessionStore` reads them.
 * A protected payload the source was given no protector for arrives as its `ProtectedDataEnvelope`, unchecked (the integrity
 * hash covers the plaintext), so a reader can show that the content is encrypted instead of failing the stream.
 */
export interface ReviewJournalSource {
  /**
   * Streams stamped at or after `sinceIso`, oldest first, at most `limit` (1 to 1000). A stream never stamped (written before
   * the stamp existed, or while the account lacked the column grant) is not listed.
   */
  changedSince(sinceIso: string, limit: number, after?: ChangedSessionCursor): Promise<readonly ChangedSession[]>;
  /**
   * Every stream of the shard, stamped or not, in primary-key order, at most `limit` (1 to 1000). A projector without a
   * watermark of its revision reads this once, so streams written before the stamp existed are projected too. Reads only the
   * stream table and writes nothing.
   */
  streamsByKey(limit: number, after?: StreamKeyCursor): Promise<readonly ShardStream[]>;
  /** Events of one stream with `seq > afterSeq`, in journal order, at most `limit` (1 to 1000). Unknown stream → empty. */
  eventsAfter(tenantId: string, sessionId: string, afterSeq: number, limit: number): Promise<readonly SessionEvent[]>;
}

/** Where a conversation ran: the live release of the agent, or an operator's preview of a release not yet live. */
export type ReviewChannel = "live" | "preview";
export type ReviewEntryRole = "user" | "assistant" | "tool" | "system";

/** The projected header of one conversation. Holds no conversation content: the pseudonym stands for the person. */
export interface ReviewSessionRecord {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly channel: ReviewChannel;
  /** 64 lowercase hex characters: HMAC of tenant and actor under key version `actorKeyVersion`. */
  readonly actorKey: string;
  readonly actorKeyVersion: string;
  readonly startedAt: string;
  readonly lastTurnAt: string;
  readonly answers: number;
  /** The mask version whose transcript is complete; absent until one is. */
  readonly transcriptMaskVersion?: string;
}

/** A tool the agent used in an entry, by id and the label a reader sees. */
export interface ReviewToolLabel {
  readonly toolId: string;
  readonly label: string;
}

/**
 * One masked entry of a transcript. Entries are immutable: an entry is written once per (session, maskVersion, entrySeq), and
 * different masking of the same entry is a new mask version, never an edit.
 */
export interface ReviewTranscriptEntry {
  readonly maskVersion: string;
  /** Journal sequence of the event the entry starts at; orders the transcript. */
  readonly entrySeq: number;
  readonly turnId: string;
  /** 1-based position of an assistant answer within the session; absent for other roles. */
  readonly answerIndex?: number;
  readonly role: ReviewEntryRole;
  readonly bodyFormat: "text" | "markdown";
  /** Already masked: no personal value from the session's tool results remains in it. */
  readonly body: string;
  readonly toolLabels?: readonly ReviewToolLabel[];
  /** How many known personal values were replaced in this entry. */
  readonly maskedValues: number;
  /** sha256 hex of what the entry was built from, so a rebuild can prove it saw the same source. */
  readonly sourceHash: string;
  /** When the entry happened in the conversation (the source event's occurredAt). */
  readonly at: string;
}

/** How far the projector has read one stream, under one projector revision. */
export interface ProjectionCursor {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly projectorId: string;
  readonly projectedSeq: number;
  readonly projectorRevision: string;
}

/** Where a projector's next `changedSince` starts. */
export interface ProjectionWatermark {
  readonly projectorId: string;
  readonly watermarkAt: string;
  readonly projectorRevision: string;
}

/** The worker lease a write is made under; a write whose lease is no longer current is refused with `conflict`. */
export interface LeaseFence {
  readonly workerKind: string;
  readonly fencingToken: string;
}

/** The projector's writes into one shard. */
export interface ReviewProjectionStore {
  cursor(tenantId: string, sessionId: string, projectorId: string): Promise<ProjectionCursor | undefined>;
  /**
   * One transaction: upserts the session header, inserts the entries not yet stored, and moves the cursor. Rerunning with the
   * same input changes nothing. The header keeps the `startedAt` of its first projection. An entry already stored with different content is refused with `conflict` (masking changed
   * without a new mask version). Entries and cursor must belong to `session`.
   */
  replace(session: ReviewSessionRecord, entries: readonly ReviewTranscriptEntry[], cursor: ProjectionCursor, fence: LeaseFence): Promise<void>;
  watermark(projectorId: string): Promise<ProjectionWatermark | undefined>;
  saveWatermark(watermark: ProjectionWatermark, fence: LeaseFence): Promise<void>;
}

/** Keyset position in `listSessions`, newest first: (startedAt, tenantId, sessionId) descending. */
export type ReviewSessionCursor = Pick<ReviewSessionRecord, "startedAt" | "tenantId" | "sessionId">;

export interface ReviewSessionQuery {
  readonly agentId?: string;
  readonly tenantId?: string;
  /** Inclusive lower bound on startedAt. */
  readonly from?: string;
  /** Exclusive upper bound on startedAt. */
  readonly to?: string;
  /** Matches session ids that start with this text, case-sensitively. */
  readonly sessionIdPrefix?: string;
  /** 1 to 200. */
  readonly limit: number;
  readonly after?: ReviewSessionCursor;
  /** Characters of the first user entry returned as `preview` (1 to 2000). */
  readonly previewChars: number;
}

export interface ReviewSessionSummary extends ReviewSessionRecord {
  /** The tenant's display name from its stored profile, when one exists. */
  readonly tenantName?: string;
  /** Start of the first user entry of the current mask version, already masked; absent before a transcript exists. */
  readonly preview?: string;
}

export interface ReviewSessionPage {
  readonly items: readonly ReviewSessionSummary[];
  /** Present when more items may follow; pass it back as `after`. */
  readonly next?: ReviewSessionCursor;
}

/** Why an operator touched a conversation; one row per opening. */
export interface ReviewAccessRecord {
  readonly tenantId: string;
  readonly principalId: string;
  readonly sessionId?: string;
  readonly action: string;
  readonly purpose: string;
  readonly detail?: string;
  readonly at: string;
}

/** The console's reads of one shard, and the access log those reads leave. */
export interface ReviewQueryStore {
  listSessions(query: ReviewSessionQuery): Promise<ReviewSessionPage>;
  /** One header with its tenant's name; without `preview`, which only a listing asks for. */
  session(tenantId: string, sessionId: string): Promise<ReviewSessionSummary | undefined>;
  /** Entries of one mask version in entrySeq order; empty when none are stored. */
  transcript(tenantId: string, sessionId: string, maskVersion: string): Promise<readonly ReviewTranscriptEntry[]>;
  /** Appends one access row and returns its id. */
  recordAccess(record: ReviewAccessRecord): Promise<string>;
}

/** Bounds every engine holds, so a caller is refused the same way everywhere. */
export const REVIEW_LIMITS = Object.freeze({ maxChangedPage: 1000, maxEventPage: 1000, maxSessionPage: 200, maxPreviewChars: 2000 });
