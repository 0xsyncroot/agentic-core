import type { KnowledgeDocument, KnowledgeHit, KnowledgeService, SecurityContext } from "@0xsyncroot/contracts";

function words(text: string): string[] {
  return text.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((word) => word.length > 1);
}

export class InMemoryKnowledgeService implements KnowledgeService {
  readonly #documents: ReadonlyMap<string, KnowledgeDocument>;

  constructor(documents: readonly KnowledgeDocument[]) {
    const map = new Map<string, KnowledgeDocument>();
    for (const document of documents) {
      if (map.has(document.id)) throw new Error(`Duplicate knowledge document: ${document.id}`);
      map.set(document.id, Object.freeze({ ...document }));
    }
    this.#documents = map;
  }

  async search(query: string, limit: number, security: SecurityContext): Promise<readonly KnowledgeHit[]> {
    const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 0), 100) : 0;
    const queryWords = new Set(words(query));
    if (queryWords.size === 0 || boundedLimit === 0) return [];
    const hits: KnowledgeHit[] = [];
    for (const document of this.#documents.values()) {
      if (document.tenantId && document.tenantId !== security.tenantId) continue;
      const lines = document.content.split(/\r?\n/);
      let bestScore = 0;
      let bestLine = 0;
      for (const [index, line] of lines.entries()) {
        const score = words(line).reduce((total, word) => total + (queryWords.has(word) ? 1 : 0), 0);
        if (score > bestScore) { bestScore = score; bestLine = index; }
      }
      const score = bestScore + words(document.title).filter((word) => queryWords.has(word)).length * 2;
      if (score === 0) continue;
      const start = Math.max(0, bestLine - 2);
      const end = Math.min(lines.length, bestLine + 3);
      hits.push({
        documentId: document.id,
        title: document.title,
        excerpt: lines.slice(start, end).join("\n").slice(0, 2_000),
        citation: `${document.sourceRef}#L${start + 1}-L${end}`,
        score,
      });
    }
    return hits.sort((left, right) => right.score - left.score || left.documentId.localeCompare(right.documentId)).slice(0, boundedLimit);
  }

  async read(
    documentId: string,
    range: { readonly startLine: number; readonly endLine: number },
    security: SecurityContext,
  ): Promise<{ readonly content: string; readonly citation: string; readonly contentHash: string } | null> {
    const document = this.#documents.get(documentId);
    if (!document || (document.tenantId && document.tenantId !== security.tenantId)) return null;
    const lines = document.content.split(/\r?\n/);
    const start = Math.max(1, range.startLine);
    const end = Math.min(lines.length, range.endLine, start + 199);
    if (end < start) throw new Error("end_line must be greater than or equal to start_line");
    return { content: lines.slice(start - 1, end).join("\n"), citation: `${document.sourceRef}#L${start}-L${end}`, contentHash: document.contentHash };
  }
}
