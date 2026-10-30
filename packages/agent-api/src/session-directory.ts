import { AgenticError, type SessionReader, type SessionDirectoryCursor, type SecurityContext, type JsonValue, type SessionDirectoryEntry } from "@0xsyncroot/contracts";

function cursor(value: string | null): SessionDirectoryCursor | undefined {
  if (!value) return undefined;
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as SessionDirectoryCursor;
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,7}Z$/.test(parsed.createdAt) || !Number.isFinite(Date.parse(parsed.createdAt)) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(parsed.sessionId)) throw new Error();
    return parsed;
  } catch { throw new AgenticError("validation", "Invalid session cursor"); }
}

function title(input: JsonValue | undefined): string {
  const payload = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const content = typeof payload.content === "string" ? payload.content.replace(/\s+/g, " ").trim() : "";
  const attachment = Array.isArray(payload.attachments) ? payload.attachments[0] : undefined;
  const name = attachment && typeof attachment === "object" && !Array.isArray(attachment) && typeof attachment.name === "string" ? attachment.name : "";
  return [content.slice(0, 90), name].filter(Boolean).join(" · ").slice(0, 180);
}

export async function sessionDirectory(reader: Pick<SessionReader, "listSessions">, params: URLSearchParams, security: SecurityContext, profileId?: string) {
  if (!reader.listSessions) throw new AgenticError("validation", "Session directory is not available");
  const limit = Number(params.get("limit") ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AgenticError("validation", "Invalid session page size");
  const before = cursor(params.get("cursor"));
  const query = (params.get("q") ?? "").trim();
  if (query.length > 180) throw new AgenticError("validation", "Session search is too long");
  const agentProfileId = profileId ?? (params.get("agentProfileId") || undefined);
  if (agentProfileId && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(agentProfileId)) throw new AgenticError("validation", "Invalid agent profile");
  if (query) return searchDirectory(reader as Required<Pick<SessionReader, "listSessions">>, security, agentProfileId, before, limit, query);
  const entries = await reader.listSessions({ limit: limit + 1, ...(before ? { before } : {}), ...(agentProfileId ? { agentProfileId } : {}) }, security);
  const page = entries.slice(0, limit);
  const last = page.at(-1);
  return { sessions: page.map((entry) => ({ sessionId: entry.sessionId, title: title(entry.firstInput), createdAt: entry.createdAt })),
    ...(entries.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ createdAt: last.createdAt, sessionId: last.sessionId })).toString("base64url") } : {}) };
}

// Search decoded public titles, so encrypted stores share the same semantics without
// exposing event payloads or needing a plaintext search index. Each request is bounded;
// an empty result with nextCursor means there are older entries still to examine.
async function searchDirectory(reader: Required<Pick<SessionReader, "listSessions">>, security: SecurityContext,
  agentProfileId: string | undefined, before: SessionDirectoryCursor | undefined, limit: number, query: string) {
  const normalize = (value: string) => value.toLocaleLowerCase("vi-VN").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\u0111/g, "d");
  const needle = normalize(query);
  const sessions: { sessionId: string; title: string; createdAt: string }[] = [];
  const result = (next?: SessionDirectoryCursor) => ({ sessions,
    ...(next ? { nextCursor: Buffer.from(JSON.stringify({ createdAt: next.createdAt, sessionId: next.sessionId })).toString("base64url") } : {}) });
  for (let scanned = 0; scanned < 200; scanned += 50) {
    const entries = await reader.listSessions({ limit: 51, ...(before ? { before } : {}), ...(agentProfileId ? { agentProfileId } : {}) }, security);
    for (let index = 0; index < Math.min(50, entries.length); index++) {
      const entry: SessionDirectoryEntry = entries[index]!;
      if (before && !(entry.createdAt < before.createdAt || (entry.createdAt === before.createdAt && entry.sessionId < before.sessionId))) {
        throw new AgenticError("conflict", "Session search cursor did not advance");
      }
      before = entry;
      const name = title(entry.firstInput);
      if (normalize(name).includes(needle)) sessions.push({ sessionId: entry.sessionId, title: name, createdAt: entry.createdAt });
      if (sessions.length === limit) return result(index < entries.length - 1 ? before : undefined);
    }
    if (entries.length <= 50) return result();
  }
  return result(before);
}
