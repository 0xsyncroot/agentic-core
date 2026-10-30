import assert from "node:assert/strict";
import test from "node:test";
import type { ToolInvocation } from "@0xsyncroot/contracts";
import { executeMcpTool } from "../src/elicitation.js";
import { mcpCompletedResult, withNextCall } from "../src/image-result.js";
import { normalizeLimits } from "../src/shared.js";

/** A server's `structuredContent.nextCall` reaches the runtime as the response's `nextCall`, named by this adapter's tool id. */
const id = (tool: string) => `mcp_docs_${tool}`;
const read = (nextCall?: unknown) => ({ content: [], structuredContent: { documentId: "d1", preview: { rows: [[1]], nextOffset: 1 }, ...(nextCall ? { nextCall } : {}) } });

test("a well-formed nextCall is lifted with the same server's tool id; the result is left as sent", () => {
  const value = read({ tool: "read_table", arguments: { documentId: "d1", sheet: "T9", all: true }, why: "cut" });
  const lifted = withNextCall(mcpCompletedResult(value, "read", 100_000), value, id) as Record<string, unknown>;
  assert.deepEqual(lifted.nextCall, { toolId: "mcp_docs_read_table", arguments: { documentId: "d1", sheet: "T9", all: true }, why: "cut" });
  assert.equal(lifted.kind, "completed");
  assert.deepEqual(lifted.result, value);
});

test("no nextCall, or a malformed one, changes nothing", () => {
  for (const next of [undefined, { tool: "", arguments: {}, why: "x" }, { tool: "read_table", arguments: ["d1"], why: "x" }, { tool: "read_table", arguments: {}, why: 1 }]) {
    const value = read(next);
    const response = mcpCompletedResult(value, "read", 100_000);
    assert.equal(withNextCall(response, value, id), response);
  }
  const unnamable = read({ tool: "x".repeat(300), arguments: {}, why: "x" });
  const response = mcpCompletedResult(unnamable, "read", 100_000);
  assert.equal(withNextCall(response, unnamable, () => { throw new Error("too long"); }), response, "a tool the server cannot name here names nothing");
});

test("a typed reads rides with the lifted call; a malformed one is dropped and the call stays", () => {
  const reads = { source: { id: "d1", name: "Lương.xlsx" }, unit: "sheet", catalog: [{ name: "T9", rows: 120 }, { name: "T8", rows: 118 }], target: "T9", shown: { rows: 10, of: 120 } };
  const call = { tool: "read_table", arguments: { documentId: "d1", sheet: "T9", all: true }, why: "cut" };
  const typed = read({ ...call, reads });
  assert.deepEqual((withNextCall(mcpCompletedResult(typed, "read", 100_000), typed, id) as Record<string, unknown>).nextCall,
    { toolId: "mcp_docs_read_table", arguments: call.arguments, why: "cut", reads });
  for (const bad of [{ ...reads, unit: "Sheets!" }, { ...reads, target: "T7" }, { ...reads, catalog: "T9" }, "sheet"]) {
    const value = read({ ...call, reads: bad });
    assert.deepEqual((withNextCall(mcpCompletedResult(value, "read", 100_000), value, id) as Record<string, unknown>).nextCall,
      { toolId: "mcp_docs_read_table", arguments: call.arguments, why: "cut" });
  }
});

test("a server call's nextCall reaches the runtime under this server's id for the named tool", async () => {
  const value = read({ tool: "read_table", arguments: { documentId: "d1", all: true }, why: "cut" });
  const client = { callTool: async () => ({ kind: "completed", result: value }) } as never;
  const response = await executeMcpTool(client, "office-docs", "read_document", { arguments: { documentId: "d1" } } as unknown as ToolInvocation,
    new AbortController().signal, normalizeLimits({})) as Record<string, unknown>;
  assert.deepEqual(response.nextCall, { toolId: "mcp_office-docs_read_table", arguments: { documentId: "d1", all: true }, why: "cut" });
});
