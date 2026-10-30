import assert from "node:assert/strict";
import test from "node:test";
import {
  AgenticError, CAPABILITIES, assertValidCoreEventDraft, validateToolGroupCatalog, type JsonValue, type JudgmentPort, type JudgmentRequest, type RunTurnResult, type SystemPromptProvider,
  type ToolDefinition, type ToolGroupCatalog,
} from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { createToolsLoadTool, createWorkPlanningPlugin, TOOLS_LOAD_TOOL } from "@0xsyncroot/plugins-base";
import { JUDGMENT_CAPABILITY, SYSTEM_PROMPT_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { TurnToolSelection } from "../src/agent/tool-selection.js";
import { toolRelevanceState } from "../src/agent/tool-relevance.js";
import { resolveTurnDirective } from "../src/agent/turn-control.js";
import { activeHost, answer, call, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/** Core's tool-relevance seam inside real turns: which groups a request is offered, how one comes back, and what is journaled. */
function plugin(id: string, provides: string, activate: PluginDescriptor["plugin"]["activate"]): PluginDescriptor {
  return {
    trustTier: "platform-core",
    manifest: { manifestVersion: 1, id: `io.syncroot.test.${id}`, version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
      artifact: { digest: `builtin:${id}`, signature: "test" }, requires: {},
      provides: { [provides]: { version: "1.0.0", cardinality: provides === CAPABILITIES.judgment ? "single" : "multi" } }, permissions: {} },
    plugin: { validate: async () => ({ valid: true }), activate },
  };
}
/** A judge answering each group's question by the group it names; a group it has no number for fails with `failure`. */
function judgment(needed: Readonly<Record<string, number>>, asked: string[] = [], failure: () => Error = () => new Error("no verdict")): PluginDescriptor {
  return plugin("judgment", CAPABILITIES.judgment, async (context) => {
    const port: JudgmentPort = { providerId: "fake", model: "fake", judge: async (request: JudgmentRequest) => {
      const question = (request.questions.needed as { instructions?: string } | undefined)?.instructions ?? "";
      const group = Object.keys(needed).find((name) => question.includes(`group "${name}"`));
      asked.push(group ?? question);
      if (group === undefined) throw failure();
      return { modelId: "fake", answers: { needed: { type: "noul", noul: needed[group]! } } };
    } };
    context.registrations.provide(JUDGMENT_CAPABILITY, port);
    return { dispose: () => undefined };
  });
}
const tool = (id: string, result: JsonValue = { ok: id }): ToolDefinition => ({
  id, version: "1", description: id, requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {}, execute: async () => result,
});
const GROUPS = [
  { id: "screen", purpose: "read the open screen", toolIds: ["screen_view"] },
  { id: "payroll", purpose: "read payroll records", toolIds: ["pay_read"] },
  // `doc_gone` is in the group's catalog but not in any turn's surface (a connector down, a policy that removed it).
  { id: "docs", purpose: "read attached files", toolIds: ["doc_read", "doc_gone"] },
  // Declared, but no tool of it is in any turn's surface: never offered, never loadable into the surface.
  { id: "ghost", purpose: "tools this deployment lacks", toolIds: ["ghost_tool"] },
];
const CATALOG: ToolGroupCatalog = { groups: GROUPS, loader: TOOLS_LOAD_TOOL };
const surface = () => toolPlugin("surface", [tool("screen_view"), tool("pay_read"), tool("doc_read"), tool("calc"), createToolsLoadTool(GROUPS)]);
/** A preloaded skill requiring `pay_read`, rendered with whether the turn offers it. */
const preload = (extra: Partial<SystemPromptProvider> = {}) => plugin("prompt", CAPABILITIES.systemPrompt, async (context) => {
  context.registrations.provide(SYSTEM_PROMPT_CAPABILITY, {
    id: "test.skills", preloadedSkills: [{ id: "x.pay", name: "pay", description: "payroll procedure" }],
    skillTools: ({ loadedSkills }) => ["pay_read", ...(loadedSkills.has("x.recon") ? ["doc_read"] : [])],
    render: async (_security, turn) => `PRELOAD offers pay_read: ${turn?.offeredToolIds?.has("pay_read") ?? "all"}`, ...extra,
  });
  return { dispose: () => undefined };
});
const names = (request: { readonly tools: readonly { readonly name: string }[] }) => request.tools.map((entry) => entry.name);
const selections = (result: RunTurnResult) => result.events.filter((event) => event.type === "tool/selection").map((event) => event.payload as Record<string, JsonValue>);
const REQUEST = "đọc bảng lương tháng 9 trên màn hình giúp em";

async function run(input: { readonly plugins: readonly PluginDescriptor[]; readonly script: Parameters<typeof scriptedModel>[0];
  readonly content?: string; readonly groups?: boolean; readonly seam?: "on" | "shadow" | "off" }) {
  const { adapter, requests } = scriptedModel(input.script);
  const { host, router } = await activeHost(adapter, input.plugins);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), {}, {
      judgmentSeams: { toolRelevance: input.seam ?? "on" }, ...(input.groups === false ? {} : { toolGroups: CATALOG }),
    }).runTurn({ sessionId: `groups-${Math.random()}`, content: input.content ?? REQUEST, security: security() });
    return { result, requests };
  } finally { await host.shutdown(); }
}

test("order: a group the judge rules out is left out, but never one a preloaded skill requires; the loader is offered", async () => {
  const { result, requests } = await run({ plugins: [surface(), preload(), judgment({ screen: 0.97, payroll: 0, docs: 0.01 })], script: [answer("Xong.")] });
  assert.deepEqual(names(requests[0]!), ["screen_view", "pay_read", "calc", "tools_load"], "pinned by the skill, kept; docs out; ungrouped calc kept");
  assert.match(requests[0]!.messages.find((message) => message.role === "system")!.content ?? "", /PRELOAD offers pay_read: true/u, "the preload is rendered as offered");
  assert.deepEqual(selections(result), [{ basis: "judged", groups: [
    { group: "screen", offered: true, reason: "needed" }, { group: "payroll", offered: true, reason: "skill" },
    { group: "docs", offered: false, reason: "not-needed" },
  ] }], "one row at the open: group ids and reasons only, the absent group not named");
});

test("reachability: an unoffered call is refused with its group and the loader call as data; the load offers it from the next step", async () => {
  const { result, requests } = await run({
    plugins: [surface(), preload(), judgment({ screen: 0.9, payroll: 0.9, docs: 0 })],
    script: [call("d1", "doc_read", {}), call("l1", "tools_load", { group: "docs" }), call("g1", "tools_load", { group: "ghost" }), answer("Xong.")],
  });
  const refusal = { error: JSON.parse(requests[1]!.messages.find((message) => message.role === "tool")!.content!) as { message: string; load: JsonValue } };
  assert.deepEqual(refusal.error.load, { toolId: "tools_load", arguments: { group: "docs" } });
  assert.doesNotMatch(refusal.error.message, /Tools available/u, "names no tools to use instead");
  assert.ok(!names(requests[1]!).includes("doc_read"));
  assert.ok(names(requests[2]!).includes("doc_read"), "loaded for the rest of the turn");
  const loaded = requests[2]!.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content!) as unknown);
  assert.deepEqual(loaded.at(-1), { group: "docs", tools: ["doc_read"] }, "the loader lists only the tools this turn's surface holds");
  assert.ok(!names(requests[3]!).includes("ghost_tool"), "a load adds only tools the turn's surface holds");
  assert.deepEqual(selections(result).slice(1), [{ basis: "added", groups: [{ group: "docs", offered: true, reason: "loaded" }] }]);
});

test("a skill loaded during the turn adds the groups it requires, and only adds", async () => {
  const loader = { skillLoader: { toolId: "skill_load", argument: "skill_id" } };
  const { result, requests } = await run({
    plugins: [toolPlugin("skills", [tool("skill_load", { instructions: "recon" })]), surface(), preload(loader), judgment({ screen: 0.9, payroll: 0.9, docs: 0 })],
    script: [call("s1", "skill_load", { skill_id: "x.recon" }), answer("Xong.")],
  });
  assert.ok(names(requests[0]!).includes("skill_load") && !names(requests[0]!).includes("doc_read"));
  assert.ok(names(requests[1]!).includes("doc_read"));
  assert.deepEqual(selections(result).at(-1), { basis: "added", groups: [{ group: "docs", offered: true, reason: "skill-loaded" }] });
});

test("fail-open: a judge that gives no verdict offers every group, and nothing to load", async () => {
  const { result, requests } = await run({ plugins: [surface(), preload(), judgment({})], script: [answer("Xong.")] });
  assert.deepEqual(names(requests[0]!), ["screen_view", "pay_read", "doc_read", "calc"]);
  assert.deepEqual(selections(result)[0]!.groups, [
    { group: "screen", offered: true, reason: "no-verdict" }, { group: "payroll", offered: true, reason: "skill" },
    { group: "docs", offered: true, reason: "no-verdict" },
  ]);
});

test("fail-open: a judge that throws or times out leaves requests byte-identical to a composition without groups", async () => {
  const script = [call("c1", "calc", {}), call("d1", "doc_read", {}), answer("Xong.")];
  const prompt = () => preload({ render: async () => "PROCEDURE" });
  const shape = (requests: { readonly tools: unknown; readonly messages: unknown; readonly toolChoice?: unknown }[]) =>
    requests.map(({ tools, messages, toolChoice }) => JSON.stringify({ tools, messages, toolChoice }));
  const plain = await run({ plugins: [toolPlugin("plain", [tool("screen_view"), tool("pay_read"), tool("doc_read"), tool("calc")]), prompt()], groups: false, script });
  for (const failure of [() => new Error("gateway down"), () => new AgenticError("timeout", "judge timed out")]) {
    const failed = await run({ plugins: [surface(), prompt(), judgment({}, [], failure)], script });
    assert.deepEqual(shape(failed.requests), shape(plain.requests));
    assert.ok(selections(failed.result)[0]!.groups && (selections(failed.result)[0]!.groups as { offered: boolean }[]).every((entry) => entry.offered));
  }
});

test("the threshold: a group is left out at a confidence of 0.1 and offered above it", async () => {
  const { requests } = await run({ plugins: [surface(), preload(), judgment({ screen: 0.1, payroll: 0.9, docs: 0.11 })], script: [answer("Xong.")] });
  assert.deepEqual(names(requests[0]!), ["pay_read", "doc_read", "calc", "tools_load"]);
});

test("a request of a few words offers every group without asking the judge", async () => {
  const asked: string[] = [];
  const { result, requests } = await run({ plugins: [surface(), preload(), judgment({ screen: 0, payroll: 0, docs: 0 }, asked)], content: "tiếp tục đi", script: [answer("Xong.")] });
  assert.deepEqual(asked, []);
  assert.deepEqual(names(requests[0]!), ["screen_view", "pay_read", "doc_read", "calc"]);
  assert.equal(selections(result)[0]!.basis, "short-request");
});

test("shadow: the judge is asked and the row says what would be left out, while every group is offered", async () => {
  const { result, requests } = await run({ plugins: [surface(), preload(), judgment({ screen: 0.9, payroll: 0, docs: 0 })], seam: "shadow", script: [answer("Xong.")] });
  assert.deepEqual(names(requests[0]!), ["screen_view", "pay_read", "doc_read", "calc"]);
  assert.deepEqual(selections(result)[0], { basis: "judged", shadow: true, groups: [
    { group: "screen", offered: true, reason: "needed" }, { group: "payroll", offered: true, reason: "skill" }, { group: "docs", offered: false, reason: "not-needed" },
  ] });
});

test("no judge, or the seam off: every request is byte-identical to a composition without groups", async () => {
  const script = [call("c1", "calc", {}), call("d1", "doc_read", {}), answer("Xong.")];
  const plain = await run({ plugins: [toolPlugin("plain", [tool("screen_view"), tool("pay_read"), tool("doc_read"), tool("calc")]), preload()], groups: false, script });
  const shape = (requests: typeof plain.requests) => requests.map(({ tools, messages, toolChoice }) => JSON.stringify({ tools, messages, toolChoice }));
  const noJudge = await run({ plugins: [surface(), preload()], script });
  const seamOff = await run({ plugins: [surface(), preload(), judgment({ screen: 0, payroll: 0, docs: 0 })], script, seam: "off" });
  assert.equal(plain.requests.length, 3);
  assert.deepEqual(shape(noJudge.requests), shape(plain.requests));
  assert.deepEqual(shape(seamOff.requests), shape(plain.requests));
  assert.equal(selections(noJudge.result).length + selections(seamOff.result).length, 0, "nothing selected, nothing journaled");
});

test("the tool/selection row is a closed shape at the journal boundary", () => {
  const draft = (payload: JsonValue) => ({ type: "tool/selection", turnId: "t", payload });
  assert.doesNotThrow(() => assertValidCoreEventDraft(draft({ basis: "judged", groups: [{ group: "docs", offered: false, reason: "not-needed" }] })));
  assert.throws(() => assertValidCoreEventDraft(draft({ basis: "judged", groups: [{ group: "docs", offered: false, reason: "because" }] })), /closed sets/u);
  assert.throws(() => assertValidCoreEventDraft(draft({ basis: "judged", groups: [], request: "free text" })), /closed sets/u);
  assert.throws(() => assertValidCoreEventDraft(draft({ basis: "judged", groups: [{ group: "docs", offered: true, reason: "needed", tools: ["x"] }] })), /closed sets/u);
});

test("a resumed turn offers every group; a group the agent called earlier in the session is pinned, not asked", async () => {
  const tools = [tool("screen_view"), tool("pay_read"), tool("doc_read"), createToolsLoadTool(GROUPS)];
  const base = { catalog: CATALOG, tools, mode: "on" as const, content: REQUEST, turnId: "now", pinnedToolIds: new Set<string>() };
  const judge = async () => ({ answers: { needed: { type: "noul" as const, noul: 0 } } });
  const resumed = new TurnToolSelection({ ...base, judge, operation: "resume-interaction", events: [] });
  await resumed.judge(judge, REQUEST, undefined, new AbortController().signal);
  resumed.settle([]);
  assert.deepEqual([...resumed.offeredToolIds], ["screen_view", "pay_read", "doc_read"]);
  assert.equal((resumed.openingDraft("now")!.payload as { basis: string }).basis, "resume");
  const earlier = (toolId: string, initiator?: string) => ({ eventId: toolId, seq: 1, sessionId: "s", turnId: "before", stepId: "x", type: "tool/intent",
    occurredAt: new Date().toISOString(), payload: { toolId, callId: "c", executionId: "e", arguments: "{}", state: "prepared", sideEffect: "none", ...(initiator ? { initiator } : {}) } }) as never;
  const judged = new TurnToolSelection({ ...base, judge, operation: "run-turn", events: [earlier("doc_read"), earlier("pay_read", "policy")] });
  assert.deepEqual(judged.asked.map((group) => group.id), ["screen", "payroll"], "a policy's own read pins nothing");
  await judged.judge(judge, REQUEST, undefined, new AbortController().signal);
  judged.settle([]);
  assert.deepEqual([...judged.offeredToolIds], ["doc_read", "tools_load"]);
  assert.deepEqual(judged.loadFor("pay_read"), { group: "payroll", call: { toolId: "tools_load", arguments: { group: "payroll" } } });
  assert.equal(judged.loadFor("doc_read"), undefined);
});

test("the session's offer only grows: an earlier row's groups stay offered, the judge is asked only about the rest, a resume reuses it", async () => {
  const tools = [tool("screen_view"), tool("pay_read"), tool("doc_read"), createToolsLoadTool(GROUPS)];
  const base = { catalog: CATALOG, tools, mode: "on" as const, content: REQUEST, turnId: "now", pinnedToolIds: new Set<string>() };
  const judge = async () => ({ answers: { needed: { type: "noul" as const, noul: 0 } } });
  const row = (turnId: string, basis: string, groups: readonly { group: string; offered: boolean; reason: string }[]) => ({
    eventId: `${turnId}-${basis}`, seq: 1, sessionId: "s", turnId, type: "tool/selection", occurredAt: new Date().toISOString(), payload: { basis, groups },
  }) as never;
  const opened = row("before", "judged", [
    { group: "screen", offered: true, reason: "needed" }, { group: "payroll", offered: false, reason: "not-needed" }, { group: "docs", offered: false, reason: "no-fact" },
  ]);
  const judged = new TurnToolSelection({ ...base, judge, operation: "run-turn", events: [opened] });
  assert.deepEqual(judged.asked.map((group) => group.id), ["payroll", "docs"], "a group the session offered is not asked again");
  await judged.judge(judge, REQUEST, undefined, new AbortController().signal);
  judged.settle([]);
  assert.deepEqual([...judged.offeredToolIds], ["screen_view", "tools_load"], "offered though the judge would now rule it out");
  assert.deepEqual((judged.openingDraft("now")!.payload as { groups: unknown }).groups, [
    { group: "screen", offered: true, reason: "session" }, { group: "payroll", offered: false, reason: "not-needed" }, { group: "docs", offered: false, reason: "not-needed" },
  ]);
  const loaded = row("before", "added", [{ group: "docs", offered: true, reason: "loaded" }]);
  const resumed = new TurnToolSelection({ ...base, judge, operation: "resume-interaction", events: [opened, loaded] });
  assert.deepEqual(resumed.asked, [], "a resume asks nothing");
  resumed.settle([]);
  assert.deepEqual([...resumed.offeredToolIds], ["screen_view", "doc_read", "tools_load"], "the resume offers what the session offered, a load included");
  assert.deepEqual(resumed.openingDraft("now")!.payload, { basis: "resume", groups: [
    { group: "screen", offered: true, reason: "session" }, { group: "payroll", offered: false, reason: "not-needed" }, { group: "docs", offered: true, reason: "session" },
  ] }, "a group left out stays out for the reason its last row gave");
  const unnamed = new TurnToolSelection({ ...base, judge, operation: "resume-approval", events: [row("before", "judged", [{ group: "screen", offered: true, reason: "needed" }])] });
  unnamed.settle([]);
  assert.deepEqual([...unnamed.offeredToolIds], ["screen_view", "pay_read", "doc_read"], "a group no row named is offered: nothing ruled it out");
});

test("in real turns the second turn of a session keeps the first turn's tool list and asks the judge nothing new", async () => {
  const asked: string[] = [];
  const { adapter, requests } = scriptedModel([answer("Một."), answer("Hai.")]);
  const { host, router } = await activeHost(adapter, [surface(), judgment({ screen: 0.9, payroll: 0, docs: 0 }, asked)]);
  try {
    const loop = new DefaultAgentLoop(router, new SpyStore(), {}, { judgmentSeams: { toolRelevance: "on" }, toolGroups: CATALOG });
    const sessionId = `grow-${Math.random()}`;
    await loop.runTurn({ sessionId, content: REQUEST, security: security() });
    asked.length = 0;
    const second = await loop.runTurn({ sessionId, content: "còn bảng lương tháng 8 trên màn hình thì sao", security: security() });
    assert.deepEqual(names(requests[1]!), names(requests[0]!), "the same tools in the same order: the cached prefix holds");
    assert.deepEqual(asked.sort(), ["docs", "payroll"], "only the groups the session never offered are asked");
    assert.deepEqual(selections(second)[0]!.groups, [
      { group: "screen", offered: true, reason: "session" }, { group: "payroll", offered: false, reason: "not-needed" }, { group: "docs", offered: false, reason: "not-needed" },
    ]);
  } finally { await host.shutdown(); }
});

test("the judged state stays within 2,000 characters: the newest request text, then the plan cut from its last sub-goal", () => {
  const steps = Array.from({ length: 40 }, (_unused, index) => ({ id: `s${index}`, description: `sub-goal ${index} `.repeat(4), status: "pending" as const }));
  const state = toolRelevanceState("x".repeat(5_000) + " newest words", { goal: "reconcile", steps, updatedAt: "" }) as { request: string; plan?: { steps: unknown[] } };
  assert.ok(JSON.stringify(state).length <= 2_000);
  assert.ok(state.request.endsWith("newest words"));
  assert.ok(state.plan && state.plan.steps.length > 0 && state.plan.steps.length < 40);
});

test("the judged state fits even when the request text grows under JSON escaping", () => {
  const raw = "\u0001".repeat(1_500) + "\n\"newest\"";
  const state = toolRelevanceState(raw, undefined) as { request: string };
  assert.ok(JSON.stringify(state).length <= 2_000);
  assert.ok(state.request.endsWith("\n\"newest\""));
  assert.ok(state.request.length > 100, "the newest part is kept, not the whole text dropped");
});

test("precedence: a policy's list narrows what the turn offers and never widens it, unless the policy forces its own choice", async () => {
  const [a, b, c] = [tool("a"), tool("b"), tool("c")];
  const policy = (directive: Record<string, unknown>) => ({ id: "p", revision: "1", beforeModelStep: async () => directive }) as never;
  const state = {} as never;
  const signal = new AbortController().signal;
  const offered = (directive: Record<string, unknown>) => resolveTurnDirective(policy(directive), state, [a!, b!, c!], signal, {}, [a!, c!])
    .then((effective) => effective.tools.map((entry) => entry.id));
  assert.deepEqual(await offered({}), ["a", "c"]);
  assert.deepEqual(await offered({ allowedToolIds: ["a", "b"] }), ["a"], "a read-back narrowing keeps narrowing");
  assert.deepEqual(await offered({ allowedToolIds: ["b"], toolChoice: "required" }), ["b"], "a forced choice stands whole");
  assert.deepEqual(await offered({ toolChoice: { name: "b" } }), ["a", "b", "c"], "a named choice is forced: its tool is offered though left out");
  assert.deepEqual(await offered({ allowedToolIds: ["b"], toolChoice: { name: "b" } }), ["b"]);
  assert.deepEqual((await resolveTurnDirective(undefined, state, [a!, b!, c!], signal, {}, [a!])).tools.map((entry) => entry.id), ["a"]);
});

test("both planning tools stay offered when a group holding them is ruled out: the plan is published with one and marked with the other", async () => {
  const groups = [...GROUPS, { id: "planning", purpose: "plan the work", toolIds: ["plan_update", "plan_mark"] }];
  const { adapter, requests } = scriptedModel([answer("Xong.")]);
  const { host, router } = await activeHost(adapter, [surface(), createWorkPlanningPlugin(), judgment({ screen: 0.9, payroll: 0.9, docs: 0, planning: 0 })]);
  try {
    await new DefaultAgentLoop(router, new SpyStore(), {}, { judgmentSeams: { toolRelevance: "on" }, toolGroups: { groups, loader: TOOLS_LOAD_TOOL } })
      .runTurn({ sessionId: `groups-${Math.random()}`, content: REQUEST, security: security() });
  } finally { await host.shutdown(); }
  const offered = names(requests[0]!);
  assert.ok(offered.includes("plan_update") && offered.includes("plan_mark"), offered.join(", "));
  assert.equal(offered.includes("doc_read"), false, "the judge's verdict still applies to the other groups");
});

test("a group whose declared fact does not hold is left out without asking; with the fact it is judged as before", async () => {
  const groups = GROUPS.map((group) => group.id === "docs" ? { ...group, requires: "files" as const } : group);
  const turn = async (attachments?: readonly { id: string; name: string; mediaType: string; byteSize: number }[]) => {
    const asked: string[] = [];
    const { adapter, requests } = scriptedModel([answer("Xong.")]);
    const { host, router } = await activeHost(adapter, [surface(), judgment({ screen: 0.97, payroll: 0.97, docs: 0.97 }, asked)]);
    try {
      const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { judgmentSeams: { toolRelevance: "on" }, toolGroups: { groups, loader: TOOLS_LOAD_TOOL } })
        .runTurn({ sessionId: `facts-${Math.random()}`, content: REQUEST, security: security(), ...(attachments ? { attachments } : {}) });
      return { asked, offered: names(requests[0]!), selection: selections(result)[0] };
    } finally { await host.shutdown(); }
  };
  const without = await turn();
  assert.deepEqual(without.asked.sort(), ["payroll", "screen"], "the judge is never asked about docs");
  assert.deepEqual(without.offered, ["screen_view", "pay_read", "calc", "tools_load"], "docs out, and loadable");
  assert.deepEqual(without.selection, { basis: "judged", groups: [
    { group: "screen", offered: true, reason: "needed" }, { group: "payroll", offered: true, reason: "needed" }, { group: "docs", offered: false, reason: "no-fact" }] });
  const withFile = await turn([{ id: "doc-1", name: "september.xlsx", mediaType: "text/csv", byteSize: 2048 }]);
  assert.deepEqual(withFile.asked.sort(), ["docs", "payroll", "screen"]);
  assert.ok(withFile.offered.includes("doc_read"));
});

test("a catalog naming an unknown fact is refused, and the journal takes the no-fact reason", () => {
  assert.throws(() => validateToolGroupCatalog({ groups: [{ ...GROUPS[0]!, requires: "tab" as never }], loader: TOOLS_LOAD_TOOL }), /unknown fact/u);
  assert.doesNotThrow(() => validateToolGroupCatalog({ groups: [{ ...GROUPS[2]!, requires: "files" }], loader: TOOLS_LOAD_TOOL }));
  assert.doesNotThrow(() => assertValidCoreEventDraft({ type: "tool/selection", turnId: "t1",
    payload: { basis: "judged", groups: [{ group: "docs", offered: false, reason: "no-fact" }] } }));
});
