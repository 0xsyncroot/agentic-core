import { randomUUID } from "node:crypto";
import type {
  MemoryCandidate,
  MemoryContext,
  MemoryQuery,
  MemoryRecord,
  MemoryService,
  SecurityContext,
} from "@0xsyncroot/contracts";
import { hasPermission } from "@0xsyncroot/contracts";
import { sha256 } from "./hash.js";

function assertTenant(tenantId: string, security: SecurityContext): void {
  if (tenantId !== security.tenantId) throw new Error("Memory tenant boundary violation");
}

function terms(text: string): Set<string> {
  return new Set(text.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean));
}

export class InMemoryMemoryService implements MemoryService {
  readonly #records = new Map<string, MemoryRecord>();

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
    this.#records.set(record.id, record);
    return record;
  }

  async search(query: MemoryQuery, security: SecurityContext): Promise<MemoryContext> {
    if (!hasPermission(security, "memory.read")) throw new Error("Permission denied: memory.read");
    for (const scope of query.scopes) assertTenant(scope.tenantId, security);

    const limit = Number.isInteger(query.limit) ? Math.min(Math.max(query.limit, 0), 100) : 0;
    if (!query.text.trim() || query.scopes.length === 0 || limit === 0) {
      return { records: [], contextText: "", contextHash: sha256("") };
    }
    const requestedScopes = new Set(query.scopes.map((scope) => `${scope.type}:${scope.id}`));
    const queryTerms = terms(query.text);
    const scored = [...this.#records.values()]
      .filter((record) => record.status === "active")
      .filter((record) => record.scope.tenantId === security.tenantId)
      .filter((record) => requestedScopes.has(`${record.scope.type}:${record.scope.id}`))
      .filter((record) => record.scope.type !== "actor" || record.scope.id === security.actorId)
      .map((record) => ({
        record,
        score: [...terms(record.content)].filter((term) => queryTerms.has(term)).length,
      }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || right.record.recordedAt.localeCompare(left.record.recordedAt))
      .slice(0, limit)
      .map(({ record }) => record);

    const contextText = scored
      .map((record) => `[memory:${record.id}@${record.revision}; authority=${record.authority}] ${record.content}`)
      .join("\n");
    return { records: scored, contextText, contextHash: sha256(contextText) };
  }

  async forget(id: string, security: SecurityContext): Promise<boolean> {
    if (!hasPermission(security, "memory.forget")) throw new Error("Permission denied: memory.forget");
    const record = this.#records.get(id);
    if (!record) return false;
    assertTenant(record.scope.tenantId, security);
    if (record.scope.type === "actor" && record.scope.id !== security.actorId) {
      throw new Error("Cannot forget another actor's memory");
    }
    this.#records.set(id, {
      ...record,
      status: "deleted",
      revision: record.revision + 1,
      content: "",
      contentHash: sha256(""),
      recordedAt: new Date().toISOString(),
    });
    return true;
  }
}
