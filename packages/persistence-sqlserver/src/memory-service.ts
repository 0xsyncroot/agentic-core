import { randomUUID } from "node:crypto";
import {
  AgenticError, hasPermission, isProtectedDataEnvelope, type BlindIndexEncoder, type JsonValue,
  type MemoryCandidate, type MemoryContext, type MemoryQuery, type MemoryRecord, type MemoryService,
  type PayloadProtector, type ProtectedDataEnvelope, type SecurityContext,
} from "@0xsyncroot/contracts";
import type { ConnectionPool, Transaction } from "mssql";
import { sha256 } from "./hash.js";
import { dateTime, integer, longText, request, text } from "./sql-request.js";
import { withTenantTransaction } from "./transaction.js";

interface MemoryRow extends Record<string, unknown> {
  id: string; revision: number; tenant_id: string; scope_type: MemoryRecord["scope"]["type"]; scope_id: string;
  kind: MemoryRecord["kind"]; status: MemoryRecord["status"]; content: string; protected_content: string | null;
  format: MemoryRecord["format"]; classification: MemoryRecord["classification"]; source_ref: string;
  authority: MemoryRecord["authority"]; content_hash: string; recorded_at: Date | string;
}

function assertTenant(tenantId: string, security: SecurityContext): void {
  if (tenantId !== security.tenantId) throw new Error("Memory tenant boundary violation");
}

async function mapMemory(row: MemoryRow, protector?: PayloadProtector): Promise<MemoryRecord> {
  let content = row.content;
  const protectedContent = row.protected_content ? JSON.parse(row.protected_content) as JsonValue : null;
  if (isProtectedDataEnvelope(protectedContent)) {
    if (!protector) throw new AgenticError("permanent", `Memory revision ${row.id}@${row.revision} is protected but no payload protector is configured`);
    const value = await protector.unprotect(protectedContent as ProtectedDataEnvelope, {
      tenantId: row.tenant_id, recordId: `${row.id}@${row.revision}`, purpose: "memory-content", classification: row.classification,
    });
    if (typeof value !== "string") throw new AgenticError("permanent", `Memory revision ${row.id}@${row.revision} has invalid protected content`);
    content = value;
  }
  if (sha256(content) !== row.content_hash) throw new AgenticError("permanent", `Memory revision integrity check failed: ${row.id}@${row.revision}`);
  return {
    id: row.id, revision: Number(row.revision), scope: { tenantId: row.tenant_id, type: row.scope_type, id: row.scope_id },
    kind: row.kind, status: row.status, content, format: row.format, classification: row.classification,
    sourceRef: row.source_ref, authority: row.authority, contentHash: row.content_hash, recordedAt: new Date(row.recorded_at).toISOString(),
  };
}

async function writeOutbox(transaction: Transaction, record: Pick<MemoryRecord, "id" | "revision" | "scope">, operation: "upsert" | "delete"): Promise<void> {
  let input = text(text(text(text(request(transaction), "id", randomUUID()), "tenant_id", record.scope.tenantId), "memory_id", record.id), "operation", operation, 16);
  integer(input, "revision", record.revision);
  longText(input, "payload", JSON.stringify({ memoryId: record.id, revision: record.revision, operation }));
  await input.query(`INSERT INTO agentic.memory_outbox(id,tenant_id,memory_id,revision,operation,payload)
    VALUES (@id,@tenant_id,@memory_id,@revision,@operation,@payload);`);
}

export class SqlServerMemoryService implements MemoryService {
  constructor(private readonly pool: ConnectionPool, private readonly payloadProtector?: PayloadProtector, private readonly blindIndex?: BlindIndexEncoder) {
    if (Boolean(payloadProtector) !== Boolean(blindIndex)) throw new Error("Memory payload protection and blind indexing must be configured together");
  }

  async propose(candidate: MemoryCandidate, security: SecurityContext): Promise<MemoryRecord> {
    assertTenant(candidate.scope.tenantId, security);
    if (!hasPermission(security, "memory.propose")) throw new Error("Permission denied: memory.propose");
    if (candidate.scope.type === "actor" && candidate.scope.id !== security.actorId) throw new Error("Cannot write another actor's memory");
    const record: MemoryRecord = {
      ...candidate, id: randomUUID(), revision: 1, status: candidate.authority === "model-inferred" ? "quarantined" : "active",
      recordedAt: new Date().toISOString(), contentHash: sha256(candidate.content),
    };
    const protectedContent = this.payloadProtector ? await this.payloadProtector.protect(record.content, {
      tenantId: record.scope.tenantId, recordId: `${record.id}@1`, purpose: "memory-content", classification: record.classification,
    }) : null;
    const searchTokens = this.blindIndex ? await this.blindIndex.encodeTerms(record.content, record.scope.tenantId) : [];
    return withTenantTransaction(this.pool, security, async (transaction) => {
      let input = text(text(text(text(text(text(request(transaction), "id", record.id), "tenant_id", record.scope.tenantId), "scope_type", record.scope.type), "scope_id", record.scope.id), "kind", record.kind, 32), "status", record.status, 32);
      integer(input, "revision", 1); dateTime(input, "recorded_at", new Date(record.recordedAt));
      await input.query(`INSERT INTO agentic.memory_record(id,tenant_id,scope_type,scope_id,kind,status,current_revision,recorded_at)
        VALUES (@id,@tenant_id,@scope_type,@scope_id,@kind,@status,@revision,@recorded_at);`);
      input = text(text(text(text(text(text(request(transaction), "memory_id", record.id), "tenant_id", record.scope.tenantId), "format", record.format, 32), "classification", record.classification, 32), "authority", record.authority, 32), "content_hash", record.contentHash, 64);
      integer(input, "revision", 1); dateTime(input, "recorded_at", new Date(record.recordedAt));
      longText(input, "content", protectedContent ? "" : record.content); longText(input, "source_ref", record.sourceRef);
      longText(input, "protected_content", protectedContent ? JSON.stringify(protectedContent) : null);
      longText(input, "search_tokens", JSON.stringify(searchTokens));
      await input.query(`INSERT INTO agentic.memory_revision(memory_id,revision,tenant_id,content,format,classification,source_ref,
        authority,content_hash,recorded_at,protected_content,search_tokens) VALUES (@memory_id,@revision,@tenant_id,@content,@format,
        @classification,@source_ref,@authority,@content_hash,@recorded_at,@protected_content,@search_tokens);`);
      await writeOutbox(transaction, record, "upsert");
      return record;
    });
  }

  async search(query: MemoryQuery, security: SecurityContext): Promise<MemoryContext> {
    if (!hasPermission(security, "memory.read")) throw new Error("Permission denied: memory.read");
    for (const scope of query.scopes) assertTenant(scope.tenantId, security);
    const limit = Number.isInteger(query.limit) ? Math.min(Math.max(query.limit, 0), 100) : 0;
    if (!query.text.trim() || query.scopes.length === 0 || limit === 0) return { records: [], contextText: "", contextHash: sha256("") };
    return withTenantTransaction(this.pool, security, async (transaction) => {
      const terms = this.blindIndex ? await this.blindIndex.encodeTerms(query.text, security.tenantId) : undefined;
      if (terms && terms.length === 0) return { records: [], contextText: "", contextHash: sha256("") };
      let input = text(text(request(transaction), "tenant_id", security.tenantId), "actor_id", security.actorId);
      integer(input, "limit", limit);
      const scopeSql = query.scopes.map((scope, index) => {
        text(input, `scope_type_${index}`, scope.type); text(input, `scope_id_${index}`, scope.id);
        return `(r.scope_type=@scope_type_${index} AND r.scope_id=@scope_id_${index})`;
      }).join(" OR ");
      const searchSql = terms
        ? "EXISTS (SELECT 1 FROM OPENJSON(v.search_tokens) stored JOIN OPENJSON(@search_terms) wanted ON stored.[value]=wanted.[value])"
        : "LOWER(v.content) LIKE LOWER(@search_text) ESCAPE '\\'";
      if (terms) longText(input, "search_terms", JSON.stringify(terms));
      else longText(input, "search_text", `%${escapeLike(query.text.trim())}%`);
      const result = await input.query<MemoryRow>(`SELECT TOP (@limit) r.id,r.current_revision AS revision,r.tenant_id,r.scope_type,r.scope_id,
        r.kind,r.status,v.content,v.protected_content,v.format,v.classification,v.source_ref,v.authority,v.content_hash,v.recorded_at
        FROM agentic.memory_record r JOIN agentic.memory_revision v ON v.tenant_id=r.tenant_id AND v.memory_id=r.id AND v.revision=r.current_revision
        WHERE r.tenant_id=@tenant_id AND r.status='active' AND (r.scope_type<>'actor' OR r.scope_id=@actor_id)
        AND (${scopeSql}) AND ${searchSql} ORDER BY v.recorded_at DESC;`);
      const records = await Promise.all(result.recordset.map((row) => mapMemory(row, this.payloadProtector)));
      const contextText = records.map((record) => `[memory:${record.id}@${record.revision}; authority=${record.authority}] ${record.content}`).join("\n");
      return { records, contextText, contextHash: sha256(contextText) };
    });
  }

  async forget(id: string, security: SecurityContext): Promise<boolean> {
    if (!hasPermission(security, "memory.forget")) throw new Error("Permission denied: memory.forget");
    return withTenantTransaction(this.pool, security, async (transaction) => {
      let input = text(text(request(transaction), "tenant_id", security.tenantId), "id", id);
      const locked = await input.query(`SELECT current_revision FROM agentic.memory_record WITH (UPDLOCK,HOLDLOCK)
        WHERE tenant_id=@tenant_id AND id=@id;`);
      if (!locked.recordset[0]) return false;
      input = text(text(request(transaction), "tenant_id", security.tenantId), "id", id);
      const result = await input.query<MemoryRow>(`SELECT r.id,r.current_revision AS revision,r.tenant_id,r.scope_type,r.scope_id,r.kind,r.status,
        v.content,v.protected_content,v.format,v.classification,v.source_ref,v.authority,v.content_hash,v.recorded_at
        FROM agentic.memory_record r JOIN agentic.memory_revision v ON v.tenant_id=r.tenant_id AND v.memory_id=r.id AND v.revision=r.current_revision
        WHERE r.tenant_id=@tenant_id AND r.id=@id;`);
      const current = result.recordset[0] ? await mapMemory(result.recordset[0], this.payloadProtector) : undefined;
      if (!current) return false;
      if (current.scope.type === "actor" && current.scope.id !== security.actorId) throw new Error("Cannot forget another actor's memory");
      const revision = current.revision + 1;
      const recordedAt = new Date();
      input = text(text(text(text(text(text(request(transaction), "memory_id", id), "tenant_id", security.tenantId), "format", current.format, 32), "classification", current.classification, 32), "authority", current.authority, 32), "content_hash", sha256(""), 64);
      integer(input, "revision", revision); dateTime(input, "recorded_at", recordedAt); longText(input, "source_ref", current.sourceRef);
      await input.query(`INSERT INTO agentic.memory_revision(memory_id,revision,tenant_id,content,format,classification,source_ref,
        authority,content_hash,recorded_at,protected_content,search_tokens) VALUES (@memory_id,@revision,@tenant_id,N'',@format,
        @classification,@source_ref,@authority,@content_hash,@recorded_at,NULL,N'[]');`);
      input = text(text(request(transaction), "tenant_id", security.tenantId), "id", id); integer(input, "revision", revision);
      await input.query("UPDATE agentic.memory_record SET status='deleted',current_revision=@revision WHERE tenant_id=@tenant_id AND id=@id;");
      await writeOutbox(transaction, { id, revision, scope: current.scope }, "delete");
      return true;
    });
  }
}

function escapeLike(value: string): string { return value.replace(/[\\%_\[]/g, (character) => `\\${character}`); }
