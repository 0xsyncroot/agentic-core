import assert from "node:assert/strict";
import { test } from "node:test";
import type { JudgmentPort, SecurityContext, ToolDefinition } from "@0xsyncroot/contracts";
import { InMemoryToolResultSpool, PluginHost } from "@0xsyncroot/core";
import { InMemoryMemoryService } from "@0xsyncroot/persistence-memory";
import { TOOL_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import {
  InMemoryKnowledgeService, StaticSkillCatalog, createBaseAgentToolPlugins, createKnowledgePlugin, createMemoryPlugin,
  createRankCandidatesTool, createReadResultToolPlugin, createSkillCatalogPlugin,
} from "@0xsyncroot/plugins-base";
import { resolveAgentOptions } from "../src/agent/agent-options.js";
import { modelToolSchema } from "../src/agent/model-tool-schema.js";
import { ToolExecutionCoordinator } from "../src/agent/tool-execution-coordinator.js";

function tool(id: string): ToolDefinition {
  return {
    id, version: "1.0.0", description: "A test tool.",
    inputSchema: { type: "object" }, outputSchema: {},
    requiredPermissions: [], sideEffect: "none", timeoutMs: 1_000,
    execute: async () => ({}),
  };
}

test("modelToolSchema throws on an illegal provider function name", () => {
  assert.throws(
    () => modelToolSchema(tool("mcp.docs.search")),
    /Tool id "mcp\.docs\.search" is not a valid provider function name/,
  );
  assert.throws(() => modelToolSchema(tool("a".repeat(65))), /is not a valid provider function name/);
  assert.throws(() => modelToolSchema(tool("")), /is not a valid provider function name/);
});

test("modelToolSchema passes a valid id straight through as the function name", () => {
  const schema = modelToolSchema(tool("mcp_docs_search"));
  assert.equal(schema.name, "mcp_docs_search");
});

test("modelToolSchema shows modelInputSchema when a tool has one, else inputSchema", () => {
  const stricter = { type: "object", required: ["a"] };
  const shown = modelToolSchema({ ...tool("strict_tool"), inputSchema: { type: "object" }, modelInputSchema: stricter });
  assert.deepEqual(shown.inputSchema, stricter);
  assert.deepEqual(modelToolSchema(tool("plain_tool")).inputSchema, { type: "object" });
});

test("a modelInputSchema the validator cannot read fails when the tool is admitted", () => {
  const unreadable = { ...tool("strict_tool"), modelInputSchema: { type: "object", patternProperties: {} } };
  assert.throws(() => new ToolExecutionCoordinator([unreadable], resolveAgentOptions({})), /unsupported json schema keyword/i);
});

// Declaring what a tool accepts must not change what the model is shown (the one-time proof for the base tool schemas:
// docs/incidents/2026-10-17-core-plan-update-refused.md).
test("a base tool without modelInputSchema shows its inputSchema as is; plan_update shows its modelInputSchema, with a description per step", async () => {
  const security: SecurityContext = { tenantId: "t", actorId: "a", permissions: new Set(), correlationId: "c", purpose: "test" };
  const host = new PluginHost();
  await host.activate([
    createMemoryPlugin(new InMemoryMemoryService()), createKnowledgePlugin(new InMemoryKnowledgeService([])),
    createSkillCatalogPlugin(new StaticSkillCatalog([])), ...createBaseAgentToolPlugins(), createReadResultToolPlugin(new InMemoryToolResultSpool()),
  ], { security, verifyArtifact: async () => true });
  try {
    const judgment: JudgmentPort = { providerId: "none", model: "none", judge: async () => { throw new Error("not called"); } };
    const tools = [...host.capabilities.all(TOOL_CAPABILITY), createRankCandidatesTool(judgment)];
    for (const entry of tools.filter((candidate) => candidate.modelInputSchema === undefined)) {
      assert.equal(modelToolSchema(entry).inputSchema, entry.inputSchema, `${entry.id}: the model is shown the schema the validator uses`);
    }
    const plan = tools.find((entry) => entry.id === "plan_update")!;
    assert.ok(plan.modelInputSchema, "plan_update declares what the model is shown");
    const shown = modelToolSchema(plan).inputSchema;
    assert.deepEqual(shown, plan.modelInputSchema);
    assert.deepEqual((shown as { properties: { steps: { items: { required: string[] } } } }).properties.steps.items.required, ["description", "status"], "the model is still asked for a description on every step");
  } finally { await host.shutdown(); }
});
