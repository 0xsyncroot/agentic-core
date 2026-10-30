import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolGroup } from "@0xsyncroot/contracts";
import { createToolsLoadTool } from "../src/index.js";

const GROUPS: readonly ToolGroup[] = [
  { id: "analysis", toolIds: ["compare"], purpose: "Compute figures over results already read, and compare two tables row by row (for example a file against the software) to find who differs." },
  { id: "screen", toolIds: ["view"], purpose: "Read and operate the open tab: see the screen, click, fill." },
  { id: "plain", toolIds: ["p"], purpose: "Read the records" },
];

test("the loader lists each group by id and the words of its purpose before the first elaboration, keeping the clause that names its only tool", () => {
  const { description } = createToolsLoadTool(GROUPS);
  assert.ok(description.endsWith("Groups: analysis: Compute figures over results already read, and compare two tables row by row | screen: Read and operate the open tab | plain: Read the records"), description);
});
