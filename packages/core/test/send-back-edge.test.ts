import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_AGENT_OPTIONS } from "../src/agent/agent-options.js";
import { normalizedContentHash } from "../src/agent/turn-control.js";
import { decide, objectionsHeard, openTurn } from "../src/agent/turn-end.js";
import type { TurnLedger } from "../src/agent/turn-end-facts.js";
import { workRemainsReview } from "../src/agent/work-remains-gate.js";

/**
 * A draft the policy's judge read as delivering a result is never sent to a step that may not call tools, and stands when it
 * comes back unmoved: both end as partial with the policy's notice instead of a closing step that rewrites the answer. A
 * draft that delivers nothing keeps its closing step. The objection the draft first got, and every count, stay as they were.
 */
const bounds = { ...DEFAULT_AGENT_OPTIONS, maxSteps: 4, initialStepBudget: 4 };
const decision = { decision: "continue", feedback: "Work remains: the total is not reconciled.", fallback: "Still open.", workRemains: true, delivered: true } as const;
const undelivered = { decision: "continue", feedback: "Work remains: nothing is read yet.", fallback: "Still open.", workRemains: true } as const;
const objected = (ledger: TurnLedger, stepIndex: number) => decide(ledger, { stepIndex, countedCalls: 0, wrote: false,
  outcome: { kind: "objection", ended: false, workRemains: true, phase: "terminal", answer: `draft-${stepIndex}` } }, bounds).ledger;

test("the lookahead says when a sent-back draft would meet no step with tools: the allowance edge, the ceiling, a closing order", () => {
  let { ledger } = openTurn(bounds, 1, { toolCalls: 0, wrote: false });
  const after = { bounds, countedCalls: 0 };
  assert.equal(objectionsHeard(ledger, { stepIndex: 1 }, after).noToolStepAfter, undefined);
  ledger = objected(objected(ledger, 1), 2);
  assert.equal(objectionsHeard(ledger, { stepIndex: 3 }, after).noToolStepAfter, true, "step 4 of 4 is the closing step");
  assert.equal(objectionsHeard(ledger, { stepIndex: 3 }).noToolStepAfter, undefined, "asked without the bounds, nothing is looked ahead");
  const fresh = openTurn(bounds, 1, { toolCalls: 0, wrote: false }).ledger;
  assert.equal(objectionsHeard(fresh, { stepIndex: 1 }, { bounds, countedCalls: bounds.maxToolCalls }).noToolStepAfter, true, "the step spent the ceiling");
  assert.equal(objectionsHeard({ ...fresh, closing: "step-failure:timeout" }, { stepIndex: 1 }, after).noToolStepAfter, true);
});

test("the gate: a draft at the edge stands as partial; below it the draft is sent back; a call at the edge is still objected", () => {
  const first = { heard: 0, fallbackDue: false, spent: false };
  assert.deepEqual(workRemainsReview("terminal", decision, { ...first, noToolStepAfter: true }, false, "Draft."), { kind: "proceed",
    terminalDecision: { decision: "accept", outcome: "partial", reason: "work-remains-final-step", notice: "Still open." }, delivered: true });
  const sentBack = workRemainsReview("terminal", decision, first, false, "Draft.");
  assert.deepEqual([sentBack.kind, "delivered" in sentBack && sentBack.delivered], ["continue", true],
    "a draft that hands work back gets its objection while a step with tools follows, marked for the journal");
  const call = workRemainsReview("tool-call", decision, { ...first, noToolStepAfter: true }, false, null);
  assert.deepEqual([call.kind, "exhausted" in call], ["continue", false], "only drafts stand at the edge; a call is objected as before");
  assert.equal(workRemainsReview("terminal", undelivered, { ...first, noToolStepAfter: true }, false, "Still looking.").kind, "continue",
    "a draft that delivers nothing is sent on, and the closing step after it writes the answer");
});

test("the gate: an unmoved delivered draft stands; an unmoved undelivered one and spent objections on a draft that kept moving still close the work", () => {
  const draft = "Figures handed over: 3 of 5.";
  const once = { heard: 1, fallbackDue: false, spent: false, objectedAnswer: normalizedContentHash(draft)! };
  const unmoved = workRemainsReview("terminal", decision, once, false, draft);
  assert.deepEqual(unmoved, { kind: "proceed", terminalDecision: { decision: "accept", outcome: "partial", reason: "work-remains-unmoved", notice: "Still open." }, delivered: true });
  const spent = workRemainsReview("terminal", decision, { heard: 3, fallbackDue: true, spent: true, objectedAnswer: normalizedContentHash("Other.")! }, false, draft);
  assert.deepEqual(spent, { kind: "close", feedback: decision.feedback, reason: "work-remains-unmoved", noticeFollows: true, delivered: true });
  assert.deepEqual(workRemainsReview("terminal", undelivered, once, false, draft),
    { kind: "close", feedback: undelivered.feedback, reason: "work-remains-unmoved", noticeFollows: true }, "an unmoved progress note gets its closing step");
});
