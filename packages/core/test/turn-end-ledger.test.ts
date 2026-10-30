import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, LlmStreamEvent, SessionEvent, ToolDefinition, TurnControlPolicy, TurnTerminalDecision } from "@0xsyncroot/contracts";
import { DefaultAgentLoop, type ContinueQuestionWording } from "@0xsyncroot/core";
import { finalStepInstruction } from "../src/agent/final-step-instruction.js";
import { activeHost, answer, calls, planningPlugin, PLAN_TOOL_ID, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/**
 * A turn's end reads the sub-goal ledger: a partial end asks the user whether to go on only while the plan holds a step its
 * attributed results do not show done, and never on a partial the policy accepted on its own reason (a proven blocker). The
 * last step's digest lists each step's claimed status beside whether the results show it done.
 */
const read: ToolDefinition = {
  id: "test_read", version: "1", description: "read", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {},
  execute: async (invocation) => {
    const page = (invocation.arguments as { page?: number }).page ?? 1;
    if (page === 0) throw new Error("page 0 does not exist");
    return { page } as JsonValue;
  },
};
const WORDING: ContinueQuestionWording = { question: "Go on?", continueLabel: "Go on", stopLabel: "Stop", stopped: "Stopped." };
const SUMMARY = "The screen lists 13 allowances: PC01, PC02 and the rest.";

let planCalls = 0;
/** A plan update whose steps carry their own descriptions (`Step <id>`), and the reads of the same model step. */
const step = (plan: readonly (readonly [string, string])[], reads: readonly number[] = []): () => LlmStreamEvent => calls([
  { id: `plan-${planCalls += 1}`, name: PLAN_TOOL_ID, args: { goal: "Tell what the screen holds",
    steps: plan.map(([id, status]) => ({ id, description: `Step ${id}`, status })) } },
  ...reads.map((page, index) => ({ id: `read-${planCalls}-${index}`, name: "test_read", args: { page } })),
]);

/** A review that sends every answer back as unfinished work and objects to the closing answer too: the reviewed-to-the-end shape. */
const neverSatisfied: TurnControlPolicy = {
  id: "test.audit", revision: "v1", keepDraftsAsNarration: true, beforeModelStep: async () => ({}),
  reviewTerminal: async (state) => state.finalStep
    ? { decision: "continue", feedback: "Two figures are not in the observation.", fallback: "Some figures do not match the data read." }
    : { decision: "continue", feedback: "Two figures are not in the observation.", fallback: "Some figures do not match the data read.", workRemains: true },
};

async function run(sessionId: string, script: readonly (() => LlmStreamEvent)[], policy: TurnControlPolicy, options: { readonly maxSteps?: number } = {}) {
  const { adapter, requests } = scriptedModel(script);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read]), planningPlugin()]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: options.maxSteps ?? 48 }, { turnControlPolicy: policy, continueQuestion: WORDING })
      .runTurn({ sessionId, content: "open the allowance screen and tell me what it holds", security: security() });
    return { result, requests };
  } finally { await host.shutdown(); }
}

const decisions = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "turn/control-decision")
  .map((event) => `${(event.payload as { phase: string }).phase}:${(event.payload as { decision: string }).decision}`);

test("a read-only turn whose every sub-goal is shown ends partial without the continue card, however often its answer was sent back", async () => {
  const { result } = await run("ledger-shown", [step([["s1", "in_progress"]], [1]), step([["s1", "completed"]]), answer(SUMMARY), answer(SUMMARY), answer(SUMMARY)], neverSatisfied);
  assert.deepEqual(decisions(result.events), ["terminal:continue", "terminal:close", "terminal:accept"], "objected, closed on the same answer, closing answer stands");
  assert.equal(result.outcome, "partial");
  assert.equal(result.interaction, undefined, "the read that shows the one sub-goal done leaves nothing to go on with");
  assert.equal(result.events.some((event) => event.type === "interaction/requested"), false);
});

test("the same reviewed-to-the-end turn asks whether to go on while a plan step is left undone", async () => {
  const { result } = await run("ledger-undone", [step([["s1", "in_progress"], ["s2", "pending"]], [1]), answer(SUMMARY), answer(SUMMARY), answer(SUMMARY)], neverSatisfied);
  assert.deepEqual(decisions(result.events), ["terminal:continue", "terminal:close", "terminal:accept"]);
  assert.equal(result.outcome, "partial");
  assert.ok(result.interaction, "step s2 has no result to show for it");
});

test("a sub-goal claimed done whose only result failed is not shown, and the card asks", async () => {
  const { result } = await run("ledger-claimed", [step([["s1", "in_progress"]], [0]), step([["s1", "completed"]]), answer(SUMMARY), answer(SUMMARY), answer(SUMMARY)], neverSatisfied);
  assert.equal(result.outcome, "partial");
  assert.ok(result.interaction, "the model's claim is no evidence: the read it made failed");
});

test("with no plan, a read-only turn reviewed to the end by a figure audit ends partial without the card", async () => {
  const { result } = await run("ledger-no-plan-audit", [calls([{ id: "r1", name: "test_read", args: { page: 1 } }]), answer(SUMMARY), answer(SUMMARY), answer(SUMMARY)], neverSatisfied);
  assert.equal(result.events.some((event) => event.type === "work/plan-updated"), false, "no plan");
  assert.deepEqual(decisions(result.events), ["terminal:continue", "terminal:close", "terminal:accept"], "objected, closed on the same answer, closing answer stands");
  assert.equal(result.outcome, "partial");
  assert.equal(result.interaction, undefined, "a work-remains objection alone is no evidence that work is left");
  assert.equal(result.events.some((event) => event.type === "interaction/requested"), false);
});

test("with no plan, the fallback after spent work-remains objections ends partial without the card; the policy's notice stays", async () => {
  const policy: TurnControlPolicy = {
    id: "test.calls", revision: "v1", beforeModelStep: async () => ({}), reviewTerminal: async () => ({ decision: "accept" }),
    reviewToolCalls: async () => ({ decision: "continue", feedback: "Open the sheet first.", fallback: "The sheet is not open yet.", workRemains: true }),
  };
  const reads = Array.from({ length: 6 }, (_value, index) => calls([{ id: `r${index}`, name: "test_read", args: { page: 1 } }]));
  const { result } = await run("ledger-no-plan-fallback", [...reads, answer(SUMMARY)], policy);
  assert.equal(result.events.some((event) => event.type === "work/plan-updated"), false, "no plan");
  assert.deepEqual([result.outcome, result.content], ["partial", "The sheet is not open yet."]);
  assert.equal(result.interaction, undefined);
});

test("with no plan, the step allowance cutting the work still asks", async () => {
  const accept: TurnControlPolicy = { id: "test.accept", revision: "v1", beforeModelStep: async () => ({}), reviewTerminal: async () => ({ decision: "accept" }) };
  const reads = Array.from({ length: 3 }, (_value, index) => calls([{ id: `r${index}`, name: "test_read", args: { page: index + 1 } }]));
  const { result } = await run("ledger-no-plan-budget", [...reads, answer(SUMMARY)], accept, { maxSteps: 3 });
  assert.equal(result.outcome, "partial");
  assert.ok(result.interaction, "a runtime bound cut the work: some was left");
});

test("a blocker the policy proves ends partial without the card, though a plan step is left undone", async () => {
  const proven: TurnTerminalDecision = { decision: "accept", outcome: "partial", reason: "blocker-proven" };
  const policy: TurnControlPolicy = { id: "test.blocker", revision: "v1", beforeModelStep: async () => ({}), reviewTerminal: async () => proven };
  const { result } = await run("ledger-blocked", [step([["s1", "in_progress"], ["s2", "pending"]], [1]), answer("Part two cannot be read: the reader is down.")], policy);
  assert.equal(result.outcome, "partial");
  assert.equal(result.interaction, undefined);
});

test("the step allowance asks only while a sub-goal is left: a plan shown done ends without the card", async () => {
  const accept: TurnControlPolicy = { id: "test.accept", revision: "v1", beforeModelStep: async () => ({}), reviewTerminal: async () => ({ decision: "accept" }) };
  const done = await run("ledger-budget-done", [step([["s1", "in_progress"]], [1]), step([["s1", "completed"]], [2]), answer(SUMMARY)], accept, { maxSteps: 3 });
  assert.deepEqual([done.result.outcome, done.result.interaction], ["partial", undefined]);
  const left = await run("ledger-budget-left", [step([["s1", "in_progress"], ["s2", "pending"], ["s3", "pending"]], [1]),
    step([["s1", "completed"], ["s2", "in_progress"], ["s3", "pending"]]), answer(SUMMARY)], accept, { maxSteps: 3 });
  assert.equal(left.result.outcome, "partial");
  assert.ok(left.result.interaction, "s2 has nothing to show for it while s3 waits behind it");
});

test("the last step's digest lists each step's claimed status beside whether its results show it done", async () => {
  const accept: TurnControlPolicy = { id: "test.accept", revision: "v1", beforeModelStep: async () => ({}), reviewTerminal: async () => ({ decision: "accept" }) };
  const { requests } = await run("ledger-digest", [step([["s1", "in_progress"], ["s2", "pending"], ["s3", "pending"]], [0]),
    step([["s1", "completed"], ["s2", "in_progress"], ["s3", "pending"]], [1]), answer(SUMMARY)], accept, { maxSteps: 3 });
  const instruction = requests.at(-1)!.messages.map((message) => message.content ?? "").find((content) => content.includes("Your work plan"));
  assert.ok(instruction, "the closing step carries the digest");
  const lines = instruction.split("\n").filter((line) => line.startsWith("- [") && line.includes("Step s"));
  assert.deepEqual(lines, ["- [completed / not shown] Step s1", "- [in_progress / shown] Step s2", "- [pending / not shown] Step s3"]);
});

test("the digest shape: ids from the plan only, the step's own description and outcome, no runtime words per step", () => {
  const message = finalStepInstruction({ notes: [], stopReason: "progress-stalled", plan: {
    plan: { planId: "p", revision: 2, state: "active", goal: "g", updatedAt: "t", steps: [
      { id: "a", description: "Open the list", status: "completed", outcome: "13 rows" }, { id: "b", description: "Read row 14", status: "in_progress" },
    ] },
    shown: new Set(["a"]),
  } });
  const text = String(message.content);
  assert.ok(text.includes("Your work plan, each step as [the status you gave it / whether the results attributed to it show it done]:"));
  assert.ok(text.includes("- [completed / shown] Open the list — 13 rows\n- [in_progress / not shown] Read row 14"));
});
