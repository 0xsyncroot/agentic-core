import assert from "node:assert/strict";
import { test } from "node:test";
import { APPROVAL_DECISION, APPROVAL_EVENT, assertValidCoreEventDraft, CORE_EVENT_REGISTRY, parseTurnAttachments, toolNextCallReads, type EventDraft, type JsonValue } from "@0xsyncroot/contracts";

const updatedAt = "2026-09-19T08:00:00.000Z";

function planDraft(payload: Record<string, JsonValue>): EventDraft {
  return { type: "work/plan-updated", turnId: "turn-1", payload: { goal: "Raise the allowance", updatedAt, ...payload } };
}

test("plan snapshots with and without a runtime identity are both accepted, outside any model step", () => {
  assert.equal(CORE_EVENT_REGISTRY["work/plan-updated"].step, false);
  assert.doesNotThrow(() => assertValidCoreEventDraft(planDraft({ steps: [{ id: "1", description: "Search", status: "completed" }] })),
    "a legacy snapshot keeps goal, steps and updatedAt only");
  assert.doesNotThrow(() => assertValidCoreEventDraft(planDraft({
    planId: "plan-1", revision: 2, state: "awaiting_user", cause: "terminal", changedStepIds: ["lookup"],
    steps: [{ id: "lookup", description: "Look up the employee", status: "completed", outcome: "Found NV001" }],
  })));
  assert.throws(() => assertValidCoreEventDraft(planDraft({ steps: {} })), /requires goal, steps and updatedAt/u);
});

test("a plan with a runtime identity must be complete, bounded and safe to deliver", () => {
  const step = { id: "lookup", description: "Look up the employee", status: "in_progress" };
  const identified = { planId: "plan-1", revision: 1, state: "active", steps: [step] };
  assert.throws(() => assertValidCoreEventDraft(planDraft({ planId: "plan-1", steps: [step] })), /planId, a positive revision and a known state/u,
    "an identity without its revision and state is a half-written plan, not a legacy one");
  assert.throws(() => assertValidCoreEventDraft(planDraft({ ...identified, revision: 0 })), /positive revision/u);
  assert.throws(() => assertValidCoreEventDraft(planDraft({ ...identified, state: "skipped" })), /known state/u);
  assert.throws(() => assertValidCoreEventDraft(planDraft({ ...identified, cause: "guess" })), /unknown cause/u);
  assert.throws(() => assertValidCoreEventDraft(planDraft({ ...identified, changedStepIds: [1] })), /changedStepIds/u);
  assert.throws(() => assertValidCoreEventDraft(planDraft({ ...identified, steps: [{ ...step, id: "step 1" }] })), /unique safe ids/u,
    "an id a delivery layer would drop is refused before it is journaled");
  assert.throws(() => assertValidCoreEventDraft(planDraft({ ...identified, steps: [step, step] })), /unique safe ids/u);
  assert.throws(() => assertValidCoreEventDraft(planDraft({ ...identified, steps: [{ ...step, status: "skipped" }] })), /known status/u);
  assert.throws(() => assertValidCoreEventDraft(planDraft({ ...identified, steps: [{ ...step, outcome: "x".repeat(501) }] })), /bounded text/u);
  assert.throws(() => assertValidCoreEventDraft(planDraft({
    ...identified, steps: Array.from({ length: 21 }, (_, index) => ({ ...step, id: `step-${index}` })),
  })), /exceeds the plan limits/u);
});

test("a pause the runtime closed says why, as the runtime, with a matching outcome", () => {
  const approval = { approvalId: "approval-1", actionDigest: "digest", resolvedAt: updatedAt };
  assert.doesNotThrow(() => assertValidCoreEventDraft({ type: "approval/resolved", turnId: "turn-2",
    payload: { ...approval, decision: "superseded", reason: "superseded", resolvedBy: "runtime" } }));
  assert.doesNotThrow(() => assertValidCoreEventDraft({ type: "approval/resolved", turnId: "turn-2",
    payload: { ...approval, decision: "approve", resolvedBy: "user-a" } }), "a user's answer carries no reason");
  assert.throws(() => assertValidCoreEventDraft({ type: "approval/resolved", turnId: "turn-2",
    payload: { ...approval, decision: "approve", reason: "expired", resolvedBy: "runtime" } }), /matching decision/u);
  assert.throws(() => assertValidCoreEventDraft({ type: "approval/resolved", turnId: "turn-2",
    payload: { ...approval, decision: "expired", reason: "expired", resolvedBy: "user-a" } }), /resolvedBy runtime/u);

  const interaction = { interactionId: "interaction-1", actionDigest: "digest", resolvedAt: updatedAt };
  assert.doesNotThrow(() => assertValidCoreEventDraft({ type: "interaction/resolved", turnId: "turn-2",
    payload: { ...interaction, action: "cancel", reason: "expired", resolvedBy: "runtime" } }));
  assert.throws(() => assertValidCoreEventDraft({ type: "interaction/resolved", turnId: "turn-2",
    payload: { ...interaction, action: "decline", reason: "superseded", resolvedBy: "runtime" } }), /matching action/u);
  assert.doesNotThrow(() => assertValidCoreEventDraft({ type: "interaction/resolved", turnId: "turn-2", classification: "confidential",
    payload: { ...interaction, action: "accept", resolvedBy: "user-a", echo: [{ label: "Amount", value: "500 000" }] } }));
  assert.throws(() => assertValidCoreEventDraft({ type: "interaction/resolved", turnId: "turn-2",
    payload: { ...interaction, action: "accept", resolvedBy: "user-a", echo: [{ label: "Amount", value: 500 }] } }), /echo/u);

  const closed = { callId: "call-1", executionId: "exec-1", toolId: "update_employee", state: "cancelled", dispatched: false };
  assert.doesNotThrow(() => assertValidCoreEventDraft({ type: "tool/result", turnId: "turn-1", stepId: "step-1", callId: "call-1",
    payload: { ...closed, closure: { pauseKind: "approval", pauseId: "approval-1", closedByTurnId: "turn-2" } } }));
  assert.throws(() => assertValidCoreEventDraft({ type: "tool/result", turnId: "turn-1", stepId: "step-1", callId: "call-1",
    payload: { ...closed, closure: { pauseKind: "form", pauseId: "approval-1", closedByTurnId: "turn-2" } } }), /invalid closure/u);
  assert.throws(() => assertValidCoreEventDraft({ type: "tool/result", turnId: "turn-1", stepId: "step-1", callId: "call-1",
    payload: { ...closed, informationGain: "some" } }), /informationGain/u);
});

test("turn boundaries carry a well-formed continuation and a known decision", () => {
  const continuation = { pauseKind: "interaction", pauseId: "interaction-1", fromTurnId: "turn-1", rootTurnId: "turn-1" };
  assert.doesNotThrow(() => assertValidCoreEventDraft({ type: "turn/start", turnId: "turn-2", payload: { inputIdempotencyKey: "k", continuation } }));
  assert.throws(() => assertValidCoreEventDraft({ type: "turn/start", turnId: "turn-2",
    payload: { inputIdempotencyKey: "k", continuation: { ...continuation, rootTurnId: "" } } }), /invalid continuation/u);
  assert.doesNotThrow(() => assertValidCoreEventDraft({ type: "turn/end", turnId: "turn-2", payload: { status: "partial", decision: "budget-reached" } }));
  assert.throws(() => assertValidCoreEventDraft({ type: "turn/end", turnId: "turn-2", payload: { status: "completed", decision: "done" } }), /unknown decision/u);
});

function attachment(overrides: Record<string, JsonValue> = {}): JsonValue {
  return { id: "doc-1", name: "budget.xlsx", mediaType: "application/pdf", byteSize: 1_024, ...overrides };
}

test("an attachment manifest round-trips, undefined and empty both mean 'nothing attached'", () => {
  assert.equal(parseTurnAttachments(undefined), undefined);
  assert.equal(parseTurnAttachments(null), undefined);
  assert.equal(parseTurnAttachments([]), undefined);
  const parsed = parseTurnAttachments([attachment(), attachment({ id: "doc-2", source: "paste" })]);
  assert.equal(parsed?.length, 2);
  assert.deepEqual(parsed?.[0], { id: "doc-1", name: "budget.xlsx", mediaType: "application/pdf", byteSize: 1_024 });
  assert.deepEqual(parsed?.[1], { id: "doc-2", name: "budget.xlsx", mediaType: "application/pdf", byteSize: 1_024, source: "paste" });
});

test("a name cannot smuggle a line break, a paragraph break or a bidi override into a single manifest line", () => {
  // U+2028/U+2029 render as a real newline in most viewers, same effect as the "\n" this already
  // rejected: without this, one attachment's name could read as two manifest lines.
  assert.throws(() => parseTurnAttachments([attachment({ name: "a - b.xlsx id=doc-mine" })]), /name contains control characters/u);
  assert.throws(() => parseTurnAttachments([attachment({ name: "a b" })]), /name contains control characters/u);
  // The bidi override/embedding/isolate controls and the plain directional marks can make the
  // displayed order of a name diverge from its bytes.
  for (const bidi of ["‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩", "‎", "‏", "؜"]) {
    assert.throws(() => parseTurnAttachments([attachment({ name: `report${bidi}.pdf` })]), /name contains control characters/u,
      `U+${bidi.codePointAt(0)!.toString(16)} must be rejected`);
  }
  // Ordinary right-to-left script text (no formatting controls) is not a control character and is
  // still a perfectly fine file name.
  assert.doesNotThrow(() => parseTurnAttachments([attachment({ name: "تقرير الميزانية.pdf" })]));
});

test("an id is an opaque handle: surrounding whitespace is refused, never silently stripped", () => {
  assert.throws(() => parseTurnAttachments([attachment({ id: " doc-1" })]), /id must not have leading or trailing whitespace/u);
  assert.throws(() => parseTurnAttachments([attachment({ id: "doc-1 " })]), /id must not have leading or trailing whitespace/u);
  // A display name is still normalized: incidental whitespace around it is not a caller error.
  assert.deepEqual(parseTurnAttachments([attachment({ name: "  budget.xlsx  " })])?.[0]?.name, "budget.xlsx");
});

test("approval outcomes use the shared contract and reject tool-state spellings", () => {
  const resolved = { type: APPROVAL_EVENT.RESOLVED, turnId: "turn-1", payload: {
    approvalId: "a", actionDigest: "digest", resolvedBy: "user-a", resolvedAt: updatedAt,
  } };
  for (const decision of Object.values(APPROVAL_DECISION)) {
    assert.doesNotThrow(() => assertValidCoreEventDraft({ ...resolved, payload: { ...resolved.payload, decision } }));
  }
  for (const decision of ["denied", "approved", "unknown", ""]) {
    assert.throws(() => assertValidCoreEventDraft({ ...resolved, payload: { ...resolved.payload, decision } }), /approval\/resolved/u);
  }
});

test("a judgment event needs a bounded seam, a known outcome and finite values, outside any model step", () => {
  const draft = (payload: Record<string, JsonValue>): EventDraft => ({ type: "judgment/classified", turnId: "t1", payload });
  const ok = { seam: "completion-audit", providerId: "test-judge", modelId: "example-judgment-model", outcome: "answered", elapsedMs: 92,
    answers: { delivers: { type: "noul", value: 0.9877 }, kind: { type: "choice", value: 0.91, choice: "result" } } };
  assert.doesNotThrow(() => assertValidCoreEventDraft(draft(ok)));
  assert.doesNotThrow(() => assertValidCoreEventDraft(draft({ seam: "completion-audit", providerId: "test-judge", modelId: "m", outcome: "failed", elapsedMs: 3, reason: "429" })));
  assert.throws(() => assertValidCoreEventDraft(draft({ ...ok, seam: "" })), /seam/u);
  assert.throws(() => assertValidCoreEventDraft(draft({ ...ok, outcome: "maybe" })), /outcome/u);
  assert.throws(() => assertValidCoreEventDraft(draft({ ...ok, answers: { delivers: { type: "noul", value: "high" } } })), /finite/u);
  assert.throws(() => assertValidCoreEventDraft(draft({ ...ok, elapsedMs: -1 })), /elapsedMs/u);
  const verdict = { label: "unmoved", threshold: 0.1, mode: "on", sameHash: false };
  assert.doesNotThrow(() => assertValidCoreEventDraft(draft({ ...ok, verdict })));
  assert.throws(() => assertValidCoreEventDraft(draft({ seam: "answer-moved", providerId: "p", modelId: "m", outcome: "failed", elapsedMs: 3, verdict })), /answered/u);
  assert.throws(() => assertValidCoreEventDraft(draft({ ...ok, verdict: { ...verdict, label: "" } })), /label/u);
  assert.throws(() => assertValidCoreEventDraft(draft({ ...ok, verdict: { ...verdict, threshold: 1.5 } })), /threshold/u);
  assert.throws(() => assertValidCoreEventDraft(draft({ ...ok, verdict: { ...verdict, mode: "maybe" } })), /mode/u);
  assert.throws(() => assertValidCoreEventDraft(draft({ ...ok, verdict: { ...verdict, sameHash: "no" } })), /sameHash/u);
  assert.doesNotThrow(() => assertValidCoreEventDraft(draft({ ...ok, seam: "answer-moved-item", verdict: { ...verdict, label: "absent", item: "3.264.300" } })));
  assert.throws(() => assertValidCoreEventDraft(draft({ ...ok, verdict: { ...verdict, item: "x".repeat(301) } })), /item/u);
  assert.throws(() => assertValidCoreEventDraft(draft({ ...ok, verdict: { ...verdict, item: "" } })), /item/u);
});

test("a standing approval on a policy decision names its decision, on an allowed call no approval also covers", () => {
  const decision = (extra: Record<string, JsonValue>): EventDraft => ({
    type: "tool/policy-decision", turnId: "turn-1", stepId: "step-1", callId: "call-1",
    payload: { callId: "call-1", executionId: "exec-1", toolId: "write", decisionId: "standing-1", outcome: "allow", policyRevision: "rev",
      reason: "standing", actionDigest: "digest", ...extra },
  });
  const standing = { revision: "rev-1", since: "2026-10-15T01:00:00.000Z" };
  assert.doesNotThrow(() => assertValidCoreEventDraft(decision({ standingApproval: standing })));
  assert.doesNotThrow(() => assertValidCoreEventDraft(decision({ standingApproval: { ...standing, presentation: { action: "Write", target: "Sheet", summary: "s", impact: "i" } } })),
    "with the card it replaced");
  for (const [why, extra] of [
    ["a refused call", { outcome: "deny", standingApproval: standing }],
    ["a card still asked", { outcome: "require_approval", standingApproval: standing }],
    ["also covered by an approval", { coveredBy: "approval-1", standingApproval: standing }],
    ["no revision", { standingApproval: { since: standing.since } }],
    ["a time that is not one", { standingApproval: { revision: "rev-1", since: "yesterday" } }],
    ["not an object", { standingApproval: true }],
    ["a presentation that is not an object", { standingApproval: { ...standing, presentation: "card" } }],
  ] as const) {
    assert.throws(() => assertValidCoreEventDraft(decision(extra as unknown as Record<string, JsonValue>)), /standingApproval/u, why);
  }
});

test("memory/context-unavailable says why in a bounded reason, code and message; none may be a free-form blob", () => {
  const draft = (payload: Record<string, JsonValue>): EventDraft => ({ type: "memory/context-unavailable", turnId: "turn-3", payload });
  assert.equal(CORE_EVENT_REGISTRY["memory/context-unavailable"].step, false);
  assert.doesNotThrow(() => assertValidCoreEventDraft(draft({ reason: "error", code: "ER_PARSE_ERROR", message: "syntax error" })));
  assert.doesNotThrow(() => assertValidCoreEventDraft(draft({ reason: "timeout", message: "Memory search exceeded 5000 ms" })));
  assert.doesNotThrow(() => assertValidCoreEventDraft(draft({ reason: "error", message: "" })), "new Error() has an empty message");
  assert.doesNotThrow(() => assertValidCoreEventDraft(draft({ reason: "error", code: "c".repeat(64), message: "m".repeat(300) })), "the bounds are inclusive");
  const refusal = /memory\/context-unavailable requires/u;
  assert.throws(() => assertValidCoreEventDraft(draft({ reason: "gone", message: "x" })), refusal);
  assert.throws(() => assertValidCoreEventDraft(draft({ message: "x" })), refusal);
  assert.throws(() => assertValidCoreEventDraft(draft({ reason: "error" })), refusal);
  assert.throws(() => assertValidCoreEventDraft(draft({ reason: "error", message: 5 })), refusal);
  assert.throws(() => assertValidCoreEventDraft(draft({ reason: "error", message: "m".repeat(301) })), refusal);
  assert.throws(() => assertValidCoreEventDraft(draft({ reason: "error", code: "c".repeat(65), message: "x" })), refusal);
  assert.throws(() => assertValidCoreEventDraft(draft({ reason: "error", code: 1064, message: "x" })), refusal);
});

test("a superseded narration names itself and the narration that took its place, which is never itself", () => {
  const superseded = (payload: Record<string, JsonValue>): EventDraft =>
    ({ type: "assistant/narration-superseded", turnId: "turn-1", stepId: "step-3", payload });
  const refusal = /assistant\/narration-superseded requires narrationId and another narration's id as by/u;
  assert.doesNotThrow(() => assertValidCoreEventDraft(superseded({ narrationId: "n-1", by: "n-2" })));
  assert.throws(() => assertValidCoreEventDraft(superseded({ narrationId: "", by: "n-2" })), refusal);
  assert.throws(() => assertValidCoreEventDraft(superseded({ narrationId: "n-1" })), refusal);
  assert.throws(() => assertValidCoreEventDraft(superseded({ narrationId: "n-1", by: 7 })), refusal);
  assert.throws(() => assertValidCoreEventDraft(superseded({ narrationId: "n-2", by: "n-2" })), refusal, "never itself");
  assert.throws(() => assertValidCoreEventDraft({ type: "assistant/narration-superseded", turnId: "turn-1", payload: { narrationId: "n-1", by: "n-2" } }),
    "journaled in the step whose outcome decided it");
});

test("a tool result's nextCall names a tool, its arguments as an object and why, or is absent", () => {
  const result = (nextCall?: JsonValue): EventDraft => ({ type: "tool/result", turnId: "turn-1", stepId: "step-2", callId: "call-1",
    payload: { callId: "call-1", executionId: "exec-1", toolId: "reader_read_document", state: "succeeded", dispatched: true, ...(nextCall !== undefined ? { nextCall } : {}) } });
  const refusal = /tool\/result nextCall must name a tool, its arguments as an object and why/u;
  assert.doesNotThrow(() => assertValidCoreEventDraft(result()));
  assert.doesNotThrow(() => assertValidCoreEventDraft(result({ toolId: "reader_read_table", arguments: { sheet: "T9", all: true }, why: "The preview was cut." })));
  assert.throws(() => assertValidCoreEventDraft(result({ toolId: "", arguments: {}, why: "x" })), refusal, "a tool with no id");
  assert.throws(() => assertValidCoreEventDraft(result({ toolId: "reader_read_table", arguments: ["T9"], why: "x" })), refusal, "arguments as a list");
  assert.throws(() => assertValidCoreEventDraft(result({ toolId: "reader_read_table", arguments: {}, why: 3 })), refusal, "why as a number");
  assert.throws(() => assertValidCoreEventDraft(result({ toolId: "reader_read_table", arguments: {} })), refusal, "no why");
  assert.throws(() => assertValidCoreEventDraft(result("reader_read_table")), refusal, "a bare string");
  assert.throws(() => assertValidCoreEventDraft(result(null)), refusal);
});

test("a nextCall's reads is kept as typed, rebuilt from its known fields, and anything else is no reads", () => {
  const reads = { source: { id: "d1", name: "Lương T9.xlsx", heading: "BẢNG LƯƠNG" }, unit: "sheet",
    catalog: [{ name: "T9", heading: "BẢNG LƯƠNG", rows: 120 }, { name: "Ghi chú" }], target: "T9", shown: { rows: 10, of: 120 } };
  assert.deepEqual(toolNextCallReads(reads), reads);
  assert.deepEqual(toolNextCallReads({ ...reads, extra: 1, catalog: [{ name: "T9", note: "x" }], shown: undefined }),
    { source: reads.source, unit: "sheet", catalog: [{ name: "T9" }], target: "T9" }, "unknown fields are dropped");
  for (const [bad, why] of [[{ ...reads, unit: "Sheet" }, "a unit that is not one lowercase word"], [{ ...reads, unit: "work sheet" }, "a unit of two words"],
    [{ ...reads, target: "T10" }, "a target outside the catalog"], [{ ...reads, catalog: [] }, "no parts"], [{ ...reads, catalog: [{ name: "T9", rows: -1 }] }, "negative rows"],
    [{ ...reads, shown: { rows: 130, of: 120 } }, "more shown than there is"], [{ ...reads, source: { id: "", name: "x" } }, "a source with no id"],
    [{ ...reads, source: { id: "d1", name: "x", heading: 3 } }, "a heading that is not text"], [null, "null"], ["sheet", "a string"]] as const) {
    assert.equal(toolNextCallReads(bad), undefined, why);
  }
  const result = (nextCall: JsonValue): EventDraft => ({ type: "tool/result", turnId: "turn-1", stepId: "step-2", callId: "call-1",
    payload: { callId: "call-1", executionId: "exec-1", toolId: "reader_read_document", state: "succeeded", dispatched: true, nextCall } });
  const call = { toolId: "reader_read_table", arguments: { sheet: "T9", all: true }, why: "cut" };
  assert.doesNotThrow(() => assertValidCoreEventDraft(result({ ...call, reads })));
  assert.throws(() => assertValidCoreEventDraft(result({ ...call, reads: { ...reads, target: "T10" } })), /tool\/result nextCall reads must name its source/u);
});

test("a control decision says delivered only as true", () => {
  const decision = (extra: Record<string, JsonValue>): EventDraft => ({ type: "turn/control-decision", turnId: "turn-1", stepId: "step-4",
    payload: { policyId: "completion", policyRevision: "1", phase: "terminal", decision: "continue", workRemains: true, ...extra } });
  assert.doesNotThrow(() => assertValidCoreEventDraft(decision({})));
  assert.doesNotThrow(() => assertValidCoreEventDraft(decision({ delivered: true })));
  assert.throws(() => assertValidCoreEventDraft(decision({ delivered: false })), /delivered is true or absent/u);
  assert.throws(() => assertValidCoreEventDraft(decision({ delivered: "yes" })), /delivered is true or absent/u);
  assert.throws(() => assertValidCoreEventDraft(decision({ delivered: null })), /delivered is true or absent/u);
});
