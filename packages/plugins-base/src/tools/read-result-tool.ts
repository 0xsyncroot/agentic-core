import { missingResultText, type JsonValue, type ToolDefinition, type ToolInvocation, type ToolResultSpool } from "@0xsyncroot/contracts";
import { integerArgument, objectArguments, stringArgument } from "./arguments.js";

export const READ_RESULT_TOOL_ID = "read_result";

/** Below the runtime's own result budget, so a page is never cut again. */
const PAGE_CHARS = 20_000;

function valueAt(value: JsonValue, path: string): JsonValue | undefined {
  if (path === "(root)") return value;
  let current: JsonValue | undefined = value;
  for (const segment of path.split(/[.[\]]/u).filter(Boolean)) {
    if (current === null || typeof current !== "object") return undefined;
    current = Object.hasOwn(current, segment) ? (current as Record<string, JsonValue>)[segment] : undefined;
  }
  return current;
}

/**
 * Reads on from a tool result the runtime had to cut.
 *
 * Every tool has a limit on how much one call may return, and a list longer than that is cut with a
 * note naming this tool. The page is bounded by size as well as count, because a row's size is not
 * known to anyone until it is measured: the same 100 rows are 5,000 characters in one tool and 60,000
 * in another.
 */
export function createReadResultTool(spool: ToolResultSpool): ToolDefinition {
  return {
    id: READ_RESULT_TOOL_ID, restoresResult: true,
    version: "1.1.0",
    description: "Recover a retained tool observation by resultId. Omit path to read the whole value, or use a field/list path (for example data.nodes or data.payrollPeriod). Lists are paged: continue from nextOffset until done is true. Retained results describe their original observation time, not current state. Read missing evidence before answering.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["resultId"],
      properties: {
        resultId: { type: "string", description: "The resultId from a retained observation or truncation note." },
        path: { type: "string", description: "Field or list to read. Defaults to (root); use a narrower path for a large object." },
        offset: { type: "integer", minimum: 0, description: "Index of the first entry to return. Default 0; use the nextOffset of the previous page." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Most entries to return. The page is also cut by size, so fewer may come back." },
      },
    },
    outputSchema: { type: "object", additionalProperties: true, required: ["rows", "total", "done"] },
    requiredPermissions: [], sideEffect: "none", timeoutMs: 30_000,
    // A page is already bounded to PAGE_CHARS; leaving it under the runtime default would cut a page that is small on purpose.
    maxResultChars: PAGE_CHARS * 3,
    execute: async (invocation: ToolInvocation) => {
      const args = objectArguments(invocation.arguments);
      const resultId = stringArgument(args, "resultId", 100);
      const path = args.path === undefined ? "(root)" : stringArgument(args, "path", 300);
      const offset = integerArgument(args, "offset", 0, 0, 10_000_000);
      const limit = integerArgument(args, "limit", 500, 1, 500);
      const scope = { tenantId: invocation.security.tenantId, sessionId: invocation.sessionId };
      const stored = spool.get(scope, resultId);
      if (!stored) throw new Error(missingResultText(spool, scope, resultId));
      const value = valueAt(stored.value, path);
      if (value === undefined) throw new Error(`The stored result has no value at "${path}". Use a field or list path from the original result.`);
      if (!Array.isArray(value) && JSON.stringify(value).length > PAGE_CHARS) {
        throw new Error(`The value at "${path}" is too large to recover whole. Read a narrower field or list path (for a UI snapshot, data.nodes) instead.`);
      }
      const list = Array.isArray(value) ? value : [value];
      const rows: JsonValue[] = [];
      let chars = 0;
      for (const row of list.slice(offset, offset + limit)) {
        const size = JSON.stringify(row).length;
        if (rows.length > 0 && chars + size > PAGE_CHARS) break;
        rows.push(row);
        chars += size;
      }
      const next = offset + rows.length;
      const done = next >= list.length;
      return {
        resultId, path, offset, returned: rows.length, total: list.length, rows, done,
        ...(done ? {} : { nextOffset: next }),
      };
    },
  };
}
