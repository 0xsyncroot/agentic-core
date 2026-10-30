import assert from "node:assert/strict";
import test from "node:test";
import { AgenticError, CAPABILITIES, type JsonValue, type JudgmentPort, type LlmAdapter, type LlmStreamEvent, type PreparedLlmRequest, type JudgmentRequest, type MemoryService, type ToolDefinition } from "@0xsyncroot/contracts";
import { DefaultAgentLoop, InMemoryToolResultSpool } from "@0xsyncroot/core";
import { BaseMemoryContextPolicy, createMemoryPlugin } from "@0xsyncroot/plugins-base";
import { JUDGMENT_CAPABILITY, SYSTEM_PROMPT_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { activeHost, answer, call, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/** The seams inside a real turn: what the judge said reaches the model's next step, and is journaled. */
function plugin(id: string, provides: string, activate: PluginDescriptor["plugin"]["activate"]): PluginDescriptor {
  return {
    trustTier: "platform-core",
    manifest: { manifestVersion: 1, id: `io.syncroot.test.${id}`, version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
      artifact: { digest: `builtin:${id}`, signature: "test" }, requires: {},
      provides: { [provides]: { version: "1.0.0", cardinality: provides === CAPABILITIES.judgment ? "single" : "multi" } }, permissions: {} },
    plugin: { validate: async () => ({ valid: true }), activate },
  };
}
const judgment = (judge: (request: JudgmentRequest) => Record<string, unknown>): PluginDescriptor => plugin("judgment", CAPABILITIES.judgment, async (context) => {
  const port: JudgmentPort = { providerId: "fake", model: "fake", judge: async (request) => ({ modelId: "fake", answers: judge(request) as never }) };
  context.registrations.provide(JUDGMENT_CAPABILITY, port);
  return { dispose: () => undefined };
});
const screenTool: ToolDefinition = {
  id: "ui_open", version: "1", description: "open", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {}, observes: { channel: "screen", condense: () => ({ screen: "x" }) },
  execute: async () => ({ screen: "payroll", rows: "placeholder" }) as JsonValue,
};

test("observation review on: the loading warning sits beside the tool result the model reads next, and the judgment is journaled", async () => {
  const { adapter, requests } = scriptedModel([call("open", "ui_open", { label: "Tháng 8" }), answer("Xong.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("ui", [screenTool]), judgment((request) => ({
    ...("screen" in request.questions ? { screen: { type: "choice", choice: "loading", confidence: 0.97, probabilities: { loading: 0.97 } } } : {}),
    ...("reached" in request.questions ? { reached: { type: "noul", noul: 0.99 } } : {}),
    ...("injection" in request.questions ? { injection: { type: "noul", noul: 0 } } : {}),
  }))]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { judgmentSeams: { observationReview: "on", observationState: "on" } })
      .runTurn({ sessionId: `seam-${Math.random()}`, content: "đếm bảng lương tháng 8", security: security() });
    const toolMessage = requests[1]!.messages.find((message) => message.role === "tool");
    assert.match(toolMessage!.content ?? "", /still loading/u);
    assert.match(toolMessage!.content ?? "", /"rows":"placeholder"/u, "the tool's own result is untouched");
    const judged = result.events.filter((event) => event.type === "judgment/classified").map((event) => (event.payload as { seam: string }).seam);
    assert.deepEqual(judged, ["observation-review"]);
  } finally { await host.shutdown(); }
});

test("skill relevance on: a conditional skill the request does not need is left out of that turn's system prompt", async () => {
  const promptPlugin = plugin("prompt", CAPABILITIES.systemPrompt, async (context) => {
    context.registrations.provide(SYSTEM_PROMPT_CAPABILITY, {
      id: "test.skills", conditionalSkills: [{ id: "x.payroll", name: "Payroll", description: "payroll writes" }],
      render: async (_security, turn) => (turn?.skippedSkills?.has("x.payroll") ? "CORE ONLY" : "CORE + PAYROLL SKILL"),
    });
    return { dispose: () => undefined };
  });
  const run = async (needed: number) => {
    const { adapter, requests } = scriptedModel([answer("Xong.")]);
    const { host, router } = await activeHost(adapter, [promptPlugin, judgment(() => ({ needed: { type: "noul", noul: needed } }))]);
    try {
      await new DefaultAgentLoop(router, new SpyStore(), {}, { judgmentSeams: { skillRelevance: "on" } })
        .runTurn({ sessionId: `skill-${Math.random()}`, content: "phụ cấp nhập ở đâu", security: security() });
      return requests[0]!.messages.find((message) => message.role === "system")!.content ?? "";
    } finally { await host.shutdown(); }
  };
  assert.match(await run(0.02), /CORE ONLY/u);
  assert.match(await run(0.6), /CORE \+ PAYROLL SKILL/u, "doubt keeps the skill");
});

test("result relevance is asked only once the context fills half the window; a small turn makes no such call", async () => {
  // Asked before every step, the judge would be called on every step of a long turn while the context is far from full.
  const pages = (size: number): ToolDefinition => ({
    id: "read_page", version: "1", description: "read", requiredPermissions: [], sideEffect: "none", timeoutMs: 100, retainResult: true,
    inputSchema: { type: "object" }, outputSchema: {}, execute: async (invocation) => ({ page: (invocation.arguments as { page: number }).page, rows: "x".repeat(size) }) as JsonValue,
  });
  const run = async (size: number, maxContextChars: number) => {
    const { adapter } = scriptedModel([1, 2, 3, 4].map((page) => call(`p${page}`, "read_page", { page })).concat(answer("Xong.")));
    const { host, router } = await activeHost(adapter, [toolPlugin("pages", [pages(size)]), judgment(() => ({ needed: { type: "noul", noul: 0.9 } }))]);
    try {
      const result = await new DefaultAgentLoop(router, new SpyStore(), { maxContextChars }, { judgmentSeams: { resultRelevance: "on" }, toolResultSpool: new InMemoryToolResultSpool() })
        .runTurn({ sessionId: `pressure-${Math.random()}`, content: "đọc hết các trang", security: security() });
      return result.events.filter((event) => event.type === "judgment/classified" && (event.payload as { seam: string }).seam === "result-relevance").length;
    } finally { await host.shutdown(); }
  };
  assert.equal(await run(200, 1_000_000), 0, "a context far under the window: nothing to shorten, nothing asked");
  assert.ok(await run(5_000, 20_000) > 0, "past half the window the earlier results are judged");
});

test("a load-on-demand skill the judge finds the request needs is named at the end of the first step; doubt or an earlier load names none", async () => {
  // A closing line that names a tool instead of the procedure keeps the model from loading the skill the request needs.
  const promptPlugin = plugin("prompt", CAPABILITIES.systemPrompt, async (context) => {
    context.registrations.provide(SYSTEM_PROMPT_CAPABILITY, { id: "test.loadable", loadableSkills: [{ id: "x.recon", name: "reconcile", description: "compare two payrolls" }], skillLoader: { toolId: "skill_load", argument: "skill_id" }, render: async () => "CORE" });
    return { dispose: () => undefined };
  });
  const firstStep = async (needed: number, sessionId = `suggest-${Math.random()}`, store = new SpyStore()) => {
    const { adapter, requests } = scriptedModel([answer("Xong.")]);
    const { host, router } = await activeHost(adapter, [promptPlugin, judgment(() => ({ fits: { type: "noul", noul: needed } }))]);
    try {
      await new DefaultAgentLoop(router, store, {}, { judgmentSeams: { skillRelevance: "on" } }).runTurn({ sessionId, content: "đối soát bảng lương", security: security() });
      return requests[0]!.messages.map((message) => message.content ?? "").join("\n");
    } finally { await host.shutdown(); }
  };
  assert.match(await firstStep(0.95), /Runtime check: the skill "reconcile" \(x\.recon\) matches this request and is not loaded\. Load it with skill_load before planning/u);
  assert.doesNotMatch(await firstStep(0.5), /skill "reconcile"/u, "doubt names nothing");
  // Only the first step carries it: once the model has answered that step, "not loaded" would be stale.
  const { adapter, requests } = scriptedModel([call("l", "skill_load", { skill_id: "x.recon" }), answer("Xong.")]);
  const { host, router } = await activeHost(adapter, [promptPlugin, judgment(() => ({ fits: { type: "noul", noul: 0.95 } }))]);
  try {
    await new DefaultAgentLoop(router, new SpyStore(), {}, { judgmentSeams: { skillRelevance: "on" } }).runTurn({ sessionId: `suggest-once-${Math.random()}`, content: "đối soát bảng lương", security: security() });
    assert.match(requests[0]!.messages.map((message) => message.content ?? "").join("\n"), /skill "reconcile"/u);
    assert.doesNotMatch(requests[1]!.messages.map((message) => message.content ?? "").join("\n"), /skill "reconcile"/u, "gone after the first step");
  } finally { await host.shutdown(); }
});

test("the skill-suggestion judge weighs the request against every skill the agent has, one question per loadable skill", async () => {
  // Asked about one skill alone, the judge scores an unrelated lookup as fitting it: the other skills belong in the state.
  const promptPlugin = plugin("prompt", CAPABILITIES.systemPrompt, async (context) => {
    context.registrations.provide(SYSTEM_PROMPT_CAPABILITY, { id: "test.skills", preloadedSkills: [{ id: "x.screen", name: "screen", description: "read and drive the open screen" }],
      loadableSkills: [{ id: "x.recon", name: "reconcile", description: "compare two payrolls" }], skillLoader: { toolId: "skill_load", argument: "skill_id" }, render: async () => "CORE" });
    return { dispose: () => undefined };
  });
  const asked: JudgmentRequest[] = [];
  const { adapter } = scriptedModel([answer("Xong.")]);
  const { host, router } = await activeHost(adapter, [promptPlugin, judgment((request) => { asked.push(request); return { fits: { type: "noul", noul: 0.02 } }; })]);
  try {
    await new DefaultAgentLoop(router, new SpyStore(), {}, { judgmentSeams: { skillRelevance: "on" } }).runTurn({ sessionId: `fit-${Math.random()}`, content: "An thực lĩnh bao nhiêu?", security: security() });
  } finally { await host.shutdown(); }
  const fit = asked.find((request) => "fits" in request.questions)!;
  assert.deepEqual((fit.state as { skills: Record<string, string> }).skills, { "x.screen": "read and drive the open screen", "x.recon": "compare two payrolls" }, "the skills compete");
  assert.match(String((fit.questions.fits as { instructions: unknown }).instructions), /"x\.recon" the one whose procedure the request asks to carry out/u);
});

test("a skill whose load the checkpoint summarized away is named again; a pinned load kept whole is not", async () => {
  // Loads counted from the whole journal would count a skill that a checkpoint cut short as still loaded.
  const promptPlugin = plugin("prompt", CAPABILITIES.systemPrompt, async (context) => {
    context.registrations.provide(SYSTEM_PROMPT_CAPABILITY, { id: "test.loadable", loadableSkills: [{ id: "x.recon", name: "reconcile", description: "compare two payrolls" }], skillLoader: { toolId: "load_skill", argument: "skill_id" }, render: async () => "CORE" });
    return { dispose: () => undefined };
  });
  const loader = (pinned: boolean): ToolDefinition => ({
    id: "load_skill", version: "1", description: "load", requiredPermissions: [], sideEffect: "none", timeoutMs: 100, maxResultChars: 40_000,
    ...(pinned ? { pinnedResult: true } : {}), inputSchema: { type: "object" }, outputSchema: {},
    execute: async () => ({ procedure: "RECON-PROCEDURE ".repeat(200) }) as JsonValue,
  });
  const page: ToolDefinition = { id: "read_page", version: "1", description: "read", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
    inputSchema: { type: "object" }, outputSchema: {}, execute: async () => ({ rows: "Nguồn dữ liệu ".repeat(400) }) as JsonValue };
  const secondTurnFirstStep = async (pinned: boolean) => {
    const { adapter, requests } = scriptedModel([call("l", "load_skill", { skill_id: "x.recon" }), ...[1, 2, 3, 4].map((n) => call(`p${n}`, "read_page", { n })), answer("Xong."), answer("Tiếp.")]);
    const { host, router } = await activeHost(adapter, [promptPlugin, toolPlugin("tools", [loader(pinned), page]), judgment(() => ({ fits: { type: "noul", noul: 0.95 } }))]);
    const { ConfiguredContextCompactionPolicy, DeterministicConversationCompactor } = await import("@0xsyncroot/core");
    try {
      const agent = new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 10 }, { judgmentSeams: { skillRelevance: "on" },
        conversationCompactor: new DeterministicConversationCompactor(1), contextCompactionPolicy: new ConfiguredContextCompactionPolicy({ thresholdRatio: 0.01, retainRatio: 0.005 }) });
      const sessionId = `reload-${pinned}-${Math.random()}`;
      await agent.runTurn({ sessionId, content: "đối soát bảng lương", security: security() });
      const before = requests.length;
      await agent.runTurn({ sessionId, content: "tiếp tục", security: security() });
      return requests[before]!.messages.map((message) => message.content ?? "").join("\n");
    } finally { await host.shutdown(); }
  };
  assert.match(await secondTurnFirstStep(false), /skill "reconcile" \(x\.recon\) matches this request and is not loaded/u, "summarized away: named again");
  const kept = await secondTurnFirstStep(true);
  assert.doesNotMatch(kept, /skill "reconcile" \(x\.recon\) matches/u, "kept whole: still loaded");
  assert.match(kept, /RECON-PROCEDURE/u);
});

const skillPrompt = (skills: readonly string[]) => plugin("prompt", CAPABILITIES.systemPrompt, async (context) => {
  context.registrations.provide(SYSTEM_PROMPT_CAPABILITY, {
    id: "test.skills", conditionalSkills: skills.map((id) => ({ id, name: id, description: `about ${id}` })),
    render: async (_security, turn) => `SKILLS ${skills.filter((id) => !turn?.skippedSkills?.has(id)).join(",")}`,
  });
  return { dispose: () => undefined };
});

test("the open waits for the skill judgments, the memory search and the model route together; the journal keeps its order", async () => {
  // Setup took the sum of three independent waits. Each fake below arrives and then waits for the other two: a serial open never lets them meet.
  const arrived = new Set<string>();
  let meet!: () => void;
  const together = new Promise<void>((resolve) => { meet = resolve; });
  const arrive = async (who: string) => { arrived.add(who); if (arrived.size === 3) meet(); await together; };
  const memory: MemoryService = {
    propose: async () => { throw new Error("not used"); }, forget: async () => false,
    search: async () => { await arrive("memory"); return { records: [], contextText: "remembered", contextHash: "h1" }; },
  };
  const { adapter } = scriptedModel([answer("Xong.")]);
  adapter.resolveModel = async () => {
    await arrive("route");
    return { providerId: adapter.id, adapterId: adapter.id, modelId: adapter.model, routeRevision: "r1", metadataSource: "fallback" };
  };
  const port: JudgmentPort = { providerId: "fake", model: "fake", judge: async () => { await arrive("judgment"); return { modelId: "fake", answers: { needed: { type: "noul", noul: 0.5 } } }; } };
  const withPort = await activeHost(adapter, [skillPrompt(["x.payroll"]), plugin("judgment", CAPABILITIES.judgment, async (context) => { context.registrations.provide(JUDGMENT_CAPABILITY, port); return { dispose: () => undefined }; }), createMemoryPlugin(memory)]);
  try {
    const guard = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("the open waits serially: the three waits never met")), 5_000).unref());
    const result = await Promise.race([guard, new DefaultAgentLoop(withPort.router, new SpyStore(), {}, { judgmentSeams: { skillRelevance: "on" }, memoryContextPolicy: new BaseMemoryContextPolicy() })
      .runTurn({ sessionId: `open-${Math.random()}`, content: "phụ cấp nhập ở đâu", security: security({ permissions: new Set(["tool.echo", "memory.read"]) }) })]);
    assert.deepEqual([...arrived].sort(), ["judgment", "memory", "route"]);
    const order = result.events.map((event) => event.type).filter((type) => ["judgment/classified", "memory/context-selected", "model/route-selected"].includes(type));
    assert.deepEqual(order, ["judgment/classified", "memory/context-selected", "model/route-selected"], "appends keep the order the serial open had");
  } finally { await withPort.host.shutdown(); }
});

test("memory down does not fail the open: the turn answers with one context-unavailable row; a route that is down still fails it, after the judgment settled", async () => {
  // Memory is advisory, the route is not: memory down does not fail the turn, a route that is down does.
  let judged = 0;
  let searches = 0;
  const memory: MemoryService = {
    propose: async () => { throw new Error("not used"); }, forget: async () => false,
    search: async () => { searches += 1; throw new AgenticError("transient", "memory down"); },
  };
  const port: JudgmentPort = { providerId: "fake", model: "fake", judge: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); judged += 1; return { modelId: "fake", answers: { needed: { type: "noul", noul: 0.5 } } }; } };
  const open = async (routeDown: boolean) => {
    const { adapter, requests } = scriptedModel([answer("Xong.")]);
    if (routeDown) adapter.resolveModel = async () => { throw new AgenticError("transient", "route down"); };
    const { host, router } = await activeHost(adapter, [skillPrompt(["x.payroll"]), plugin("judgment", CAPABILITIES.judgment, async (context) => { context.registrations.provide(JUDGMENT_CAPABILITY, port); return { dispose: () => undefined }; }), createMemoryPlugin(memory)]);
    try {
      const outcome = await new DefaultAgentLoop(router, new SpyStore(), {}, { judgmentSeams: { skillRelevance: "on" }, memoryContextPolicy: new BaseMemoryContextPolicy() })
        .runTurn({ sessionId: `open-fail-${Math.random()}`, content: "phụ cấp nhập ở đâu", security: security({ permissions: new Set(["tool.echo", "memory.read"]) }) })
        .then((result) => result, (error: unknown) => error);
      return { outcome, requests };
    } finally { await host.shutdown(); }
  };
  const memoryDown = await open(false);
  assert.equal(searches, 1);
  assert.equal(judged, 1);
  assert.equal(memoryDown.requests.length, 1, "the model was asked");
  const events = (memoryDown.outcome as { events: readonly { type: string; payload: unknown }[] }).events;
  const unavailable = events.filter((event) => event.type === "memory/context-unavailable");
  assert.deepEqual(unavailable.map((event) => event.payload), [{ reason: "error", code: "transient", message: "memory down" }]);
  const order = events.map((event) => event.type).filter((type) => ["judgment/classified", "memory/context-unavailable", "model/route-selected"].includes(type));
  assert.deepEqual(order, ["judgment/classified", "memory/context-unavailable", "model/route-selected"], "the row keeps the place the selected row had");

  const routeDown = await open(true);
  assert.equal(judged, 2, "the judgment finished before the open failed: nothing is left running into a failed turn");
  assert.match(String((routeDown.outcome as Error).message), /route down/u);
  assert.equal(routeDown.requests.length, 0);
});

test("a gateway that stalls three turns running: advisory seams stop being asked and one breaker row is journaled; the skills stay (fail open)", async () => {
  const realNow = performance.now.bind(performance);
  let clock = 0;
  // Every reading is two seconds on: each turn's stall starts well outside the last one's second.
  performance.now = () => (clock += 2_000);
  let asked = 0;
  const port: JudgmentPort = { providerId: "fake", model: "fake", judge: async (_request, _signal, options) => { asked += 1; throw new AgenticError("timeout", `fake request exceeded ${options?.timeoutMs} ms`); } };
  const { adapter, requests } = scriptedModel([answer("Xong.")]);
  const { host, router } = await activeHost(adapter, [skillPrompt(["x.payroll"]), plugin("judgment", CAPABILITIES.judgment, async (context) => { context.registrations.provide(JUDGMENT_CAPABILITY, port); return { dispose: () => undefined }; })]);
  try {
    const agent = new DefaultAgentLoop(router, new SpyStore(), {}, { judgmentSeams: { skillRelevance: "on" } });
    const turn = (n: number) => agent.runTurn({ sessionId: `breaker-${n}-${Math.random()}`, content: "phụ cấp nhập ở đâu", security: security() });
    const rows = (result: Awaited<ReturnType<typeof turn>>) => result.events.filter((event) => event.type === "judgment/classified").map((event) => event.payload as { seam: string; reason?: string });
    const first = await turn(1); const second = await turn(2); const third = await turn(3);
    assert.deepEqual(rows(first).map((row) => row.seam), ["skill-relevance"]);
    assert.deepEqual(rows(third).map((row) => row.seam), ["skill-relevance", "judgment-breaker"]);
    assert.equal(rows(third)[1]!.reason, "breaker: open 60000 ms");
    assert.equal(rows(second).length, 1);
    const calls = asked;
    const fourth = await turn(4);
    assert.equal(asked, calls, "open: the judge is not asked");
    assert.deepEqual(rows(fourth), [], "and nothing is journaled for the skipped call");
    assert.match(requests.at(-1)!.messages.find((message) => message.role === "system")!.content ?? "", /SKILLS x\.payroll/u, "no verdict: the skill stays, as when a judgment fails");
    assert.equal(fourth.outcome, "completed");
  } finally { performance.now = realNow; await host.shutdown(); }
});

/** One turn on which the judge hangs twice on x.recon, so the chat model decides that skill; `dependencies` are the loop's own. */
async function fallbackTurn(dependencies: ConstructorParameters<typeof DefaultAgentLoop>[3]) {
  const promptPlugin = plugin("prompt", CAPABILITIES.systemPrompt, async (context) => {
    context.registrations.provide(SYSTEM_PROMPT_CAPABILITY, { id: "test.skills", preloadedSkills: [{ id: "x.screen", name: "screen", description: "read and drive the open screen" }],
      loadableSkills: [{ id: "x.recon", name: "reconcile", description: "compare two payrolls" }, { id: "x.fix", name: "fix", description: "correct a payroll" }],
      skillLoader: { toolId: "skill_load", argument: "skill_id" }, render: async () => "CORE" });
    return { dispose: () => undefined };
  });
  const judged: string[] = [];
  const port: JudgmentPort = { providerId: "fake", model: "fake", judge: async (request, _signal, options) => {
    const question = String((request.questions.fits as { instructions: string }).instructions);
    const skill = question.includes('"x.recon"') ? "x.recon" : "x.fix";
    judged.push(skill);
    if (skill === "x.recon") throw new AgenticError("timeout", `fake request exceeded ${options?.timeoutMs} ms`);
    return { modelId: "fake", answers: { fits: { type: "noul", noul: 0.02 } } };
  } };
  const fitRequests: PreparedLlmRequest[] = [], stepRequests: PreparedLlmRequest[] = [];
  const chat: LlmAdapter = { id: "chat", model: "chat-model", defaultParameters: { thinking: true }, plainParameters: { thinking: false },
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      (request.runtimeSnapshotId === "skill-fit" ? fitRequests : stepRequests).push(request);
      yield { type: "final", content: request.runtimeSnapshotId === "skill-fit" ? "yes" : "Xong.", toolCalls: [], finishReason: "stop", status: "completed" };
    } };
  const { host, router } = await activeHost(chat, [promptPlugin, plugin("judgment", CAPABILITIES.judgment, async (context) => {
    context.registrations.provide(JUDGMENT_CAPABILITY, port);
    return { dispose: () => undefined };
  })]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { judgmentSeams: { skillRelevance: "on" }, ...dependencies })
      .runTurn({ sessionId: `fallback-${Math.random()}`, content: "đối soát hai bảng lương", security: security() });
    const rows = result.events.filter((event) => event.type === "judgment/classified").map((event) => event.payload as Record<string, unknown>)
      .filter((row) => row.seam === "skill-suggestion");
    return { judged, fitRequests, stepRequests, rows };
  } finally { await host.shutdown(); }
}

test("skill suggestion: a judge that hangs twice on one skill is sent again once, then the chat model decides that skill alone, and the journal says who", async () => {
  const { judged, fitRequests, stepRequests, rows } = await fallbackTurn({});
  assert.deepEqual(judged.sort(), ["x.fix", "x.recon", "x.recon"], "the stuck skill twice, the answered one once");
  assert.equal(fitRequests.length, 1, "the chat model is asked about x.recon alone");
  assert.deepEqual(fitRequests[0]!.parameters, { thinking: false });
  assert.equal(fitRequests[0]!.model, "chat-model", "AGENTIC_JUDGMENT_FALLBACK_MODEL unset: the chat model's id");
  assert.match(stepRequests[0]!.messages.map((message) => message.content ?? "").join("\n"), /the skill "reconcile" \(x\.recon\) matches this request and is not loaded/u);
  assert.deepEqual(rows.map((row) => [row.providerId, row.outcome]).sort(), [["chat", "answered"], ["fake", "answered"], ["fake", "failed"], ["fake", "failed"]]);
  const fallback = rows.find((row) => row.providerId === "chat")!;
  assert.equal(fallback.modelId, "chat-model");
  assert.deepEqual(fallback.answers, { fits: { type: "noul", value: 1 } });
  assert.equal(typeof fallback.elapsedMs, "number");
});

test("skill suggestion: with a fallback model set, the chat model's turn is untouched and the fallback request and its journal row carry the set id", async () => {
  const { fitRequests, stepRequests, rows } = await fallbackTurn({ judgmentFallbackModel: "example-fallback-model" });
  assert.equal(fitRequests.length, 1);
  assert.equal(fitRequests[0]!.model, "example-fallback-model");
  assert.equal(stepRequests[0]!.model, "chat-model", "only the fallback question changes model");
  const fallback = rows.find((row) => row.providerId === "chat")!;
  assert.equal(fallback.modelId, "example-fallback-model");
  assert.deepEqual(fallback.answers, { fits: { type: "noul", value: 1 } });
});
