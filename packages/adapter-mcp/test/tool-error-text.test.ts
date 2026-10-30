import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { toolErrorMessage } from "../src/shared.js";

/**
 * What a failing MCP tool told the agent, versus what the agent was given.
 *
 * A tool that refuses answers with `isError` and its reason in text content — that is the whole
 * mechanism by which a server tells an agent how to correct itself. Both clients threw that text
 * away and raised "MCP tool X returned an error" instead, so every refusal EXAMPLE writes — the
 * error code, the row a header is really on, the request it just rejected — stopped at the client.
 *
 * It looked exactly like a model ignoring good advice: across two browser runs the agent was
 * refused 45 times with the row to use named in every refusal, and used it zero times. It could
 * not have used it. It never saw it, and it changed the only thing it could still guess at.
 */
test("a refusing tool's own words reach the caller", () => {
  const message = toolErrorMessage("mcp_example_read_budget_table", {
    isError: true,
    content: [{ type: "text", text: "[example.office_docs_refused] Use headerRow 7 — that row reads: STT | Nội dung." }],
  });
  assert.match(message, /mcp_example_read_budget_table/u, "the tool is still named");
  assert.match(message, /example\.office_docs_refused/u, "the server's error code crosses");
  assert.match(message, /Use headerRow 7/u, "and the correction it named");
});

test("a refusal with nothing to say still says which tool refused", () => {
  const message = toolErrorMessage("mcp_catalog_list", { isError: true, content: [] });
  assert.match(message, /mcp_catalog_list/u);
});

test("neither client builds that sentence on its own any more", () => {
  // Source-checked rather than asserted through a live server, because what went wrong was one
  // line in each of two transports and a port interface in front of them that no test crossed.
  for (const file of ["http-client.ts", "stdio-client.ts"]) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.ok(source.includes("new McpToolRefusal(name, result)"), `${file} must hand the server's own text on`);
    assert.ok(!/returned an error`/u.test(source), `${file} still builds its own error sentence`);
  }
});
