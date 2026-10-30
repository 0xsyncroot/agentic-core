import type { JsonValue, MemoryService, ToolDefinition } from "@0xsyncroot/contracts";
import { baseMemoryScopes } from "../memory/base-memory-context-policy.js";
import { integerArgument, objectArguments, stringArgument } from "./arguments.js";

export function createMemorySearchTool(memory: MemoryService): ToolDefinition {
  return {
    id: "memory_search", version: "1.0.0",
    description: "Search active tenant, user and current-session memory. Returns provenance-tagged records; quarantined memory is excluded.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } }, required: ["query"], additionalProperties: false },
    outputSchema: {},
    requiredPermissions: ["memory.read"], sideEffect: "none", timeoutMs: 2_000,
    execute: async (invocation) => {
      const args = objectArguments(invocation.arguments);
      const result = await memory.search({
        text: stringArgument(args, "query"), limit: integerArgument(args, "limit", 5, 1, 10),
        scopes: baseMemoryScopes(invocation.security, invocation.sessionId),
      }, invocation.security);
      return {
        context: result.contextText,
        records: result.records.map((record) => ({ id: record.id, revision: record.revision, authority: record.authority, sourceRef: record.sourceRef })),
        contextHash: result.contextHash,
      } as unknown as JsonValue;
    },
  };
}
