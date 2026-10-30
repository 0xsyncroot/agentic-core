import assert from "node:assert/strict";
import test from "node:test";
import {
  AgenticError, assertValidCoreEventDraft, CAPABILITIES, type EventDraft, type JsonValue, type JudgmentPort, type JudgmentRequest,
  type JudgmentVerdict, type SessionEvent, type ToolDefinition, type TurnControlPolicy, type TurnJudge,
} from "@0xsyncroot/contracts";
import { DefaultAgentLoop, type JudgmentSeamMode } from "@0xsyncroot/core";
import { JUDGMENT_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { ANSWER_MOVED_ITEM_SEAM, ANSWER_MOVED_SEAM, ANSWER_STATES_VALUE_QUESTION, AnswerMovedCheck } from "../src/agent/answer-moved.js";
import { normalizedContentHash, validateTerminalDecision } from "../src/agent/turn-control.js";
import type { TurnEventWriter } from "../src/agent/turn-event-writer.js";
import { createTurnJudge } from "../src/agent/turn-judge.js";
import { workRemainsReview } from "../src/agent/work-remains-gate.js";
import { activeHost, answer, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/** The disputed values beside the answer-moved judgment: one gone from the new answer makes it moved, and nothing else changes. */
const signal = new AbortController().signal;
const draft = "Totals: A 3.264.300, B 20.";
const objection = "Contradicted by the evidence: 3.264.300; 20";

/** `moved`: the first judgment's P; `states`: per value, its P, or an Error the port throws. */
type Answers = { readonly moved: number; readonly states: Readonly<Record<string, number | Error>> };

function port(answers: () => Answers, asked: JudgmentRequest[] = []): JudgmentPort {
  return { providerId: "fake", model: "fake", judge: async (request) => {
    asked.push(request);
    const { moved, states } = answers();
    if ("moved" in request.questions) return { modelId: "fake", answers: { moved: { type: "noul", noul: moved } } };
    const value = states[(request.state as { value: string }).value];
    if (value === undefined || value instanceof Error) throw value ?? new AgenticError("permanent", "no answer");
    return { modelId: "fake", answers: { states: { type: "noul", noul: value } } };
  } };
}

/** A check on the real turn judge, its journal rows kept and each validated as the store would. */
function check(mode: Exclude<JudgmentSeamMode, "off">, answers: Answers) {
  const rows: EventDraft[] = [];
  const asked: JudgmentRequest[] = [];
  const writer = { append: async (drafts: readonly EventDraft[]) => { for (const row of drafts) { assertValidCoreEventDraft(row); rows.push(row); } } } as unknown as TurnEventWriter;
  const judge: TurnJudge = createTurnJudge(port(() => answers, asked), writer, "turn-1")!;
  const verdicts = () => rows.map((row) => [(row.payload as { seam: string }).seam, (row.payload as { verdict?: JudgmentVerdict }).verdict]);
  return { asked, rows, verdicts, check: new AnswerMovedCheck(judge, mode, "reconcile the sheets", signal) };
}

test("a disputed value gone from the new answer turns an unmoved reading into moved; the first row carries the final verdict", async () => {
  const { verdicts, check: seam } = check("on", { moved: 0.02, states: { "3.264.300": 0.03, "20": 0.97 } });
  seam.objected(draft, objection, 0, ["3.264.300", "20"]);
  assert.equal(await seam.unmoved("Totals: A as read, B 20.", normalizedContentHash(draft), 0), false);
  const rows = verdicts();
  assert.deepEqual(rows.at(-1), [ANSWER_MOVED_SEAM, { label: "moved", threshold: 0.1, mode: "on", sameHash: false }], "written once every value answered");
  assert.deepEqual(rows.slice(0, 2).sort(), [
    [ANSWER_MOVED_ITEM_SEAM, { label: "absent", threshold: 0.1, mode: "on", sameHash: false, item: "3.264.300" }],
    [ANSWER_MOVED_ITEM_SEAM, { label: "present", threshold: 0.1, mode: "on", sameHash: false, item: "20" }],
  ].sort());
});

test("every value still stated: the first judgment decides as before", async () => {
  const { verdicts, check: seam } = check("on", { moved: 0.02, states: { "3.264.300": 0.98, "20": 0.11 } });
  seam.objected(draft, objection, 0, ["3.264.300", "20"]);
  assert.equal(await seam.unmoved("Totals, reworded: A 3.264.300, B 20.", normalizedContentHash(draft), 0), true);
  assert.deepEqual(verdicts().at(-1), [ANSWER_MOVED_SEAM, { label: "unmoved", threshold: 0.1, mode: "on", sameHash: false }]);
});

test("the values never turn a moved answer into an unmoved one", async () => {
  for (const states of [{ "3.264.300": 0.99 }, { "3.264.300": 0.01 }]) {
    const { verdicts, check: seam } = check("on", { moved: 0.4, states });
    seam.objected(draft, objection, 0, ["3.264.300"]);
    assert.equal(await seam.unmoved("Totals: A 3.200.000.", normalizedContentHash(draft), 0), false);
    assert.equal((verdicts().at(-1)![1] as JudgmentVerdict).label, "moved");
  }
});

test("a value whose judgment fails vetoes nothing, and its failure is journaled", async () => {
  const { rows, check: seam } = check("on", { moved: 0.02, states: { "3.264.300": new AgenticError("permanent", "refused"), "20": 0.95 } });
  seam.objected(draft, objection, 0, ["3.264.300", "20"]);
  assert.equal(await seam.unmoved("Totals, reworded.", normalizedContentHash(draft), 0), true);
  assert.deepEqual(rows.map((row) => [(row.payload as { seam: string }).seam, (row.payload as { outcome: string }).outcome]).sort(),
    [[ANSWER_MOVED_ITEM_SEAM, "answered"], [ANSWER_MOVED_ITEM_SEAM, "failed"], [ANSWER_MOVED_SEAM, "answered"]].sort());
});

test("no disputed values: only the first judgment is asked; each value is asked on its state, its answer cut as the drafts are", async () => {
  const bare = check("on", { moved: 0.02, states: {} });
  bare.check.objected(draft, objection, 0);
  assert.equal(await bare.check.unmoved("Totals, reworded.", normalizedContentHash(draft), 0), true);
  assert.equal(bare.asked.length, 1);
  const { asked, check: seam } = check("on", { moved: 0.9, states: { "3.264.300": 0.9 } });
  seam.objected(draft, objection, 0, ["3.264.300"]);
  await seam.unmoved("y".repeat(5_000), normalizedContentHash(draft), 0);
  const item = asked.find((request) => "states" in request.questions)!;
  assert.deepEqual(item.questions, { states: ANSWER_STATES_VALUE_QUESTION });
  assert.deepEqual(item.state, { value: "3.264.300", answer: "y".repeat(4_000) });
});

test("shadow: the values are asked and journaled, and nothing is decided", async () => {
  const { verdicts, check: seam } = check("shadow", { moved: 0.02, states: { "3.264.300": 0.01 } });
  seam.objected(draft, objection, 0, ["3.264.300"]);
  assert.equal(await seam.unmoved("Totals, reworded.", normalizedContentHash(draft), 0), false);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(verdicts().map(([name, verdict]) => [name, (verdict as JudgmentVerdict).label, (verdict as JudgmentVerdict).mode]),
    [[ANSWER_MOVED_ITEM_SEAM, "absent", "shadow"], [ANSWER_MOVED_SEAM, "moved", "shadow"]]);
});

test("a policy's disputed values are validated and carried to the gate's objection; phrases or none carry nothing", () => {
  const decision = validateTerminalDecision({ decision: "continue", feedback: "Two figures differ.", workRemains: true, objection: { disputed: ["3.264.300", "20"] } });
  assert.deepEqual(decision.decision === "continue" && decision.objection, { disputed: ["3.264.300", "20"] });
  for (const disputed of [[""], Array.from({ length: 9 }, (_, index) => `${index}`), ["x".repeat(301)], "3.264.300"]) {
    assert.throws(() => validateTerminalDecision({ decision: "continue", feedback: "f", objection: { disputed } }), /disputed/u);
  }
  assert.equal("objection" in validateTerminalDecision({ decision: "continue", feedback: "f", objection: { disputed: [] } }), false);
  const objections = { heard: 1, fallbackDue: false, spent: false, objectedAnswer: normalizedContentHash(draft)! };
  const review = workRemainsReview("terminal", decision as Extract<typeof decision, { decision: "continue" }>, objections, false, "Reworded.");
  assert.deepEqual(review.kind === "continue" && review.disputed, ["3.264.300", "20"]);
});

/** In a real turn: the policy disputes a value; the reworded repeat drops it, so the work is not closed as unmoved. */
const read: ToolDefinition = {
  id: "test_read", version: "1", description: "read", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {}, execute: async () => ({ page: 1 }) as JsonValue,
};
const judgment = (answers: Answers): PluginDescriptor => ({
  trustTier: "platform-core",
  manifest: { manifestVersion: 1, id: "io.syncroot.test.judgment", version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
    artifact: { digest: "builtin:judgment", signature: "test" }, requires: {},
    provides: { [CAPABILITIES.judgment]: { version: "1.0.0", cardinality: "single" } }, permissions: {} },
  plugin: { validate: async () => ({ valid: true }), activate: async (context) => {
    context.registrations.provide(JUDGMENT_CAPABILITY, port(() => answers));
    return { dispose: () => undefined };
  } },
});
const policy: TurnControlPolicy = {
  id: "p", revision: "v1", beforeModelStep: async () => ({}),
  reviewTerminal: async () => ({ decision: "continue", feedback: objection, fallback: "Two figures differ.", workRemains: true, objection: { disputed: ["3.264.300"] } }),
};
const decisions = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "turn/control-decision")
  .map((event) => `${(event.payload as { phase: string }).phase}:${(event.payload as { decision: string }).decision}`);

async function run(answers: Answers | undefined) {
  const { adapter } = scriptedModel([answer(draft), answer("Totals: A as read."), answer("Totals: A, as read."), answer("Totals, as read!"), answer("Closing.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read]), ...(answers ? [judgment(answers)] : [])]);
  try {
    return await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 12 }, { turnControlPolicy: policy, ...(answers ? { judgmentSeams: { answerMoved: "on" } } : {}) })
      .runTurn({ sessionId: `answer-moved-values-${Math.random()}`, content: "reconcile the sheets", security: security() });
  } finally { await host.shutdown(); }
}

test("in a turn: a value gone from the reworded answer keeps it from closing as unmoved; a value still stated lets it close", async () => {
  const vetoed = await run({ moved: 0.02, states: { "3.264.300": 0.01 } });
  assert.deepEqual(decisions(vetoed.events), decisions((await run(undefined)).events), "the hash decides alone, lap for lap");
  const stated = await run({ moved: 0.02, states: { "3.264.300": 0.99 } });
  assert.deepEqual(decisions(stated.events), ["terminal:continue", "terminal:close", "terminal:accept"]);
});
