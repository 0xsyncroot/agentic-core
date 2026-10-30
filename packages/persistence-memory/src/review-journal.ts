import {
  AgenticError, REVIEW_LIMITS, reviewPageSize, reviewTime, type ChangedSession, type ChangedSessionCursor, type ReviewJournalSource,
  type SessionEvent, type ShardStream, type StreamKeyCursor,
} from "@0xsyncroot/contracts";

/**
 * The append stamp of one store: microseconds since the epoch, one more than the last stamp whenever the wall clock has not
 * moved past it, so two appends never share a stamp and a later append always sorts after an earlier one.
 */
export class AppendClock {
  #last = 0;

  next(): string {
    this.#last = Math.max(Date.now() * 1000, this.#last + 1);
    const millis = Math.floor(this.#last / 1000);
    return `${new Date(millis).toISOString().slice(0, 23)}${String(this.#last % 1000).padStart(3, "0")}Z`;
  }
}

/** One stream as the journal reader sees it. */
export interface JournalStream {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly ownerActorId: string;
  readonly agentProfileId: string | undefined;
  readonly events: readonly SessionEvent[];
  readonly lastAppendedAt: string | undefined;
}

function streamKey(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new AgenticError("validation", `${field} must be a non-empty string`);
  return value;
}

const position = (item: Pick<ChangedSession, "lastAppendedAt" | "tenantId" | "sessionId">) => [item.lastAppendedAt, item.tenantId, item.sessionId] as const;
function compare(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
  return 0;
}

/** The in-memory session store's journal, read without an owner check, under the same bounds as every engine. */
export class InMemoryReviewJournal implements ReviewJournalSource {
  constructor(private readonly streams: () => Iterable<JournalStream>) {}

  async changedSince(sinceIso: string, limit: number, after?: ChangedSessionCursor): Promise<readonly ChangedSession[]> {
    const size = reviewPageSize(limit, "limit", REVIEW_LIMITS.maxChangedPage);
    const since = reviewTime(sinceIso, "sinceIso");
    const from = after && position({
      lastAppendedAt: reviewTime(after.lastAppendedAt, "after.lastAppendedAt"), tenantId: streamKey(after.tenantId, "after.tenantId"),
      sessionId: streamKey(after.sessionId, "after.sessionId"),
    });
    const changed: ChangedSession[] = [];
    for (const stream of this.streams()) {
      if (stream.lastAppendedAt === undefined || stream.lastAppendedAt < since) continue;
      const item: ChangedSession = {
        tenantId: stream.tenantId, sessionId: stream.sessionId, ownerActorId: stream.ownerActorId, agentProfileId: stream.agentProfileId ?? null,
        currentSeq: stream.events.length, lastAppendedAt: stream.lastAppendedAt,
      };
      if (!from || compare(position(item), from) > 0) changed.push(item);
    }
    return changed.sort((left, right) => compare(position(left), position(right))).slice(0, size);
  }

  async streamsByKey(limit: number, after?: StreamKeyCursor): Promise<readonly ShardStream[]> {
    const size = reviewPageSize(limit, "limit", REVIEW_LIMITS.maxChangedPage);
    const from = after && [streamKey(after.tenantId, "after.tenantId"), streamKey(after.sessionId, "after.sessionId")];
    const listed: ShardStream[] = [];
    for (const stream of this.streams()) {
      if (from && compare([stream.tenantId, stream.sessionId], from) <= 0) continue;
      listed.push({
        tenantId: stream.tenantId, sessionId: stream.sessionId, ownerActorId: stream.ownerActorId, agentProfileId: stream.agentProfileId ?? null,
        currentSeq: stream.events.length, lastAppendedAt: stream.lastAppendedAt ?? null,
      });
    }
    return listed.sort((left, right) => compare([left.tenantId, left.sessionId], [right.tenantId, right.sessionId])).slice(0, size);
  }

  async eventsAfter(tenantId: string, sessionId: string, afterSeq: number, limit: number): Promise<readonly SessionEvent[]> {
    const size = reviewPageSize(limit, "limit", REVIEW_LIMITS.maxEventPage);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new AgenticError("validation", "afterSeq must be a non-negative integer");
    const tenant = streamKey(tenantId, "tenantId"); const session = streamKey(sessionId, "sessionId");
    for (const stream of this.streams()) {
      // Sequences are dense and start at 1, so the event with seq n sits at index n - 1.
      if (stream.tenantId === tenant && stream.sessionId === session) return stream.events.slice(afterSeq, afterSeq + size);
    }
    return [];
  }
}
