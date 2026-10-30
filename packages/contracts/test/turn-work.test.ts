import assert from "node:assert/strict";
import { test } from "node:test";
import { createInterruptedToolResults, projectTurnWork, type EventDraft, type JsonValue, type SessionEvent } from "@0xsyncroot/contracts";

/** A journal in the making: events get dense sequences and the clock the test sets, as a store would stamp them. */
function journal() {
  const events: SessionEvent[] = [];
  let clock = Date.parse("2026-09-19T08:00:00.000Z");
  const append = (draft: EventDraft, advanceMs = 100): SessionEvent => {
    clock += advanceMs;
    const at = new Date(clock).toISOString();
    const event: SessionEvent = {
      ...draft, eventId: `event-${events.length + 1}`, sessionId: "session-work", seq: events.length + 1,
      occurredAt: at, recordedAt: at, tenantId: "tenant-a", actorId: "user-a", correlationId: "correlation",
      runtimeSnapshotId: "runtime", integrityHash: `hash-${events.length + 1}`,
    };
    events.push(event);
    return event;
  };
  return { events, append };
}

function toolEvents(turnId: string, stepId: string, call: { callId: string; executionId: string; toolId: string }) {
  return {
    intent: (extra: Record<string, JsonValue> = {}): EventDraft => ({ type: "tool/intent", turnId, stepId, callId: call.callId,
      payload: { ...call, arguments: "{}", state: "prepared", sideEffect: "none", ...extra } }),
    state: (state: string): EventDraft => ({ type: "tool/state", turnId, stepId, callId: call.callId, payload: { ...call, state } }),
    result: (state: string, extra: Record<string, JsonValue> = {}): EventDraft => ({ type: "tool/result", turnId, stepId, callId: call.callId,
      payload: { ...call, state, dispatched: state !== "not_started", ...extra } }),
  };
}

function plan(turnId: string, revision: number, state: string, steps: readonly [string, string, string, string?][], cause = "proposal"): EventDraft {
  return {
    type: "work/plan-updated", turnId,
    payload: {
      planId: "plan-payroll", revision, state, cause, goal: "Raise the allowance", updatedAt: new Date(0).toISOString(),
      steps: steps.map(([id, description, status, outcome]) => ({ id, description, status, ...(outcome ? { outcome } : {}) })),
    },
  };
}

test("an approved call is one tool of the turn that proposed it, with the result its resume recorded", () => {
  const { events, append } = journal();
  const write = toolEvents("turn-ask", "step-ask-1", { callId: "call-write", executionId: "exec-write", toolId: "update_employee" });
  append({ type: "turn/start", turnId: "turn-ask", payload: { inputIdempotencyKey: "ask" } }, 0);
  append({ type: "user/input", turnId: "turn-ask", payload: { content: "Raise the allowance", source: "chat" } });
  append(write.intent());
  append(write.state("awaiting_approval"));
  append({ type: "turn/end", turnId: "turn-ask", payload: { status: "awaiting_approval", steps: 1 } }, 4_900);

  const resumed = toolEvents("turn-approved", "step-approved-1", { callId: "call-write", executionId: "exec-write", toolId: "update_employee" });
  const readback = toolEvents("turn-approved", "step-approved-2", { callId: "call-read", executionId: "exec-read", toolId: "employee_profile" });
  append({ type: "turn/start", turnId: "turn-approved", payload: {
    inputIdempotencyKey: "approve", continuation: { pauseKind: "approval", pauseId: "approval-1", fromTurnId: "turn-ask", rootTurnId: "turn-ask" },
  } }, 60_000);
  append({ type: "approval/resolved", turnId: "turn-approved", payload: {
    approvalId: "approval-1", decision: "approve", actionDigest: "digest", resolvedBy: "user-a", resolvedAt: new Date(0).toISOString(),
  } });
  append(resumed.intent());
  append(resumed.state("dispatching"));
  append(resumed.result("succeeded", { workStepId: "apply" }));
  append(readback.intent({ initiator: "policy" }));
  append(readback.result("succeeded", { workStepId: "apply" }));
  append({ type: "turn/end", turnId: "turn-approved", payload: { status: "completed", steps: 2, decision: "finish" } }, 7_000);

  const [asked, approved] = projectTurnWork(events);
  assert.deepEqual(asked?.tools, [{ callId: "call-write", executionId: "exec-write", toolId: "update_employee", state: "succeeded", workStepId: "apply" }],
    "the write is listed once, under the turn whose intent came first, closed by the result its resume wrote");
  assert.equal(asked?.status, "awaiting_approval");
  assert.equal(asked?.durationMs, 5_200);
  assert.deepEqual(approved?.tools, [{ callId: "call-read", executionId: "exec-read", toolId: "employee_profile", state: "succeeded", workStepId: "apply", initiator: "policy" }],
    "the resume lists only the call it made itself");
  assert.equal(approved?.continuesTurnId, "turn-ask");
  assert.equal(approved?.decision, "finish");
  assert.equal(approved?.durationMs, 7_600);
});

test("a plan journaled before plans had an identity is scoped to its own turn and closed the way the turn ended", () => {
  const { events, append } = journal();
  for (const [turnId, status] of [["turn-old", "partial"], ["turn-older-style", "completed"]] as const) {
    append({ type: "turn/start", turnId, payload: { inputIdempotencyKey: turnId } });
    append({ type: "work/plan-updated", turnId, stepId: `${turnId}-1`, callId: "call-plan", payload: {
      goal: "Research", updatedAt: new Date(0).toISOString(),
      steps: [{ id: "1", description: "Search", status: "completed" }, { description: "Summarize", status: "in_progress" }],
    } });
    append({ type: "turn/end", turnId, payload: { status } });
  }
  const [partial, completed] = projectTurnWork(events);
  assert.deepEqual(partial?.plan, {
    planId: "legacy:turn-old", state: "stopped",
    steps: [{ id: "1", description: "Search", status: "completed" }, { id: "2", description: "Summarize", status: "in_progress" }],
  }, "a step without an id takes its position, and a partial turn leaves the plan stopped");
  assert.equal(completed?.plan?.planId, "legacy:turn-older-style");
  assert.equal(completed?.plan?.state, "completed");
  assert.equal(completed?.plan?.steps.length, 2, "an identical plan in another turn is another plan, so nothing is hidden as unchanged");
});

test("across a pause and its continuations each turn lists only the plan steps it changed", () => {
  const { events, append } = journal();
  const continuation = (fromTurnId: string, pauseKind: string) => ({ pauseKind, pauseId: `pause-${fromTurnId}`, fromTurnId, rootTurnId: "turn-1" });
  append({ type: "turn/start", turnId: "turn-1", payload: { inputIdempotencyKey: "one" } });
  append({ type: "assistant/narration", turnId: "turn-1", payload: { narrationId: "attempt-1", audience: "user", content: "I will look up the employee first." } });
  append(plan("turn-1", 1, "active", [["lookup", "Look up the employee", "in_progress"], ["ask", "Ask for the amount", "pending"], ["apply", "Apply the change", "pending"]]));
  append(plan("turn-1", 2, "awaiting_user", [["lookup", "Look up the employee", "in_progress"], ["ask", "Ask for the amount", "pending"], ["apply", "Apply the change", "pending"]], "terminal"));
  append({ type: "turn/end", turnId: "turn-1", payload: { status: "awaiting_interaction" } });

  append({ type: "turn/start", turnId: "turn-2", payload: { inputIdempotencyKey: "two", continuation: continuation("turn-1", "interaction") } });
  append(plan("turn-2", 3, "active", [["lookup", "Look up the employee", "completed", "Found NV001"], ["ask", "Ask for the amount", "in_progress"], ["apply", "Apply the change", "pending"]]));
  append(plan("turn-2", 4, "awaiting_user", [["lookup", "Look up the employee", "completed", "Found NV001"], ["ask", "Ask for the amount", "in_progress"], ["apply", "Apply the change", "pending"]], "terminal"));
  append({ type: "turn/end", turnId: "turn-2", payload: { status: "awaiting_approval" } });

  append({ type: "turn/start", turnId: "turn-3", payload: { inputIdempotencyKey: "three", continuation: continuation("turn-2", "approval") } });
  append(plan("turn-3", 5, "completed", [["lookup", "Look up the employee", "completed", "Found NV001"], ["ask", "Ask for the amount", "completed"], ["apply", "Apply the change", "completed"]], "terminal"));
  append({ type: "turn/end", turnId: "turn-3", payload: { status: "completed", decision: "finish" } });

  // An unrelated request replaces the finished plan; the turn's own plan is the new one.
  append({ type: "turn/start", turnId: "turn-4", payload: { inputIdempotencyKey: "four" } });
  append({ type: "work/plan-updated", turnId: "turn-4", payload: {
    planId: "plan-report", revision: 1, state: "active", cause: "proposal", goal: "Report", updatedAt: new Date(0).toISOString(),
    steps: [{ id: "collect", description: "Collect the totals", status: "in_progress" }],
  } });
  append(plan("turn-4", 6, "stopped", [["lookup", "Look up the employee", "completed", "Found NV001"], ["ask", "Ask for the amount", "completed"], ["apply", "Apply the change", "completed"]]));

  const [first, second, third, fourth] = projectTurnWork(events);
  assert.deepEqual(first?.narration, { narrationId: "attempt-1", content: "I will look up the employee first." });
  assert.deepEqual(first?.plan, { planId: "plan-payroll", state: "awaiting_user", steps: [
    { id: "lookup", description: "Look up the employee", status: "in_progress" },
    { id: "ask", description: "Ask for the amount", status: "pending" },
    { id: "apply", description: "Apply the change", status: "pending" },
  ] }, "a plan's first turn introduced every step");
  assert.deepEqual(second?.plan, { planId: "plan-payroll", state: "awaiting_user", steps: [
    { id: "lookup", description: "Look up the employee", status: "completed", outcome: "Found NV001" },
    { id: "ask", description: "Ask for the amount", status: "in_progress" },
  ] }, "the untouched last step is not repeated");
  assert.equal(second?.continuesTurnId, "turn-1");
  assert.deepEqual(third?.plan, { planId: "plan-payroll", state: "completed", steps: [
    { id: "ask", description: "Ask for the amount", status: "completed" },
    { id: "apply", description: "Apply the change", status: "completed" },
  ] });
  assert.deepEqual(fourth?.plan, { planId: "plan-report", state: "active", steps: [
    { id: "collect", description: "Collect the totals", status: "in_progress" },
  ] }, "closing the replaced plan does not make it this turn's plan");
  assert.equal(fourth?.status, "in_progress");
});

test("a failed turn shows how its open calls were closed, and its legacy plan as failed", () => {
  const { events, append } = journal();
  const lost = toolEvents("turn-failed", "step-1", { callId: "call-send", executionId: "exec-send", toolId: "send_report" });
  append({ type: "turn/start", turnId: "turn-failed", payload: { inputIdempotencyKey: "failed" } });
  append({ type: "work/plan-updated", turnId: "turn-failed", payload: {
    goal: "Send", updatedAt: new Date(0).toISOString(), steps: [{ id: "1", description: "Send the report", status: "in_progress" }],
  } });
  append(lost.intent());
  append(lost.state("dispatching"));
  for (const draft of createInterruptedToolResults(events.filter((event) => event.turnId === "turn-failed"), "turn-failed")) append(draft);
  append({ type: "turn/failed", turnId: "turn-failed", payload: { code: "worker-lost", message: "lost", retryable: false } }, 2_000);
  const [failed] = projectTurnWork(events);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.plan?.state, "failed");
  assert.deepEqual(failed?.tools.map((tool) => tool.state), ["outcome_unknown"], "a call past the dispatch boundary is unknown, never not-run");
  assert.equal(failed?.durationMs, 2_400);
  assert.equal(failed?.decision, undefined);
});

test("a turn still running has no end, and its open call keeps the last state it reported", () => {
  const { events, append } = journal();
  const pending = toolEvents("turn-live", "step-1", { callId: "call-ask", executionId: "exec-ask", toolId: "request_user_input" });
  append({ type: "turn/start", turnId: "turn-live", payload: { inputIdempotencyKey: "live" } });
  append(pending.intent());
  append(pending.state("awaiting_interaction"));
  const [live] = projectTurnWork(events);
  assert.equal(live?.status, "in_progress");
  assert.equal(live?.endedAt, undefined);
  assert.equal(live?.durationMs, undefined);
  assert.deepEqual(live?.tools, [{ callId: "call-ask", executionId: "exec-ask", toolId: "request_user_input", state: "awaiting_interaction" }]);
  assert.deepEqual(projectTurnWork([]), []);
});

test("recovery closes open calls by execution, once each, even when a provider reuses a call id", () => {
  const first = toolEvents("turn-r", "step-1", { callId: "call_0", executionId: "exec-1", toolId: "lookup" });
  const reused = toolEvents("turn-r", "step-2", { callId: "call_0", executionId: "exec-2", toolId: "lookup" });
  const drafts = createInterruptedToolResults([
    first.intent(), first.result("succeeded"),
    reused.intent(), reused.state("dispatching"),
    // The same execution recorded twice, as an approved call is when it resumes.
    reused.intent(),
  ], "turn-r");
  assert.equal(drafts.length, 1, "the finished call is not closed again, and the open execution is closed once");
  assert.deepEqual(drafts[0]?.payload, {
    callId: "call_0", executionId: "exec-2", toolId: "lookup", state: "outcome_unknown", dispatched: true,
    error: { type: "tool_error", code: "unknown-outcome", message: "Worker was lost after the tool crossed the dispatch boundary", retryable: false },
  });
  assert.equal(drafts[0]?.stepId, "step-2");

  const legacy = toolEvents("turn-l", "step-1", { callId: "call-legacy", executionId: "exec-legacy", toolId: "lookup" });
  const legacyResult: EventDraft = { type: "tool/result", turnId: "turn-l", stepId: "step-1", callId: "call-legacy", payload: { state: "succeeded" } };
  assert.deepEqual(createInterruptedToolResults([legacy.intent(), legacyResult], "turn-l"), [],
    "a result row without an execution still closes its call by call id");
  const undispatched = createInterruptedToolResults([legacy.intent()], "turn-l");
  assert.equal((undispatched[0]?.payload as Record<string, JsonValue>).state, "not_started");
});

test("a draft a policy sent back and kept as narration is never taken for the turn's announcement", () => {
  const { events, append } = journal();
  const narration = (turnId: string, stepId: string, narrationId: string, content: string): EventDraft =>
    ({ type: "assistant/narration", turnId, stepId, payload: { narrationId, audience: "user", content } });
  const stepEnd = (turnId: string, stepId: string, reason: string): EventDraft => ({ type: "step/end", turnId, stepId, payload: { status: "completed", reason } });
  // The announcement comes after two kept drafts: one from a send-back, one beside the fallback's own step.
  append({ type: "turn/start", turnId: "turn-kept", payload: { inputIdempotencyKey: "kept" } });
  append(narration("turn-kept", "step-1", "draft-1", "Draft the policy sent back."));
  append(stepEnd("turn-kept", "step-1", "turn-control-continue"));
  append(narration("turn-kept", "step-2", "announce", "I will read the remaining sheets."));
  append(stepEnd("turn-kept", "step-2", "narration"));
  append(narration("turn-kept", "step-3", "draft-3", "Draft kept beside the fallback."));
  append(stepEnd("turn-kept", "step-3", "turn-control-fallback"));
  append({ type: "turn/end", turnId: "turn-kept", payload: { status: "partial", decision: "partial" } });
  // Only drafts: the turn announced nothing.
  append({ type: "turn/start", turnId: "turn-drafts", payload: { inputIdempotencyKey: "drafts" } });
  append(narration("turn-drafts", "step-4", "draft-4", "Another draft."));
  append(stepEnd("turn-drafts", "step-4", "turn-control-continue"));

  const [kept, drafts] = projectTurnWork(events);
  assert.deepEqual(kept?.narration, { narrationId: "announce", content: "I will read the remaining sheets." });
  assert.equal(drafts?.narration, undefined);
});

test("the opening line acknowledges the request and is never taken for the turn's announcement", () => {
  const { events, append } = journal();
  append({ type: "turn/start", turnId: "turn-open", payload: { inputIdempotencyKey: "open" } });
  append({ type: "assistant/narration", turnId: "turn-open", payload: { narrationId: "opening:turn-open", audience: "user", content: "Got your request.", opening: true } });
  append({ type: "assistant/narration", turnId: "turn-open", stepId: "step-1", payload: { narrationId: "announce", audience: "user", content: "I will read the sheets." } });
  append({ type: "step/end", turnId: "turn-open", stepId: "step-1", payload: { status: "completed", reason: "narration" } });
  append({ type: "turn/end", turnId: "turn-open", payload: { status: "completed" } });
  append({ type: "turn/start", turnId: "turn-only-opening", payload: { inputIdempotencyKey: "only" } });
  append({ type: "assistant/narration", turnId: "turn-only-opening", payload: { narrationId: "opening:turn-only-opening", audience: "user", content: "Got it.", opening: true } });
  append({ type: "turn/end", turnId: "turn-only-opening", payload: { status: "completed" } });

  const [announced, opened] = projectTurnWork(events);
  assert.deepEqual(announced?.narration, { narrationId: "announce", content: "I will read the sheets." });
  assert.equal(opened?.narration, undefined);
});

test("a superseded narration leaves the turn's account; the sentence that superseded it and a progressing one stay", () => {
  const { events, append } = journal();
  const narration = (turnId: string, stepId: string, narrationId: string, content: string): EventDraft =>
    ({ type: "assistant/narration", turnId, stepId, payload: { narrationId, audience: "user", content } });
  const superseded = (turnId: string, stepId: string, narrationId: string, by: string): EventDraft =>
    ({ type: "assistant/narration-superseded", turnId, stepId, payload: { narrationId, by } });
  append({ type: "turn/start", turnId: "turn-stuck", payload: { inputIdempotencyKey: "stuck" } });
  append(narration("turn-stuck", "step-1", "n-1", "Looking for the save button."));
  append(narration("turn-stuck", "step-2", "n-2", "The save button is still covered."));
  append(superseded("turn-stuck", "step-2", "n-1", "n-2"));
  append(narration("turn-stuck", "step-3", "n-3", "The list still covers the save button."));
  append(superseded("turn-stuck", "step-3", "n-2", "n-3"));
  append({ type: "turn/end", turnId: "turn-stuck", payload: { status: "partial", decision: "partial" } });
  append({ type: "turn/start", turnId: "turn-next", payload: { inputIdempotencyKey: "next" } });
  append(narration("turn-next", "step-4", "n-4", "Next turn."));
  append(superseded("turn-next", "step-5", "n-3", "n-4"));

  const [stuck, next] = projectTurnWork(events);
  assert.deepEqual(stuck?.narration, { narrationId: "n-3", content: "The list still covers the save button." },
    "the superseded sentences are gone from the account, as they are gone from the chat; another turn's event drops nothing here");
  assert.deepEqual(next?.narration, { narrationId: "n-4", content: "Next turn." });
});
