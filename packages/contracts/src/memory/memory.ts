import type { SecurityContext } from "../security/security-context.js";
import type { DataClassification } from "../shared/json.js";

/** Generic scopes owned by the platform. Products add namespaced scopes such as `product:case`. */
export type CoreMemoryScopeType = "global" | "tenant" | "actor" | "agent" | "session";
export type MemoryScopeType = CoreMemoryScopeType | `${string}:${string}`;

export interface MemoryScope {
  readonly tenantId: string;
  readonly type: MemoryScopeType;
  readonly id: string;
}
export interface MemoryCandidate {
  readonly scope: MemoryScope; readonly kind: "episodic" | "semantic" | "relational"; readonly content: string;
  readonly format: "text" | "markdown" | "json"; readonly classification: DataClassification; readonly sourceRef: string;
  readonly authority: "user-stated" | "domain-verified" | "document-derived" | "model-inferred";
}
export interface MemoryRecord extends MemoryCandidate {
  readonly id: string; readonly revision: number; readonly status: "active" | "superseded" | "deleted" | "quarantined";
  readonly recordedAt: string; readonly contentHash: string;
}
export interface MemoryQuery {
  readonly text: string;
  readonly scopes: readonly MemoryScope[];
  readonly limit: number;
}

export interface MemoryContext {
  readonly records: readonly MemoryRecord[];
  readonly contextText: string;
  readonly contextHash: string;
}

/** Deployment/base policy that decides whether automatic memory context is selected for a turn. */
export interface MemoryContextPolicy {
  createQuery(input: {
    readonly text: string;
    readonly sessionId: string;
    readonly security: SecurityContext;
  }): MemoryQuery | undefined;
}
export interface MemoryReader {
  search(query: MemoryQuery, security: SecurityContext): Promise<MemoryContext>;
}

export interface MemoryWriter {
  propose(candidate: MemoryCandidate, security: SecurityContext): Promise<MemoryRecord>;
  forget(id: string, security: SecurityContext): Promise<boolean>;
}

/** Backward-compatible aggregate for adapters that provide both capabilities. */
export interface MemoryService extends MemoryReader, MemoryWriter {}
