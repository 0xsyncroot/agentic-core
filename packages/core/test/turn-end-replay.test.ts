import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { cardReport, formatCards } from "./replay/card-report.js";
import { COMPOSED_BOUNDS } from "./replay/composed-bounds.js";
import { DecideTurnEndModel } from "./replay/decide-turn-end-model.js";
import { CURRENT_EXPLANATIONS, LEGACY_EXPLANATIONS } from "./replay/explanations.js";
import { REPLICA_SOURCES } from "./replay/legacy-replica.js";
import { LegacyTurnEndModel, type LegacyVariant } from "./replay/legacy-turn-end-model.js";
import { compareModels, formatShifts } from "./replay/model-shift.js";
import { formatReport, replayFixture, type ReplayReport } from "./replay/replay-report.js";
import { anchoredCode, anchorKey, frozenSource, snapshotAnchors } from "./replay/source-snapshot.js";
import { loadFixture, redactionViolations, type CallFacts, type RunFacts } from "./replay/step-facts.js";

// The turn-end replay gate. The recorded step facts (replay/fixture.json, built by scripts/replay/extract-step-facts.mjs) drive
// the legacy turn-end logic; per recorded stop class each run is reproduced, diverged with a named cause, or unexplained from
// the first differing step. The result must equal replay/baseline.json. The current rules (decide() under the bounds the
// product composes today, replay/composed-bounds.ts) are replayed the same way against replay/decide-baseline.json, together
// with where they end each run against the legacy rules and where they ask the user whether to go on (replay/card-report.ts:
// the continue card, read from the sub-goals the run's plan facts leave undone). A change to the turn-end logic shows up here as a changed count or
// run, and the baselines are updated on purpose (REPLAY_UPDATE=1) in the same change that explains it.

const fixture = loadFixture(new URL("./replay/fixture.json", import.meta.url));
const baselineUrl = new URL("./replay/baseline.json", import.meta.url);
const decideBaselineUrl = new URL("./replay/decide-baseline.json", import.meta.url);
/** Recorded classes whose runs the user saw finish or pause: the current rules may end none of them earlier. */
const FINISHED_CLASSES = new Set(["answer", "pause"]);
const snapshotUrl = new URL("./replay/replica-snapshot.json", import.meta.url);
/** The turn-end sources at 583c295, comment-free: what the legacy model runs and the replica copies. */
const legacySources = new URL("./replay/legacy-sources/", import.meta.url);
const updating = process.env.REPLAY_UPDATE === "1";

/** What the baseline pins: the counts and every divergence, without the decided ledger (diagnostic only). */
function pinned(report: ReplayReport) {
  return {
    model: report.model, byClass: report.byClass, byOracle: report.byOracle, labelledNotJoined: report.labelledNotJoined,
    divergences: report.divergences.map(({ run, stopClass, oracle, codeAge, outcome, k, differs, cause, later, recorded, decided }) => ({
      run, stopClass, oracle, codeAge, outcome, ...(k !== undefined ? { k, differs, recorded, decided: { ...decided, ledger: undefined } } : {}),
      ...(cause ? { cause } : {}), ...(later ? { later } : {}),
    })),
  };
}

const replay = (variant?: LegacyVariant) => replayFixture(new LegacyTurnEndModel(variant), fixture, LEGACY_EXPLANATIONS);
const counts = (report: ReplayReport) => JSON.stringify(report.byClass);

test("the committed step-fact fixture holds only allowlisted keys with enum, number or boolean values", () => {
  assert.ok(fixture.runs.length > 0);
  assert.deepEqual(redactionViolations(fixture), []);
});

test("the redaction check refuses text, ids, amounts, diacritics and keys outside the allowlist", () => {
  const run = fixture.runs[0]!;
  const planted = (patch: (copy: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify({ ...fixture, runs: [run] })) as Record<string, unknown>;
    patch(copy);
    return redactionViolations(copy);
  };
  const firstStep = (copy: Record<string, unknown>) => ((copy.runs as Record<string, unknown>[])[0]!.steps as Record<string, unknown>[])[0]!;
  assert.deepEqual(planted(() => undefined), []);
  assert.equal(planted((copy) => { (copy.runs as Record<string, unknown>[])[0]!.session = "widget-1"; }).length, 1);
  assert.equal(planted((copy) => { firstStep(copy).mode = "Lương tháng 9"; }).length, 1);
  assert.equal(planted((copy) => { firstStep(copy).mode = "call_05f3f1c9dfe6"; }).length, 1);
  assert.equal(planted((copy) => { firstStep(copy).mode = "user@example"; }).length, 1);
  assert.equal(planted((copy) => { firstStep(copy).mode = "1.155.036.824"; }).length, 1);
  assert.equal(planted((copy) => { firstStep(copy).reviews = [{ phase: "terminal", decision: "continue", feedback: "Thiếu bảng" }]; }).length, 1);
  assert.equal(planted((copy) => { firstStep(copy).calls = [{ state: "succeeded", toolId: "acme_list_people" }]; }).length, 1);
  assert.equal(planted((copy) => { firstStep(copy).calls = [{ state: "succeeded", tool: "acme_list_people" }]; }).length, 1);
  assert.equal(planted((copy) => { firstStep(copy).toolsOffered = ["acme_list_people"]; }).length, 1);
  assert.equal(planted((copy) => { firstStep(copy).calls = [{ state: "succeeded", halted: "Lương tháng 9" }]; }).length, 1);
  assert.equal(planted((copy) => { firstStep(copy).calls = [{ state: "succeeded", workStep: "step_work_data" }]; }).length, 1);
  assert.equal(planted((copy) => { firstStep(copy).plan = { state: "active", steps: [{ id: "step_work_data", status: "pending" }] }; }).length, 1);
  assert.equal(planted((copy) => { firstStep(copy).plan = { state: "active", steps: [{ id: 1, status: "pending", description: "Doi chieu" }] }; }).length, 1);
  assert.equal(planted((copy) => { firstStep(copy).plan = { state: "active", goal: "x", steps: [{ id: 1, status: "pending" }] }; }).length, 1);
  assert.equal(planted((copy) => { firstStep(copy).plan = { state: "active", steps: [{ id: 1, status: "Hoàn thành" }] }; }).length, 1);
  assert.equal(planted((copy) => { firstStep(copy).plan = { state: "active", steps: [{ id: 1, status: "completed", outcome: "ok" }] }; }).length, 1);
  assert.deepEqual(planted((copy) => { firstStep(copy).plan = { state: "active", cause: "proposal", steps: [{ id: 1, status: "in_progress" }] }; }), []);
});

test("plan facts are coherent: tool indexes are positive ordinals, credited calls are attributed successes, attributed steps belong to the run's plan", () => {
  const calls = (run: RunFacts): CallFacts[] => run.steps.flatMap((step) => [...(step.reads ?? []), ...(step.calls ?? [])]);
  const planStepIds = (run: RunFacts) => new Set([run.planAtStart, ...run.steps.map((step) => step.plan)].flatMap((plan) => plan?.steps.map((step) => step.id) ?? []));
  const indexes = (run: RunFacts) => [...calls(run).map((call) => call.tool ?? 0), ...run.steps.flatMap((step) => step.toolsOffered ?? [])];
  assert.deepEqual(fixture.runs.filter((run) => indexes(run).some((index) => !Number.isInteger(index) || index < 0)).map((run) => run.run), []);
  assert.deepEqual(fixture.runs.filter((run) => calls(run).some((call) => call.credited && (!call.workStep || call.state !== "succeeded" || call.plan))).map((run) => run.run), []);
  assert.deepEqual(fixture.runs.filter((run) => calls(run).some((call) => call.workStep && !planStepIds(run).has(call.workStep))).map((run) => run.run), []);
  assert.ok(fixture.runs.filter((run) => planStepIds(run).size > 0).length > 0);
  assert.ok(fixture.runs.some((run) => calls(run).some((call) => call.credited)));
});

test("the legacy turn-end replay equals the committed baseline, per recorded stop class", async (t) => {
  const report = await replay();
  for (const line of formatReport(report).split("\n")) t.diagnostic(line);
  const actual = JSON.parse(JSON.stringify(pinned(report))) as unknown;
  if (updating) writeFileSync(baselineUrl, `${JSON.stringify(actual, null, 1)}\n`);
  assert.deepEqual(actual, JSON.parse(readFileSync(baselineUrl, "utf8")),
    "the replay changed: explain each changed run, then update replay/baseline.json with REPLAY_UPDATE=1");
});

test("decide() under today's bounds replays the recorded runs as its committed baseline holds, and ends them no worse than the legacy rules", async (t) => {
  const current = new DecideTurnEndModel(COMPOSED_BOUNDS);
  const report = await replayFixture(current, fixture, CURRENT_EXPLANATIONS);
  for (const line of formatReport(report).split("\n")) t.diagnostic(line);
  const versusLegacy = await compareModels(new LegacyTurnEndModel(), current, fixture);
  for (const line of formatShifts("decide() against legacy@583c295, run by run:", versusLegacy).split("\n")) t.diagnostic(line);
  // No run the user saw finish or pause ends earlier; no stuck run (labelled stuck, or ended by the gate's bound) ends later.
  const stuck = (run: { readonly oracle: string; readonly stopClass: string }) => run.oracle === "stuck" || run.stopClass === "work-remains-unmoved";
  assert.deepEqual(versusLegacy.shifted.filter((run) => FINISHED_CLASSES.has(run.stopClass) && run.shift === "earlier").map((run) => run.run), []);
  assert.deepEqual(versusLegacy.shifted.filter((run) => stuck(run) && run.shift === "later").map((run) => run.run), []);
  // The continue card: never on a run the user saw finish or the oracle labels correct; where it asks is pinned with the rest.
  const cards = await cardReport(current, fixture);
  for (const line of formatCards(cards).split("\n")) t.diagnostic(line);
  assert.equal(cards.byStatus.completed?.cards ?? 0, 0, "a completed run is asked to go on");
  assert.equal(cards.byOracle.correct?.cards ?? 0, 0, "a run the oracle labels correct is asked to go on");
  const actual = JSON.parse(JSON.stringify({ ...pinned(report), versusLegacy, cards })) as unknown;
  if (updating) writeFileSync(decideBaselineUrl, `${JSON.stringify(actual, null, 1)}\n`);
  assert.deepEqual(actual, JSON.parse(readFileSync(decideBaselineUrl, "utf8")),
    "decide() changed on the recorded runs: explain each changed run, then update replay/decide-baseline.json with REPLAY_UPDATE=1");
});

// Runs the recorded window holds none of, built on a recorded run's shape (two reads, then "work remains" on the answer) and kept
// apart from the recorded fixture so its counts stay what the journals hold: the same answer back after the objection stands as
// partial when the policy marked it delivered, and goes on to the closing step when it did not.
const constructed = loadFixture(new URL("./replay/constructed-fixture.json", import.meta.url));

test("the replay reads delivered from the journal: an unmoved delivered answer stands, an undelivered one gets the closing step", async () => {
  assert.deepEqual(redactionViolations(constructed), []);
  const current = new DecideTurnEndModel(COMPOSED_BOUNDS);
  assert.deepEqual((await replayFixture(current, constructed)).divergences, []);
  const unmarked = JSON.parse(JSON.stringify(constructed).replaceAll('"delivered":true', '"delivered":false')) as typeof constructed;
  const diverged = (await replayFixture(current, unmarked)).divergences;
  assert.deepEqual(diverged.map((run) => [run.run, run.k, run.decided?.review?.decision, run.decided?.next.kind]), [[1, 4, "close", "close"]],
    "without delivered the replay closes the work where the runtime let the answer stand");
});

test("the comparison sees an end that moves: a lower step ceiling ends finished runs earlier", async () => {
  const lower = await compareModels(new LegacyTurnEndModel(), new DecideTurnEndModel({ ...COMPOSED_BOUNDS, maxSteps: 8 }), fixture);
  assert.ok(lower.shifted.some((run) => FINISHED_CLASSES.has(run.stopClass) && run.shift === "earlier"));
});

test("the replay runs the frozen StepBudget: a different allowance changes its output", async () => {
  const base = await replay();
  assert.notEqual(counts(await replay({ options: { initialStepBudget: 3 } })), counts(base));
  assert.notEqual(counts(await replay({ options: { maxToolCalls: 8 } })), counts(base));
});

test("the replay runs the replica's rules: charging refused steps as stalls changes its output", async () => {
  const base = await replay();
  const stalled = await replay({
    recordBatch: (budget, stepIndex, batch, _calls, durationMs) => {
      if (batch.planningOnly) budget.recordPlanningStep(durationMs, batch.planChanged);
      else budget.recordStepOutcome(stepIndex, batch.progressed && !batch.refusedOnly && !batch.unavailableOnly, durationMs);
    },
  });
  assert.notEqual(counts(stalled), counts(base));
});

test("the replica still matches the frozen code it copies (comment-free), until both are updated together", () => {
  const current = snapshotAnchors(legacySources, REPLICA_SOURCES);
  if (updating) writeFileSync(snapshotUrl, `${JSON.stringify(current, null, 1)}\n`);
  const recorded = JSON.parse(readFileSync(snapshotUrl, "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(recorded).sort(), Object.keys(current).sort());
  for (const anchor of REPLICA_SOURCES) {
    assert.equal(current[anchorKey(anchor)], recorded[anchorKey(anchor)],
      `legacy-sources copy of ${anchor.file} differs where legacy-replica.ts copies it (${anchor.marker}): the copy is frozen at 583c295`);
  }
});

test("the drift check sees a code change inside an anchor and ignores a comment change", () => {
  const anchor = REPLICA_SOURCES.find((entry) => entry.marker === "const toolBudgetReached")!;
  const text = frozenSource(legacySources, anchor);
  const code = anchoredCode(text, anchor);
  const commented = text.replace("const toolBudgetReached =", "// a reworded rule\n    const toolBudgetReached = /* note */");
  assert.equal(anchoredCode(commented, anchor), code);
  const changed = text.replace("budget.progressing && setup.coordinator.extendToolCalls", "!budget.progressing && setup.coordinator.extendToolCalls");
  assert.notEqual(changed, text);
  assert.notEqual(anchoredCode(changed, anchor), code);
});
