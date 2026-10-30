import assert from "node:assert/strict";
import { test } from "node:test";
import { createEchoToolPlugin } from "@0xsyncroot/adapter-echo";
import {
  AgenticError, assertValidCoreEventDraft,
  type AgentProgressEvent, type LlmAdapter, type SessionEvent, type TurnControlPolicy, type TurnControlState, type TurnTerminalDecision,
} from "@0xsyncroot/contracts";
import { DefaultAgentLoop, type ContinueQuestionWording } from "@0xsyncroot/core";
import { createSystemPromptPlugin, answerOnlyInput } from "@0xsyncroot/plugins-base";
import type { RuntimeViewLease } from "../src/runtime-provider.js";
import { continueQuestionRequest } from "../src/agent/runtime-question.js";
import { taskTurnIdsFor } from "../src/agent/task-turns.js";
import { TurnEventWriter } from "../src/agent/turn-event-writer.js";
import { TurnJournalView } from "../src/agent/turn-journal-view.js";
import { TurnTerminator, type TurnTerminalOutcome } from "../src/agent/turn-terminator.js";
import { SpyStore, activeHost, answer, call, calls, planningPlugin, scriptedModel, security, PLAN_TOOL_ID } from "./turn-harness.js";

const WORDING: ContinueQuestionWording = {
  question: "Go on with the rest?", continueLabel: "Go on", stopLabel: "Stop here", stopped: "Stopped as you asked.",
};
const REQUEST = "read both parts";
const PARTIAL = "Part one is read; part two remains.";

function payload(event: SessionEvent | undefined): Record<string, unknown> {
  return (event?.payload ?? {}) as Record<string, unknown>;
}

function lastPlanState(events: readonly SessionEvent[]): unknown {
  return payload(events.filter((event) => event.type === "work/plan-updated").at(-1)).state;
}

/** A plan, two reads, and a final step the step allowance forces: the turn ends partial with its answer. */
function budgetScript(after: readonly ReturnType<typeof answer>[] = []) {
  return scriptedModel([
    calls([
      { id: "plan-1", name: PLAN_TOOL_ID, args: { goal: "Read both parts", steps: [
        { id: "one", description: "Read part one", status: "in_progress" }, { id: "two", description: "Read part two", status: "pending" },
      ] } },
      { id: "read-1", name: "agentic_echo", args: { value: "part one" } },
    ]),
    call("read-2", "agentic_echo", { value: "part one, page two" }),
    answer(PARTIAL),
    ...after,
  ]);
}

async function pausedOnBudget(sessionId: string, options: { readonly wording?: ContinueQuestionWording; readonly after?: readonly ReturnType<typeof answer>[]; readonly policy?: TurnControlPolicy } = {}) {
  const model = budgetScript(options.after);
  const { host, router } = await activeHost(model.adapter, [createSystemPromptPlugin(), createEchoToolPlugin(), planningPlugin()]);
  const store = new SpyStore();
  const agent = new DefaultAgentLoop(router, store, { maxSteps: 3 }, {
    ...(options.wording ? { continueQuestion: options.wording } : {}), ...(options.policy ? { turnControlPolicy: options.policy } : {}),
  });
  const progress: AgentProgressEvent[] = [];
  const paused = await agent.runTurn({ sessionId, content: REQUEST, security: security(), idempotencyKey: `${sessionId}-ask`, onProgress: (event) => progress.push(event) });
  return { ...model, host, store, agent, paused, progress };
}

test("the step allowance ends a turn partial with its answer and decision, and the runtime asks whether to go on", async () => {
  const { host, paused, progress } = await pausedOnBudget("budget-asks", { wording: WORDING });
  assert.deepEqual([paused.outcome, paused.content], ["partial", PARTIAL], "the answer the user read stays the turn's content");
  assert.equal(payload(paused.events.at(-1)).decision, "budget-reached");
  assert.deepEqual([paused.interaction?.requesterId, paused.interaction?.toolId, paused.interaction?.callId, paused.interaction?.message],
    ["runtime", "runtime", "", WORDING.question]);
  const requested = paused.events.find((event) => event.type === "interaction/requested");
  assert.equal(requested?.callId, undefined, "no call is bound to the runtime's own question");
  assert.deepEqual(["callId", "executionId", "toolId", "decisionId"].map((key) => payload(requested)[key]), [undefined, undefined, undefined, undefined]);
  const types = paused.events.map((event) => event.type);
  assert.deepEqual(types.slice(types.lastIndexOf("interaction/requested"), types.lastIndexOf("interaction/requested") + 2), ["interaction/requested", "step/end"],
    "asked in the same append as the step's end");
  assert.equal(lastPlanState(paused.events), "awaiting_user", "the plan waits on the answer, so going on restores it");
  assert.ok(progress.some((event) => event.type === "interaction-requested"));
  await host.shutdown();
});

test("continue resumes the same task: a continuation link, no user message, the plan restored and the original request audited", async () => {
  const states: TurnControlState[] = [];
  const policy: TurnControlPolicy = {
    id: "test.capture", revision: "v1", beforeModelStep: async () => ({}),
    reviewTerminal: async (state) => { states.push(state); return { decision: "accept" }; },
  };
  const { host, store, agent, paused, requests } = await pausedOnBudget("budget-continue", { wording: WORDING, policy, after: [answer("Both parts are read.")] });
  const progress: AgentProgressEvent[] = [];
  const resumed = await agent.resumeInteraction({
    sessionId: "budget-continue", interactionId: paused.interaction!.interactionId, action: "accept", content: { next: "continue" },
    security: security(), idempotencyKey: "budget-continue-go", onProgress: (event) => progress.push(event),
  });
  assert.deepEqual([resumed.outcome, resumed.content], ["completed", "Both parts are read."]);
  assert.deepEqual(payload(resumed.events.find((event) => event.type === "turn/start")).continuation, {
    pauseKind: "interaction", pauseId: paused.interaction!.interactionId, fromTurnId: paused.turnId, rootTurnId: paused.turnId,
  });
  const journal = await store.inner.load("budget-continue", security());
  assert.equal(taskTurnIdsFor(journal, resumed.turnId).length, 2);
  assert.equal(resumed.events.some((event) => event.type === "user/input"), false, "the answer is never a message the user typed");
  const resolved = payload(resumed.events.find((event) => event.type === "interaction/resolved"));
  assert.deepEqual([resolved.requesterId, resolved.choice, resolved.echo], ["runtime", "continue", [{ label: WORDING.question, value: WORDING.continueLabel }]]);
  const restored = progress.find((event) => event.type === "plan-updated" && event.cause === "restore");
  assert.ok(restored, "the plan the partial turn left waiting is restored");
  const told = requests.at(-1)!.messages.filter((message) => message.context?.provenance === "runtime-question-answer");
  assert.equal(told.length, 1);
  assert.match(told[0]!.content ?? "", /chose to continue/u);
  assert.equal(told[0]!.context?.trust, "instruction", "the runtime's note, not untrusted data");
  assert.equal(answerOnlyInput(states.at(-1)!, "Both parts are read.")?.request, REQUEST, "the audit weighs the request that began the task");
  await host.shutdown();
});

test("stop, a skip or a dismissal ends the answer's turn at once, without calling the model", async () => {
  for (const [action, content] of [["accept", { next: "stop" }], ["decline", undefined]] as const) {
    const sessionId = `budget-stop-${action}`;
    const { host, agent, paused, requests } = await pausedOnBudget(sessionId, { wording: WORDING });
    const calledBefore = requests.length;
    const ended = await agent.resumeInteraction({
      sessionId, interactionId: paused.interaction!.interactionId, action, ...(content ? { content } : {}), security: security(), idempotencyKey: `${sessionId}-answer`,
    });
    assert.equal(requests.length, calledBefore, `${action}: the model was not called`);
    assert.deepEqual([ended.outcome, ended.content, ended.interaction], ["partial", WORDING.stopped, undefined]);
    assert.equal(payload(ended.events.find((event) => event.type === "interaction/resolved")).choice, "stop");
    assert.equal(lastPlanState(ended.events), "stopped");
    await host.shutdown();
  }
});

test("a new message instead of an answer closes the question as superseded, with no call to answer and nothing told as a choice", async () => {
  const { host, agent, paused, requests } = await pausedOnBudget("budget-superseded", { wording: WORDING, after: [answer("Here is something else.")] });
  const next = await agent.runTurn({ sessionId: "budget-superseded", content: "something else", security: security() });
  const resolved = next.events.find((event) => event.type === "interaction/resolved");
  assert.deepEqual([payload(resolved).interactionId, payload(resolved).reason, payload(resolved).action, payload(resolved).resolvedBy],
    [paused.interaction!.interactionId, "superseded", "cancel", "runtime"]);
  assert.equal(next.events.some((event) => event.type === "tool/result" && payload(event).closure !== undefined), false);
  assert.equal(requests.at(-1)!.messages.some((message) => message.context?.provenance === "runtime-question-answer"), false);
  await assert.rejects(agent.resumeInteraction({
    sessionId: "budget-superseded", interactionId: paused.interaction!.interactionId, action: "accept", content: { next: "continue" },
    security: security(), idempotencyKey: "budget-superseded-late",
  }), (error: unknown) => error instanceof AgenticError && error.reason === "superseded");
  await host.shutdown();
});

test("a product that supplies no wording is never asked: the turn ends partial as before", async () => {
  const { host, paused } = await pausedOnBudget("budget-silent");
  assert.deepEqual([paused.outcome, paused.content, paused.interaction], ["partial", PARTIAL, undefined]);
  assert.equal(paused.events.some((event) => event.type === "interaction/requested"), false);
  assert.equal(lastPlanState(paused.events), "stopped");
  await host.shutdown();
});

test("a replayed partial turn returns its answer and the question it ended on", async () => {
  const { host, agent, paused } = await pausedOnBudget("budget-replay", { wording: WORDING });
  const replayed = await agent.runTurn({ sessionId: "budget-replay", content: REQUEST, security: security(), idempotencyKey: "budget-replay-ask" });
  assert.equal(replayed.replayed, true);
  assert.deepEqual([replayed.outcome, replayed.content, replayed.interaction?.interactionId, replayed.interaction?.toolId],
    ["partial", PARTIAL, paused.interaction!.interactionId, "runtime"]);
  await host.shutdown();
});

test("a policy's partial never asks; the work-remains bound asks only while a plan step is left undone, and never without a plan", async () => {
  const twoSteps = calls([{ id: "plan-1", name: PLAN_TOOL_ID, args: { goal: "Read both parts", steps: [
    { id: "one", description: "Read part one", status: "in_progress" }, { id: "two", description: "Read part two", status: "pending" },
  ] } }]);
  const cases = [["UI connection unavailable", true, false], ["work-remains-unmoved", true, true], ["work-remains-unmoved", false, false]] as const;
  for (const [reason, planned, asks] of cases) {
    const decision: TurnTerminalDecision = { decision: "accept", outcome: "partial", reason };
    const policy: TurnControlPolicy = { id: "test.partial", revision: "v1", beforeModelStep: async () => ({}), reviewTerminal: async () => decision };
    const { adapter } = scriptedModel([...(planned ? [twoSteps] : []), answer("Half of it.")]);
    const { host, router } = await activeHost(adapter as LlmAdapter, [createSystemPromptPlugin(), planningPlugin()]);
    const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { continueQuestion: WORDING, turnControlPolicy: policy })
      .runTurn({ sessionId: `policy-${reason.length}-${planned}`, content: "work", security: security() });
    assert.deepEqual([result.outcome, result.content, result.interaction !== undefined], ["partial", "Half of it.", asks], `${reason} planned ${planned}`);
    await host.shutdown();
  }
});

test("the journal accepts a runtime question without a call binding, and refuses one that names a call", () => {
  const base = {
    interactionId: "q-1", requesterId: "runtime", request: { kind: "form", message: "m", requestedSchema: { type: "object", properties: {} } },
    policyRevision: "p", runtimeSnapshotId: "r", runtimeRouteRevision: "rr", agentProfileId: "default", requestedBy: "user-a",
    grantRevision: "g", expiresAt: new Date().toISOString(),
  };
  assertValidCoreEventDraft({ type: "interaction/requested", turnId: "t", stepId: "s", payload: base });
  assert.throws(() => assertValidCoreEventDraft({ type: "interaction/requested", turnId: "t", stepId: "s", callId: "c", payload: base }), /binds no call/u);
  assert.throws(() => assertValidCoreEventDraft({ type: "interaction/requested", turnId: "t", payload: { ...base, requesterId: "a-tool" } }), /complete continuation binding/u);
  assert.throws(() => assertValidCoreEventDraft({ type: "interaction/resolved", turnId: "t", payload: {
    interactionId: "q-1", action: "accept", actionDigest: "d", resolvedBy: "user-a", resolvedAt: new Date().toISOString(), requesterId: "runtime",
  } }), /choice/u);
});

test("a fallback the runtime's own bound ended asks after its drafts, in the same append, and its closers see the question", async () => {
  const store = new SpyStore();
  const runtime = { id: "runtime-test", coreVersion: "1.0.0", pluginSetId: "test", policyRevision: "test-policy", memoryPolicyRevision: "m", createdAt: new Date(0).toISOString() };
  const claim = await store.claimTurn({
    sessionId: "fallback-asks", turnId: "turn-f", ownerId: "worker", idempotencyKey: "key-f", requestFingerprint: "f", leaseTtlMs: 10_000,
    startEvents: [{ type: "turn/start", turnId: "turn-f", payload: { inputIdempotencyKey: "key-f" } }],
  }, { security: security(), runtime });
  if (claim.kind !== "acquired") throw new Error("not acquired");
  const view = await TurnJournalView.open(store, "fallback-asks", security());
  const writer = new TurnEventWriter(store, "fallback-asks", security(), runtime, claim.seq, claim.lease);
  view.follow(writer);
  const terminator = new TurnTerminator({
    input: { sessionId: "fallback-asks", content: "x", security: security() }, turnId: "turn-f", writer, view,
    runtimeLease: { snapshot: runtime, binding: { routeRevision: "route-1" } } as unknown as RuntimeViewLease, interactionTtlMs: 60_000,
  });
  const outcomes: TurnTerminalOutcome[] = [];
  terminator.attach({ close: async (outcome) => { outcomes.push(outcome); return []; } });
  await writer.append([{ type: "step/start", turnId: "turn-f", stepId: "s1", payload: { index: 1 } }], "step-start:s1");
  const result = await terminator.finishFallback({
    stepId: "s1", stepIndex: 1, content: "What is still open.", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    drafts: [{ type: "assistant/message", turnId: "turn-f", stepId: "s1", requestId: "r", attemptId: "a", payload: { content: "What is still open.", toolCalls: [], finishReason: "turn-control-fallback", usage: {} } }],
    question: continueQuestionRequest(WORDING),
  });
  assert.deepEqual(result.events.map((event) => event.type), ["turn/start", "step/start", "assistant/message", "interaction/requested", "step/end", "turn/end"]);
  assert.deepEqual([result.outcome, result.content, result.interaction?.requesterId], ["partial", "What is still open.", "runtime"]);
  assert.deepEqual(outcomes, [{ kind: "fallback", asksUser: true }]);
});
