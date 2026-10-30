import type { SecurityContext } from "../security/security-context.js";
import type { DataClassification } from "../shared/json.js";
export interface KnowledgeDocument {
  readonly id: string; readonly title: string; readonly content: string; readonly sourceRef: string;
  readonly contentHash: string; readonly classification: DataClassification; readonly tenantId?: string;
}
export interface KnowledgeHit { readonly documentId: string; readonly title: string; readonly excerpt: string; readonly citation: string; readonly score: number }
export interface KnowledgeService {
  search(query: string, limit: number, security: SecurityContext): Promise<readonly KnowledgeHit[]>;
  read(documentId: string, range: { readonly startLine: number; readonly endLine: number }, security: SecurityContext): Promise<{ readonly content: string; readonly citation: string; readonly contentHash: string } | null>;
}
