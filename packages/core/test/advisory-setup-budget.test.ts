import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITIES, type JudgmentPort, type JudgmentRequest, type JudgmentResult } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { JUDGMENT_CAPABILITY, SYSTEM_PROMPT_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { withinBudget } from "../src/agent/turn-open-waits.js";
import { activeHost, answer, scriptedModel, security, SpyStore } from "./turn-harness.js";

/**
 * The advisory judgments of a turn's open (skill and tool relevance) only trim what the turn is offered. They are waited for
 * up to the setup budget; past it the turn is offered everything and its first model call goes out, while the abandoned
 * judgment finishes on its own and its rejection is nobody's unhandled error. The deciding skill suggestion is not bounded.
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
const judgment = (judge: JudgmentPort["judge"]): PluginDescriptor => plugin("judgment", CAPABILITIES.judgment, async (context) => {
  context.registrations.provide(JUDGMENT_CAPABILITY, { providerId: "fake", model: "fake", judge });
  return { dispose: () => undefined };
});
const skills = plugin("prompt", CAPABILITIES.systemPrompt, async (context) => {
  context.registrations.provide(SYSTEM_PROMPT_CAPABILITY, {
    id: "test.skills", conditionalSkills: [{ id: "x.payroll", name: "Payroll", description: "payroll writes" }],
    loadableSkills: [{ id: "x.recon", name: "reconcile", description: "compare two payrolls" }], skillLoader: { toolId: "skill_load", argument: "skill_id" },
    render: async (_security, turn) => (turn?.skippedSkills?.has("x.payroll") ? "CORE ONLY" : "CORE + PAYROLL SKILL"),
  });
  return { dispose: () => undefined };
});
const later = <T>(ms: number, value: () => T): Promise<T> => new Promise((resolve, reject) => setTimeout(() => { try { resolve(value()); } catch (error) { reject(error); } }, ms));

/** A judge that answers `skill-relevance` (not needed) and `skill-suggestion` (fits) after `delays` ms, or fails the relevance call. */
function slowJudge(delays: { readonly relevance: number; readonly suggestion: number }, relevanceFails = false): JudgmentPort["judge"] {
  return (request: JudgmentRequest): Promise<JudgmentResult> => "needed" in request.questions
    ? later(delays.relevance, () => { if (relevanceFails) throw new Error("judge failed late"); return { modelId: "fake", answers: { needed: { type: "noul", noul: 0.01 } } }; })
    : later(delays.suggestion, () => ({ modelId: "fake", answers: { fits: { type: "noul", noul: 0.99 } } }));
}

async function firstRequest(judge: JudgmentPort["judge"], advisorySetupBudgetMs: number) {
  const { adapter, requests } = scriptedModel([answer("Xong.")]);
  const { host, router } = await activeHost(adapter, [skills, judgment(judge)]);
  const started = performance.now();
  let askedAt = 0;
  const stream = adapter.stream.bind(adapter);
  adapter.stream = (request, signal) => { askedAt ||= performance.now() - started; return stream(request, signal); };
  try {
    await new DefaultAgentLoop(router, new SpyStore(), { advisorySetupBudgetMs }, { judgmentSeams: { skillRelevance: "on" } })
      .runTurn({ sessionId: `budget-${Math.random()}`, content: "đối soát bảng lương", security: security() });
    return { text: requests[0]!.messages.map((message) => message.content ?? "").join("\n"), askedAt };
  } finally { await host.shutdown(); }
}

test("a relevance verdict inside the budget still trims the turn, exactly as before", async () => {
  const { text } = await firstRequest(slowJudge({ relevance: 5, suggestion: 5 }), 800);
  assert.match(text, /CORE ONLY/u);
});

test("past the budget the turn is offered every skill and its first call goes out without waiting for the advisory verdict", async () => {
  const { text, askedAt } = await firstRequest(slowJudge({ relevance: 600, suggestion: 5 }), 40);
  assert.match(text, /CORE \+ PAYROLL SKILL/u, "no verdict in time keeps the skill");
  assert.ok(askedAt < 400, `the first model call went out at ${Math.round(askedAt)} ms, not after the 600 ms judgment`);
});

test("the deciding skill suggestion is not bounded by the advisory budget", async () => {
  const { text, askedAt } = await firstRequest(slowJudge({ relevance: 5, suggestion: 200 }), 40);
  assert.match(text, /skill "reconcile"/u, "the suggestion that came after the budget is still named");
  assert.ok(askedAt >= 190, "the open waited for it");
});

test("an abandoned judgment that fails after the budget is never an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const { text } = await firstRequest(slowJudge({ relevance: 100, suggestion: 5 }, true), 20);
    assert.match(text, /CORE \+ PAYROLL SKILL/u);
    // The abandoned call settles after the turn ended: its failure row cannot be journaled any more, and that rejection is caught too.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(unhandled, []);
  } finally { process.off("unhandledRejection", onUnhandled); }
});

test("withinBudget: the verdict when it comes in time, the unjudged value at the budget, an early failure fails the wait", async () => {
  assert.equal(await withinBudget(later(5, () => "judged"), "unjudged", 100), "judged");
  assert.equal(await withinBudget(later(100, () => "judged"), "unjudged", 5), "unjudged");
  await assert.rejects(withinBudget(later(5, () => { throw new Error("aborted"); }), "unjudged", 100), /aborted/u);
});
