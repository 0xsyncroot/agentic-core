import { randomUUID } from "node:crypto";
import { AgenticError, hasPermission, isProtectedDataEnvelope, type BlindIndexEncoder, type JsonValue, type MemoryCandidate, type MemoryContext, type MemoryQuery, type MemoryRecord, type MemoryService, type PayloadProtector, type ProtectedDataEnvelope, type SecurityContext } from "@0xsyncroot/contracts";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { sha256 } from "./hash.js";
import { withTenantTransaction } from "./transaction.js";

interface MemoryRow extends RowDataPacket {
  id: string; revision: number; tenant_id: string; scope_type: MemoryRecord["scope"]["type"]; scope_id: string;
  kind: MemoryRecord["kind"]; status: MemoryRecord["status"]; content: string; protected_content: ProtectedDataEnvelope | string | null;
  format: MemoryRecord["format"]; classification: MemoryRecord["classification"]; source_ref: string;
  authority: MemoryRecord["authority"]; content_hash: string; recorded_at: Date | string;
}

function assertTenant(tenantId: string, security: SecurityContext): void { if (tenantId !== security.tenantId) throw new Error("Memory tenant boundary violation"); }
function envelope(value: MemoryRow["protected_content"]): JsonValue | null { return typeof value === "string" ? JSON.parse(value) as JsonValue : value as JsonValue | null; }

async function mapMemory(row: MemoryRow, protector?: PayloadProtector): Promise<MemoryRecord> {
  let content = row.content;
  const protectedContent = envelope(row.protected_content);
  if (isProtectedDataEnvelope(protectedContent)) {
    if (!protector) throw new AgenticError("permanent", `Memory revision ${row.id}@${row.revision} is protected but no payload protector is configured`);
    const value = await protector.unprotect(protectedContent, { tenantId: row.tenant_id, recordId: `${row.id}@${row.revision}`, purpose: "memory-content", classification: row.classification });
    if (typeof value !== "string") throw new AgenticError("permanent", `Memory revision ${row.id}@${row.revision} has invalid protected content`);
    content = value;
  }
  if (sha256(content) !== row.content_hash) throw new AgenticError("permanent", `Memory revision integrity check failed: ${row.id}@${row.revision}`);
  return { id: row.id, revision: row.revision, scope: { tenantId: row.tenant_id, type: row.scope_type, id: row.scope_id }, kind: row.kind, status: row.status, content, format: row.format, classification: row.classification, sourceRef: row.source_ref, authority: row.authority, contentHash: row.content_hash, recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : new Date(row.recorded_at).toISOString() };
}

async function outbox(connection: PoolConnection, record: Pick<MemoryRecord, "id" | "revision" | "scope">, operation: "upsert" | "delete"): Promise<void> {
  await connection.execute("INSERT INTO agentic_memory_outbox(id,tenant_id,memory_id,revision,operation,payload) VALUES (?,?,?,?,?,?)", [randomUUID(), record.scope.tenantId, record.id, record.revision, operation, JSON.stringify({ memoryId: record.id, revision: record.revision, operation })]);
}

export class MySqlMemoryService implements MemoryService {
  constructor(private readonly pool: Pool, private readonly payloadProtector?: PayloadProtector, private readonly blindIndex?: BlindIndexEncoder) {
    if (Boolean(payloadProtector) !== Boolean(blindIndex)) throw new Error("Memory payload protection and blind indexing must be configured together");
  }

  async propose(candidate: MemoryCandidate, security: SecurityContext): Promise<MemoryRecord> {
    assertTenant(candidate.scope.tenantId, security);
    if (!hasPermission(security, "memory.propose")) throw new Error("Permission denied: memory.propose");
    if (candidate.scope.type === "actor" && candidate.scope.id !== security.actorId) throw new Error("Cannot write another actor's memory");
    const record: MemoryRecord = { ...candidate, id: randomUUID(), revision: 1, status: candidate.authority === "model-inferred" ? "quarantined" : "active", recordedAt: new Date().toISOString(), contentHash: sha256(candidate.content) };
    const protectedContent = this.payloadProtector ? await this.payloadProtector.protect(record.content, { tenantId: record.scope.tenantId, recordId: `${record.id}@1`, purpose: "memory-content", classification: record.classification }) : null;
    const searchTokens = this.blindIndex ? await this.blindIndex.encodeTerms(record.content, record.scope.tenantId) : [];
    return withTenantTransaction(this.pool, security, async (connection) => {
      await connection.execute("INSERT INTO agentic_memory_record(id,tenant_id,scope_type,scope_id,kind,status,current_revision,recorded_at) VALUES (?,?,?,?,?,?,?,?)", [record.id, record.scope.tenantId, record.scope.type, record.scope.id, record.kind, record.status, 1, new Date(record.recordedAt)]);
      await connection.execute("INSERT INTO agentic_memory_revision(memory_id,revision,tenant_id,content,format,classification,source_ref,authority,content_hash,recorded_at,protected_content,search_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [record.id, 1, record.scope.tenantId, protectedContent ? "" : record.content, record.format, record.classification, record.sourceRef, record.authority, record.contentHash, new Date(record.recordedAt), protectedContent ? JSON.stringify(protectedContent) : null, JSON.stringify(searchTokens)]);
      await outbox(connection, record, "upsert");
      return record;
    });
  }

  async search(query: MemoryQuery, security: SecurityContext): Promise<MemoryContext> {
    if (!hasPermission(security, "memory.read")) throw new Error("Permission denied: memory.read");
    for (const scope of query.scopes) assertTenant(scope.tenantId, security);
    const limit = Number.isInteger(query.limit) ? Math.min(Math.max(query.limit, 0), 100) : 0;
    if (!query.text.trim() || query.scopes.length === 0 || limit === 0) return { records: [], contextText: "", contextHash: sha256("") };
    return withTenantTransaction(this.pool, security, async (connection) => {
      const terms = this.blindIndex ? await this.blindIndex.encodeTerms(query.text, security.tenantId) : undefined;
      // The person's text is searched as its words only: boolean mode parsed "-", "+", quotes and brackets as operators, and
      // even natural-language mode still parses "*" and quotes, so "---" or `* "…"` in a message failed the whole turn.
      const words = terms ? "" : query.text.split(/[^\p{L}\p{M}\p{N}_]+/u).filter(Boolean).join(" ");
      if (terms ? terms.length === 0 : !words) return { records: [], contextText: "", contextHash: sha256("") };
      const scopeSql = query.scopes.map(() => "(r.scope_type=? AND r.scope_id=?)").join(" OR ");
      const values: Array<string | number> = [security.tenantId, security.actorId, ...query.scopes.flatMap((scope) => [scope.type, scope.id]), terms ? JSON.stringify(terms) : words, limit];
      const searchSql = terms ? "JSON_OVERLAPS(v.search_tokens, CAST(? AS JSON))" : "MATCH(v.content) AGAINST (? IN NATURAL LANGUAGE MODE)";
      const [rows] = await connection.query<MemoryRow[]>(
        `SELECT r.id,r.current_revision AS revision,r.tenant_id,r.scope_type,r.scope_id,r.kind,r.status,v.content,v.protected_content,v.format,v.classification,v.source_ref,v.authority,v.content_hash,v.recorded_at
           FROM agentic_memory_record r JOIN agentic_memory_revision v ON v.tenant_id=r.tenant_id AND v.memory_id=r.id AND v.revision=r.current_revision
          WHERE r.tenant_id=? AND r.status='active' AND (r.scope_type<>'actor' OR r.scope_id=?) AND (${scopeSql}) AND ${searchSql}
          ORDER BY v.recorded_at DESC LIMIT ?`, values,
      );
      const records = await Promise.all(rows.map((row) => mapMemory(row, this.payloadProtector)));
      const contextText = records.map((record) => `[memory:${record.id}@${record.revision}; authority=${record.authority}] ${record.content}`).join("\n");
      return { records, contextText, contextHash: sha256(contextText) };
    });
  }

  async forget(id: string, security: SecurityContext): Promise<boolean> {
    if (!hasPermission(security, "memory.forget")) throw new Error("Permission denied: memory.forget");
    return withTenantTransaction(this.pool, security, async (connection) => {
      const [locked] = await connection.execute<RowDataPacket[]>(
        "SELECT current_revision FROM agentic_memory_record WHERE tenant_id=? AND id=? FOR UPDATE",
        [security.tenantId, id],
      );
      if (!locked[0]) return false;
      const [rows] = await connection.execute<MemoryRow[]>(
        `SELECT r.id,r.current_revision AS revision,r.tenant_id,r.scope_type,r.scope_id,r.kind,r.status,v.content,v.protected_content,v.format,v.classification,v.source_ref,v.authority,v.content_hash,v.recorded_at
           FROM agentic_memory_record r JOIN agentic_memory_revision v ON v.tenant_id=r.tenant_id AND v.memory_id=r.id AND v.revision=r.current_revision
          WHERE r.tenant_id=? AND r.id=?`, [security.tenantId, id],
      );
      const current = rows[0] ? await mapMemory(rows[0], this.payloadProtector) : undefined;
      if (!current) return false;
      if (current.scope.type === "actor" && current.scope.id !== security.actorId) throw new Error("Cannot forget another actor's memory");
      const revision = current.revision + 1;
      const recordedAt = new Date().toISOString();
      await connection.execute("INSERT INTO agentic_memory_revision(memory_id,revision,tenant_id,content,format,classification,source_ref,authority,content_hash,recorded_at,protected_content,search_tokens) VALUES (?,?,?,'',?,?,?,?,?,?,NULL,JSON_ARRAY())", [id, revision, security.tenantId, current.format, current.classification, current.sourceRef, current.authority, sha256(""), new Date(recordedAt)]);
      await connection.execute("UPDATE agentic_memory_record SET status='deleted',current_revision=? WHERE tenant_id=? AND id=?", [revision, security.tenantId, id]);
      await outbox(connection, { id, revision, scope: current.scope }, "delete");
      return true;
    });
  }
}
