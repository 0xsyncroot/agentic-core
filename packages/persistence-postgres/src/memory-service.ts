import { randomUUID } from "node:crypto";
import type {
  BlindIndexEncoder,
  MemoryCandidate,
  MemoryContext,
  MemoryQuery,
  MemoryRecord,
  MemoryService,
  PayloadProtector,
  ProtectedDataEnvelope,
  SecurityContext,
} from "@0xsyncroot/contracts";
import { AgenticError, hasPermission, isProtectedDataEnvelope } from "@0xsyncroot/contracts";
import type { Pool, PoolClient } from "pg";
import { sha256 } from "./hash.js";
import { withTenantTransaction } from "./transaction.js";

interface MemoryRow {
  id: string;
  revision: number;
  tenant_id: string;
  scope_type: MemoryRecord["scope"]["type"];
  scope_id: string;
  kind: MemoryRecord["kind"];
  status: MemoryRecord["status"];
  content: string;
  protected_content: ProtectedDataEnvelope | null;
  format: MemoryRecord["format"];
  classification: MemoryRecord["classification"];
  source_ref: string;
  authority: MemoryRecord["authority"];
  content_hash: string;
  recorded_at: Date | string;
}

async function mapMemory(row: MemoryRow, protector?: PayloadProtector): Promise<MemoryRecord> {
  let content = row.content;
  if (isProtectedDataEnvelope(row.protected_content)) {
    if (!protector) throw new AgenticError("permanent", `Memory revision ${row.id}@${row.revision} is protected but no payload protector is configured`);
    const unprotected = await protector.unprotect(row.protected_content, {
      tenantId: row.tenant_id, recordId: `${row.id}@${row.revision}`,
      purpose: "memory-content", classification: row.classification,
    });
    if (typeof unprotected !== "string") throw new AgenticError("permanent", `Memory revision ${row.id}@${row.revision} has invalid protected content`);
    content = unprotected;
  }
  if (sha256(content) !== row.content_hash) {
    throw new AgenticError("permanent", `Memory revision integrity check failed: ${row.id}@${row.revision}`);
  }
  return {
    id: row.id,
    revision: row.revision,
    scope: { tenantId: row.tenant_id, type: row.scope_type, id: row.scope_id },
    kind: row.kind,
    status: row.status,
    content,
    format: row.format,
    classification: row.classification,
    sourceRef: row.source_ref,
    authority: row.authority,
    contentHash: row.content_hash,
    recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : new Date(row.recorded_at).toISOString(),
  };
}

function assertTenant(tenantId: string, security: SecurityContext): void {
  if (tenantId !== security.tenantId) throw new Error("Memory tenant boundary violation");
}

async function appendOutbox(
  client: PoolClient,
  record: Pick<MemoryRecord, "id" | "revision" | "scope">,
  operation: "upsert" | "delete",
): Promise<void> {
  await client.query(
    "INSERT INTO agentic.memory_outbox(id, tenant_id, memory_id, revision, operation, payload) VALUES ($1,$2,$3,$4,$5,$6)",
    [
      randomUUID(),
      record.scope.tenantId,
      record.id,
      record.revision,
      operation,
      JSON.stringify({ memoryId: record.id, revision: record.revision, operation }),
    ],
  );
}

export class PostgresMemoryService implements MemoryService {
  constructor(
    private readonly pool: Pool,
    private readonly payloadProtector?: PayloadProtector,
    private readonly blindIndex?: BlindIndexEncoder,
  ) {
    if (Boolean(payloadProtector) !== Boolean(blindIndex)) throw new Error("Memory payload protection and blind indexing must be configured together");
  }

  async propose(candidate: MemoryCandidate, security: SecurityContext): Promise<MemoryRecord> {
    assertTenant(candidate.scope.tenantId, security);
    if (!hasPermission(security, "memory.propose")) throw new Error("Permission denied: memory.propose");
    if (candidate.scope.type === "actor" && candidate.scope.id !== security.actorId) {
      throw new Error("Cannot write another actor's memory");
    }

    const record: MemoryRecord = {
      ...candidate,
      id: randomUUID(),
      revision: 1,
      status: candidate.authority === "model-inferred" ? "quarantined" : "active",
      recordedAt: new Date().toISOString(),
      contentHash: sha256(candidate.content),
    };
    const protectedContent = this.payloadProtector ? await this.payloadProtector.protect(record.content, {
      tenantId: record.scope.tenantId, recordId: `${record.id}@${record.revision}`,
      purpose: "memory-content", classification: record.classification,
    }) : null;
    const searchTokens = this.blindIndex ? await this.blindIndex.encodeTerms(record.content, record.scope.tenantId) : [];
    return withTenantTransaction(this.pool, security, async (client) => {
      await client.query(
        `INSERT INTO agentic.memory_record(
           id, tenant_id, scope_type, scope_id, kind, status, current_revision, recorded_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          record.id,
          record.scope.tenantId,
          record.scope.type,
          record.scope.id,
          record.kind,
          record.status,
          record.revision,
          record.recordedAt,
        ],
      );
      await client.query(
        `INSERT INTO agentic.memory_revision(
           memory_id, revision, tenant_id, content, format, classification,
           source_ref, authority, content_hash, recorded_at, protected_content, search_tokens
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          record.id,
          record.revision,
          record.scope.tenantId,
          protectedContent ? "" : record.content,
          record.format,
          record.classification,
          record.sourceRef,
          record.authority,
          record.contentHash,
          record.recordedAt,
          protectedContent ? JSON.stringify(protectedContent) : null,
          searchTokens,
        ],
      );
      await appendOutbox(client, record, "upsert");
      return record;
    });
  }

  async search(query: MemoryQuery, security: SecurityContext): Promise<MemoryContext> {
    if (!hasPermission(security, "memory.read")) throw new Error("Permission denied: memory.read");
    for (const scope of query.scopes) assertTenant(scope.tenantId, security);
    const limit = Number.isInteger(query.limit) ? Math.min(Math.max(query.limit, 0), 100) : 0;
    if (query.scopes.length === 0 || !query.text.trim() || limit === 0) {
      return { records: [], contextText: "", contextHash: sha256("") };
    }

    return withTenantTransaction(this.pool, security, async (client) => {
      const encodedTerms = this.blindIndex ? await this.blindIndex.encodeTerms(query.text, security.tenantId) : undefined;
      if (encodedTerms && encodedTerms.length === 0) return { records: [], contextText: "", contextHash: sha256("") };
      const values: unknown[] = [encodedTerms ?? query.text, limit, security.actorId];
      const scopeClauses = query.scopes.map((scope) => {
        values.push(scope.type, scope.id);
        const offset = values.length - 1;
        return `(r.scope_type = $${offset} AND r.scope_id = $${offset + 1})`;
      });
      const result = await client.query<MemoryRow>(
        `SELECT r.id, r.current_revision AS revision, r.tenant_id, r.scope_type, r.scope_id,
                r.kind, r.status, v.content, v.protected_content, v.format, v.classification, v.source_ref,
                v.authority, v.content_hash, v.recorded_at
           FROM agentic.memory_record r
           JOIN agentic.memory_revision v
             ON v.memory_id = r.id AND v.revision = r.current_revision
          WHERE r.status = 'active'
            AND (${scopeClauses.join(" OR ")})
            AND (r.scope_type <> 'actor' OR r.scope_id = $3)
            AND ${this.blindIndex ? "v.search_tokens && $1::text[]" : "v.search_document @@ websearch_to_tsquery('simple', $1)"}
          ORDER BY ${this.blindIndex ? "cardinality(v.search_tokens)" : "ts_rank_cd(v.search_document, websearch_to_tsquery('simple', $1))"} DESC,
                   v.recorded_at DESC
          LIMIT $2`,
        values,
      );
      const records = await Promise.all(result.rows.map((row) => mapMemory(row, this.payloadProtector)));
      const contextText = records
        .map((record) => `[memory:${record.id}@${record.revision}; authority=${record.authority}] ${record.content}`)
        .join("\n");
      return { records, contextText, contextHash: sha256(contextText) };
    });
  }

  async forget(id: string, security: SecurityContext): Promise<boolean> {
    if (!hasPermission(security, "memory.forget")) throw new Error("Permission denied: memory.forget");
    return withTenantTransaction(this.pool, security, async (client) => {
      const selected = await client.query<MemoryRow>(
        `SELECT r.id, r.current_revision AS revision, r.tenant_id, r.scope_type, r.scope_id,
                r.kind, r.status, v.content, v.protected_content, v.format, v.classification, v.source_ref,
                v.authority, v.content_hash, v.recorded_at
           FROM agentic.memory_record r
           JOIN agentic.memory_revision v
             ON v.memory_id = r.id AND v.revision = r.current_revision
          WHERE r.id = $1
          FOR UPDATE OF r`,
        [id],
      );
      const current = selected.rows[0] ? await mapMemory(selected.rows[0], this.payloadProtector) : undefined;
      if (!current) return false;
      if (current.scope.type === "actor" && current.scope.id !== security.actorId) {
        throw new Error("Cannot forget another actor's memory");
      }
      const revision = current.revision + 1;
      const recordedAt = new Date().toISOString();
      await client.query(
        `INSERT INTO agentic.memory_revision(
           memory_id, revision, tenant_id, content, format, classification,
           source_ref, authority, content_hash, recorded_at, protected_content, search_tokens
         ) VALUES ($1,$2,$3,'',$4,$5,$6,$7,$8,$9,NULL,'{}')`,
        [
          current.id,
          revision,
          current.scope.tenantId,
          current.format,
          current.classification,
          current.sourceRef,
          current.authority,
          sha256(""),
          recordedAt,
        ],
      );
      await client.query(
        "UPDATE agentic.memory_record SET status = 'deleted', current_revision = $2 WHERE id = $1",
        [id, revision],
      );
      await appendOutbox(client, { id, revision, scope: current.scope }, "delete");
      return true;
    });
  }
}
