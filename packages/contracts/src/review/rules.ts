import { AgenticError } from "../errors/agentic-error.js";
import type { AdminPrincipalSeed, CatalogAuditRecord, MemberRole } from "./control-plane.js";
import {
  REVIEW_LIMITS, type LeaseFence, type ProjectionCursor, type ProjectionWatermark, type ReviewAccessRecord, type ReviewSessionQuery,
  type ReviewSessionRecord, type ReviewTranscriptEntry,
} from "./review.js";

/**
 * The input rules every review and control-plane engine applies before it stores anything, so a caller is refused the same
 * way by each. Identifiers are printable ASCII within the stored column's length; times are ISO 8601 UTC and come back in
 * their canonical form; anything else is `validation`.
 */

function invalid(field: string, rule: string): never { throw new AgenticError("validation", `${field} ${rule}`); }

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
/** Characters of four-byte text that fit a 65,535-byte TEXT column. */
const TEXT_COLUMN_CHARS = 16_383;
const TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/u;

/** An identifier of 1 to `max` printable ASCII characters (0 to `max` with `allowEmpty`). */
export function reviewIdentifier(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || !PRINTABLE_ASCII.test(value) || value.length > max || (!allowEmpty && value.length === 0)) {
    invalid(field, `must be ${allowEmpty ? 0 : 1} to ${max} printable ASCII characters`);
  }
  return value;
}

/** The canonical form of a review time: ISO 8601 UTC with exactly six fractional digits. */
export function reviewTime(value: unknown, field: string): string {
  const match = typeof value === "string" ? TIME.exec(value) : null;
  if (!match || new Date(`${match[1]}Z`).toISOString().slice(0, 19) !== match[1]) invalid(field, "must be an ISO 8601 UTC time with at most six fractional digits");
  return `${match[1]}.${(match[2] ?? "").padEnd(6, "0")}Z`;
}

/** A page size of 1 to `max`. */
export function reviewPageSize(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) invalid(field, `must be an integer from 1 to ${max}`);
  return value;
}

function count(value: unknown, field: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > 4_294_967_295) invalid(field, `must be an integer of at least ${min}`);
  return value;
}

function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) invalid(field, "must be 64 lowercase hex characters");
  return value;
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) invalid(field, `must be one of ${allowed.join(", ")}`);
  return value as T;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length > max) invalid(field, `must be text of at most ${max} characters`);
  return value;
}

/** The count, hash and enumeration rules above, for the other review rule modules. */
export { count as reviewCount, hash as reviewHash, oneOf as reviewOneOf };

const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

export function checkedReviewSession(record: ReviewSessionRecord): ReviewSessionRecord {
  return {
    tenantId: reviewIdentifier(record.tenantId, "tenantId", 191), sessionId: reviewIdentifier(record.sessionId, "sessionId", 191),
    agentId: reviewIdentifier(record.agentId, "agentId", 100), channel: oneOf(record.channel, "channel", ["live", "preview"]),
    actorKey: hash(record.actorKey, "actorKey"), actorKeyVersion: reviewIdentifier(record.actorKeyVersion, "actorKeyVersion", 16),
    startedAt: reviewTime(record.startedAt, "startedAt"), lastTurnAt: reviewTime(record.lastTurnAt, "lastTurnAt"),
    answers: count(record.answers, "answers"),
    ...optional("transcriptMaskVersion", record.transcriptMaskVersion === undefined ? undefined : reviewIdentifier(record.transcriptMaskVersion, "transcriptMaskVersion", 32)),
  };
}

/** Entries in the canonical form, refusing two entries for the same (maskVersion, entrySeq). */
export function checkedReviewEntries(entries: readonly ReviewTranscriptEntry[]): ReviewTranscriptEntry[] {
  const keys = new Set<string>();
  return entries.map((entry) => {
    const checked: ReviewTranscriptEntry = {
      maskVersion: reviewIdentifier(entry.maskVersion, "maskVersion", 32), entrySeq: count(entry.entrySeq, "entrySeq"),
      turnId: reviewIdentifier(entry.turnId, "turnId", 191),
      ...optional("answerIndex", entry.answerIndex === undefined ? undefined : count(entry.answerIndex, "answerIndex", 1)),
      role: oneOf(entry.role, "role", ["user", "assistant", "tool", "system"]), bodyFormat: oneOf(entry.bodyFormat, "bodyFormat", ["text", "markdown"]),
      body: text(entry.body, "body", 4_000_000),
      ...optional("toolLabels", entry.toolLabels === undefined ? undefined : entry.toolLabels.map((label) => ({ toolId: text(label.toolId, "toolLabels.toolId", 200), label: text(label.label, "toolLabels.label", 500) }))),
      maskedValues: count(entry.maskedValues, "maskedValues"), sourceHash: hash(entry.sourceHash, "sourceHash"), at: reviewTime(entry.at, "at"),
    };
    if (checked.toolLabels && JSON.stringify(checked.toolLabels).length > TEXT_COLUMN_CHARS) invalid("toolLabels", `must serialise to at most ${TEXT_COLUMN_CHARS} characters`);
    const key = `${checked.maskVersion}\u0000${checked.entrySeq}`;
    if (keys.has(key)) invalid("entries", "must not repeat a (maskVersion, entrySeq)");
    keys.add(key);
    return checked;
  });
}

export function checkedProjectionCursor(cursor: ProjectionCursor, session: Pick<ReviewSessionRecord, "tenantId" | "sessionId">): ProjectionCursor {
  if (cursor.tenantId !== session.tenantId || cursor.sessionId !== session.sessionId) invalid("cursor", "must belong to the session it is saved with");
  return {
    tenantId: cursor.tenantId, sessionId: cursor.sessionId, projectorId: reviewIdentifier(cursor.projectorId, "projectorId", 64),
    projectedSeq: count(cursor.projectedSeq, "projectedSeq"), projectorRevision: reviewIdentifier(cursor.projectorRevision, "projectorRevision", 64),
  };
}

export function checkedProjectionWatermark(watermark: ProjectionWatermark): ProjectionWatermark {
  return {
    projectorId: reviewIdentifier(watermark.projectorId, "projectorId", 64), watermarkAt: reviewTime(watermark.watermarkAt, "watermarkAt"),
    projectorRevision: reviewIdentifier(watermark.projectorRevision, "projectorRevision", 64),
  };
}

export function checkedLeaseFence(fence: LeaseFence): LeaseFence {
  if (typeof fence.fencingToken !== "string" || !/^[0-9]{1,20}$/u.test(fence.fencingToken)) invalid("fencingToken", "must be a decimal token");
  return { workerKind: reviewIdentifier(fence.workerKind, "workerKind", 64), fencingToken: fence.fencingToken };
}

/** A lease request: kind and owner as stored, and a whole number of milliseconds up to a day. */
export function checkedLeaseRequest(workerKind: string, owner: string, ttlMs: number): { workerKind: string; owner: string; ttlMs: number } {
  if (typeof ttlMs !== "number" || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) invalid("ttlMs", "must be an integer from 1 to 86400000");
  return { workerKind: reviewIdentifier(workerKind, "workerKind", 64), owner: reviewIdentifier(owner, "owner", 191), ttlMs };
}

export function checkedReviewAccess(record: ReviewAccessRecord): ReviewAccessRecord {
  return {
    tenantId: reviewIdentifier(record.tenantId, "tenantId", 191), principalId: reviewIdentifier(record.principalId, "principalId", 36),
    ...optional("sessionId", record.sessionId === undefined ? undefined : reviewIdentifier(record.sessionId, "sessionId", 191)),
    action: reviewIdentifier(record.action, "action", 32), purpose: reviewIdentifier(record.purpose, "purpose", 32),
    ...optional("detail", record.detail === undefined ? undefined : text(record.detail, "detail", TEXT_COLUMN_CHARS)), at: reviewTime(record.at, "at"),
  };
}

export function checkedReviewSessionQuery(query: ReviewSessionQuery): ReviewSessionQuery {
  return {
    limit: reviewPageSize(query.limit, "limit", REVIEW_LIMITS.maxSessionPage), previewChars: reviewPageSize(query.previewChars, "previewChars", REVIEW_LIMITS.maxPreviewChars),
    ...optional("agentId", query.agentId === undefined ? undefined : reviewIdentifier(query.agentId, "agentId", 100)),
    ...optional("tenantId", query.tenantId === undefined ? undefined : reviewIdentifier(query.tenantId, "tenantId", 191)),
    ...optional("from", query.from === undefined ? undefined : reviewTime(query.from, "from")),
    ...optional("to", query.to === undefined ? undefined : reviewTime(query.to, "to")),
    ...optional("sessionIdPrefix", query.sessionIdPrefix === undefined ? undefined : reviewIdentifier(query.sessionIdPrefix, "sessionIdPrefix", 191)),
    ...optional("after", query.after === undefined ? undefined : {
      startedAt: reviewTime(query.after.startedAt, "after.startedAt"), tenantId: reviewIdentifier(query.after.tenantId, "after.tenantId", 191),
      sessionId: reviewIdentifier(query.after.sessionId, "after.sessionId", 191),
    }),
  };
}

export function checkedMemberRole(role: MemberRole): MemberRole {
  const scopeKind = oneOf(role.scopeKind, "scopeKind", ["platform", "agent"]);
  return { scopeKind, scopeId: reviewIdentifier(role.scopeId, "scopeId", 100, scopeKind === "platform"), role: reviewIdentifier(role.role, "role", 32) };
}

export function checkedAdminPrincipalSeed(seed: AdminPrincipalSeed): AdminPrincipalSeed {
  return {
    principalId: reviewIdentifier(seed.principalId, "principalId", 36), issuer: reviewIdentifier(seed.issuer, "issuer", 100),
    subject: reviewIdentifier(seed.subject, "subject", 255), displayName: text(seed.displayName, "displayName", 200),
  };
}

export function checkedCatalogAudit(record: CatalogAuditRecord): CatalogAuditRecord {
  const scopeKind = oneOf(record.scopeKind, "scopeKind", ["platform", "agent"]);
  return {
    scopeKind, scopeId: reviewIdentifier(record.scopeId, "scopeId", 100, scopeKind === "platform"),
    principalId: reviewIdentifier(record.principalId, "principalId", 36), actorScope: reviewIdentifier(record.actorScope, "actorScope", 16),
    action: reviewIdentifier(record.action, "action", 64), targetKind: reviewIdentifier(record.targetKind, "targetKind", 32),
    targetId: reviewIdentifier(record.targetId, "targetId", 191),
    ...optional("beforeHash", record.beforeHash === undefined ? undefined : hash(record.beforeHash, "beforeHash")),
    ...optional("afterHash", record.afterHash === undefined ? undefined : hash(record.afterHash, "afterHash")),
    ...optional("detail", record.detail === undefined ? undefined : text(record.detail, "detail", 4_000_000)), at: reviewTime(record.at, "at"),
  };
}
