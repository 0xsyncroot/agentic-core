import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { JsonValue, SecurityContext, SessionEvent, WorkPlan, WorkPlanStep, WorkPlanningProvider } from "@0xsyncroot/contracts";
import { PluginHost } from "@0xsyncroot/core";
import { WORK_PLANNING_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import { createWorkPlanningPlugin } from "@0xsyncroot/plugins-base";
import { resolveAgentOptions } from "../src/agent/agent-options.js";
import { ToolExecutionCoordinator } from "../src/agent/tool-execution-coordinator.js";
import { WorkPlanLedger } from "../src/agent/work-plan-ledger.js";

/** Synthetic cases preserve recorded proposal shapes: id-only steps, status transitions and merge relationships. */

interface RefusedCase {
  readonly run: string; readonly callId: string; readonly arguments: string;
  readonly storedPlan: { readonly planId: string; readonly revision: number; readonly state: string; readonly goal: string; readonly steps: readonly StoredStep[]; readonly updatedAt: string };
}
interface StoredStep { readonly id: string; readonly description: string; readonly status: string; readonly outcome?: string }
interface SentStep { readonly id?: string; readonly description?: string; readonly status: string; readonly outcome?: string }

const CASES = JSON.parse(readFileSync(new URL("./fixtures/refused-plan-updates.json", import.meta.url), "utf8")) as readonly RefusedCase[];
const security: SecurityContext = { tenantId: "tenant-a", actorId: "user-a", permissions: new Set(), correlationId: "plan-admission", purpose: "test" };
const context = { sessionId: "s", turnId: "turn-1", stepId: "step-1", security, runtime: { id: "rt" } as never };

async function mountedPlanning(): Promise<{ readonly host: PluginHost; readonly planning: WorkPlanningProvider }> {
  const host = new PluginHost();
  await host.activate([createWorkPlanningPlugin()], { security, verifyArtifact: async () => true });
  return { host, planning: host.capabilities.all(WORK_PLANNING_CAPABILITY)[0]! };
}

function ledgerOf(planning: WorkPlanningProvider, stored?: RefusedCase["storedPlan"]): WorkPlanLedger {
  const event = (type: string, seq: number, payload: Record<string, unknown>) => ({ type, turnId: "turn-1", seq, payload }) as unknown as SessionEvent;
  return WorkPlanLedger.restore({
    turnId: "turn-1", isUserTurn: true, workPlanning: planning, taskTurnIds: ["turn-1"], report: () => undefined,
    events: stored ? [event("turn/start", 1, {}), event("work/plan-updated", 2, stored)] : [],
  });
}

async function admitted(planning: WorkPlanningProvider, args: string): Promise<{ readonly kind: string; readonly message?: string }> {
  const coordinator = new ToolExecutionCoordinator([planning.definition], resolveAgentOptions({}));
  const prepared = await coordinator.prepare({ id: "call-1", name: planning.definition.id, arguments: args }, context);
  return prepared.kind === "terminal"
    ? { kind: `${prepared.kind}:${prepared.outcome.state}`, message: String((prepared.outcome.error as { message?: string } | undefined)?.message) }
    : { kind: prepared.kind };
}

const sent = (args: string): readonly SentStep[] => (JSON.parse(args) as { steps: readonly SentStep[] }).steps;
const idOnly = (step: SentStep): boolean => step.description === undefined;

test("the fixture is the 33 refused calls of the eval: every one has a step with no description and an id the plan stored", () => {
  assert.equal(CASES.length, 33);
  for (const entry of CASES) {
    const missing = sent(entry.arguments).filter(idOnly);
    assert.ok(missing.length > 0, `${entry.run} ${entry.callId} has no step without a description`);
    for (const step of missing) assert.ok(entry.storedPlan.steps.some((stored) => stored.id === step.id), `${entry.run}: ${step.id} is not stored`);
  }
});

test("all 33 synthetic regression updates pass tool admission and the ledger applies them, keeping the stored descriptions", async () => {
  const { host, planning } = await mountedPlanning();
  const admissionFailures: string[] = [];
  const ledgerFailures: string[] = [];
  let idOnlySteps = 0;
  for (const entry of CASES) {
    const admission = await admitted(planning, entry.arguments);
    if (admission.kind !== "ready") { admissionFailures.push(`${entry.run} ${admission.kind} ${admission.message}`); continue; }
    const outcome = ledgerOf(planning, entry.storedPlan).propose(JSON.parse(entry.arguments) as JsonValue);
    if (!outcome.ok) { ledgerFailures.push(`${entry.run} ${outcome.message}`); continue; }
    // A step with a description is matched by the merge (it may keep another step's id and note it); a step named by id alone is the case here.
    for (const step of sent(entry.arguments).filter(idOnly)) {
      idOnlySteps += 1;
      const applied: WorkPlanStep | undefined = outcome.plan.steps.find((candidate) => candidate.id === step.id);
      const before = entry.storedPlan.steps.find((candidate) => candidate.id === step.id);
      assert.ok(applied && before, `${entry.run}: ${step.id} is in the plan`);
      assert.equal(applied.status, step.status, `${entry.run}: ${step.id} status`);
      assert.equal(applied.outcome, step.outcome, `${entry.run}: ${step.id} outcome`);
      assert.equal(applied.description, before.description, `${entry.run}: ${step.id} keeps its stored description`);
    }
  }
  assert.deepEqual(admissionFailures, [], `${admissionFailures.length}/33 refused by tool admission`);
  assert.deepEqual(ledgerFailures, [], `${ledgerFailures.length}/33 refused by the ledger`);
  assert.equal(idOnlySteps, 65, "the 33 calls hold 65 steps named by id alone");
  await host.shutdown();
});

test("an id-only step is admitted, but with no stored plan the ledger refuses the id by name", async () => {
  const { host, planning } = await mountedPlanning();
  const args = JSON.stringify({ goal: "g", steps: [{ id: "step_1", status: "completed", outcome: "done" }] });
  assert.equal((await admitted(planning, args)).kind, "ready");
  const outcome = ledgerOf(planning).propose(JSON.parse(args) as JsonValue);
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.message, /no step in the plan has the id "step_1"/u);
  await host.shutdown();
});

test("an unknown id is refused in the tool-input check's own form, naming each step's position and id", async () => {
  // A first plan with its done step as `{id, status, outcome}`: the model repairs its call after a refusal in the tool-input
  // check's form, and repeats it unchanged after a prose one.
  const { host, planning } = await mountedPlanning();
  const outcome = ledgerOf(planning).propose({ goal: "g", steps: [
    { id: "period_confirm", status: "completed", outcome: "October" },
    { id: "work_data_check", description: "Check the work data", status: "in_progress" },
    { id: "adjustment_ask", status: "pending" },
  ] } as JsonValue);
  assert.equal(outcome.ok ? "" : outcome.message, 'Invalid tool input: $.steps[0].description is required (no step in the plan has the id "period_confirm"); '
    + '$.steps[2].description is required (no step in the plan has the id "adjustment_ask")');
  await host.shutdown();
});

test("tool admission still checks the accepted shape: status, unknown fields, types and the goal", async () => {
  const { host, planning } = await mountedPlanning();
  const refusals: ReadonlyArray<readonly [unknown, RegExp]> = [
    [{ goal: "g", steps: [{ description: "d" }] }, /steps\[0\]\.status is required/u],
    [{ goal: "g", steps: [{ description: "d", status: "done" }] }, /steps\[0\]\.status/u],
    [{ goal: "g", steps: [{ description: "d", status: "pending", extra: 1 }] }, /extra/u],
    [{ goal: "g", steps: [{ description: 5, status: "pending" }] }, /steps\[0\]\.description/u],
    [{ steps: [{ description: "d", status: "pending" }] }, /goal is required/u],
    [{ goal: "g", steps: [] }, /steps/u],
  ];
  for (const [args, pattern] of refusals) {
    const admission = await admitted(planning, JSON.stringify(args));
    assert.equal(admission.kind, "terminal:not_started", JSON.stringify(args));
    assert.match(admission.message ?? "", pattern);
  }
  const neither = JSON.stringify({ goal: "g", steps: [{ status: "pending" }] });
  assert.equal((await admitted(planning, neither)).kind, "ready", "the schema accepts what the port accepts");
  const outcome = ledgerOf(planning).propose(JSON.parse(neither) as JsonValue);
  assert.equal(outcome.ok, false, "parseProposal still refuses a step with neither id nor description");
  assert.match(outcome.ok ? "" : outcome.message, /needs a description or the id of a step in the plan/u);
  await host.shutdown();
});

test("the preview of a planning call equals what the batch applies after tool admission, for all 33 calls", async () => {
  const { host, planning } = await mountedPlanning();
  const shape = (plan: WorkPlan) => ({ goal: plan.goal, state: plan.state, steps: plan.steps });
  for (const entry of CASES) {
    const ledger = ledgerOf(planning, entry.storedPlan);
    const preview = ledger.previewProposals([{ id: entry.callId, name: planning.definition.id, arguments: entry.arguments }]);
    const admission = await admitted(planning, entry.arguments);
    const outcome = admission.kind === "ready" ? ledger.propose(JSON.parse(entry.arguments) as JsonValue) : undefined;
    assert.ok(outcome?.ok, `${entry.run}: the batch applies the call (${admission.kind} ${admission.message ?? ""})`);
    assert.ok(preview, `${entry.run}: the preview produces a plan`);
    assert.deepEqual(shape(preview), shape(outcome.plan), entry.run);
  }
  await host.shutdown();
});
