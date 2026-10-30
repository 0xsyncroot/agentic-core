import type { JsonValue, KnowledgeService, ToolDefinition } from "@0xsyncroot/contracts";
import { integerArgument, objectArguments, stringArgument } from "./arguments.js";

export function createKnowledgeTools(knowledge: KnowledgeService): readonly ToolDefinition[] {
  return [
    {
      id: "knowledge_search", version: "1.0.0",
      description: "Search the approved local/offline knowledge corpus. Returns excerpts and citations; it never accesses the internet.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } }, required: ["query"], additionalProperties: false },
      outputSchema: {},
      requiredPermissions: ["knowledge.read"], sideEffect: "none", timeoutMs: 2_000,
      execute: async (invocation) => {
        const args = objectArguments(invocation.arguments);
        return { hits: await knowledge.search(stringArgument(args, "query"), integerArgument(args, "limit", 5, 1, 10), invocation.security) } as unknown as JsonValue;
      },
    },
    {
      id: "knowledge_read", version: "1.0.0",
      description: "Read a bounded line range from a document returned by knowledge_search, preserving its citation and content hash.",
      inputSchema: { type: "object", properties: { document_id: { type: "string" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } }, required: ["document_id", "start_line", "end_line"], additionalProperties: false },
      outputSchema: {},
      requiredPermissions: ["knowledge.read"], sideEffect: "none", timeoutMs: 2_000,
      execute: async (invocation) => {
        const args = objectArguments(invocation.arguments);
        const result = await knowledge.read(stringArgument(args, "document_id", 500), {
          startLine: integerArgument(args, "start_line", 1, 1, 1_000_000),
          endLine: integerArgument(args, "end_line", 200, 1, 1_000_000),
        }, invocation.security);
        return (result ?? { error: "document_not_found" }) as unknown as JsonValue;
      },
    },
  ];
}
