import type { SecurityContext, SessionDirectoryEntry, SessionDirectoryQuery } from "@0xsyncroot/contracts";
import { AgenticError } from "@0xsyncroot/contracts";
import type { StoreCore } from "./core.js";
import { directoryKey, sessionKeys } from "./keys.js";

const SEP = "\u0000";
const BATCH = 50;

/**
 * The listing index is one sorted set per owner with every score equal, so Redis orders members
 * lexicographically: `createdAt NUL sessionId`, the same newest-created-first order the memory
 * store sorts by. It lives in its own slot (it spans sessions), so it is written after the
 * session script, not inside it; a lost write leaves the session out of the history list only.
 */
export async function indexSession(core: StoreCore, security: SecurityContext, sessionId: string, createdAt: string): Promise<void> {
  const key = directoryKey(core.options.prefix, security.tenantId, security.actorId);
  await core.client.zAdd(key, { score: 0, value: `${createdAt}${SEP}${sessionId}` });
  await core.client.expire(key, core.options.sessionTtl);
}

export async function listSessions(
  core: StoreCore, query: SessionDirectoryQuery, security: SecurityContext,
): Promise<readonly SessionDirectoryEntry[]> {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 51) throw new AgenticError("validation", "Invalid session page size");
  const key = directoryKey(core.options.prefix, security.tenantId, security.actorId);
  let max = query.before ? `(${query.before.createdAt}${SEP}${query.before.sessionId}` : "+";
  const found: SessionDirectoryEntry[] = [];
  while (found.length < query.limit) {
    const members = await core.client.zRange(key, max, "-", { BY: "LEX", REV: true, LIMIT: { offset: 0, count: BATCH } });
    if (members.length === 0) break;
    const rows = await Promise.all(members.map(async (member) => {
      const sessionId = member.slice(member.indexOf(SEP) + 1);
      const fields = await core.client.hmGet(sessionKeys(core.options.prefix, security.tenantId, sessionId).meta, ["created", "input", "profile"]);
      return { member, sessionId, created: fields[0], input: fields[1], profile: fields[2] };
    }));
    for (const row of rows) {
      if (row.created == null) {
        // The session expired; its index entry has no purpose left.
        await core.client.zRem(key, row.member);
        continue;
      }
      if (query.agentProfileId && (row.profile ?? "default") !== query.agentProfileId) continue;
      if (found.length < query.limit) found.push({ sessionId: row.sessionId, createdAt: String(row.created), ...(row.input == null ? {} : { firstInput: JSON.parse(String(row.input)) }) });
    }
    if (members.length < BATCH) break;
    max = `(${members[members.length - 1]}`;
  }
  return found;
}
