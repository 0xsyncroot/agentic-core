import { inPromptOrder } from "@0xsyncroot/contracts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEchoLlmPlugin } from "@0xsyncroot/adapter-echo";
import type { AgentProfileDefinition, LlmAdapter, LlmStreamEvent, SecurityContext, SkillDefinition, ToolDefinition } from "@0xsyncroot/contracts";
import { DefaultAgentLoop, PluginHost, TenantRuntimeRouter } from "@0xsyncroot/core";
import { InMemoryMemoryService, InMemorySessionStore } from "@0xsyncroot/persistence-memory";
import { SYSTEM_PROMPT_CAPABILITY, TOOL_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import {
  InMemoryKnowledgeService,
  StaticSkillCatalog,
  createKnowledgeDocument,
  createKnowledgePlugin,
  createMemoryPlugin,
  createBaseAgentToolPlugins,
  createSkillCatalogPlugin,
  createSystemPromptPlugin,
  createUtilityToolsPlugin,
  createWorkPlanningPlugin,
  createAgentProfilePlugin,
  createSkillToolsPlugin,
} from "@0xsyncroot/plugins-base";

const TEST_SKILLS: readonly SkillDefinition[] = [{
  id: "offline-research", version: "1.0.0", name: "Offline research",
  description: "Research trusted local sources.", requiredTools: ["knowledge_search", "knowledge_read"],
  instructions: "Search and cite trusted sources. Do not assume internet access.",
}];

const security: SecurityContext = {
  tenantId: "tenant-a",
  actorId: "user-a",
  permissions: new Set(["knowledge.read", "memory.read", "skills.read", "utility.calculate", "utility.time", "agent.plan"]),
  correlationId: "agentic-base-test",
  purpose: "test",
};

async function execute(tool: ToolDefinition, args: Record<string, unknown>) {
  return tool.execute(
    {
      callId: crypto.randomUUID(),
      sessionId: "session-a",
      turnId: "turn-a",
      stepId: "step-a",
      arguments: args as never,
      security,
      idempotencyKey: crypto.randomUUID(),
    },
    new AbortController().signal,
  );
}

test("base tool plugins can mount independently without unrelated providers", async () => {
  const host = new PluginHost();
  await host.activate(
    [createUtilityToolsPlugin(), createWorkPlanningPlugin(), createEchoLlmPlugin()],
    { security, verifyArtifact: async () => true },
  );
  const toolIds = host.capabilities.all(TOOL_CAPABILITY).map((tool) => tool.id).sort();
  assert.deepEqual(toolIds, ["calculate", "current_time", "plan_mark", "plan_update"]);
  const planningPrompt = await host.capabilities.all(SYSTEM_PROMPT_CAPABILITY)[0]?.render(security);
  assert.match(planningPrompt ?? "", /plan_update/);
  // Progress goes through the mark, in the step that does the work; at the answer the runtime closes the steps the results show done.
  assert.match(planningPrompt ?? "", /when a step's status changes, send plan_mark with its id, status and a one-sentence outcome \(numbers you observed when completed\), in the same step as the work/u);
  // No step is asked of the model to close the plan: a reply spent on marks alone is a request with no work in it.
  assert.match(planningPrompt ?? "", /Your final answer is a reply with no tool call, planning calls included: when you give it, the runtime closes the plan from the results\./u);
  assert.doesNotMatch(planningPrompt ?? "", /With your final answer|close every plan step/u);
  assert.doesNotMatch(planningPrompt ?? "", /send no plan change before answering/u);
  assert.doesNotMatch(planningPrompt ?? "", /Update the full plan|rewrite its description/u);
  assert.match(planningPrompt ?? "", /a completed step's outcome states the concrete result you observed, including the numbers that matter/u);
  // The runtime's batch contract (core StepFailureStop): known calls go together, and evidence is judged per step, not per call.
  assert.match(planningPrompt ?? "", /Calls whose arguments you already know may go together in one step, in the order they must run: the runtime runs them in that order, stops the ones that change state or ask the user after the first call that does not succeed, and returns every result at once\./u);
  assert.match(planningPrompt ?? "", /A call that depends on a result you have not seen yet waits for the next step\./u);
  assert.match(planningPrompt ?? "", /Mark a step completed only once you have seen the result that completes it, never beside the call that does it\./u);
  assert.match(planningPrompt ?? "", /When a step's results arrive, decide whether they added evidence\. Do not repeat equivalent actions that produce no new information\./u);
  assert.doesNotMatch(planningPrompt ?? "", /After each observation/u);
  await host.shutdown();

  const withoutPlanning = new PluginHost();
  await withoutPlanning.activate(
    [createSystemPromptPlugin(), createUtilityToolsPlugin(), createEchoLlmPlugin()],
    { security, verifyArtifact: async () => true },
  );
  const basePrompt = await withoutPlanning.capabilities.all(SYSTEM_PROMPT_CAPABILITY)[0]?.render(security);
  assert.doesNotMatch(basePrompt ?? "", /work plan|plan_update/i);
  assert.match(basePrompt ?? "", /continue in the same turn until complete or blocked/i);
  assert.match(basePrompt ?? "", /runtime challenge is the confirmation/i);
  assert.match(basePrompt ?? "", /duplicate confirmation/i);
  await withoutPlanning.shutdown();
});

test("static skill catalog rejects duplicate IDs and snapshots required tools", () => {
  const skill = TEST_SKILLS[0]!;
  assert.throws(() => new StaticSkillCatalog([skill, skill]), /duplicate skill/i);
  const loaded = new StaticSkillCatalog([skill]).get(skill.id);
  assert.ok(loaded);
  assert.equal(Object.isFrozen(loaded.requiredTools), true);
});

test("agent profile and available skill metadata are injected independently", async () => {
  const profile: AgentProfileDefinition = {
    id: "finance-assistant", version: "1.0.0", name: "Finance Assistant",
    description: "Supports finance operations.", supportedDomains: ["accounting", "payroll"],
    instructions: "Be concise and introduce the supported scope when asked.",
    contentDigest: "sha256-test-profile",
  };
  const host = new PluginHost();
  await host.activate([
    createSkillCatalogPlugin(new StaticSkillCatalog(TEST_SKILLS)),
    createAgentProfilePlugin(profile),
    createSkillToolsPlugin(),
  ], { security, verifyArtifact: async () => true });
  const prompts = await Promise.all(host.capabilities.all(SYSTEM_PROMPT_CAPABILITY).map((item) => item.render(security)));
  const combined = prompts.join("\n");
  assert.match(combined, /Identity: Finance Assistant/);
  assert.match(combined, /Supported domains: accounting, payroll/);
  assert.match(combined, /offline-research/);
  assert.match(combined, /call skill_load/);
  assert.doesNotMatch(combined, /Do not assume internet access/);
  await host.shutdown();
});

test("skill metadata fails closed when its system-prompt budget is exceeded", async () => {
  const oversized: SkillDefinition = {
    id: "oversized-skill", version: "1.0.0", name: "Oversized",
    description: "x".repeat(32_001), requiredTools: [], instructions: "Do the work.",
  };
  const host = new PluginHost();
  await assert.rejects(host.activate([
    createSkillCatalogPlugin(new StaticSkillCatalog([oversized])),
    createSkillToolsPlugin(),
  ], { security, verifyArtifact: async () => true }), /system-prompt budget/i);
});

test("agent profile content digest is bound to the runtime snapshot", async () => {
  const base = {
    id: "finance-assistant", version: "1.0.0", name: "Finance Assistant",
    description: "Supports finance operations.", supportedDomains: ["finance"],
    instructions: "Be concise.",
  } as const;
  const first = new PluginHost();
  const second = new PluginHost();
  await first.activate([createAgentProfilePlugin({ ...base, contentDigest: "sha256-first" })], {
    security, verifyArtifact: async () => true,
  });
  await second.activate([createAgentProfilePlugin({ ...base, contentDigest: "sha256-second" })], {
    security, verifyArtifact: async () => true,
  });
  assert.notEqual(first.snapshot.id, second.snapshot.id);
  await first.shutdown();
  await second.shutdown();
});

test("custom system-prompt content is bound to the runtime snapshot", async () => {
  const first = new PluginHost();
  const second = new PluginHost();
  await first.activate([createSystemPromptPlugin("First trusted system prompt.")], {
    security, verifyArtifact: async () => true,
  });
  await second.activate([createSystemPromptPlugin("Second trusted system prompt.")], {
    security, verifyArtifact: async () => true,
  });
  assert.notEqual(first.snapshot.id, second.snapshot.id);
  await first.shutdown();
  await second.shutdown();
});

test("default system-prompt behavior has an explicit runtime revision", () => {
  assert.equal(createSystemPromptPlugin().config?.promptRevision, "default-execution-v6");
});

test("the system text is the same for every purpose of one tenant, so a card answer reuses the turn's cached prefix", async () => {
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin()], { security, verifyArtifact: async () => true });
  const [prompt] = host.capabilities.all(SYSTEM_PROMPT_CAPABILITY);
  const turn = await prompt!.render({ ...security, purpose: "sample-app-agent-turn" });
  const interaction = await prompt!.render({ ...security, purpose: "sample-app-agent-interaction" });
  assert.equal(interaction, turn);
  assert.match(turn, /Operate only inside tenant tenant-a\./u);
  assert.doesNotMatch(turn, /sample-app-agent-turn/u);
  await host.shutdown();
});

test("full skill instructions are bound to the runtime snapshot", async () => {
  const first = new PluginHost();
  const second = new PluginHost();
  await first.activate([createSkillCatalogPlugin(new StaticSkillCatalog(TEST_SKILLS))], {
    security, verifyArtifact: async () => true,
  });
  await second.activate([createSkillCatalogPlugin(new StaticSkillCatalog([
    { ...TEST_SKILLS[0]!, instructions: `${TEST_SKILLS[0]!.instructions} Verify every citation.` },
  ]))], { security, verifyArtifact: async () => true });
  assert.notEqual(first.snapshot.id, second.snapshot.id);
  await first.shutdown();
  await second.shutdown();
});

test("offline agent bundle searches cited knowledge and provides safe utilities", async () => {
  const knowledge = new InMemoryKnowledgeService([
    createKnowledgeDocument({
      id: "architecture.md",
      title: "Agentic Architecture",
      content: "# Architecture\n\nThe runtime pins an immutable snapshot.\nMemory is tenant scoped.",
      sourceRef: "docs/architecture.md",
      classification: "internal",
    }),
  ]);
  const host = new PluginHost();
  await host.activate(
    [
      createMemoryPlugin(new InMemoryMemoryService()),
      createKnowledgePlugin(knowledge),
      createSkillCatalogPlugin(new StaticSkillCatalog(TEST_SKILLS)),
      ...createBaseAgentToolPlugins(),
    ],
    { security, verifyArtifact: async () => true },
  );
  const tools = new Map(host.capabilities.all(TOOL_CAPABILITY).map((tool) => [tool.id, tool]));
  const search = tools.get("knowledge_search");
  const calculator = tools.get("calculate");
  const skill = tools.get("skill_load");
  const userInput = tools.get("request_user_input");
  assert.ok(search && calculator && skill && userInput);
  const result = (await execute(search, { query: "immutable snapshot", limit: 5 })) as { hits: Array<{ citation: string }> };
  assert.match(result.hits[0]?.citation ?? "", /docs\/architecture\.md#L/);
  assert.deepEqual(await execute(calculator, { expression: "2 * (3 + 4)^2" }), {
    expression: "2 * (3 + 4)^2",
    result: 98,
  });
  const loaded = (await execute(skill, { skill_id: "offline-research" })) as { instructions: string };
  assert.match(loaded.instructions, /Do not assume internet access/);
  const requested = await execute(userInput, {
    message: "Describe the request", fields: [{ id: "details", label: "Details", type: "multiline", required: true }],
  }) as Record<string, unknown>;
  assert.equal(requested.kind, "interaction-required");
  assert.deepEqual((requested.request as Record<string, unknown>).requestedSchema, {
    type: "object", properties: { details: { title: "Details", type: "string", maxLength: 8_000 } }, required: ["details"],
  });
  // One free question is asked in chat; the tool has no untitled catch-all field to fall back on.
  await assert.rejects(execute(userInput, { message: "Describe the request" }), /requires 1-20 fields; ask a single free question in chat/u);
  await host.shutdown();
});

test("offline research performs search-read-synthesize through the agent loop", async () => {
  const knowledge = new InMemoryKnowledgeService([
    createKnowledgeDocument({
      id: "memory.md",
      title: "Memory Architecture",
      content: "# Memory\n\nCanonical memory uses PostgreSQL. Vector search is optional.",
      sourceRef: "docs/memory.md",
      classification: "internal",
    }),
  ]);
  let invocation = 0;
  const researcher: LlmAdapter = {
    id: "offline-researcher",
    model: "scripted-offline",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      invocation += 1;
      if (invocation === 1) {
        yield {
          type: "final",
          content: null,
          toolCalls: [{ id: "plan-1", name: "plan_update", arguments: JSON.stringify({
            goal: "Find and verify the memory architecture",
            steps: [
              { id: "search", description: "Find relevant evidence", status: "in_progress" },
              { id: "read", description: "Read the cited source", status: "pending" },
            ],
          }) }],
          finishReason: "tool_calls",
        };
      } else if (invocation === 2) {
        yield {
          type: "final",
          content: null,
          toolCalls: [{ id: "search-1", name: "knowledge_search", arguments: '{"query":"canonical memory vector","limit":5}' }],
          finishReason: "tool_calls",
        };
      } else if (invocation === 3) {
        yield {
          type: "final",
          content: null,
          toolCalls: [{ id: "read-1", name: "knowledge_read", arguments: '{"document_id":"memory.md","start_line":1,"end_line":4}' }],
          finishReason: "tool_calls",
        };
      } else if (invocation === 4) {
        yield {
          type: "final",
          content: null,
          toolCalls: [{ id: "plan-2", name: "plan_update", arguments: JSON.stringify({
            goal: "Find and verify the memory architecture",
            steps: [
              { id: "search", description: "Find relevant evidence", status: "completed" },
              { id: "read", description: "Read the cited source", status: "completed" },
            ],
          }) }],
          finishReason: "tool_calls",
        };
      } else {
        yield {
          type: "final",
          content: "PostgreSQL; vector is optional [docs/memory.md#L1-L4].",
          toolCalls: [],
          finishReason: "stop",
        };
      }
    },
  };
  const host = new PluginHost();
  await host.activate(
    [
      createMemoryPlugin(new InMemoryMemoryService()),
      createKnowledgePlugin(knowledge),
      createSkillCatalogPlugin(new StaticSkillCatalog(TEST_SKILLS)),
      ...createBaseAgentToolPlugins(),
      createEchoLlmPlugin(researcher),
    ],
    { security, verifyArtifact: async () => true },
  );
  const runtimeProvider = new TenantRuntimeRouter([{
    tenantId: security.tenantId, agentProfileId: "default", provider: host, routeRevision: "test:offline-research-v1",
  }]);
  const result = await new DefaultAgentLoop(runtimeProvider, new InMemorySessionStore()).runTurn({
    sessionId: "offline-research-session",
    content: "Memory lưu ở đâu?",
    security,
  });
  assert.match(result.content, /docs\/memory\.md#L1-L4/);
  assert.equal(result.events.filter((event) => event.type === "tool/intent").length, 4);
  assert.equal(result.events.filter((event) => event.type === "request/prepared").length, 5);
  // Two proposals from the model, plus the runtime's own terminal close once every step is done
  // and nothing is left pending — the model never sets that state, the ledger does.
  const planEvents = result.events.filter((event) => event.type === "work/plan-updated");
  assert.equal(planEvents.length, 3);
  assert.deepEqual((planEvents[1]!.payload as { steps: { description: string; status: string }[] }).steps.map((step) => [step.description, step.status]), [
    ["Find relevant evidence", "completed"], ["Read the cited source", "completed"],
  ]);
  // How the loop judged its answer is recorded on the turn's end, not in a row per call.
  assert.equal(result.events.some((event) => event.type === "work/decision"), false);
  assert.equal((result.events.find((event) => event.type === "turn/end")?.payload as Record<string, unknown>).decision, "finish");
  await host.shutdown();
});

test("generic loop exposes skill metadata, then lets the model load and apply the matching skill", async () => {
  const knowledge = new InMemoryKnowledgeService([createKnowledgeDocument({
    id: "policy.md", title: "Policy", content: "# Policy\n\nUse authoritative records.",
    sourceRef: "docs/policy.md", classification: "internal",
  })]);
  let invocation = 0;
  const skillAwareModel: LlmAdapter = {
    id: "skill-aware-model", model: "scripted-skill-aware",
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      invocation += 1;
      assert.equal(request.toolChoice, undefined, "skill use must be chosen by the model, not a domain policy");
      const context = request.messages.map((message) => message.content ?? "").join("\n");
      if (invocation === 1) {
        assert.match(context, /offline-research/);
        assert.doesNotMatch(context, /Do not assume internet access/);
        yield { type: "final", content: null, finishReason: "tool_calls", toolCalls: [{
          id: "load-skill", name: "skill_load", arguments: '{"skill_id":"offline-research"}',
        }] };
      } else if (invocation === 2) {
        assert.match(context, /Do not assume internet access/);
        yield { type: "final", content: null, finishReason: "tool_calls", toolCalls: [{
          id: "search-policy", name: "knowledge_search", arguments: '{"query":"authoritative records","limit":3}',
        }] };
      } else {
        yield { type: "final", content: "Đã kiểm tra nguồn nghiệp vụ có thẩm quyền.", finishReason: "stop", toolCalls: [] };
      }
    },
  };
  const host = new PluginHost();
  await host.activate([
    createMemoryPlugin(new InMemoryMemoryService()),
    createKnowledgePlugin(knowledge),
    createSkillCatalogPlugin(new StaticSkillCatalog(TEST_SKILLS)),
    ...createBaseAgentToolPlugins(),
    createEchoLlmPlugin(skillAwareModel),
  ], { security, verifyArtifact: async () => true });
  const result = await new DefaultAgentLoop(new TenantRuntimeRouter([{
    tenantId: security.tenantId, agentProfileId: "default", provider: host, routeRevision: "test:skill-aware-v1",
  }]), new InMemorySessionStore()).runTurn({ sessionId: "skill-aware-session", content: "Kiểm tra policy", security });
  const invokedTools = result.events.filter((event) => event.type === "tool/intent")
    .map((event) => (event.payload as Record<string, unknown>).toolId);
  assert.deepEqual(invokedTools, ["skill_load", "knowledge_search"]);
  assert.equal(result.events.some((event) => event.type === "turn/control-decision"), false);
  assert.equal(result.content, "Đã kiểm tra nguồn nghiệp vụ có thẩm quyền.");
  await host.shutdown();
});

test("a profile's preloaded skills become operating procedure instead of a lookup the model may skip", async () => {
  const skill = TEST_SKILLS[0]!;
  const profile: AgentProfileDefinition = {
    id: "finance-assistant", version: "1.0.0", name: "Finance Assistant",
    description: "Supports finance operations.", supportedDomains: ["payroll"],
    instructions: "Be concise.", contentDigest: "sha256-preload-profile",
    preloadSkills: [skill.id],
  };
  const catalog = new StaticSkillCatalog(TEST_SKILLS);
  const host = new PluginHost();
  await host.activate([
    createSkillCatalogPlugin(catalog),
    createAgentProfilePlugin(profile, catalog),
  ], { security, verifyArtifact: async () => true });
  const combined = (await Promise.all(
    host.capabilities.all(SYSTEM_PROMPT_CAPABILITY).map((item) => item.render(security)),
  )).join("\n");
  assert.match(combined, /Identity: Finance Assistant/);
  assert.ok(combined.includes(skill.instructions), "the full skill procedure is present from the first step");
  assert.match(combined, /already loaded for you/);
  await host.shutdown();

  // Without the catalog the profile still boots, but the skill is not preloaded.
  const bare = new PluginHost();
  await bare.activate([createAgentProfilePlugin(profile)], { security, verifyArtifact: async () => true });
  const bareCombined = (await Promise.all(
    bare.capabilities.all(SYSTEM_PROMPT_CAPABILITY).map((item) => item.render(security)),
  )).join("\n");
  assert.equal(bareCombined.includes(skill.instructions), false);
  await bare.shutdown();

  // An unknown id is a composition-time failure, never a silently ignored declaration.
  assert.throws(
    () => createAgentProfilePlugin({ ...profile, preloadSkills: ["org.missing"] }, catalog),
    /preloads an unknown skill: org.missing/,
  );
});

test("a profile preloads several skills and is stopped at boot when the always-on budget is blown", async () => {
  const first = TEST_SKILLS[0]!;
  const second: SkillDefinition = {
    id: "expense-review", version: "2.0.0", name: "Expense review",
    description: "Check expense claims.", requiredTools: [],
    instructions: "Verify each claim against its receipt before approving.",
  };
  const catalog = new StaticSkillCatalog([first, second]);
  const profile: AgentProfileDefinition = {
    id: "multi-skill", version: "1.0.0", name: "Multi", description: "Two procedures.",
    supportedDomains: [], instructions: "Be concise.", contentDigest: "sha256-multi",
    preloadSkills: [first.id, second.id],
  };
  const host = new PluginHost();
  await host.activate([createSkillCatalogPlugin(catalog), createAgentProfilePlugin(profile, catalog)],
    { security, verifyArtifact: async () => true });
  const combined = (await Promise.all(
    host.capabilities.all(SYSTEM_PROMPT_CAPABILITY).map((item) => item.render(security)),
  )).join("\n");
  assert.ok(combined.includes(first.instructions) && combined.includes(second.instructions),
    "every preloaded procedure is present, not just the first");
  assert.match(combined, /2 skills are already loaded/);
  assert.match(combined, /load on demand/, "the rest of the catalogue stays reachable");
  await host.shutdown();

  // Preloading is carried on every model step, so an oversized set must fail at composition
  // time rather than quietly crowding out the conversation later.
  const oversized: SkillDefinition = { ...second, id: "oversized", instructions: "x".repeat(80_000) };
  assert.throws(
    () => createAgentProfilePlugin({ ...profile, preloadSkills: [oversized.id] }, new StaticSkillCatalog([oversized])),
    /over the 64000-byte budget/,
  );
});

test("a profile's closing instructions are the last thing in the system prompt, whatever was registered after the profile", async () => {
  const profile: AgentProfileDefinition = {
    id: "closing", version: "1.0.0", name: "Closing", description: "Has a closing section.",
    supportedDomains: [], instructions: "Be concise.", contentDigest: "sha256-closing",
    closingInstructions: "Reason in the user's language.",
  };
  const host = new PluginHost();
  // The base prompt registers AFTER the profile, as it does in a real composition.
  await host.activate([createAgentProfilePlugin(profile), createSystemPromptPlugin()], { security, verifyArtifact: async () => true });
  const providers = inPromptOrder(host.capabilities.all(SYSTEM_PROMPT_CAPABILITY));
  const text = (await Promise.all(providers.map((item) => item.render(security)))).join("\n\n");
  assert.ok(text.startsWith("# Agent profile"), "the profile itself still opens the prompt");
  assert.ok(text.trimEnd().endsWith("Reason in the user's language."),
    "measured on a real model: the same sentence was followed one time in five near the top of a long prompt and nine in ten as its last line");
  assert.ok(text.indexOf("Be concise.") < text.indexOf("Never end with an offer") && text.indexOf("Never end with an offer") < text.indexOf("# Before you begin"));
  assert.ok(text.indexOf("# Before you begin") < text.indexOf("Keep working until everything") && text.indexOf("Keep working until everything") < text.indexOf("Reason in the user's language."),
    "the platform's persistence line closes the prompt, just before the profile's own last words");
  await host.shutdown();
});

test("the always-on budget is counted in bytes, so non-Latin instructions are charged what they cost", () => {
  // The reason the budget is denominated in bytes. These two skills are the same length by
  // `.length` — the unit a character budget measures — but one costs half again as much to send.
  // Under the old character budget the second passed while being materially more expensive, which
  // is the kind of wrong that shows up as cost and latency rather than as an error.
  const latin = "a".repeat(25_000);
  const vietnamese = "ệ".repeat(25_000);
  assert.equal(latin.length, vietnamese.length, "the two samples must be equal by character count");
  assert.ok(Buffer.byteLength(vietnamese, "utf8") > Buffer.byteLength(latin, "utf8") * 2.5,
    "the Vietnamese sample should cost far more in bytes than the Latin one");

  const profile: AgentProfileDefinition = {
    id: "byte-budget", version: "1.0.0", name: "Bytes", description: "One procedure.",
    supportedDomains: [], instructions: "Be concise.", contentDigest: "sha256-bytes",
    preloadSkills: ["sized"],
  };
  const skill = (instructions: string): SkillDefinition => ({
    id: "sized", version: "1.0.0", name: "Sized", description: "Sized.", requiredTools: [], instructions,
  });

  // Same character count, opposite verdicts — which is the whole argument for the unit.
  assert.doesNotThrow(
    () => createAgentProfilePlugin(profile, new StaticSkillCatalog([skill(latin)])),
    "25,000 Latin characters fit the byte budget",
  );
  assert.throws(
    () => createAgentProfilePlugin(profile, new StaticSkillCatalog([skill(vietnamese)])),
    /over the 64000-byte budget/,
    "the same 25,000 characters in Vietnamese do not, and a character budget could not tell",
  );
  // And the error reports both numbers, because whoever hits it was reading a character count.
  assert.throws(
    () => createAgentProfilePlugin(profile, new StaticSkillCatalog([skill(vietnamese)])),
    /preloads 75\d{3} bytes \(25\d{3} characters\)/u,
    "the message must report bytes and characters together",
  );
});
