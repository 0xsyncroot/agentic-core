import {
  checkedReviewAccess, checkedReviewSessionQuery, reviewIdentifier, type ReviewAccessRecord, type ReviewQueryStore, type ReviewSessionPage,
  type ReviewSessionQuery, type ReviewSessionSummary, type ReviewTranscriptEntry,
} from "@0xsyncroot/contracts";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { mysqlTime } from "./mysql-time.js";
import { ENTRY_COLUMNS, entryFromRow, likePrefix, SESSION_COLUMNS, sessionFromRow, type EntryRow, type SessionRow } from "./review-rows.js";
import { uuid7 } from "./uuid7.js";

const SESSIONS_WITH_PROFILE = "agentic_review_session s LEFT JOIN agentic_tenant_profile p ON p.tenant_id = s.tenant_id";

/**
 * The console's reads of one shard. Listing pages newest first on (started_at, tenant_id, session_id) and fetches one row
 * more than asked to know whether another page follows; previews come from a second query over the page's sessions only.
 * LIMIT and the preview length are inlined after `checkedReviewSessionQuery` proved them integers in range.
 */
export class MySqlReviewQueryStore implements ReviewQueryStore {
  constructor(private readonly pool: Pool) {}

  async listSessions(query: ReviewSessionQuery): Promise<ReviewSessionPage> {
    const checked = checkedReviewSessionQuery(query);
    const where: string[] = []; const binds: (string | number)[] = [];
    const add = (clause: string, ...values: (string | number)[]) => { where.push(clause); binds.push(...values); };
    if (checked.agentId !== undefined) add("s.agent_id = ?", checked.agentId);
    if (checked.tenantId !== undefined) add("s.tenant_id = ?", checked.tenantId);
    if (checked.from !== undefined) add("s.started_at >= ?", mysqlTime(checked.from, "from"));
    if (checked.to !== undefined) add("s.started_at < ?", mysqlTime(checked.to, "to"));
    if (checked.sessionIdPrefix !== undefined) add("s.session_id LIKE ? ESCAPE '!'", likePrefix(checked.sessionIdPrefix));
    if (checked.after) {
      const at = mysqlTime(checked.after.startedAt, "after.startedAt");
      add("(s.started_at < ? OR (s.started_at = ? AND (s.tenant_id < ? OR (s.tenant_id = ? AND s.session_id < ?))))",
        at, at, checked.after.tenantId, checked.after.tenantId, checked.after.sessionId);
    }
    const [rows] = await this.pool.execute<SessionRow[]>(
      `SELECT ${SESSION_COLUMNS}, p.display_name FROM ${SESSIONS_WITH_PROFILE} ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY s.started_at DESC, s.tenant_id DESC, s.session_id DESC LIMIT ${checked.limit + 1}`, binds);
    const page = rows.slice(0, checked.limit).map(sessionFromRow);
    const previews = await this.#previews(page, checked.previewChars);
    const items = page.map((item) => {
      const preview = previews.get(`${item.tenantId}\u0000${item.sessionId}`);
      return preview === undefined ? item : { ...item, preview };
    });
    const last = items.at(-1);
    return rows.length > checked.limit && last
      ? { items, next: { startedAt: last.startedAt, tenantId: last.tenantId, sessionId: last.sessionId } }
      : { items };
  }

  async session(tenantId: string, sessionId: string): Promise<ReviewSessionSummary | undefined> {
    const [rows] = await this.pool.execute<SessionRow[]>(
      `SELECT ${SESSION_COLUMNS}, p.display_name FROM ${SESSIONS_WITH_PROFILE} WHERE s.tenant_id = ? AND s.session_id = ?`,
      [reviewIdentifier(tenantId, "tenantId", 191), reviewIdentifier(sessionId, "sessionId", 191)]);
    return rows[0] ? sessionFromRow(rows[0]) : undefined;
  }

  async transcript(tenantId: string, sessionId: string, maskVersion: string): Promise<readonly ReviewTranscriptEntry[]> {
    const [rows] = await this.pool.execute<EntryRow[]>(
      `SELECT ${ENTRY_COLUMNS} FROM agentic_review_transcript WHERE tenant_id = ? AND session_id = ? AND mask_version = ? ORDER BY entry_seq`,
      [reviewIdentifier(tenantId, "tenantId", 191), reviewIdentifier(sessionId, "sessionId", 191), reviewIdentifier(maskVersion, "maskVersion", 32)]);
    return rows.map(entryFromRow);
  }

  async recordAccess(record: ReviewAccessRecord): Promise<string> {
    const checked = checkedReviewAccess(record);
    const accessId = uuid7();
    await this.pool.execute(
      "INSERT INTO agentic_review_access (tenant_id, access_id, principal_id, session_id, action, purpose, detail, at) VALUES (?,?,?,?,?,?,?,?)",
      [checked.tenantId, accessId, checked.principalId, checked.sessionId ?? null, checked.action, checked.purpose, checked.detail ?? null, mysqlTime(checked.at, "at")]);
    return accessId;
  }

  /** The start of the first user entry of each session's current mask version, keyed by tenant and session. */
  async #previews(page: readonly ReviewSessionSummary[], chars: number): Promise<Map<string, string>> {
    const masked = page.filter((item) => item.transcriptMaskVersion !== undefined);
    if (masked.length === 0) return new Map();
    const keys = masked.map(() => "(?,?,?)").join(",");
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT t.tenant_id, t.session_id, LEFT(t.body, ${chars}) AS preview FROM agentic_review_transcript t
         JOIN (SELECT tenant_id, session_id, mask_version, MIN(entry_seq) AS entry_seq FROM agentic_review_transcript
                WHERE role = 'user' AND (tenant_id, session_id, mask_version) IN (${keys}) GROUP BY tenant_id, session_id, mask_version) f
           ON f.tenant_id = t.tenant_id AND f.session_id = t.session_id AND f.mask_version = t.mask_version AND f.entry_seq = t.entry_seq`,
      [...masked.flatMap((item) => [item.tenantId, item.sessionId, item.transcriptMaskVersion!])]);
    return new Map(rows.map((row) => [`${String(row.tenant_id)}\u0000${String(row.session_id)}`, String(row.preview)]));
  }
}
