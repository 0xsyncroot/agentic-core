import assert from "node:assert/strict";
import { test } from "node:test";
import {
  askReadBack, closesTurn, decide, NO_TERMINAL_OUTCOME, objectionsHeard, openTurn, recordedBatch, stepRan, WORK_REMAINS_CLOSING,
} from "../src/agent/turn-end.js";
import type { StepFacts, StepOutcomeFacts, StepRecord, TurnEndBounds, TurnLedger, TurnNext } from "../src/agent/turn-end-facts.js";

// decide() holds every turn-end rule; the replay (turn-end-replay.test.ts) proves it matches the recorded runs. These pin the
// rules the recorded runs cannot show: whether the user is asked to go on, the one closing step and its cause, the one re-ask,
// the read-back step, a failure under an ordered closing step, the end with no step left, both ceilings, and the objection
// count's resets (the recorded runs never reset it on the runtime's evidence or on the same answer).

const bounds: TurnEndBounds = { maxSteps: 20, initialStepBudget: 4, stepBudgetExtension: 4, maxToolCalls: 10 };
const NOTHING_SPENT = { toolCalls: 0, wrote: false };
const answer = (fields: Partial<Extract<StepOutcomeFacts, { kind: "answer" }>> = {}): StepOutcomeFacts =>
  ({ kind: "answer", silent: false, calledATool: false, completed: true, ...fields });
const after = (ledger: TurnLedger, record: StepRecord, outcome: StepOutcomeFacts, spent: Partial<Pick<StepFacts, "countedCalls" | "wrote" | "subGoalsUndone">> = {}) =>
  decide(ledger, { ...record, outcome, countedCalls: 0, wrote: ledger.wrote, ...spent }, bounds);
const ended = (next: TurnNext) => { assert.equal(next.kind, "end"); return next as Extract<TurnNext, { kind: "end" }>; };
const asks = (next: TurnNext): boolean => next.kind === "end" && next.by !== "failure" && next.ask;
const progressed = { progressed: true, planningOnly: false, planChanged: false, unavailableOnly: false, refusedOnly: false, workDispatched: true };

test("a turn opens with its allowance, and its first step is a closing step only at an edge", () => {
  const opened = openTurn(bounds, 1, NOTHING_SPENT);
  assert.equal(opened.ledger.allowance.granted, 4);
  assert.deepEqual(opened.next, { kind: "continue" });
  assert.deepEqual(openTurn({ ...bounds, initialStepBudget: 1 }, 1, NOTHING_SPENT).next, { kind: "closing", reason: "progress-stalled" });
  assert.deepEqual(openTurn(bounds, 2, { toolCalls: 10, wrote: true }).next, { kind: "closing", reason: "tool-call-limit" },
    "the calls a resumed turn's coordinator counted before its first step count");
  const past = openTurn({ ...bounds, maxSteps: 1 }, 2, NOTHING_SPENT);
  assert.deepEqual(past.next, { kind: "end", by: "failure", outcome: "failed", reason: NO_TERMINAL_OUTCOME }, "a resumed turn past its ceiling has no step");
});

test("an accepted answer ends the turn; a partial end asks whether to go on only while a sub-goal is not shown done", () => {
  const { ledger } = openTurn(bounds, 1, NOTHING_SPENT);
  const done = ended(after(ledger, { stepIndex: 2 }, answer(), { subGoalsUndone: true }).next);
  assert.deepEqual(done, { kind: "end", by: "answer", outcome: "completed", decision: "finish", ask: false });
  const policyPartial = after(ledger, { stepIndex: 2 }, answer({ accepted: { outcome: "partial", reason: "policy" } }), { subGoalsUndone: true }).next;
  assert.equal(ended(policyPartial).outcome, "partial");
  assert.equal(asks(policyPartial), false, "a partial the policy accepted on its own reason is its proof the rest cannot go on");
  const stalled = { stepIndex: 4, finalReason: "progress-stalled" };
  const limited = ended(after(ledger, stalled, answer(), { subGoalsUndone: true }).next);
  assert.deepEqual(limited, { kind: "end", by: "answer", outcome: "partial", decision: "budget-reached", reason: "progress-stalled", ask: true });
  assert.equal(asks(after(ledger, stalled, answer(), { subGoalsUndone: false }).next), false, "every sub-goal shown: nothing to go on with");
  assert.equal(asks(after(ledger, stalled, answer()).next), true, "no plan: the allowance cut the work, so some was left");
  const gateEnded = answer({ accepted: { outcome: "partial", reason: "work-remains-unmoved" } });
  assert.equal(asks(after(ledger, { stepIndex: 2 }, gateEnded, { subGoalsUndone: true }).next), true, "the gate's bound with a sub-goal left");
  assert.equal(asks(after(ledger, { stepIndex: 2 }, gateEnded, { subGoalsUndone: false }).next), false, "the gate's bound with every sub-goal shown");
  assert.equal(asks(after(ledger, { stepIndex: 2 }, gateEnded).next), false, "no plan: a work-remains finding is not evidence of work left (a product may send a figure-only finding as one)");
});

test("the work-remains closing step ends as plain partial and asks only while a sub-goal is not shown done", () => {
  const { ledger } = openTurn(bounds, 1, NOTHING_SPENT);
  const closing = { stepIndex: 3, finalReason: WORK_REMAINS_CLOSING };
  const overruled = answer({ accepted: { outcome: "partial", reason: "closing-step-objection" } });
  assert.deepEqual(ended(after(ledger, closing, overruled, { subGoalsUndone: true }).next),
    { kind: "end", by: "answer", outcome: "partial", decision: "partial", reason: WORK_REMAINS_CLOSING, ask: true });
  assert.equal(asks(after(ledger, closing, overruled, { subGoalsUndone: false }).next), false,
    "a read-only turn whose every sub-goal is shown is not asked to go on, however often its answer was sent back");
  assert.equal(asks(after(ledger, closing, overruled).next), false, "no plan: the gate's closing step is not evidence of work left");
  assert.equal(asks(after(ledger, closing, answer({ accepted: { outcome: "partial", reason: "policy" } }), { subGoalsUndone: true }).next), false,
    "a blocker the policy proved on the closing step asks nothing");
  assert.equal(asks(after(ledger, closing, answer({ accepted: { reason: "policy" } }), { subGoalsUndone: true }).next), true,
    "the review accepting the closing answer does not decide it: the sub-goal left does");
});

test("one closing step: it keeps the cause that ordered it, a failure's replacing the gate's; the ceiling and the edge close an open turn", () => {
  const { ledger } = openTurn(bounds, 1, NOTHING_SPENT);
  const closed = after(ledger, { stepIndex: 2 }, { kind: "close" });
  assert.deepEqual(closed.next, { kind: "closing", reason: WORK_REMAINS_CLOSING });
  assert.equal(closesTurn(closed.ledger), true);
  // The gate's closing step was ordered first: reaching the tool-call ceiling on the same step does not rename it.
  const spent = after(ledger, { stepIndex: 2 }, { kind: "close" }, { countedCalls: 10 });
  assert.deepEqual(spent.next, { kind: "closing", reason: WORK_REMAINS_CLOSING });
  const failed = after(closed.ledger, { stepIndex: 3, finalReason: WORK_REMAINS_CLOSING }, { kind: "failed", code: "transient", recoverable: true });
  assert.deepEqual(failed.next, { kind: "closing", reason: WORK_REMAINS_CLOSING }, "the retry of a closing step is a closing step");
  const twice = after(failed.ledger, { stepIndex: 4, finalReason: WORK_REMAINS_CLOSING }, { kind: "failed", code: "transient", recoverable: true });
  assert.deepEqual(twice.next, { kind: "closing", reason: "step-failure:transient" });
  // With no closing step ordered, the ceiling outranks the allowance edge, and either closes the next step only.
  assert.deepEqual(after(ledger, { stepIndex: 1, batch: progressed }, { kind: "tools" }, { countedCalls: 10 }).next, { kind: "closing", reason: "tool-call-limit" });
  const edge = after(ledger, { stepIndex: 3 }, { kind: "tools" });
  assert.deepEqual(edge.next, { kind: "closing", reason: "progress-stalled" });
  assert.equal(closesTurn(edge.ledger), false, "at the edge an objection may still buy a step");
});

test("an answer is asked again once per turn: a closing step's re-ask is a closing step past the ceiling, any other an ordinary step", () => {
  const ceiling = { ...bounds, maxSteps: 4 };
  const { ledger } = openTurn(ceiling, 1, NOTHING_SPENT);
  const atEdge = { stepIndex: 4, finalReason: "step-limit" };
  const reached = decide(ledger, { ...atEdge, outcome: answer({ calledATool: true }), countedCalls: 0, wrote: false }, ceiling);
  assert.equal(reached.ledger.allowance.granted, 5, "the re-ask runs past the ceiling");
  assert.deepEqual(reached.next, { kind: "closing", reason: "step-limit" });
  const again = ended(decide(reached.ledger, { stepIndex: 5, finalReason: "step-limit", outcome: answer({ silent: true }), countedCalls: 0, wrote: false }, ceiling).next);
  assert.deepEqual(again, { kind: "end", by: "answer", outcome: "partial", decision: "budget-reached", reason: "step-limit", ask: true });
  const silent = answer({ silent: true, completed: false });
  const first = after(openTurn(bounds, 1, NOTHING_SPENT).ledger, { stepIndex: 2 }, silent);
  assert.deepEqual(first.next, { kind: "continue" }, "an ordinary step's re-ask keeps its tools");
  assert.deepEqual(ended(after(first.ledger, { stepIndex: 3 }, silent).next),
    { kind: "end", by: "answer", outcome: "partial", decision: "partial", reason: "empty-response", ask: false });
  assert.equal(ended(after(first.ledger, { stepIndex: 4, finalReason: "progress-stalled" }, answer({ calledATool: true })).next).reason, "progress-stalled",
    "one re-ask per turn, whichever step used it");
});

test("a silent or cut-short answer is a partial end like any other: it asks when a sub-goal is undone, and without a plan only when a bound cut it", () => {
  const silent = answer({ silent: true, completed: false });
  const cutShort = answer({ completed: false });
  const first = after(openTurn(bounds, 1, NOTHING_SPENT).ledger, { stepIndex: 2 }, silent);
  for (const [outcome, subGoalsUndone, ask] of [[silent, true, true], [silent, false, false], [silent, undefined, false], [cutShort, true, true], [cutShort, undefined, false]] as const) {
    const end = ended(after(first.ledger, { stepIndex: 3 }, outcome, subGoalsUndone === undefined ? {} : { subGoalsUndone }).next);
    assert.deepEqual([end.outcome, end.ask], ["partial", ask], `${outcome === silent ? "silent" : "cut short"} ${subGoalsUndone}`);
  }
});

test("an objection ended on the policy's fallback asks only when work remains and a sub-goal is not shown done; one sent back is refunded", () => {
  const { ledger } = openTurn(bounds, 1, NOTHING_SPENT);
  for (const [workRemains, subGoalsUndone, ask] of [[true, true, true], [true, false, false], [true, undefined, false], [false, true, false], [false, undefined, false]] as const) {
    const fallback = ended(after(ledger, { stepIndex: 2 }, { kind: "objection", ended: true, workRemains, phase: "terminal" },
      subGoalsUndone === undefined ? {} : { subGoalsUndone }).next);
    assert.deepEqual(fallback, { kind: "end", by: "fallback", outcome: "partial", reason: "turn-control-fallback", ask }, `${workRemains} ${subGoalsUndone}`);
  }
  const sentBack = after(ledger, { stepIndex: 2 }, { kind: "objection", ended: false, workRemains: false, phase: "terminal" });
  assert.equal(sentBack.ledger.allowance.granted, 5, "the lap is given back");
  assert.deepEqual(sentBack.next, { kind: "continue" });
});

test("a failed step is retried once, then closes the turn, then ends on the product's sentence, one spelling throughout; final codes fail it", () => {
  const { ledger } = openTurn(bounds, 1, NOTHING_SPENT);
  const failed = (code: string, recoverable = true): StepOutcomeFacts => ({ kind: "failed", code, recoverable });
  const retried = after(ledger, { stepIndex: 1 }, failed("transient"));
  assert.deepEqual(retried.next, { kind: "continue" });
  const closing = after(retried.ledger, { stepIndex: 2 }, failed("transient"));
  assert.deepEqual(closing.next, { kind: "closing", reason: "step-failure:transient" });
  // A run of failures that ordered a closing step stays: the step that ran under it does not clear it.
  const ran = after(closing.ledger, { stepIndex: 3, finalReason: "step-failure:transient" }, { kind: "tools" });
  assert.equal(stepRan(ran.ledger).failures, 2);
  assert.deepEqual(after(ran.ledger, { stepIndex: 4 }, failed("transient")).next,
    { kind: "end", by: "fallback", outcome: "partial", reason: "step-failure:transient", ask: false });
  assert.equal(ended(after(closing.ledger, { stepIndex: 3, finalReason: "step-failure:transient" }, answer()).next).reason, "step-failure:transient");
  assert.deepEqual(after(ledger, { stepIndex: 1 }, failed("cancelled", false)).next, { kind: "end", by: "failure", outcome: "failed", reason: "cancelled" });
  // Without an ordered closing step, a step that ran to its end clears the run; decide() alone does not, since the step's
  // last writes still follow it.
  const answered = after(retried.ledger, { stepIndex: 2 }, { kind: "tools" });
  assert.equal(answered.ledger.failures, 1);
  assert.equal(stepRan(answered.ledger).failures, 0);
});

test("a step's batch is counted before the read-back step a review asked for; a batch after the ask fails loudly", () => {
  assert.deepEqual(recordedBatch({ stepIndex: 2 }, progressed), { stepIndex: 2, batch: progressed });
  assert.throws(() => recordedBatch({ stepIndex: 2, readBack: true }, progressed), /after a review asked for a step/u);
});

test("a step that leads on past the granted allowance ends the turn with no outcome", () => {
  const { ledger } = openTurn({ ...bounds, maxSteps: 4 }, 1, NOTHING_SPENT);
  const edge = decide(ledger, { stepIndex: 4, finalReason: "step-limit", outcome: { kind: "tools" }, countedCalls: 0, wrote: false }, { ...bounds, maxSteps: 4 });
  assert.deepEqual(edge.next, { kind: "end", by: "failure", outcome: "failed", reason: NO_TERMINAL_OUTCOME });
});

test("the read-back step is bought once, after a successful write only, and is the answer decide() then applies", () => {
  const record = { stepIndex: 4, finalReason: "progress-stalled" };
  const unwritten = openTurn(bounds, 1, NOTHING_SPENT).ledger;
  assert.equal(askReadBack(unwritten, record, bounds), undefined, "nothing was written: there is nothing to read back");
  const written = after(unwritten, { stepIndex: 1, batch: progressed }, { kind: "tools" }, { wrote: true }).ledger;
  assert.equal(written.wrote, true);
  const asked = askReadBack(written, record, bounds)!;
  assert.equal(asked.granted, true);
  assert.equal(askReadBack(written, asked.record, bounds), undefined, "a second ask in the same step buys nothing");
  const bought = after(written, asked.record, { kind: "objection", ended: false, workRemains: false, phase: "terminal" });
  assert.equal(bought.ledger.readBack, true);
  assert.deepEqual(bought.next, { kind: "continue" }, "the bought step can call the read-back");
  assert.equal(askReadBack(bought.ledger, { stepIndex: 6 }, bounds), undefined, "once per turn");
  const resumed = openTurn(bounds, 2, { toolCalls: 0, wrote: true }).ledger;
  assert.equal(askReadBack(resumed, { stepIndex: 2 }, bounds)?.granted, true, "the write a resumed turn ran counts");
  const tight = openTurn({ ...bounds, maxSteps: 4 }, 1, { toolCalls: 0, wrote: true }).ledger;
  assert.equal(askReadBack(tight, record, { ...bounds, maxSteps: 4 })?.granted, false, "the ceiling is not negotiable");
});

test("the step ceiling is a number: the allowance stops at it however much the work progresses, and the edge says step-limit", () => {
  const ceiling = { ...bounds, maxSteps: 6 };
  let { ledger, next } = openTurn(ceiling, 1, NOTHING_SPENT);
  let step = 1;
  for (; next.kind === "continue"; step += 1) {
    ({ ledger, next } = decide(ledger, { stepIndex: step, batch: progressed, outcome: { kind: "tools" }, countedCalls: 1, wrote: false }, ceiling));
  }
  assert.equal(ledger.allowance.granted, 6);
  assert.equal(ledger.toolCalls, 5, "the ledger counts the calls the coordinator counted");
  assert.deepEqual(next, { kind: "closing", reason: "step-limit" }, "step 6 is the last, and it must answer");
  assert.equal(step, 6);
});

test("objections reset only on the runtime's own evidence: the model's new results never buy more, a different objection counts too", () => {
  const objection = (phase: "terminal" | "tool-call" | "choice-violation", workRemains = false): StepOutcomeFacts =>
    ({ kind: "objection", ended: false, workRemains, phase });
  let { ledger } = openTurn({ ...bounds, maxSteps: 40 }, 1, NOTHING_SPENT);
  // Every phase counts, and each lap between the objections brings the model a new result (the P6 reconciliation shape).
  const phases = ["terminal", "tool-call", "choice-violation"] as const;
  for (const [index, phase] of phases.entries()) {
    assert.deepEqual(objectionsHeard(ledger, { stepIndex: 2 * index + 1 }), { heard: index, fallbackDue: index >= 2, spent: false });
    ledger = after(ledger, { stepIndex: 2 * index + 1 }, objection(phase, index === 0)).ledger;
    ledger = after(ledger, { stepIndex: 2 * index + 2, batch: progressed }, { kind: "tools" }).ledger;
  }
  assert.equal(ledger.objections, 3, "the model's new results reset nothing");
  assert.deepEqual(objectionsHeard(ledger, { stepIndex: 7, batch: progressed }), { heard: 3, fallbackDue: true, spent: true },
    "an answer reviewed after the step's own batch is weighed the same");
  // A read the policy asked for that returned something new: the count starts over, at that step's own review already.
  const evidence: StepRecord = { stepIndex: 7, runtimeEvidence: true };
  assert.deepEqual(objectionsHeard(ledger, evidence), { heard: 0, fallbackDue: false, spent: false });
  assert.equal(after(ledger, evidence, objection("terminal")).ledger.objections, 1);
  assert.equal(after(ledger, evidence, { kind: "tools" }).ledger.objections, 0);
});

test("the same answer: the last work-remains objection's answer is kept until any new result or work call, the model's included", () => {
  const objected = (answer?: string, phase: "terminal" | "tool-call" = "terminal", workRemains = true): StepOutcomeFacts =>
    ({ kind: "objection", ended: false, workRemains, phase, ...(answer ? { answer } : {}) });
  const { ledger } = openTurn(bounds, 1, NOTHING_SPENT);
  const kept = after(ledger, { stepIndex: 1 }, objected("hash-a")).ledger;
  assert.equal(objectionsHeard(kept, { stepIndex: 2 }).objectedAnswer, "hash-a");
  assert.equal(objectionsHeard(kept, { stepIndex: 2, batch: progressed }).objectedAnswer, undefined, "the step's own new result counts");
  assert.equal(objectionsHeard(kept, { stepIndex: 2, runtimeEvidence: true }).objectedAnswer, undefined);
  assert.equal(after(kept, { stepIndex: 2, batch: progressed }, { kind: "tools" }).ledger.objectedAnswer, undefined);
  const refused = { ...progressed, progressed: false, refusedOnly: true, workDispatched: false };
  assert.equal(after(kept, { stepIndex: 2, batch: refused }, { kind: "tools" }).ledger.objectedAnswer, "hash-a", "a call refused before its tool changes nothing");
  const failed = { ...progressed, progressed: false };
  assert.equal(objectionsHeard(kept, { stepIndex: 2, batch: failed }).objectedAnswer, undefined, "a work call that reached its tool and failed counts");
  assert.equal(after(kept, { stepIndex: 2, batch: failed }, { kind: "tools" }).ledger.objectedAnswer, undefined);
  assert.equal(after(kept, { stepIndex: 2, batch: { ...failed, planningOnly: true, workDispatched: false } }, { kind: "tools" }).ledger.objectedAnswer, "hash-a",
    "a planning call is no work");
  const objections = after(after(kept, { stepIndex: 2, batch: failed }, { kind: "tools" }).ledger, { stepIndex: 3 }, objected("hash-a")).ledger;
  assert.equal(objections.objections, 2, "the work call answers the objection once; the count still bounds the laps");
  assert.equal(after(kept, { stepIndex: 2 }, objected(undefined, "tool-call")).ledger.objectedAnswer, "hash-a", "an objection to a call is not about the answer");
  assert.equal(after(kept, { stepIndex: 2 }, objected("hash-b", "terminal", false)).ledger.objectedAnswer, "hash-a", "only the gate's objection names it");
  assert.equal(after(kept, { stepIndex: 2 }, objected()).ledger.objectedAnswer, undefined, "an objection to an empty answer names none");
});
