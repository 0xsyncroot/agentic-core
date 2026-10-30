import assert from "node:assert/strict";
import { test } from "node:test";
import { AgenticError, type AgentProgressEvent, type SessionEvent, type ToolDefinition, type WorkPlanningProvider, type WorkPlanProposal } from "@0xsyncroot/contracts";
import type { TurnTerminalOutcome } from "../src/agent/turn-terminator.js";
import { WorkPlanLedger } from "../src/agent/work-plan-ledger.js";
import type { PlanEvidence } from "../src/agent/work-plan-ledger-state.js";

const DEFINITION: ToolDefinition = {
  id: "test_plan_update", version: "1.0.0", description: "plan", inputSchema: {}, outputSchema: {},
  requiredPermissions: [], sideEffect: "none", timeoutMs: 100, execute: async () => null,
};

function provider(parse: (args: unknown) => WorkPlanProposal = (args) => args as WorkPlanProposal): WorkPlanningProvider {
  return { definition: DEFINITION, parseProposal: parse };
}

function event(type: string, turnId: string, seq: number, payload: Record<string, unknown> = {}): SessionEvent {
  return { type, turnId, seq, payload } as unknown as SessionEvent;
}

function planEvent(turnId: string, seq: number, plan: Record<string, unknown>): SessionEvent {
  return event("work/plan-updated", turnId, seq, plan);
}

function ledgerOf(options: {
  readonly turnId: string; readonly taskTurnIds: readonly string[]; readonly isUserTurn?: boolean;
  readonly events?: readonly SessionEvent[]; readonly workPlanning?: WorkPlanningProvider;
  readonly reported?: AgentProgressEvent[];
  /** Steps a settled call shows done. */
  readonly done?: readonly string[];
  /** Steps a call was attributed to that did not go through. */
  readonly failed?: readonly string[];
}) {
  const reported = options.reported ?? [];
  const done = new Set(options.done ?? []);
  const called = new Set([...done, ...(options.failed ?? [])]);
  const evidence: PlanEvidence = {
    doneSteps: (plan) => new Set(plan.steps.filter((step) => done.has(step.id)).map((step) => step.id)),
    calledSteps: (plan) => new Set(plan.steps.filter((step) => called.has(step.id)).map((step) => step.id)),
  };
  const ledger = WorkPlanLedger.restore({
    turnId: options.turnId, isUserTurn: options.isUserTurn ?? true, workPlanning: options.workPlanning ?? provider(),
    events: options.events ?? [], taskTurnIds: options.taskTurnIds, report: (progress) => reported.push(progress), evidence,
  });
  return { ledger, reported };
}

test("with no prior plan in the raw tail, a first proposal always starts a fresh, active plan", () => {
  const { ledger } = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"] });
  assert.equal(ledger.workPlan, undefined);
  const outcome = ledger.propose({ goal: "Do it", steps: [{ id: "a", description: "Step A", status: "in_progress" }] });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.plan.revision, 1);
  assert.equal(outcome.plan.state, "active");
  assert.ok(outcome.plan.planId);
  assert.equal(outcome.closedDormant, undefined);
  assert.deepEqual(ledger.workPlan, outcome.plan);
});

test("a plan whose turn is in this operation's own task chain and still open is reopened as active, reported once and never journaled", () => {
  const plan = { planId: "p1", revision: 3, state: "active", goal: "g", steps: [{ id: "a", description: "A", status: "in_progress" }], updatedAt: "2026-09-01T00:00:00.000Z" };
  const events = [event("turn/start", "root", 1), planEvent("root", 2, plan)];
  const { ledger, reported } = ledgerOf({ turnId: "resume", taskTurnIds: ["root", "resume"], events });
  assert.deepEqual(ledger.workPlan, plan);
  assert.deepEqual(reported, [{ type: "plan-updated", turnId: "resume", plan, cause: "restore" }]);
});

test("the immediately preceding task's still-open plan is dormant; an older one, or a closed one, is not restored at all", () => {
  const openPlan = { planId: "p-prev", revision: 1, state: "active", goal: "g", steps: [{ id: "a", description: "A", status: "in_progress" }], updatedAt: "t" };
  const events = [event("turn/start", "root-1", 1), planEvent("root-1", 2, openPlan), event("turn/start", "root-2", 3)];
  const dormant = ledgerOf({ turnId: "root-2", taskTurnIds: ["root-2"], events });
  assert.deepEqual(dormant.ledger.workPlan, openPlan);
  assert.deepEqual(dormant.reported, [], "a dormant plan is not reported as restored");

  // A task with no plan of its own sits between the one that had a plan and the current one: too old.
  const olderEvents = [
    event("turn/start", "root-1", 1), planEvent("root-1", 2, openPlan), event("turn/start", "root-2", 3), event("turn/start", "root-3", 4),
  ];
  const tooOld = ledgerOf({ turnId: "root-3", taskTurnIds: ["root-3"], events: olderEvents });
  assert.equal(tooOld.ledger.workPlan, undefined);

  const closedPlan = { ...openPlan, state: "stopped" };
  const closedEvents = [event("turn/start", "root-1", 1), planEvent("root-1", 2, closedPlan), event("turn/start", "root-2", 3)];
  const closed = ledgerOf({ turnId: "root-2", taskTurnIds: ["root-2"], events: closedEvents });
  assert.equal(closed.ledger.workPlan, undefined);
});

test("a dormant plan the first proposal's wording matches continues it, under its own id; unmatched, a new plan starts", () => {
  const dormantPlan = { planId: "p-dormant", revision: 2, state: "awaiting_user", goal: "g", steps: [{ id: "1", description: "Confirm the period", status: "in_progress" }], updatedAt: "t" };
  const events = [event("turn/start", "root-1", 1), planEvent("root-1", 2, dormantPlan), event("turn/start", "root-2", 3)];

  const matched = ledgerOf({ turnId: "root-2", taskTurnIds: ["root-2"], events });
  const matchOutcome = matched.ledger.propose({ goal: "g2", steps: [{ id: "step-1", description: "confirm the period", status: "completed" }] });
  assert.equal(matchOutcome.ok, true);
  if (matchOutcome.ok) {
    assert.equal(matchOutcome.plan.planId, "p-dormant", "the dormant plan's own identity continues");
    assert.equal(matchOutcome.plan.revision, 3);
    assert.equal(matchOutcome.closedDormant, undefined);
  }

  const unmatchedUserTurn = ledgerOf({ turnId: "root-2", taskTurnIds: ["root-2"], events, isUserTurn: true });
  const freshOutcome = unmatchedUserTurn.ledger.propose({ goal: "g2", steps: [{ id: "x", description: "Unrelated work", status: "in_progress" }] });
  assert.equal(freshOutcome.ok, true);
  if (freshOutcome.ok) {
    assert.notEqual(freshOutcome.plan.planId, "p-dormant");
    assert.deepEqual(freshOutcome.closedDormant && { planId: freshOutcome.closedDormant.planId, state: freshOutcome.closedDormant.state, revision: freshOutcome.closedDormant.revision },
      { planId: "p-dormant", state: "stopped", revision: 3 });
  }

  // A resume operation never retires another task's dormant plan on its own authority (§10.7).
  const unmatchedResume = ledgerOf({ turnId: "root-2", taskTurnIds: ["root-2"], events, isUserTurn: false });
  const resumeOutcome = unmatchedResume.ledger.propose({ goal: "g2", steps: [{ id: "x", description: "Unrelated work", status: "in_progress" }] });
  assert.equal(resumeOutcome.ok, true);
  if (resumeOutcome.ok) assert.equal(resumeOutcome.closedDormant, undefined);
});

test("a parseProposal failure never throws, leaves the plan exactly as it was, and reports its message", () => {
  const failing = provider(() => { throw new AgenticError("validation", "steps must list from 1 to 20 steps"); });
  const { ledger } = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"], workPlanning: failing });
  const first = ledger.propose({ goal: "g", steps: [] });
  assert.deepEqual(first, { ok: false, message: "steps must list from 1 to 20 steps" });
  assert.equal(ledger.workPlan, undefined, "nothing was created by the failed proposal");
});

test("later proposals in the same operation always merge onto the plan it already owns, never start another", () => {
  const { ledger } = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"] });
  const first = ledger.propose({ goal: "g", steps: [{ id: "a", description: "A", status: "in_progress" }] });
  assert.equal(first.ok, true);
  const planId = first.ok ? first.plan.planId : undefined;
  // Wording that matches nothing in the plan the operation already owns is added as a new step,
  // never mistaken for the start of a second plan.
  const second = ledger.propose({ goal: "g", steps: [
    { id: "a", description: "A", status: "completed" }, { id: "b", description: "B", status: "in_progress" },
  ] });
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.plan.planId, planId);
    assert.equal(second.plan.revision, 2);
    assert.deepEqual(second.plan.steps.map((s) => s.id), ["a", "b"]);
  }
});

test("previewing a step's planning calls never changes the ledger, and uses the last one that parses", () => {
  const { ledger } = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"] });
  const preview = ledger.previewProposals([
    { id: "c1", name: "not_the_plan_tool", arguments: "{}" },
    { id: "c2", name: "test_plan_update", arguments: "not json" },
    { id: "c3", name: "test_plan_update", arguments: JSON.stringify({ goal: "g", steps: [{ id: "a", description: "A", status: "in_progress" }] }) },
  ]);
  assert.deepEqual(preview?.steps.map((s) => s.id), ["a"]);
  assert.equal(ledger.workPlan, undefined, "a preview leaves the ledger exactly as it found it");
  const real = ledger.propose({ goal: "g", steps: [{ id: "a", description: "A", status: "in_progress" }] });
  assert.equal(real.ok, true);
  if (real.ok) assert.deepEqual(preview, { ...real.plan, planId: preview!.planId, updatedAt: preview!.updatedAt });
});

test("currentStepId stamps only the operation's own plan, never a dormant one still waiting on a match", () => {
  const dormantPlan = { planId: "p-dormant", revision: 1, state: "active", goal: "g", steps: [{ id: "1", description: "Confirm", status: "in_progress" }], updatedAt: "t" };
  const events = [event("turn/start", "root-1", 1), planEvent("root-1", 2, dormantPlan), event("turn/start", "root-2", 3)];
  const { ledger } = ledgerOf({ turnId: "root-2", taskTurnIds: ["root-2"], events });
  assert.equal(ledger.currentStepId(), undefined);
  ledger.propose({ goal: "g", steps: [{ id: "confirm", description: "Confirm", status: "in_progress" }] });
  assert.equal(ledger.currentStepId(), "1", "matched the dormant step's own id");
});

test("isPlanningCall names only the mounted tool", () => {
  const { ledger } = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"] });
  assert.equal(ledger.isPlanningCall("test_plan_update"), true);
  assert.equal(ledger.isPlanningCall("something_else"), false);
});

function outcome(kind: TurnTerminalOutcome): TurnTerminalOutcome { return kind; }

test("close writes nothing for an operation with no plan of its own, dormant or none", async () => {
  const none = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"] });
  assert.deepEqual(await none.ledger.close(outcome({ kind: "awaiting", outcome: "awaiting_approval" })), []);

  const dormantPlan = { planId: "p-dormant", revision: 1, state: "active", goal: "g", steps: [{ id: "1", description: "A", status: "in_progress" }], updatedAt: "t" };
  const events = [event("turn/start", "root-1", 1), planEvent("root-1", 2, dormantPlan), event("turn/start", "root-2", 3)];
  const dormant = ledgerOf({ turnId: "root-2", taskTurnIds: ["root-2"], events });
  assert.deepEqual(await dormant.ledger.close(outcome({ kind: "answer", outcome: "completed", decision: "finish" })), [], "a dormant plan is never closed");
});

test("close(\"failed\") writes only when this operation proposed or dispatched; otherwise it leaves the plan untouched", async () => {
  const plan = { planId: "p1", revision: 1, state: "active", goal: "g", steps: [{ id: "a", description: "A", status: "in_progress" }], updatedAt: "t" };
  const events = [event("turn/start", "root", 1), planEvent("root", 2, plan)];

  const untouched = ledgerOf({ turnId: "root", taskTurnIds: ["root"], events });
  assert.deepEqual(await untouched.ledger.close(outcome({ kind: "failed", code: "internal" })), []);

  const dispatched = ledgerOf({ turnId: "root", taskTurnIds: ["root"], events });
  dispatched.ledger.noteNonPlanningDispatch();
  const drafts = await dispatched.ledger.close(outcome({ kind: "failed", code: "internal" }));
  assert.equal(drafts.length, 1);
  assert.equal((drafts[0]!.payload as Record<string, unknown>).state, "failed");
  assert.deepEqual(dispatched.reported.at(-1), { type: "plan-updated", turnId: "root", plan: { ...plan, revision: 2, state: "failed", updatedAt: (drafts[0]!.payload as Record<string, unknown>).updatedAt }, cause: "terminal" });
});

test("close(\"awaiting\") marks the plan awaiting_user once, and again writes nothing", async () => {
  const { ledger } = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"] });
  ledger.propose({ goal: "g", steps: [{ id: "a", description: "A", status: "in_progress" }] });
  const first = await ledger.close(outcome({ kind: "awaiting", outcome: "awaiting_approval" }));
  assert.equal((first[0]!.payload as Record<string, unknown>).state, "awaiting_user");
  const second = await ledger.close(outcome({ kind: "awaiting", outcome: "awaiting_interaction" }));
  assert.deepEqual(second, []);
});

test("close on a completed answer finishes a step with evidence and every step no call was attributed to; a failed call's step stays", async () => {
  const failed = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"], failed: ["a"] });
  failed.ledger.propose({ goal: "g", steps: [
    { id: "a", description: "A", status: "in_progress" }, { id: "b", description: "B", status: "pending" },
  ] });
  const failedDrafts = await failed.ledger.close(outcome({ kind: "answer", outcome: "completed", decision: "finish" }));
  const failedPayload = failedDrafts[0]!.payload as { steps: { id: string; status: string }[]; state: string };
  assert.deepEqual(failedPayload.steps.map((s) => [s.id, s.status]), [["a", "in_progress"], ["b", "completed"]],
    "a's call did not go through; b had no call");
  assert.equal(failedPayload.state, "active", "the step whose call failed keeps the plan open");

  const withEvidence = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"], done: ["a"] });
  withEvidence.ledger.propose({ goal: "g", steps: [
    { id: "a", description: "A", status: "in_progress" }, { id: "b", description: "B", status: "pending" }, { id: "c", description: "C", status: "pending" },
  ] });
  const drafts = await withEvidence.ledger.close(outcome({ kind: "answer", outcome: "completed", decision: "finish" }));
  assert.equal(drafts.length, 1, "one terminal row");
  const payload = drafts[0]!.payload as { steps: { id: string; status: string }[]; state: string };
  assert.deepEqual(payload.steps.map((s) => [s.id, s.status]), [["a", "completed"], ["b", "completed"], ["c", "completed"]],
    "b and c had no call: the answer accepted as completed is their work");
  assert.equal(payload.state, "completed");

  const partial = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"], done: ["a"] });
  partial.ledger.propose({ goal: "g", steps: [{ id: "a", description: "A", status: "in_progress" }, { id: "b", description: "B", status: "pending" }] });
  const partialDrafts = await partial.ledger.close(outcome({ kind: "answer", outcome: "partial", decision: "finish" }));
  assert.deepEqual((partialDrafts[0]!.payload as { steps: { id: string; status: string }[] }).steps.map((s) => [s.id, s.status]),
    [["a", "completed"], ["b", "pending"]], "a partial answer closes no step without a call");

  const nothingPending = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"] });
  nothingPending.ledger.propose({ goal: "g", steps: [{ id: "a", description: "A", status: "in_progress" }] });
  const finalDrafts = await nothingPending.ledger.close(outcome({ kind: "answer", outcome: "completed", decision: "finish" }));
  const finalPayload = finalDrafts[0]!.payload as { steps: { status: string }[]; state: string };
  assert.deepEqual(finalPayload.steps.map((s) => s.status), ["completed"]);
  assert.equal(finalPayload.state, "completed");
});

test("an in-progress step's outcome says what it starts: completing the step, at the turn's end or by a proposal without a result, leaves no result line", async () => {
  const atClose = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"] });
  atClose.ledger.propose({ goal: "g", steps: [{ id: "a", description: "A", status: "in_progress", outcome: "Starting to read the file." }] });
  const drafts = await atClose.ledger.close(outcome({ kind: "answer", outcome: "completed", decision: "finish" }));
  const closed = drafts[0]!.payload as { steps: { id: string; status: string; outcome?: string }[] };
  assert.deepEqual(closed.steps, [{ id: "a", description: "A", status: "completed" }]);

  const byProposal = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"] });
  byProposal.ledger.propose({ goal: "g", steps: [{ id: "a", description: "A", status: "in_progress", outcome: "Starting to read the file." }] });
  const done = byProposal.ledger.propose({ goal: "g", steps: [{ id: "a", description: "A", status: "completed" }] });
  assert.equal(done.ok && done.plan.steps[0]!.outcome, undefined);
  const withResult = byProposal.ledger.propose({ goal: "g", steps: [{ id: "a", description: "A", status: "completed", outcome: "Read 12 rows." }] });
  assert.equal(withResult.ok && withResult.plan.steps[0]!.outcome, "Read 12 rows.");

  const blocked = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"] });
  blocked.ledger.propose({ goal: "g", steps: [{ id: "a", description: "A", status: "blocked", outcome: "The file is empty." }] });
  const stillBlocked = blocked.ledger.propose({ goal: "g", steps: [{ id: "a", description: "A", status: "blocked" }] });
  assert.equal(stillBlocked.ok && stillBlocked.plan.steps[0]!.outcome, "The file is empty.", "only a step in progress loses its outcome");
});

test("close on a partial answer or the turn-control fallback stops the plan", async () => {
  const { ledger, reported } = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"] });
  ledger.propose({ goal: "g", steps: [{ id: "a", description: "A", status: "in_progress" }] });
  const drafts = await ledger.close(outcome({ kind: "fallback" }));
  assert.equal((drafts[0]!.payload as Record<string, unknown>).state, "stopped");
  assert.equal(reported.at(-1)?.type, "plan-updated");
});

test("a step named by id alone keeps its stored description; an unknown id is refused naming it and changes nothing", () => {
  const { ledger } = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"] });
  assert.deepEqual(ledger.propose({ goal: "g", steps: [{ id: "a", status: "in_progress" }] }),
    { ok: false, message: 'Invalid tool input: $.steps[0].description is required (no step in the plan has the id "a")' });
  assert.equal(ledger.workPlan, undefined, "a refused proposal creates no plan");
  ledger.propose({ goal: "g", steps: [{ id: "a", description: "Step A", status: "in_progress" }, { id: "b", description: "Step B", status: "pending" }] });
  const update = ledger.propose({ goal: "g", steps: [{ id: "a", status: "completed" }, { id: "b", status: "in_progress" }] });
  assert.equal(update.ok, true);
  if (update.ok) assert.deepEqual(update.plan.steps.map((s) => [s.id, s.description, s.status]), [["a", "Step A", "completed"], ["b", "Step B", "in_progress"]]);
  const refused = ledger.propose({ goal: "g", steps: [{ id: "a", status: "completed" }, { id: "ghost", status: "pending" }] });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.message, /"ghost"/u);
  assert.deepEqual(ledger.workPlan?.steps.map((s) => s.id), ["a", "b"], "the refused update left the plan as it was");
});

test("a dormant plan is continued by a proposal naming its steps by id alone", () => {
  const plan = {
    planId: "p0", revision: 1, state: "active", goal: "g", updatedAt: "2026-10-16T00:00:00.000Z",
    steps: [{ id: "a", description: "Step A", status: "in_progress" }, { id: "b", description: "Step B", status: "pending" }],
  };
  const events = [event("turn/start", "t0", 1), planEvent("t0", 2, plan), event("turn/start", "t1", 3)];
  const { ledger } = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"], events });
  const outcome = ledger.propose({ goal: "g", steps: [{ id: "a", status: "completed" }, { id: "b", status: "in_progress" }] });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.plan.planId, "p0");
    assert.deepEqual(outcome.plan.steps.map((s) => s.description), ["Step A", "Step B"]);
  }
});

test("previewing planning calls never throws on a step naming an id the plan lacks, and skips that call", () => {
  const { ledger } = ledgerOf({ turnId: "t1", taskTurnIds: ["t1"] });
  ledger.propose({ goal: "g", steps: [{ id: "a", description: "Step A", status: "in_progress" }] });
  const call = (id: string, steps: unknown[]) => ({ id, name: "test_plan_update", arguments: JSON.stringify({ goal: "g", steps }) });
  const preview = ledger.previewProposals([
    call("c1", [{ id: "a", status: "completed" }]),
    call("c2", [{ id: "ghost", status: "pending" }]),
  ]);
  assert.deepEqual(preview?.steps.map((s) => [s.id, s.description, s.status]), [["a", "Step A", "completed"]]);
  assert.equal(ledger.previewProposals([call("c3", [{ id: "ghost", status: "pending" }])]), undefined);
  assert.deepEqual(ledger.workPlan?.steps.map((s) => s.status), ["in_progress"], "a preview leaves the ledger as it found it");
});
