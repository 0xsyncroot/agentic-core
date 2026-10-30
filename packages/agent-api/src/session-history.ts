import { AgenticError, MAX_SESSION_READ_EVENTS, type SessionReader, type SecurityContext, type SessionEvent } from "@0xsyncroot/contracts";

type HistoryReader = Pick<SessionReader, "loadRecent"> & Partial<Pick<SessionReader, "loadSince">>;

/** Pin the tail first, then page to it. Compaction checkpoints never replace the public journal. */
export async function sessionHistoryEvents(reader: HistoryReader, sessionId: string, security: SecurityContext, batchSize = 500): Promise<readonly SessionEvent[]> {
  if (!reader.loadSince) return reader.loadRecent(sessionId, batchSize, security);
  const tail = await reader.loadRecent(sessionId, 1, security);
  const through = tail.at(-1)?.seq ?? 0;
  const events: SessionEvent[] = [];
  const limit = Math.min(MAX_SESSION_READ_EVENTS, Math.max(1, batchSize));
  let after = 0;
  while (after < through) {
    const page = await reader.loadSince(sessionId, after, security, limit);
    const bounded = page.filter((event) => event.seq > after && event.seq <= through);
    if (!bounded.length) throw new AgenticError("conflict", "Session history changed during pagination");
    events.push(...bounded);
    after = bounded.at(-1)!.seq;
  }
  return events;
}
