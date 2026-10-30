import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITIES, type JsonValue, type JudgmentPort, type JudgmentRequest, type SessionEvent, type TurnJudge } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { JUDGMENT_CAPABILITY, SYSTEM_PROMPT_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { createResultRelevance } from "../src/agent/result-relevance.js";
import { JudgmentMemo } from "../src/agent/judgment-memo.js";
import { activeHost, answer, call, planningPlugin, planStep, scriptedModel, security, SpyStore, toolPlugin, writeTool } from "./turn-harness.js";

/**
 * The judge is asked once per question, not once per lap: a shadow judgment does not hold the step it
 * changes nothing in, a resume does not ask its turn's skill questions again, and a retained result is not re-judged a few
 * steps on while the request is the same.
 */
function plugin(id: string, provides: string, activate: PluginDescriptor["plugin"]["activate"]): PluginDescriptor {
  return {
    trustTier: "platform-core",
    manifest: { manifestVersion: 1, id: `io.syncroot.test.${id}`, version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
      artifact: { digest: `builtin:${id}`, signature: "test" }, requires: {},
      provides: { [provides]: { version: "1.0.0", cardinality: provides === CAPABILITIES.judgment ? "single" : "multi" } }, permissions: {} },
    plugin: { validate: async () => ({ valid: true }), activate },
  };
}
const judgment = (port: JudgmentPort): PluginDescriptor => plugin("judgment", CAPABILITIES.judgment, async (context) => {
  context.registrations.provide(JUDGMENT_CAPABILITY, port);
  return { dispose: () => undefined };
});
const seams = (events: readonly SessionEvent[], seam: string) =>
  events.filter((event) => event.type === "judgment/classified" && (event.payload as { seam: string }).seam === seam).length;

test("M: a shadow step-claim judgment does not hold the plan update, and is cancelled when the turn's steps are over", async () => {
  let asked = 0;
  let cancelled = false;
  // A judge that answers only when cancelled: awaited on the critical path, the turn could never finish.
  const port: JudgmentPort = { providerId: "fake", model: "fake", judge: (request, signal) => {
    if (!("shown" in request.questions)) return Promise.resolve({ modelId: "fake", answers: {} });
    asked += 1;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true }));
  } };
  const press = { ...writeTool(), id: "test_press", sideEffect: "none" as const, requiredPermissions: [], inputSchema: { type: "object" } };
  const { adapter } = scriptedModel([
    planStep("p1", "Delete", [{ id: "s1", description: "Delete the sheet", status: "in_progress" }]),
    call("c1", "test_press", {}),
    planStep("p2", "Delete", [{ id: "s1", description: "Delete the sheet", status: "completed" }]),
    answer("Deleted."),
  ]);
  const { host, router } = await activeHost(adapter, [planningPlugin(), toolPlugin("press", [press]), judgment(port)]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { judgmentSeams: { stepClaim: "shadow" } })
      .runTurn({ sessionId: "shadow-claim", content: "delete the sheet", security: security() });
    assert.equal(result.content, "Deleted.");
    assert.equal(asked, 1, "the judgment is still asked, for measurement");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true, "it does not outlive the turn");
  } finally { await host.shutdown(); }
});

test("N: a resume does not ask the skill judgments its turn already asked about the same request", async () => {
  const asked: string[] = [];
  const port: JudgmentPort = { providerId: "fake", model: "fake", judge: async (request) => {
    asked.push(Object.keys(request.questions)[0]!);
    return { modelId: "fake", answers: { needed: { type: "noul", noul: 0.02 }, fits: { type: "noul", noul: 0.2 } } as never };
  } };
  const prompt = plugin("prompt", CAPABILITIES.systemPrompt, async (context) => {
    context.registrations.provide(SYSTEM_PROMPT_CAPABILITY, {
      id: "test.skills", conditionalSkills: [{ id: "x.payroll", name: "Payroll", description: "payroll writes" }],
      loadableSkills: [{ id: "x.recon", name: "reconcile", description: "compare two payrolls" }], skillLoader: { toolId: "skill_load", argument: "skill_id" },
      render: async (_security, turn) => (turn?.skippedSkills?.has("x.payroll") ? "CORE ONLY" : "CORE + PAYROLL SKILL"),
    });
    return { dispose: () => undefined };
  });
  const { adapter, requests } = scriptedModel([call("w1", "test_write", { value: "a" }), answer("Written.")]);
  const store = new SpyStore();
  const { host, router } = await activeHost(adapter, [prompt, toolPlugin("write", [writeTool()]), judgment(port)]);
  try {
    const agent = new DefaultAgentLoop(router, store, {}, { judgmentSeams: { skillRelevance: "on" } });
    const paused = await agent.runTurn({ sessionId: "resume-skills", content: "write a", security: security() });
    assert.equal(paused.outcome, "awaiting_approval");
    assert.deepEqual(asked.sort(), ["fits", "fits", "needed"], "the fit of the loadable skill and of the conditional procedure, and its topic");
    const resumed = await agent.resumeTurn({
      sessionId: "resume-skills", approvalId: paused.approval!.approvalId, decision: "approve", security: security(), idempotencyKey: "approve-1",
    });
    assert.equal(resumed.content, "Written.");
    assert.equal(seams(resumed.events, "skill-relevance") + seams(resumed.events, "skill-suggestion"), 0, "was four calls on every live resume");
    assert.match(requests.at(-1)!.messages.find((message) => message.role === "system")!.content ?? "", /CORE ONLY/u, "the kept verdict still applies");
  } finally { await host.shutdown(); }
});

test("N: a new request asks again", async () => {
  const memo = new JudgmentMemo();
  let asks = 0;
  const ask = async () => { asks += 1; return true; };
  await memo.remember({ seam: "s", request: "one" }, ask);
  await memo.remember({ seam: "s", request: "one" }, ask);
  await memo.remember({ seam: "s", request: "two" }, ask);
  assert.equal(asks, 2);
  // A failed judgment is no verdict: asked again next time.
  let failures = 0;
  await memo.remember({ seam: "s", request: "three" }, async () => { failures += 1; return undefined; });
  await memo.remember({ seam: "s", request: "three" }, async () => { failures += 1; return undefined; });
  assert.equal(failures, 2);
});

const relevanceJudge = (seen: JudgmentRequest[]): TurnJudge => async (_seam, request) => {
  seen.push(request);
  return { modelId: "fake", answers: { needed: { type: "noul", noul: 0.9 } } };
};
const assistant = (seq: number): SessionEvent => ({ eventId: `a${seq}`, seq, turnId: "t", type: "assistant/message", payload: {} }) as unknown as SessionEvent;
const retained = (eventId: string, seq: number): SessionEvent => ({ eventId, seq, turnId: "t", type: "tool/result",
  payload: { toolId: "read", result: { rows: [1] }, resultId: `res-${eventId}` } }) as unknown as SessionEvent;

test("O: a retained result judged needed is not judged again while the request is the same — across turns too", async () => {
  // Asked again a few messages on, a needed result rarely changes its verdict; each asking is a judgment on the step's path.
  const seen: JudgmentRequest[] = [];
  const memo = new JudgmentMemo();
  const signal = new AbortController().signal;
  const events = [retained("e1", 1), retained("e2", 2), assistant(3)];
  await createResultRelevance(relevanceJudge(seen), "on", "reconcile September", signal, new Set(), new Set(), memo)!(events);
  assert.equal(seen.length, 2);
  const later = [...events, assistant(4), assistant(5), assistant(6), assistant(7), assistant(8)];
  await createResultRelevance(relevanceJudge(seen), "on", "reconcile September", signal, new Set(), new Set(), memo)!(later);
  assert.equal(seen.length, 2, "a resume's new judge, many messages on: nothing asked again");
  await createResultRelevance(relevanceJudge(seen), "on", "now reconcile October", signal, new Set(), new Set(), memo)!(later);
  assert.equal(seen.length, 4, "a new request asks again");
});

test("O: in a real turn, each retained result is judged once however many steps follow", async () => {
  const pages = { id: "read_page", version: "1", description: "read", requiredPermissions: [], sideEffect: "none" as const, timeoutMs: 100, retainResult: true,
    inputSchema: { type: "object" }, outputSchema: {}, execute: async (invocation: { arguments: unknown }) => ({ page: (invocation.arguments as { page: number }).page, rows: "x".repeat(5_000) }) as JsonValue };
  const { adapter } = scriptedModel([1, 2, 3, 4, 5, 6].map((page) => call(`p${page}`, "read_page", { page })).concat(answer("Done.")));
  const port: JudgmentPort = { providerId: "fake", model: "fake", judge: async () => ({ modelId: "fake", answers: { needed: { type: "noul", noul: 0.9 } } as never }) };
  const { InMemoryToolResultSpool } = await import("@0xsyncroot/core");
  const { host, router } = await activeHost(adapter, [toolPlugin("pages", [pages]), judgment(port)]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxContextChars: 20_000 }, { judgmentSeams: { resultRelevance: "on" }, toolResultSpool: new InMemoryToolResultSpool() })
      .runTurn({ sessionId: "relevance-once", content: "read every page", security: security() });
    const retainedResults = result.events.filter((event) => event.type === "tool/result" && typeof (event.payload as { resultId?: unknown }).resultId === "string").length;
    assert.ok(seams(result.events, "result-relevance") <= retainedResults, `${seams(result.events, "result-relevance")} judgments for ${retainedResults} retained results`);
  } finally { await host.shutdown(); }
});
