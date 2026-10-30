import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import {
  CAPABILITIES, type LlmAdapter, type LlmStreamEvent, type PreparedLlmRequest, type SecurityContext, type SkillCatalog, type SystemPromptTurn, type ToolAuthorizationInput,
  type ToolDefinition, type ToolExecutionPolicy,
} from "@0xsyncroot/contracts";
import { LLM_CAPABILITY, SYSTEM_PROMPT_CAPABILITY, TOOL_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { createBlankRuntime, type BlankRuntime } from "../src/bootstrap.js";
import { bindToolOffers, offerableToolIds } from "../src/composition/required-prompt-budget.js";
import { SealableSkillCatalog } from "../src/composition/skill-catalog-view.js";

const SENT_TOOL = "test_sent_tool";
const OTHER_TOOL = "test_other_tool";
/** Larger than the 60,000-character startup budget on its own. */
const OVERSIZED = "x".repeat(61_000);

const tool = (id: string): ToolDefinition => ({
  id, version: "1.0.0", description: id, inputSchema: { type: "object", additionalProperties: false }, outputSchema: {},
  requiredPermissions: [], sideEffect: "none", timeoutMs: 1_000, execute: async () => ({ ok: true }),
});
const allow = async (input: ToolAuthorizationInput) => ({
  decisionId: "d", outcome: "allow" as const, policyRevision: "r", reason: `allow ${input.tool.id}`, actionDigest: "a",
});
/** Offers everything it is given; `declaresFalse` is what it tells the startup check. Without the list it has no declaration at all. */
const policy = (declaresFalse?: readonly string[]): ToolExecutionPolicy => ({
  discover: async (tools) => tools,
  authorize: allow,
  ...(declaresFalse ? { offersInSomeTurn: (candidate: ToolDefinition) => !declaresFalse.includes(candidate.id) } : {}),
});
const security: SecurityContext = {
  tenantId: "tenant", actorId: "actor", permissions: new Set(["memory.read"]), correlationId: "c", purpose: "test",
  authentication: { issuer: "test", subject: "actor", assurance: "user" }, authorizedAgentProfiles: ["budget-agent"],
};

function toolPlugin(): PluginDescriptor {
  return {
    trustTier: "first-party-domain",
    manifest: {
      manifestVersion: 1, id: "io.syncroot.product.budget-tools", version: "1.0.0", publisher: "Product Test", coreApi: "^1.0.0",
      artifact: { digest: "sha256:budget-tools", signature: "test-product-signature" }, requires: {},
      provides: { [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } }, permissions: {},
    },
    plugin: {
      validate: async () => ({ valid: true }),
      activate: async (context) => {
        const registered = [context.registrations.provide(TOOL_CAPABILITY, tool(SENT_TOOL)), context.registrations.provide(TOOL_CAPABILITY, tool(OTHER_TOOL))];
        return { dispose: async () => { for (const registration of registered.reverse()) await registration.dispose(); } };
      },
    },
  };
}

/** Replaces the mounted model's `stream`; `inner` is the model it replaces. */
function withStream(stream: (request: PreparedLlmRequest, signal: AbortSignal, inner: LlmAdapter) => AsyncIterable<LlmStreamEvent>): (descriptor: PluginDescriptor) => PluginDescriptor {
  return (descriptor) => ({
    ...descriptor,
    plugin: {
      ...descriptor.plugin,
      activate: (context) => descriptor.plugin.activate({
        ...context,
        registrations: {
          provide: (token, value) => context.registrations.provide(token, token.id === LLM_CAPABILITY.id
            ? Object.assign(Object.create(value as object), { stream: (request: PreparedLlmRequest, signal: AbortSignal) => stream(request, signal, value as LlmAdapter) })
            : value),
        },
      }),
    },
  });
}

/** Wraps the model so a test can see the tools each model call was offered. */
function recordTools(seen: string[][]): (descriptor: PluginDescriptor) => PluginDescriptor {
  return withStream((request, signal, inner) => { seen.push(request.tools.map((entry) => entry.name)); return inner.stream(request, signal); });
}

/**
 * A runtime whose one preloaded skill (the profile's only skill) has `instructions` and `requiredTools`. The skill root has to
 * sit inside the workspace; the profile file does not.
 */
async function bootWith(skill: { readonly requiredTools: readonly string[]; readonly instructions: string; readonly preload?: string },
  dependencies: Parameters<typeof createBlankRuntime>[1] = {}, extra: NodeJS.ProcessEnv = {},
  /** Further skills, not preloaded and needing no tool: loadable on demand. */
  loadable: readonly { readonly id: string; readonly instructions: string }[] = []) {
  const skillRoot = await mkdtemp(join(process.cwd(), "apps/harness/test/.budget-skill-fixture-"));
  const profileRoot = await mkdtemp(join(tmpdir(), "gateway-harness-budget-"));
  try {
    await writeFile(join(skillRoot, "SKILL.md"), ["---", "id: budget.skill", "version: 1.0.0", "name: Budget skill", "description: A skill under test.",
      skill.requiredTools.length ? `requiredTools:\n${skill.requiredTools.map((id) => `  - ${id}`).join("\n")}` : "requiredTools: []", "---", skill.instructions].join("\n"));
    for (const other of loadable) {
      await mkdir(join(skillRoot, other.id));
      await writeFile(join(skillRoot, other.id, "SKILL.md"), ["---", `id: ${other.id}`, "version: 1.0.0", `name: ${other.id}`, "description: Another skill under test.",
        "requiredTools: []", "---", other.instructions].join("\n"));
    }
    const file = join(profileRoot, "AGENT.md");
    await writeFile(file, `---\nid: budget-agent\nversion: 1.0.0\nname: Budget Agent\ndescription: Under test.\npreloadSkills:\n  - ${skill.preload ?? "budget.skill"}\n---\nStay in scope.\n`);
    const environment: NodeJS.ProcessEnv = { AGENTIC_ENABLE_DIAGNOSTIC_TOOLS: "false", AGENTIC_KNOWLEDGE_ROOTS: "", AGENTIC_SKILL_ROOTS: relative(process.cwd(), skillRoot),
      AGENTIC_AGENT_PROFILE_FILE: file, ...extra };
    return await createBlankRuntime(environment, { additionalPlugins: { descriptors: [toolPlugin()], verifyArtifact: async () => true }, ...dependencies });
  } finally {
    await rm(skillRoot, { recursive: true, force: true });
    await rm(profileRoot, { recursive: true, force: true });
  }
}

const startupBudget = /Required system prompts use \d+ characters and exceed the 60000-character startup budget/;

test("offerable tools are the mounted tools the policy does not decline, plus the tools a contextual source's namespace owns", () => {
  const mounted = [tool(SENT_TOOL), tool(OTHER_TOOL)];
  const skills = [{ requiredTools: [SENT_TOOL, "mcp_docs_search"] }, { requiredTools: ["mcp_typo_search", "unmounted_tool"] }];
  const input = { mounted, contextualSourceIds: ["mcp_docs"], skills };
  assert.deepEqual([...offerableToolIds({ ...input, policy: policy() })].sort(), [OTHER_TOOL, SENT_TOOL, "mcp_docs_search"].sort(),
    "a policy with no declaration is counted as offering every mounted tool; only a tool in a contextual namespace is added");
  assert.deepEqual([...offerableToolIds({ ...input, policy: policy([SENT_TOOL]) })].sort(), [OTHER_TOOL, "mcp_docs_search"].sort());
  assert.deepEqual([...offerableToolIds({ ...input, policy: policy([SENT_TOOL, OTHER_TOOL]) })], ["mcp_docs_search"],
    "a declaration never removes a contextual source's tool: its list is unknowable at boot");
});

test("a tool the policy declares it never offers is dropped from discovery even when the policy's own discover returns it", async () => {
  const declared = policy([SENT_TOOL]);
  const tools = [tool(SENT_TOOL), tool(OTHER_TOOL)];
  assert.deepEqual((await declared.discover(tools, { security, runtime: {} as never })).map((entry) => entry.id), [SENT_TOOL, OTHER_TOOL],
    "the fixture is a policy that contradicts itself");
  const bound = bindToolOffers(declared);
  assert.deepEqual((await bound.discover(tools, { security, runtime: {} as never })).map((entry) => entry.id), [OTHER_TOOL]);
  assert.equal(bound.offersInSomeTurn?.(tool(SENT_TOOL)), false);
  assert.equal(bound.offersInSomeTurn?.(tool(OTHER_TOOL)), true);
  const undeclared = bindToolOffers(policy());
  assert.deepEqual((await undeclared.discover(tools, { security, runtime: {} as never })).map((entry) => entry.id), [SENT_TOOL, OTHER_TOOL]);
  assert.equal(undeclared.offersInSomeTurn?.(tool(SENT_TOOL)), true, "absent is true");
  assert.equal((await bound.authorize({ tool: tool(OTHER_TOOL) } as ToolAuthorizationInput)).outcome, "allow");
});

test("a turn is never offered a tool the policy declared away, so the boot count and the turn cannot disagree", async () => {
  const seen: string[][] = [];
  const runtime = await bootWith({ requiredTools: [], instructions: "Short." },
    { toolExecutionPolicyFactory: () => policy([SENT_TOOL]), decorateLlmPlugin: recordTools(seen) });
  try {
    await runtime.agent.runTurn({ sessionId: "budget-binding", content: "hello", security });
    assert.ok(seen.length > 0, "the model was called");
    for (const offered of seen) {
      assert.ok(offered.includes(OTHER_TOOL), offered.join(","));
      assert.ok(!offered.includes(SENT_TOOL), offered.join(","));
    }
  } finally { await runtime.close(); }
});

test("boot fails on an oversized skill that a turn sends: its required tool is offered", async () => {
  await assert.rejects(bootWith({ requiredTools: [SENT_TOOL], instructions: OVERSIZED }), startupBudget);
  await assert.rejects(bootWith({ requiredTools: [SENT_TOOL], instructions: OVERSIZED }, { toolExecutionPolicyFactory: () => policy([OTHER_TOOL]) }), startupBudget,
    "declaring away a different tool changes nothing for this skill");
});

test("boot fails on an oversized skill with no required tools, whatever the policy declares: such a skill is always sent", async () => {
  await assert.rejects(bootWith({ requiredTools: [], instructions: OVERSIZED }, { toolExecutionPolicyFactory: () => policy([SENT_TOOL, OTHER_TOOL]) }), startupBudget);
});

test("boot counts as today when the policy has no declaration, and does not count a skill whose required tool no turn is offered", async () => {
  await assert.rejects(bootWith({ requiredTools: [SENT_TOOL], instructions: OVERSIZED }, { toolExecutionPolicyFactory: () => policy() }), startupBudget);
  const runtime = await bootWith({ requiredTools: [SENT_TOOL], instructions: OVERSIZED }, { toolExecutionPolicyFactory: () => policy([SENT_TOOL]) });
  try {
    assert.ok(runtime.requiredPrompt.chars <= runtime.requiredPrompt.budget, `${runtime.requiredPrompt.chars} of ${runtime.requiredPrompt.budget}`);
    assert.ok(!runtime.requiredPrompt.text.includes(OVERSIZED.slice(0, 100)), "the measured text is the text of a turn that is not sent the skill");
  } finally { await runtime.close(); }
});

test("boot counts a skill whose tools live in a contextual connector's namespace, whatever the policy declares", async () => {
  const connector = { AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "docs", endpoint: "https://mcp.example/mcp" }]) };
  await assert.rejects(bootWith({ requiredTools: ["mcp_docs_search"], instructions: OVERSIZED },
    { toolExecutionPolicyFactory: () => policy([SENT_TOOL, OTHER_TOOL]) }, connector), startupBudget);
  const small = await bootWith({ requiredTools: ["mcp_docs_search"], instructions: "Short." }, {}, connector);
  try { assert.match(small.requiredPrompt.text, /Short\./u, "a small skill of the connector is in the measured text"); } finally { await small.close(); }
});

/** What a turn reads of a booted runtime's skills: the rendered system prompt, `skill_list`, `skill_load`, the profile's lists. */
async function catalogSurfaces(runtime: BlankRuntime, turn?: SystemPromptTurn) {
  const prompts = runtime.host.capabilities.all(SYSTEM_PROMPT_CAPABILITY);
  const tools = runtime.host.capabilities.all(TOOL_CAPABILITY);
  const run = async (toolId: string, args: Record<string, string>) =>
    await tools.find((entry) => entry.id === toolId)!.execute({ arguments: args } as never, new AbortController().signal) as Record<string, unknown>;
  return {
    text: (await Promise.all(prompts.map((prompt) => prompt.render(security, turn)))).join("\n\n"),
    listed: ((await run("skill_list", {})).skills as { id: string }[]).map((entry) => entry.id),
    load: (skillId: string) => run("skill_load", { skill_id: skillId }),
    profile: prompts.find((prompt) => prompt.id === "io.syncroot.base.agent-profile")!,
  };
}

test("a skill that needs a tool the policy never offers leaves the catalog every turn reads; declared offered, it stays", async () => {
  const declined = await bootWith({ requiredTools: [SENT_TOOL], instructions: "Budget rules." }, { toolExecutionPolicyFactory: () => policy([SENT_TOOL]) });
  try {
    for (const turn of [undefined, { offeredToolIds: new Set([OTHER_TOOL]) }, { offeredToolIds: new Set([OTHER_TOOL, SENT_TOOL]) }]) {
      const surfaces = await catalogSurfaces(declined, turn);
      assert.equal(surfaces.text.includes("Budget rules."), false, "no preloaded procedure");
      assert.equal(surfaces.text.includes("budget.skill"), false, "not listed, so no order to load it");
      assert.deepEqual(surfaces.listed, []);
      assert.equal(surfaces.profile.preloadedSkills, undefined);
      assert.equal(surfaces.profile.loadableSkills, undefined);
      assert.equal(surfaces.profile.skillLoader, undefined);
    }
    assert.deepEqual(await (await catalogSurfaces(declined)).load("budget.skill"),
      { error: "skill_unavailable", skillId: "budget.skill", reason: "The skill's required tools are not offered in this deployment, so it cannot be followed here; do not load it again, and go on with the tools and skills listed in this session." });
    assert.deepEqual(await (await catalogSurfaces(declined)).load("budget.unknown"), { error: "skill_not_found" });
    assert.equal(declined.requiredPrompt.text.includes("budget.skill"), false, "the startup check measured the sealed catalog");
  } finally { await declined.close(); }
  const offered = await bootWith({ requiredTools: [SENT_TOOL], instructions: "Budget rules." }, { toolExecutionPolicyFactory: () => policy([OTHER_TOOL]) });
  try {
    const surfaces = await catalogSurfaces(offered, { offeredToolIds: new Set([SENT_TOOL]) });
    assert.match(surfaces.text, /Budget rules\./u);
    assert.deepEqual(surfaces.listed, ["budget.skill"]);
    assert.deepEqual(surfaces.profile.preloadedSkills?.map((entry) => entry.id), ["budget.skill"]);
  } finally { await offered.close(); }
});

test("a skill of a contextual connector is never left out of the catalog: absent from a turn, it stays listed and loadable", async () => {
  const connector = { AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "docs", endpoint: "https://mcp.example/mcp" }]) };
  const runtime = await bootWith({ requiredTools: ["mcp_docs_search"], instructions: "Docs rules." },
    { toolExecutionPolicyFactory: () => policy([SENT_TOOL, OTHER_TOOL]) }, connector);
  try {
    const down = await catalogSurfaces(runtime, { offeredToolIds: new Set([OTHER_TOOL]) });
    assert.equal(down.text.includes("Docs rules."), false, "the connector is down this turn: the procedure is left out of this turn");
    assert.match(down.text, /call skill_load/u, "and listed as loadable");
    assert.deepEqual(down.listed, ["budget.skill"]);
    assert.equal((await down.load("budget.skill")).instructions, "Docs rules.");
    assert.match((await catalogSurfaces(runtime, { offeredToolIds: new Set(["mcp_docs_search"]) })).text, /Docs rules\./u);
  } finally { await runtime.close(); }
});

test("an unknown preload id still fails the boot: preloads are checked against the whole catalog", async () => {
  await assert.rejects(bootWith({ requiredTools: [], instructions: "Short.", preload: "budget.unknown" }), /preloads an unknown skill: budget\.unknown/u);
});

test("the catalog view is read only once sealed, sealed once, and keeps the whole catalog's revision", () => {
  const full: SkillCatalog = {
    revision: "sha256-full",
    list: () => [{ id: "a", version: "1", name: "a", description: "a", requiredTools: [] }, { id: "b", version: "1", name: "b", description: "b", requiredTools: ["t"] }],
    get: (id) => ({ id, version: "1", name: id, description: id, requiredTools: [], instructions: id }),
  };
  const view = new SealableSkillCatalog(full);
  assert.equal(view.revision, "sha256-full");
  assert.throws(() => view.list(), /read before the composition sealed it/u);
  assert.throws(() => view.get("a"), /read before the composition sealed it/u);
  view.seal(new Set(["b"]));
  assert.deepEqual(view.list().map((entry) => entry.id), ["a"]);
  assert.equal(view.get("b"), undefined);
  assert.equal(view.get("a")?.instructions, "a");
  assert.throws(() => view.seal(new Set()), /already sealed/u);
});

/**
 * A model that loads `skillIds` in its first step offered `skill_load`, then answers; every request it is sent is kept as JSON.
 * Other model calls of the turn (judges, summaries) are answered and kept the same way.
 */
function loadingModel(skillIds: readonly string[], sent: string[]): (descriptor: PluginDescriptor) => PluginDescriptor {
  let loaded = false;
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  return withStream(async function* (request) {
    sent.push(JSON.stringify(request.messages));
    if (!loaded && request.tools.some((entry) => entry.name === "skill_load")) {
      loaded = true;
      const toolCalls = skillIds.map((skillId, index) => ({ id: `load-${index}`, name: "skill_load", arguments: JSON.stringify({ skill_id: skillId }) }));
      yield { type: "final", content: null, toolCalls, finishReason: "tool_calls", status: "completed", usage };
      return;
    }
    yield { type: "final", content: "Done.", toolCalls: [], finishReason: "stop", status: "completed", usage };
  });
}

test("a turn that loads a skill the composition left out gets skill_unavailable and no closing of it; a loaded skill's closing still comes", async () => {
  const sent: string[] = [];
  const runtime = await bootWith({ requiredTools: [SENT_TOOL], instructions: "Budget rules.\n<!-- closing -->\nBUDGET LAST" },
    { toolExecutionPolicyFactory: () => policy([SENT_TOOL]), decorateLlmPlugin: loadingModel(["budget.skill", "budget.report"], sent) }, {},
    [{ id: "budget.report", instructions: "Report rules.\n<!-- closing -->\nREPORT LAST" }]);
  try {
    const result = await runtime.agent.runTurn({ sessionId: "excluded-closing", content: "hello", security });
    assert.equal(result.outcome, "completed", JSON.stringify(result));
    const after = sent.slice(1);
    assert.ok(after.some((request) => request.includes("skill_unavailable")), "the model was told the left-out skill is unavailable");
    assert.ok(after.some((request) => request.includes("REPORT LAST")), "core's closing path ran on the journal: the loaded skill's closing is sent");
    assert.equal(sent.some((request) => request.includes("BUDGET LAST")), false, "the left-out skill's load closes nothing, in no request");
  } finally { await runtime.close(); }
});
