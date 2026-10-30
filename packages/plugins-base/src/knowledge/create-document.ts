import { createHash } from "node:crypto";
import type { KnowledgeDocument } from "@0xsyncroot/contracts";

export function createKnowledgeDocument(input: Omit<KnowledgeDocument, "contentHash">): KnowledgeDocument {
  return { ...input, contentHash: createHash("sha256").update(input.content).digest("hex") };
}
