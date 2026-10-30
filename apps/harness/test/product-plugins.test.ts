import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { CAPABILITIES, type SystemPromptProvider, type ToolDefinition, type TurnControlPolicy } from "@0xsyncroot/contracts";
import { InMemoryTurnAdmissionController } from "@0xsyncroot/core";
import { SYSTEM_PROMPT_CAPABILITY, TOOL_CAPABILITY, type PluginDescriptor, type TrustTier } from "@0xsyncroot/plugin-sdk";
import { createBlankRuntime } from "../src/bootstrap.js";

const testEnvironment: NodeJS.ProcessEnv = {
  AGENTIC_ENABLE_DIAGNOSTIC_TOOLS: "false",
  AGENTIC_KNOWLEDGE_ROOTS: "",
  AGENTIC_SKILL_ROOTS: "",
};

const productionEnvironment: NodeJS.ProcessEnv = {
  ...testEnvironment,
  AGENTIC_RUNTIME_PROFILE: "production",
  AGENTIC_LLM_PROVIDER: "deepseek",
  DEEPSEEK_API_KEY: "test-production-key",
  DATABASE_URL: "postgres://app:secret@localhost/test",
  AGENTIC_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
};

function productToolPlugin(
  trustTier: TrustTier = "first-party-domain",
  artifact = { digest: "sha256:test-product-tool", signature: "test-product-signature" },
): PluginDescriptor {
  const tool: ToolDefinition = {
    id: "test_product_lookup", version: "1.0.0", description: "A product-composed test tool",
    inputSchema: { type: "object", additionalProperties: false }, outputSchema: {},
    requiredPermissions: [], sideEffect: "none", timeoutMs: 1_000,
    execute: async () => ({ ok: true }),
  };
  return {
    trustTier,
    manifest: {
      manifestVersion: 1, id: "io.syncroot.product.test-tool", version: "1.0.0", publisher: "Product Test",
      coreApi: "^1.0.0", artifact, requires: {},
      provides: { [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } }, permissions: {},
    },
    plugin: {
      validate: async () => ({ valid: true }),
      activate: async (context) => context.registrations.provide(TOOL_CAPABILITY, tool),
    },
  };
}

function productPromptPlugin(id: string, content: string): PluginDescriptor {
  const prompt: SystemPromptProvider = { id, render: async () => content };
  return {
    trustTier: "first-party-domain",
    manifest: {
      manifestVersion: 1, id, version: "1.0.0", publisher: "Product Test", coreApi: "^1.0.0",
      artifact: { digest: `sha256:${id}`, signature: "test-product-signature" }, requires: {},
      provides: { [CAPABILITIES.systemPrompt]: { version: "1.0.0", cardinality: "multi" } }, permissions: {},
    },
    plugin: {
      validate: async () => ({ valid: true }),
      activate: async (context) => context.registrations.provide(SYSTEM_PROMPT_CAPABILITY, prompt),
    },
  };
}

test("production rejects process-local admission while development accepts it", async () => {
  await assert.rejects(createBlankRuntime(productionEnvironment, {
    runtimeProviderFactory: () => { throw new Error("must not construct runtime before admission validation"); },
    admissionController: new InMemoryTurnAdmissionController(1),
  }), /production-safe shared TurnAdmissionController/i);

  const runtime = await createBlankRuntime(testEnvironment, {
    admissionController: new InMemoryTurnAdmissionController(1),
  });
  await runtime.close();
});

test("blank runtime mounts an explicitly verified first-party product bundle", async () => {
  const descriptor = productToolPlugin();
  const runtime = await createBlankRuntime(testEnvironment, {
    additionalPlugins: {
      descriptors: [descriptor],
      verifyArtifact: async (candidate) => candidate.manifest.artifact.digest === "sha256:test-product-tool" &&
        candidate.manifest.artifact.signature === "test-product-signature",
    },
  });
  try { assert.ok(runtime.availableTools.some((tool) => tool.id === "test_product_lookup")); }
  finally { await runtime.close(); }
});

test("additional product plugins fail closed", async () => {
  await assert.rejects(createBlankRuntime(testEnvironment, {
    additionalPlugins: { descriptors: [productToolPlugin()], verifyArtifact: async () => false },
  }), /artifact verification failed/i);
  await assert.rejects(createBlankRuntime(testEnvironment, {
    additionalPlugins: { descriptors: [productToolPlugin("platform-core")], verifyArtifact: async () => true },
  }), /must use the first-party-domain trust tier/i);
});

test("blank runtime rejects individually valid prompts whose aggregate exceeds the startup budget", async () => {
  const descriptors = [productPromptPlugin("io.syncroot.product.prompt-a", "a".repeat(31_000)),
    productPromptPlugin("io.syncroot.product.prompt-b", "b".repeat(31_000))];
  await assert.rejects(createBlankRuntime(testEnvironment, {
    additionalPlugins: { descriptors, verifyArtifact: async () => true },
  }), /required system prompts.*startup budget/i);
});

test("a loaded single-agent profile is the default routed profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-harness-profile-"));
  const file = join(root, "AGENT.md");
  await writeFile(file, `---\nid: finance-agent\nversion: 1.0.0\nname: Finance Agent\ndescription: Helps with finance.\n---\nStay within the finance scope.\n`);
  const runtime = await createBlankRuntime({ ...testEnvironment, AGENTIC_AGENT_PROFILE_FILE: file });
  try {
    const result = await runtime.agent.runTurn({
      sessionId: "profile-default", content: "hello",
      security: {
        tenantId: "tenant", actorId: "actor", permissions: new Set(["memory.read"]), correlationId: "profile-default",
        purpose: "test", authentication: { issuer: "test", subject: "actor", assurance: "user" },
        authorizedAgentProfiles: ["finance-agent"],
      },
    });
    const started = result.events.find((event) => event.type === "turn/start");
    assert.equal((started?.payload as { runtimeBinding?: { agentProfileId?: string } }).runtimeBinding?.agentProfileId, "finance-agent");
  } finally { await runtime.close(); }
});

test("blank runtime passes a trusted neutral turn-control policy to core", async () => {
  let beforeCalls = 0;
  let terminalCalls = 0;
  const turnControlPolicy: TurnControlPolicy = {
    id: "test.harness-control", revision: "v1",
    beforeModelStep: async () => { beforeCalls += 1; return {}; },
    reviewTerminal: async () => { terminalCalls += 1; return { decision: "accept" }; },
  };
  const runtime = await createBlankRuntime(testEnvironment, { turnControlPolicy });
  try {
    const result = await runtime.agent.runTurn({
      sessionId: "harness-control", content: "hello",
      security: { tenantId: "tenant", actorId: "actor", permissions: new Set(["memory.read"]),
        correlationId: crypto.randomUUID(), purpose: "test",
        authentication: { issuer: "test", subject: "actor", assurance: "user" } },
    });
    assert.equal(result.outcome, "completed");
    assert.equal(beforeCalls, 1);
    assert.equal(terminalCalls, 1);
    assert.ok(result.events.some((event) => event.type === "turn/control-decision"));
  } finally { await runtime.close(); }
});

test("a curated skill requiring only mcp_<id>_* tools boots when that connector is mounted, and fails closed when it is not or the id is mistyped", async () => {
  // Skill roots must resolve inside the workspace root (process.cwd()), so the fixture lives under
  // the repo tree rather than the OS temp dir — see loadMarkdownSkillCatalog's `within()` check.
  const skillRoot = await mkdtemp(join(process.cwd(), "apps/harness/test/.mcp-skill-fixture-"));
  try {
    await writeFile(join(skillRoot, "SKILL.md"), [
      "---",
      "id: docs-lookup",
      "version: 1.0.0",
      "name: Docs Lookup",
      "description: Looks documents up over an MCP connector.",
      "requiredTools:",
      "  - mcp_docs_search",
      "---",
      "Call mcp_docs_search to look things up.",
    ].join("\n"));
    const skillRoots = relative(process.cwd(), skillRoot);

    // The connector is HTTP, never actually contacted: contextual MCP plugin activation is
    // network-free by design, so this boots without a reachable server.
    const configured = { ...testEnvironment, AGENTIC_SKILL_ROOTS: skillRoots,
      AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "docs", endpoint: "https://mcp.example/mcp" }]) };
    const runtime = await createBlankRuntime(configured);
    try { assert.ok(runtime); } finally { await runtime.close(); }

    const unconfigured = { ...testEnvironment, AGENTIC_SKILL_ROOTS: skillRoots };
    await assert.rejects(
      () => createBlankRuntime(unconfigured),
      /docs-lookup requires "mcp_docs_search", but no static tool and no configured MCP connector provides it/,
    );

    const typoServerId = { ...testEnvironment, AGENTIC_SKILL_ROOTS: skillRoots,
      AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "docz", endpoint: "https://mcp.example/mcp" }]) };
    await assert.rejects(
      () => createBlankRuntime(typoServerId),
      /but no static tool and no configured MCP connector provides it/,
    );
  } finally {
    await rm(skillRoot, { recursive: true, force: true });
  }
});

test("mcpStdioCommandAllowlist threads through createBlankRuntime to the stdio MCP plugin", async () => {
  const environment = { ...testEnvironment, AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "docs", transport: "stdio", command: process.execPath }]) };
  // No dependency at all: fails closed at composition time, before the runtime ever activates —
  // never falls back to trusting the connector's own `command`.
  await assert.rejects(() => createBlankRuntime(environment), /not on the configured allowlist/i);
  const runtime = await createBlankRuntime(environment, { mcpStdioCommandAllowlist: [process.execPath] });
  try {
    assert.ok(runtime);
  } finally {
    await runtime.close();
  }
});

test("the runtime exposes the skills' write preconditions, merged; empty when none declares one; two different orders of one write fail the boot", async () => {
  const skillRoot = await mkdtemp(join(process.cwd(), "apps/harness/test/.precondition-skill-fixture-"));
  const skill = (id: string, after: string) => ["---", `id: ${id}`, "version: 1.0.0", `name: ${id}`, "description: Writes a document after reading.",
    "requiredTools:", "  - mcp_docs_search", "  - mcp_docs_list", "  - mcp_docs_write", "preconditions:", "  mcp_docs_write:", `    after: [${after}]`, "---", "Read, then write."].join("\n");
  const environment = { ...testEnvironment, AGENTIC_SKILL_ROOTS: relative(process.cwd(), skillRoot),
    AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "docs", endpoint: "https://mcp.example/mcp" }]) };
  try {
    const none = await createBlankRuntime(testEnvironment);
    try { assert.deepEqual(none.preconditions, new Map(), "always present"); } finally { await none.close(); }
    await mkdir(join(skillRoot, "a"));
    await mkdir(join(skillRoot, "b"));
    await writeFile(join(skillRoot, "a", "SKILL.md"), skill("docs-a", "mcp_docs_search"));
    await writeFile(join(skillRoot, "b", "SKILL.md"), skill("docs-b", "mcp_docs_search"));
    const runtime = await createBlankRuntime(environment);
    try { assert.deepEqual(runtime.preconditions, new Map([["mcp_docs_write", ["mcp_docs_search"]]]), "one declaration two skills share"); } finally { await runtime.close(); }
    await writeFile(join(skillRoot, "b", "SKILL.md"), skill("docs-b", "mcp_docs_search, mcp_docs_list"));
    await assert.rejects(() => createBlankRuntime(environment),
      /Skills docs-a and docs-b declare different preconditions for mcp_docs_write: after mcp_docs_search \/ after mcp_docs_search, mcp_docs_list/u);
  } finally {
    await rm(skillRoot, { recursive: true, force: true });
  }
});
