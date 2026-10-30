import assert from "node:assert/strict";
import test from "node:test";
import { AgenticError, CAPABILITIES, type JsonValue, type JudgmentPort, type JudgmentRequest, type JudgmentVerdict, type SessionEvent, type ToolDefinition, type TurnControlPolicy, type TurnJudge } from "@0xsyncroot/contracts";
import { DefaultAgentLoop, type JudgmentSeamMode } from "@0xsyncroot/core";
import { JUDGMENT_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { ANSWER_MOVED_QUESTION, AnswerMovedCheck } from "../src/agent/answer-moved.js";
import { normalizedContentHash } from "../src/agent/turn-control.js";
import { workRemainsReview } from "../src/agent/work-remains-gate.js";
import { activeHost, answer, call, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/** The judged "same answer" beside the work-remains gate's content hash: asked where the hash is, its verdict on the judge's row. */
const signal = new AbortController().signal;
const draft = "Totals: A 10, B 20.";

function check(mode: Exclude<JudgmentSeamMode, "off">, moved: number | undefined) {
  const asked: JudgmentRequest[] = [];
  const verdicts: (JudgmentVerdict | undefined)[] = [];
  const judge: TurnJudge = async (_seam, request, _signal, options) => {
    asked.push(request);
    if (moved === undefined) return undefined;
    const answers = { moved: { type: "noul", noul: moved } } as const;
    verdicts.push(await options?.verdict?.(answers));
    return { modelId: "fake", answers };
  };
  return { asked, verdicts, check: new AnswerMovedCheck(judge, mode, "reconcile the sheets", signal) };
}
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("nothing is asked without an objected draft, or once a new result has cleared the gate's hash", async () => {
  const fresh = check("on", 0.01);
  assert.equal(await fresh.check.unmoved("Totals again.", normalizedContentHash(draft), 0), false);
  fresh.check.objected(draft, "The totals do not match.", 2);
  assert.equal(await fresh.check.unmoved("Totals again.", undefined, 2), false, "a new result since: the gate compares nothing");
  assert.equal(await fresh.check.unmoved("Totals again.", normalizedContentHash("another draft"), 2), false);
  assert.equal(fresh.asked.length, 0);
});

test("the state is the research's: request, objection, both drafts and the calls since; the question is c1.v1", async () => {
  const { asked, check: seam } = check("on", 0.9);
  seam.objected(draft, "The totals do not match.", 2);
  await seam.unmoved(`${"x".repeat(5_000)}`, normalizedContentHash(draft), 5);
  assert.deepEqual(asked[0]!.questions, { moved: ANSWER_MOVED_QUESTION });
  const state = asked[0]!.state as Record<string, JsonValue>;
  assert.deepEqual(Object.keys(state), ["request", "objection", "previousAnswer", "newAnswer", "newToolResultsSinceObjection"]);
  assert.equal(state.previousAnswer, draft);
  assert.equal((state.newAnswer as string).length, 4_000, "a draft is cut where the measured states ended");
  assert.equal(state.newToolResultsSinceObjection, 3);
});

test("shadow: every answer is judged, identical ones too, and the verdict never decides", async () => {
  const { verdicts, check: seam } = check("shadow", 0.02);
  seam.objected(draft, "The totals do not match.", 0);
  assert.equal(await seam.unmoved("Totals, reworded: A 10, B 20.", normalizedContentHash(draft), 0), false);
  assert.equal(await seam.unmoved(draft, normalizedContentHash(draft), 0), false);
  await settled();
  assert.deepEqual(verdicts, [{ label: "unmoved", threshold: 0.1, mode: "shadow", sameHash: false }, { label: "unmoved", threshold: 0.1, mode: "shadow", sameHash: true }]);
});

test("on: the verdict decides at the threshold; an identical repeat is the hash's; a failed judgment decides nothing", async () => {
  for (const [moved, unmoved, label] of [[0.1, true, "unmoved"], [0.11, false, "moved"]] as const) {
    const { verdicts, check: seam } = check("on", moved);
    seam.objected(draft, "The totals do not match.", 0);
    assert.equal(await seam.unmoved("Totals, reworded.", normalizedContentHash(draft), 0), unmoved);
    assert.deepEqual(verdicts, [{ label, threshold: 0.1, mode: "on", sameHash: false }]);
  }
  const identical = check("on", 0.9);
  identical.check.objected(draft, "The totals do not match.", 0);
  assert.equal(await identical.check.unmoved(draft, normalizedContentHash(draft), 0), false, "the gate's hash already ends it");
  assert.equal(identical.asked.length, 0);
  const failed = check("on", undefined);
  failed.check.objected(draft, "The totals do not match.", 0);
  assert.equal(await failed.check.unmoved("Reworded.", normalizedContentHash(draft), 0), false);
});

test("the gate: a judged-unmoved answer closes the work as an identical one does; otherwise the hash alone decides", () => {
  const objections = { heard: 1, fallbackDue: false, spent: false, objectedAnswer: normalizedContentHash(draft)! };
  const decision = { decision: "continue", feedback: "Two sheets are unread.", fallback: "Still unread.", workRemains: true } as const;
  assert.equal(workRemainsReview("terminal", decision, objections, false, "Reworded.", true).kind, "close");
  assert.equal(workRemainsReview("terminal", decision, objections, false, "Reworded.", false).kind, "continue");
  assert.equal(workRemainsReview("terminal", decision, objections, false, draft, false).kind, "close");
  // An answer the policy's judge read as delivering a result stands instead, with the notice: no closing step rewrites it.
  const stands = { kind: "proceed", terminalDecision: { decision: "accept", outcome: "partial", reason: "work-remains-unmoved", notice: "Still unread." }, delivered: true };
  assert.deepEqual(workRemainsReview("terminal", { ...decision, delivered: true }, objections, false, "Reworded.", true), stands);
  assert.deepEqual(workRemainsReview("terminal", { ...decision, delivered: true }, objections, false, draft, false), stands);
  assert.equal(workRemainsReview("terminal", decision, { ...objections, objectedAnswer: undefined }, false, "Reworded.", true).kind, "continue",
    "a new result since the objection: nothing is the same answer");
});

/** In a real turn: a reworded repeat under a "work remains" objection, which the hash cannot tell from a new answer. */
const read: ToolDefinition = {
  id: "test_read", version: "1", description: "read", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {}, execute: async () => ({ page: 1 }) as JsonValue,
};
const judgment = (moved: () => number | Error): PluginDescriptor => ({
  trustTier: "platform-core",
  manifest: { manifestVersion: 1, id: "io.syncroot.test.judgment", version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
    artifact: { digest: "builtin:judgment", signature: "test" }, requires: {},
    provides: { [CAPABILITIES.judgment]: { version: "1.0.0", cardinality: "single" } }, permissions: {} },
  plugin: { validate: async () => ({ valid: true }), activate: async (context) => {
    const port: JudgmentPort = { providerId: "fake", model: "fake", judge: async () => {
      const value = moved();
      if (value instanceof Error) throw value;
      return { modelId: "fake", answers: { moved: { type: "noul", noul: value } } };
    } };
    context.registrations.provide(JUDGMENT_CAPABILITY, port);
    return { dispose: () => undefined };
  } },
});
const policy: TurnControlPolicy = {
  id: "p", revision: "v1", beforeModelStep: async () => ({}),
  reviewTerminal: async () => ({ decision: "continue", feedback: "Two sheets are unread.", fallback: "Two sheets are still unread.", workRemains: true }),
};
const decisions = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "turn/control-decision")
  .map((event) => `${(event.payload as { phase: string }).phase}:${(event.payload as { decision: string }).decision}`);
const seams = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "judgment/classified").map((event) => (event.payload as { seam: string }).seam);

async function run(answerMoved: JudgmentSeamMode | undefined, moved: () => number | Error) {
  const { adapter } = scriptedModel([answer("Sheet 1 read."), answer("Sheet 1 is read."), answer("Sheet 1, read."), answer("Sheet 1 read!"), answer("Closing.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read]), judgment(moved)]);
  try {
    return await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 12 }, { turnControlPolicy: policy, ...(answerMoved ? { judgmentSeams: { answerMoved } } : {}) })
      .runTurn({ sessionId: `answer-moved-${Math.random()}`, content: "read every sheet", security: security() });
  } finally { await host.shutdown(); }
}

const verdictRows = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "judgment/classified")
  .map((event) => (event.payload as { verdict?: JudgmentVerdict }).verdict);

test("shadow in a turn: every decision is the hash's, and each answer after an objection is judged on one row with its verdict", async () => {
  const without = await run(undefined, () => 0.02);
  const shadow = await run("shadow", () => 0.02);
  assert.deepEqual(decisions(shadow.events), decisions(without.events));
  assert.equal(shadow.content, without.content);
  assert.deepEqual(seams(without.events), []);
  assert.deepEqual(seams(shadow.events), ["answer-moved", "answer-moved", "answer-moved", "answer-moved"],
    "each answer after the first, the closing step's included, is weighed against the one objected before it");
  assert.deepEqual(verdictRows(shadow.events)[0], { label: "unmoved", threshold: 0.1, mode: "shadow", sameHash: false });
});

test("on in a turn: a reworded repeat the judge reads as unmoved closes the work; a moved one is sent back as before", async () => {
  const unmoved = await run("on", () => 0.02);
  assert.deepEqual(decisions(unmoved.events), ["terminal:continue", "terminal:close", "terminal:accept"]);
  assert.deepEqual(verdictRows(unmoved.events)[0], { label: "unmoved", threshold: 0.1, mode: "on", sameHash: false });
  const moved = await run("on", () => 0.97);
  assert.deepEqual(decisions(moved.events), decisions((await run(undefined, () => 0.97)).events));
});

test("on in a turn: a judgment that fails leaves the hash deciding, lap for lap", async () => {
  const failed = await run("on", () => new AgenticError("transient", "gateway down", false));
  const without = await run(undefined, () => 0.02);
  assert.deepEqual(decisions(failed.events), decisions(without.events));
  assert.equal(failed.content, without.content);
  assert.ok(failed.events.some((event) => event.type === "judgment/classified" && (event.payload as { outcome: string }).outcome === "failed"));
});
