import assert from "node:assert/strict";
import { test } from "node:test";
import { WORK_PLAN_LIMITS, WORK_STEP_ID_PATTERN, type WorkPlanProposal, type WorkPlanStep } from "@0xsyncroot/contracts";
import { changedStepIds, mergeProposal, normalizedWording, unresolvedStepIds } from "../src/agent/work-plan-merge.js";

function step(id: string, description: string, status: WorkPlanStep["status"], outcome?: string): WorkPlanStep {
  return { id, description, status, ...(outcome ? { outcome } : {}) };
}

function proposal(steps: WorkPlanProposal["steps"], goal = "Do the work"): WorkPlanProposal {
  return { goal, steps };
}

test("a renumbered plan keeps a completed step's identity by wording, never fails, and notes the id change", () => {
  const base = [step("lookup", "Look up the record", "completed", "Found it"), step("verify", "Verify it", "in_progress")];
  // The model renumbered every id but kept the wording — a plan a strict id match would have lost.
  const result = mergeProposal(base, proposal([
    { id: "step-1", description: "Look up the record", status: "completed" },
    { id: "step-2", description: "Verify it", status: "in_progress" },
  ]), "active");
  assert.deepEqual(result.steps.map((s) => [s.id, s.status, s.outcome]), [
    ["lookup", "completed", "Found it"], ["verify", "in_progress", undefined],
  ]);
  assert.ok(result.notes.some((note) => /continues step "lookup"/u.test(note)));
});

test("a completed step the model dropped is carried forward after the step it followed; an unfinished one is not", () => {
  const base = [
    step("a", "Step A", "completed"), step("b", "Step B", "in_progress"), step("c", "Step C", "pending"),
  ];
  // The model's update only mentions B, now completed, and adds a new step D — A and C both vanish,
  // but only A (completed) survives; C (never finished) is dropped as a changed approach.
  const result = mergeProposal(base, proposal([
    { id: "b", description: "Step B", status: "completed" },
    { id: "d", description: "Step D", status: "in_progress" },
  ]), "active");
  assert.deepEqual(result.steps.map((s) => s.id), ["a", "b", "d"]);
  assert.equal(result.steps[0]!.status, "completed");
});

test("a completed step never regresses even when the model resends it unfinished", () => {
  const base = [step("a", "Step A", "completed", "Done"), step("b", "Step B", "in_progress")];
  const result = mergeProposal(base, proposal([
    { id: "a", description: "Step A", status: "in_progress" }, { id: "b", description: "Step B", status: "completed" },
  ]), "active");
  assert.deepEqual(result.steps.map((s) => [s.id, s.status]), [["a", "completed"], ["b", "completed"]]);
  assert.ok(result.notes.some((note) => /already completed/u.test(note)));
});

test("more than one step in progress keeps the first; no step in progress promotes the first pending", () => {
  const twoInProgress = mergeProposal(undefined, proposal([
    { id: "a", description: "A", status: "in_progress" }, { id: "b", description: "B", status: "in_progress" },
  ]), "active");
  assert.deepEqual(twoInProgress.steps.map((s) => s.status), ["in_progress", "pending"]);

  const noneInProgress = mergeProposal(undefined, proposal([
    { id: "a", description: "A", status: "pending" }, { id: "b", description: "B", status: "pending" },
  ]), "active");
  assert.deepEqual(noneInProgress.steps.map((s) => s.status), ["in_progress", "pending"]);
});

test("a plan over the step limit is truncated, and the cut is noted", () => {
  const steps = Array.from({ length: WORK_PLAN_LIMITS.steps + 5 }, (_, index) => (
    { id: `s${index}`, description: `Step ${index}`, status: "pending" as const }
  ));
  const result = mergeProposal(undefined, proposal(steps), "active");
  assert.equal(result.steps.length, WORK_PLAN_LIMITS.steps);
  assert.ok(result.notes.some((note) => /at most/u.test(note)));
});

test("step ids the runtime carries are always safe: Vietnamese and punctuation fold to the pattern, and stay unique", () => {
  const result = mergeProposal(undefined, proposal([
    { id: "Kiểm tra dữ liệu tháng 8", description: "Check August data", status: "in_progress" },
    { id: "Kiểm tra dữ liệu tháng 8!!", description: "A different step", status: "pending" },
  ]), "active");
  for (const s of result.steps) assert.ok(WORK_STEP_ID_PATTERN.test(s.id), `"${s.id}" must match the safe id pattern`);
  assert.equal(new Set(result.steps.map((s) => s.id)).size, 2, "ids stay unique even when they fold to the same text");
});

test("dormant matching goes by wording only; an id that happens to collide never continues the wrong step", () => {
  const base = [step("1", "Confirm the payroll period", "in_progress")];
  // A fresh plan numbers its steps from 1 again — the same id as a dormant step's ordinal must not match it.
  const noMatch = mergeProposal(base, proposal([{ id: "1", description: "Something unrelated", status: "in_progress" }]), "dormant");
  assert.equal(noMatch.matched, 0);
  const wordingMatch = mergeProposal(base, proposal([{ id: "step-1", description: "confirm   the payroll period", status: "completed" }]), "dormant");
  assert.equal(wordingMatch.matched, 1);
  assert.equal(wordingMatch.steps[0]!.id, "1", "the dormant step's own id is kept");
});

test("normalizedWording folds whitespace and case for matching, without changing the stored description", () => {
  assert.equal(normalizedWording("  Confirm   the Period "), "confirm the period");
});

test("changedStepIds reports status, description and outcome changes, and every new step", () => {
  const before = [step("a", "A", "in_progress"), step("b", "B", "pending")];
  const after = [step("a", "A", "completed", "Done"), step("b", "B", "pending"), step("c", "C", "pending")];
  assert.deepEqual(changedStepIds(before, after), ["a", "c"]);
  assert.deepEqual(changedStepIds(before, before), []);
});

test("a step sent by id alone takes the stored description, status and outcome from the proposal, and never throws", () => {
  const base = [step("a", "Step A", "completed", "Done"), step("b", "Step B", "in_progress"), step("c", "Step C", "pending")];
  const result = mergeProposal(base, proposal([
    { id: "a", status: "completed" }, { id: "b", status: "completed", outcome: "Checked" }, { id: "c", status: "in_progress" },
  ]), "active");
  assert.deepEqual(result.steps.map((s) => [s.id, s.description, s.status, s.outcome]), [
    ["a", "Step A", "completed", "Done"], ["b", "Step B", "completed", "Checked"], ["c", "Step C", "in_progress", undefined],
  ]);
  assert.equal(result.matched, 3);
  assert.deepEqual(result.notes, []);
});

test("a step sent by an id no base step holds is described by its id instead of throwing; unresolvedStepIds names it", () => {
  const base = [step("a", "Step A", "in_progress")];
  const sent = proposal([{ id: "a", status: "in_progress" }, { id: "ghost", status: "pending" }]);
  assert.deepEqual(unresolvedStepIds(base, sent), ["ghost"]);
  assert.deepEqual(unresolvedStepIds(undefined, sent), ["a", "ghost"]);
  assert.deepEqual(unresolvedStepIds(base, proposal([{ id: "x", description: "New", status: "pending" }])), []);
  const result = mergeProposal(base, sent, "active");
  assert.deepEqual(result.steps.map((s) => [s.id, s.description]), [["a", "Step A"], ["ghost", "ghost"]]);
  assert.doesNotThrow(() => mergeProposal(undefined, sent, "active"));
});
