import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentProgressEvent, JsonValue, SessionEvent, ToolDefinition, TurnControlPolicy, WorkPlanningProvider, WorkPlanProposal, WorkPlanStep } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { createWorkPlanningPlugin } from "@0xsyncroot/plugins-base";
import { WorkPlanLedger } from "../src/agent/work-plan-ledger.js";
import { activeHost, answer, calls, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/**
 * A step mark moves the plan's progress by a step id, without the model restating the plan: the ledger merges the status and
 * the outcome (the step's result line the user reads) onto the plan it keeps, keeps one step in progress (so the next work call is attributed to a step), journals the change as any plan
 * change, and refuses an id the plan does not hold by naming the ids it does. The plan closes with the answer, so a turn needs
 * no plan-only step before it.
 */
const tool = (id: string): ToolDefinition => ({
  id, version: "1.0.0", description: id, inputSchema: {}, outputSchema: {}, requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  execute: async () => null,
});
const PROVIDER: WorkPlanningProvider = {
  definition: tool("test_plan_update"), parseProposal: (args) => args as unknown as WorkPlanProposal,
  markDefinition: tool("test_plan_mark"), parseMark: (args) => args as unknown as Required<Pick<WorkPlanStep, "id" | "status" | "outcome">>,
};

function ledgerWithPlan(statuses: readonly (readonly [string, WorkPlanStep["status"]])[]) {
  const ledger = WorkPlanLedger.restore({ turnId: "t1", isUserTurn: true, workPlanning: PROVIDER, events: [], taskTurnIds: ["t1"], report: () => undefined });
  const proposed = ledger.propose({ goal: "Đối chiếu bảng", steps: statuses.map(([id, status]) => ({ id, description: `Bước ${id}`, status })) });
  assert.equal(proposed.ok, true);
  return ledger;
}

test("marking the step in progress completed sets its outcome, keeps every other step and wording, and the next pending step is now in progress", () => {
  const ledger = ledgerWithPlan([["read", "in_progress"], ["check", "pending"], ["report", "pending"]]);
  const before = ledger.workPlan!;
  const outcome = ledger.mark({ id: "read", status: "completed", outcome: "Đã đọc 152 nhân viên." });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.plan.steps, [
    { id: "read", description: "Bước read", status: "completed", outcome: "Đã đọc 152 nhân viên." },
    { id: "check", description: "Bước check", status: "in_progress" },
    { id: "report", description: "Bước report", status: "pending" },
  ]);
  assert.equal(outcome.plan.goal, before.goal);
  assert.equal(outcome.plan.planId, before.planId);
  assert.equal(outcome.plan.revision, before.revision! + 1);
  assert.deepEqual(outcome.changedStepIds, ["read", "check"]);
  assert.deepEqual(outcome.notes, ['No step was in progress; "check" is now in progress.'], "the same note a plan update gets");
  assert.equal(ledger.currentStepId(), "check", "the next work call is attributed to the step now in progress");
});

test("an id the plan does not hold is refused with the plan's ids, and the plan stays exactly as it was", () => {
  const ledger = ledgerWithPlan([["read", "in_progress"], ["check", "pending"]]);
  const before = ledger.workPlan;
  const outcome = ledger.mark({ id: "audit", status: "completed", outcome: "x" });
  assert.deepEqual(outcome, { ok: false, message: 'Invalid tool input: $.id "audit" names no step of the plan; its step ids are "read", "check"' });
  assert.deepEqual(ledger.workPlan, before);
  const none = WorkPlanLedger.restore({ turnId: "t2", isUserTurn: true, workPlanning: PROVIDER, events: [], taskTurnIds: ["t2"], report: () => undefined });
  assert.deepEqual(none.mark({ id: "read", status: "completed", outcome: "x" }),
    { ok: false, message: "Invalid tool input: there is no plan yet; publish it with test_plan_update first" });
});

test("a completed step stays completed with its outcome, a blocked step carries what blocks it, and the step marked in progress is kept in progress", () => {
  const ledger = ledgerWithPlan([["read", "in_progress"], ["check", "pending"], ["report", "pending"]]);
  ledger.mark({ id: "read", status: "completed", outcome: "Đã đọc 152 nhân viên." });
  const undone = ledger.mark({ id: "read", status: "in_progress", outcome: "Đọc lại" });
  assert.deepEqual(undone.ok && undone.plan.steps[0], { id: "read", description: "Bước read", status: "completed", outcome: "Đã đọc 152 nhân viên." });
  assert.deepEqual(undone.ok ? undone.notes : [], ['Step "read" is already completed; it stays completed with its outcome.']);
  const again = ledger.mark({ id: "read", status: "completed", outcome: "Đã đọc 152 nhân viên." });
  assert.deepEqual(again.ok ? again.notes : ["refused"], [], "the same mark again changes nothing and says nothing");
  const blocked = ledger.mark({ id: "check", status: "blocked", outcome: "Tệp đính kèm không mở được." });
  assert.deepEqual(blocked.ok && blocked.plan.steps.map((step) => [step.id, step.status, step.outcome]), [
    ["read", "completed", "Đã đọc 152 nhân viên."], ["check", "blocked", "Tệp đính kèm không mở được."], ["report", "in_progress", undefined],
  ]);
  const jumped = ledgerWithPlan([["read", "completed"], ["check", "in_progress"], ["report", "pending"]]).mark({ id: "report", status: "in_progress", outcome: "Bắt đầu lập báo cáo." });
  assert.deepEqual(jumped.ok ? jumped.plan.steps.map((step) => step.status) : [], ["completed", "pending", "in_progress"]);
  assert.deepEqual(jumped.ok ? jumped.notes : [], ['Only one step can be in progress; "check" set back to pending.']);
  const accented = ledgerWithPlan([["Đọc màn", "in_progress"], ["check", "pending"]]);
  assert.equal(accented.workPlan!.steps[0]!.id, "oc-man", "the plan carries the id in its safe form");
  assert.equal(accented.mark({ id: "Đọc màn", status: "completed", outcome: "Đã đọc màn." }).ok, true);
  assert.equal(accented.currentStepId(), "check");
  const long = accented.mark({ id: "check", status: "completed", outcome: "x".repeat(600) });
  assert.equal(long.ok && long.plan.steps[1]!.outcome!.length, 500);
  assert.deepEqual(long.ok ? long.notes : [], ['The outcome of step "check" was cut to 500 characters.']);
});

test("both planning tools are planning calls, and a step's preview applies its marks as the batch will", () => {
  const ledger = ledgerWithPlan([["read", "in_progress"], ["check", "pending"]]);
  assert.equal(ledger.isPlanningCall("test_plan_update"), true);
  assert.equal(ledger.isPlanningCall("test_plan_mark"), true);
  assert.equal(ledger.isMarkCall("test_plan_mark"), true);
  assert.equal(ledger.isMarkCall("test_plan_update"), false);
  const preview = ledger.previewProposals([
    { id: "m1", name: "test_plan_mark", arguments: JSON.stringify({ id: "read", status: "completed", outcome: "Đã đọc." }) },
    { id: "m2", name: "test_plan_mark", arguments: JSON.stringify({ id: "missing", status: "completed", outcome: "x" }) },
  ]);
  assert.deepEqual(preview?.steps.map((step) => step.status), ["completed", "in_progress"]);
  assert.equal(ledger.currentStepId(), "read", "a preview never changes the ledger");
  const withoutMark = WorkPlanLedger.restore({
    turnId: "t3", isUserTurn: true, workPlanning: { definition: PROVIDER.definition, parseProposal: PROVIDER.parseProposal }, events: [], taskTurnIds: ["t3"], report: () => undefined,
  });
  assert.equal(withoutMark.isPlanningCall("test_plan_mark"), false, "a provider with no marking tool has no mark call");
});

const read: ToolDefinition = {
  ...tool("test_read"), description: "read a page",
  execute: async (invocation) => ({ page: (invocation.arguments as { page?: number }).page ?? 1 }) as JsonValue,
};
const PLAN = { goal: "Đọc rồi đối chiếu", steps: [{ id: "read", description: "Đọc màn", status: "in_progress" }, { id: "check", description: "Đối chiếu", status: "pending" }] };
const payloadOf = (event: SessionEvent) => event.payload as Record<string, unknown>;

async function run(sessionId: string, policy?: TurnControlPolicy) {
  const { adapter, requests } = scriptedModel([
    calls([{ id: "plan", name: "plan_update", args: PLAN }, { id: "read-1", name: "test_read", args: { page: 1 } }]),
    calls([{ id: "mark", name: "plan_mark", args: { id: "read", status: "completed", outcome: "Đã đọc trang 1." } }, { id: "read-2", name: "test_read", args: { page: 2 } }]),
    answer("Đã đọc và đối chiếu: 2 trang."), answer("Đã đọc và đối chiếu: 2 trang."), answer("Đã đọc và đối chiếu: 2 trang."),
  ]);
  const progress: AgentProgressEvent[] = [];
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read]), createWorkPlanningPlugin()]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 12 }, policy ? { turnControlPolicy: policy } : {})
      .runTurn({ sessionId, content: "đọc rồi đối chiếu", security: security(), onProgress: (event) => progress.push(event) });
    return { result, requests, progress };
  } finally { await host.shutdown(); }
}

test("a mark beside the next step's work moves the plan, the work is attributed to the new step, and the answer closes the plan", async () => {
  const { result, requests, progress } = await run("plan-mark");
  assert.equal(result.outcome, "completed");
  assert.equal(requests.length, 3, "no plan-only step before the answer");
  const results = result.events.filter((event) => event.type === "tool/result");
  const stepOf = (callId: string) => payloadOf(results.find((event) => payloadOf(event).callId === callId)!).workStepId;
  assert.equal(stepOf("read-1"), "read");
  assert.equal(stepOf("read-2"), "check", "the mark ran first in its step, so the read is the next step's work");
  assert.equal(payloadOf(results.find((event) => payloadOf(event).callId === "mark")!).state, "succeeded");
  const plans = result.events.filter((event) => event.type === "work/plan-updated").map(payloadOf);
  assert.deepEqual(plans.map((plan) => [plan.cause, plan.changedStepIds]), [["proposal", ["read", "check"]], ["proposal", ["read", "check"]], ["terminal", ["check"]]],
    "the step in progress is reviewed as the model left it; the turn's end closes it");
  assert.deepEqual((plans[1]!.steps as WorkPlanStep[]).map((step) => [step.id, step.description, step.status]),
    [["read", "Đọc màn", "completed"], ["check", "Đối chiếu", "in_progress"]]);
  assert.equal((plans[1]!.steps as WorkPlanStep[])[0]!.outcome, "Đã đọc trang 1.", "the outcome is the step's result line");
  assert.equal(plans[2]!.state, "completed", "the step in progress closes with the answer, on its own evidence");
  const shown = progress.filter((event) => event.type === "plan-updated");
  assert.deepEqual(shown.map((event) => event.type === "plan-updated" && event.callId), ["plan", "mark", undefined], "clients see the mark as a plan change");
  const marked = shown[1]!.type === "plan-updated" ? shown[1]!.plan.steps[0] : undefined;
  assert.deepEqual(marked, { id: "read", description: "Đọc màn", status: "completed", outcome: "Đã đọc trang 1." }, "with the outcome clients show as the step's line");
});

test("a complete answer whose last step is still in progress, with every step's evidence shown, gets no continue card", async () => {
  const neverSatisfied: TurnControlPolicy = {
    id: "test.audit", revision: "v1", keepDraftsAsNarration: true, beforeModelStep: async () => ({}),
    reviewTerminal: async (state) => state.finalStep
      ? { decision: "continue", feedback: "Two figures are not in the observation.", fallback: "Some figures do not match the data read." }
      : { decision: "continue", feedback: "Two figures are not in the observation.", fallback: "Some figures do not match the data read.", workRemains: true },
  };
  const { result } = await run("plan-mark-s5", neverSatisfied);
  assert.equal(result.outcome, "partial");
  assert.equal(result.interaction, undefined, "every sub-goal is shown done, so nothing is left to go on with");
  assert.equal(result.events.some((event) => event.type === "interaction/requested"), false);
});
