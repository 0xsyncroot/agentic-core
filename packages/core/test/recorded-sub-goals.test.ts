import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCall, ToolDefinition, WorkPlan } from "@0xsyncroot/contracts";
import { SubGoalLedger } from "../src/agent/sub-goal-ledger.js";
import type { SettledOutcome } from "../src/agent/tool-batch-types.js";
import { RecordedSubGoals } from "./replay/recorded-sub-goals.js";
import type { CallFacts, RunFacts, StepFacts } from "./replay/step-facts.js";

/**
 * The turn-end replay rebuilds the sub-goal ledger from recorded plan and call facts (`RecordedSubGoals`) instead of running
 * `SubGoalLedger`. Every plan of three steps, in every claimed status, with every combination of attributed results per step,
 * is given to both: they must answer `undone` alike, so a change to the runtime's evidence rule cannot leave the replay's
 * card counts describing the old one. A write failing after an earlier success is outside the comparison: the fixture holds no
 * side effect for a failed call.
 */
const STATUSES = ["pending", "in_progress", "completed"] as const;
type Status = typeof STATUSES[number];
/** What the results attributed to one step were: nothing, a call that did its work, a call that failed, one that ran and reported failure, or a failure then a success. */
const RESULTS = ["none", "ok", "failed", "reported-failed", "failed-then-ok"] as const;
type Result = typeof RESULTS[number];

const definition = { id: "work_tool", sideEffect: "none" } as ToolDefinition;
const settled = (kind: "ok" | "failed" | "reported-failed"): SettledOutcome => ({
  executionId: "e", dispatched: true,
  ...(kind === "ok" ? { state: "succeeded", result: { rows: 1 } }
    : kind === "failed" ? { state: "failed", error: { type: "tool_error", code: "unavailable", retryable: false, message: "down" } }
      : { state: "succeeded", result: { type: "tool_error", code: "refused" } }),
}) as SettledOutcome;
const callsOf = (result: Result): readonly ("ok" | "failed" | "reported-failed")[] =>
  result === "none" ? [] : result === "failed-then-ok" ? ["failed", "ok"] : [result];
const facts = (kind: "ok" | "failed" | "reported-failed", workStep: number): CallFacts => ({
  state: kind === "failed" ? "failed" : "succeeded", dispatched: true, workStep,
  credited: kind !== "failed", failure: kind !== "ok",
});

function runtimeUndone(statuses: readonly Status[], results: readonly Result[]): boolean | undefined {
  const plan: WorkPlan = { planId: "p", revision: 1, state: "active", goal: "g", updatedAt: "", steps: statuses.map((status, index) => ({ id: `s${index + 1}`, description: `d${index}`, status })) };
  const ledger = new SubGoalLedger();
  results.forEach((result, index) => callsOf(result).forEach((kind, order) => {
    const call = { id: `c${index}-${order}`, name: "work_tool", arguments: "{}" } as ToolCall;
    ledger.observe(plan, `s${index + 1}`, call, definition, settled(kind));
  }));
  return ledger.undone(plan);
}

function replayUndone(statuses: readonly Status[], results: readonly Result[]): boolean | undefined {
  const sub = new RecordedSubGoals({ resume: "none" } as RunFacts);
  const calls = results.flatMap((result, index) => callsOf(result).map((kind) => facts(kind, index + 1)));
  sub.ran({ calls, plan: { state: "active", steps: statuses.map((status, index) => ({ id: index + 1, status })) } } as unknown as StepFacts);
  return sub.undone();
}

test("the replay's ledger answers undone as the runtime's SubGoalLedger does, for every plan and every attributed result", () => {
  let compared = 0;
  const product = <T>(options: readonly T[]): T[][] => options.flatMap((first) => options.flatMap((second) => options.map((third) => [first, second, third])));
  for (const statuses of product(STATUSES)) {
    for (const results of product(RESULTS)) {
      assert.equal(replayUndone(statuses, results), runtimeUndone(statuses, results), `claimed ${statuses.join(",")} results ${results.join(",")}`);
      compared += 1;
    }
  }
  assert.equal(compared, 27 * 125);
});

test("the comparison sees an evidence rule that moves: a claim trusted over its failed result changes the runtime's answer", () => {
  assert.equal(runtimeUndone(["completed"], ["failed"]), true, "the claim is no evidence when the only result failed");
  assert.equal(runtimeUndone(["completed"], ["ok"]), false);
  assert.equal(runtimeUndone(["completed"], ["reported-failed"]), true, "a call that ran and reported failure shows nothing");
  assert.equal(runtimeUndone(["completed"], ["failed-then-ok"]), false);
});
