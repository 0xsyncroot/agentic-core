import assert from "node:assert/strict";
import { test } from "node:test";
import { createEchoToolPlugin } from "@0xsyncroot/adapter-echo";
import { AgenticError, projectTurnWork, type AgentNarrationEvent, type AgentOutputEvent, type AgentProgressEvent, type LlmAdapter, type LlmStreamEvent, type SessionEvent, type TurnControlPolicy } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { InMemorySessionStore } from "@0xsyncroot/persistence-memory";
import { createSystemPromptPlugin, createUserInputTool, createWorkPlanningPlugin } from "@0xsyncroot/plugins-base";
import {
  PLAN_TOOL_ID, activeHost, answer, calls, planningPlugin, planStep, scriptedModel, security, toolPlugin, writeTool,
} from "./turn-harness.js";

function payload(event: SessionEvent | undefined): Record<string, unknown> {
  return (event?.payload ?? {}) as Record<string, unknown>;
}

function planPayloads(events: readonly SessionEvent[]): Record<string, unknown>[] {
  return events.filter((event) => event.type === "work/plan-updated").map((event) => payload(event));
}

/** A read that never goes through: the step in progress it is attributed to stays open when a completed answer closes the rest. */
const failingLookup = { ...writeTool(), id: "test_lookup_fails", sideEffect: "none" as const, requiredPermissions: [], execute: async () => { throw new Error("unavailable"); } };
/** A plan update with a failing read under its step in progress: that step is left open by the answer. */
const openStep = (callId: string, goal: string, steps: Parameters<typeof planStep>[2]) =>
  calls([{ id: callId, name: PLAN_TOOL_ID, args: { goal, steps } }, { id: `${callId}-read`, name: failingLookup.id, args: { value: "x" } }]);

test("text beside the very first plan update, before any other work, is narrated once and the agent keeps working", async () => {
  const NARRATION_TEXT = "Để em kiểm tra dữ liệu tháng 8 trước nhé.";
  let modelCall = 0;
  const scripted: LlmAdapter = {
    id: "narration-alone", model: "narration-alone",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      modelCall += 1;
      if (modelCall === 1) {
        // A real stream: the text arrives as deltas, the way a client's output draft is built.
        yield { type: "text-delta", delta: NARRATION_TEXT };
        yield {
          type: "final", content: NARRATION_TEXT,
          toolCalls: [{ id: "plan-1", name: PLAN_TOOL_ID, arguments: JSON.stringify({ goal: "Xử lý yêu cầu", steps: [{ id: "check", description: "Kiểm tra dữ liệu tháng 8", status: "in_progress" }] }) }],
          finishReason: "tool_calls",
        };
        return;
      }
      if (modelCall === 2) {
        yield { type: "final", content: null, toolCalls: [{ id: "c1", name: "agentic_echo", arguments: '{"value":"evidence"}' }], finishReason: "tool_calls" };
        return;
      }
      yield { type: "text-delta", delta: "Xong rồi ạ." };
      yield { type: "final", content: "Xong rồi ạ.", toolCalls: [], finishReason: "stop", status: "completed" };
    },
  };
  const { host, router } = await activeHost(scripted, [createSystemPromptPlugin(), createEchoToolPlugin(), planningPlugin()]);
  const narration: AgentNarrationEvent[] = [];
  const output: AgentOutputEvent[] = [];
  const progress: AgentProgressEvent[] = [];
  const result = await new DefaultAgentLoop(router, new InMemorySessionStore(), { maxSteps: 6 })
    .runTurn({
      sessionId: "narration-alone", content: "work", security: security(),
      onNarration: (event) => narration.push(event), onOutput: (event) => output.push(event), onProgress: (event) => progress.push(event),
    });
  assert.equal(result.content, "Xong rồi ạ.", "the turn kept going after the announcement, to its real answer");
  assert.equal(result.outcome, "completed");
  assert.equal(modelCall, 3, "narrating did not end the turn on its own");

  assert.deepEqual(narration.map((event) => event.type), ["assistant-narration-start", "assistant-narration-delta", "assistant-narration-end"]);
  assert.equal(narration[1]!.type === "assistant-narration-delta" && narration[1].delta, "Để em kiểm tra dữ liệu tháng 8 trước nhé.");
  const narrationId = narration[0]!.narrationId;
  assert.equal(narration.every((event) => event.narrationId === narrationId), true);

  // The draft that carried the announcement is discarded, not completed — the narration channel
  // delivered it, so the output channel does not deliver it a second time; the real final answer's
  // own draft (step 3) still completes normally.
  assert.deepEqual(output.filter((event) => event.type === "assistant-output-end").map((event) => event.status), ["discarded", "completed"]);

  const narrated = result.events.find((event) => event.type === "assistant/narration");
  const message = result.events.find((event) => event.type === "assistant/message" && (payload(event).toolCalls as unknown[] | undefined)?.length);
  assert.equal(payload(narrated).content, "Để em kiểm tra dữ liệu tháng 8 trước nhé.");
  assert.equal(payload(narrated).narrationId, narrationId);
  // Journaled in the same append as the message it announced (§10.9): only the step's own usage
  // record, written in the same batch, sits between them — never a step boundary.
  const between = result.events.filter((event) => event.seq > message!.seq && event.seq < narrated!.seq).map((event) => event.type);
  assert.deepEqual(between, ["usage/recorded"]);

  assert.ok(progress.some((event) => event.type === "plan-updated" && event.cause === "proposal"));
  assert.equal(progress.filter((event) => event.type === "tool-started").length, 2, "the plan update and the lookup both ran");
  await host.shutdown();
});

test("an announcement beside a plan update mixed with a real call is still narrated once, and the call still runs", async () => {
  const { adapter } = scriptedModel([
    calls([
      { id: "lookup-1", name: "agentic_echo", args: { value: "evidence" } },
      { id: "plan-1", name: PLAN_TOOL_ID, args: { goal: "Xử lý yêu cầu", steps: [{ id: "check", description: "Kiểm tra dữ liệu", status: "in_progress" }] } },
    ], "Để em kiểm tra dữ liệu trước nhé."),
    answer("Xong rồi ạ."),
  ]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), createEchoToolPlugin(), planningPlugin()]);
  const narration: AgentNarrationEvent[] = [];
  const result = await new DefaultAgentLoop(router, new InMemorySessionStore(), { maxSteps: 6 })
    .runTurn({ sessionId: "narration-mixed", content: "work", security: security(), onNarration: (event) => narration.push(event) });
  assert.equal(result.content, "Xong rồi ạ.");
  assert.equal(narration.filter((event) => event.type === "assistant-narration-start").length, 1);
  const lookupResult = payload(result.events.find((event) => event.type === "tool/result" && event.callId === "lookup-1"));
  assert.equal(lookupResult.state, "succeeded", "the call beside the plan update still ran, not discarded with the text");
  await host.shutdown();
});

test("text beside a plan update is the answer once other work has already run, exactly as before narration existed", async () => {
  const { adapter } = scriptedModel([
    () => ({ type: "final", content: null, toolCalls: [{ id: "c1", name: "agentic_echo", arguments: '{"value":"evidence"}' }], finishReason: "tool_calls" }),
    planStep("plan-1", "Xử lý yêu cầu", [{ id: "check", description: "Kiểm tra dữ liệu", status: "completed" }], "Đã kiểm tra xong, không có gì bất thường."),
  ]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), createEchoToolPlugin(), planningPlugin()]);
  const narration: AgentNarrationEvent[] = [];
  const result = await new DefaultAgentLoop(router, new InMemorySessionStore(), { maxSteps: 6 })
    .runTurn({ sessionId: "answer-after-work", content: "work", security: security(), onNarration: (event) => narration.push(event) });
  assert.equal(result.content, "Đã kiểm tra xong, không có gì bất thường.");
  assert.equal(result.outcome, "completed");
  assert.deepEqual(narration, [], "the window for an opening announcement had already closed");
  await host.shutdown();
});

test("silence after a plan announcement gets one recovery and never reports the promise as completed work", async () => {
  let calls_ = 0;
  const scripted: LlmAdapter = {
    id: "silent-after-plan", model: "silent-after-plan",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      calls_ += 1;
      if (calls_ === 1) {
        yield { type: "text-delta", delta: "Để em kiểm tra giúp anh/chị." };
        yield {
          type: "final", content: "Để em kiểm tra giúp anh/chị.",
          toolCalls: [{ id: "plan-1", name: PLAN_TOOL_ID, arguments: JSON.stringify({ goal: "g", steps: [{ id: "check", description: "Check", status: "in_progress" }] }) }],
          finishReason: "tool_calls",
        };
        return;
      }
      yield { type: "final", content: null, toolCalls: [], finishReason: "stop", status: "completed" };
    },
  };
  const { host, router } = await activeHost(scripted, [createSystemPromptPlugin(), planningPlugin()]);
  const result = await new DefaultAgentLoop(router, new InMemorySessionStore(), { maxSteps: 6 })
    .runTurn({ sessionId: "silent-after-plan", content: "work", security: security() });
  assert.equal(result.content, "");
  assert.equal(result.outcome, "partial");
  assert.equal(calls_, 3, "one recovery attempt, then an explicit incomplete outcome");
  assert.equal(payload(result.events.at(-1)).reason, "empty-response");
  await host.shutdown();
});

test("a proposal the planning tool refuses leaves the plan exactly as it was, and the turn still reaches an answer", async () => {
  const { adapter } = scriptedModel([
    // An empty goal passes the tool's own JSON schema (no minLength there) but fails parseProposal's
    // structural check — the case this refusal exists for: past the generic schema, still not a plan.
    () => ({ type: "final", content: null, toolCalls: [{ id: "plan-1", name: "plan_update", arguments: JSON.stringify({ goal: "", steps: [{ id: "a", description: "A", status: "in_progress" }] }) }], finishReason: "tool_calls" }),
    answer("Đã ghi nhận."),
  ]);
  // The real planning tool, whose parseProposal actually validates structure (unlike the harness stub).
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), createWorkPlanningPlugin()]);
  const result = await new DefaultAgentLoop(router, new InMemorySessionStore(), { maxSteps: 6 })
    .runTurn({ sessionId: "plan-refused", content: "work", security: security() });
  assert.equal(result.content, "Đã ghi nhận.");
  const refused = payload(result.events.find((event) => event.type === "tool/result" && event.callId === "plan-1"));
  assert.equal(refused.state, "failed");
  assert.equal(refused.dispatched, true);
  assert.match(String((refused.error as Record<string, unknown>).message), /goal must be a non-empty string/u);
  assert.equal(result.events.some((event) => event.type === "work/plan-updated"), false, "no plan was ever created from the refused call");
  await host.shutdown();
});

test("two planning calls in one step are applied in order, each with its own journaled result", async () => {
  const { adapter } = scriptedModel([
    calls([
      { id: "plan-1", name: PLAN_TOOL_ID, args: { goal: "g", steps: [{ id: "a", description: "A", status: "in_progress" }] } },
      { id: "plan-2", name: PLAN_TOOL_ID, args: { goal: "g", steps: [{ id: "a", description: "A", status: "in_progress" }, { id: "b", description: "B", status: "pending" }] } },
    ]),
    answer("done"),
  ]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), planningPlugin()]);
  const result = await new DefaultAgentLoop(router, new InMemorySessionStore(), { maxSteps: 6 })
    .runTurn({ sessionId: "two-plan-calls", content: "work", security: security() });
  const results = result.events.filter((event) => event.type === "tool/result" && (event.callId === "plan-1" || event.callId === "plan-2"));
  assert.deepEqual(results.map((event) => event.callId), ["plan-1", "plan-2"]);
  const plans = planPayloads(result.events).filter((plan) => plan.cause === "proposal");
  assert.deepEqual(plans.map((plan) => plan.revision), [1, 2]);
  assert.deepEqual((plans[1]!.steps as { id: string }[]).map((step) => step.id), ["a", "b"], "the second call's proposal is the one that stands");
  await host.shutdown();
});

test("a call combined with a plan update is stamped under the step the update sets, though an update completing a step applies after the call", async () => {
  const { adapter } = scriptedModel([
    planStep("plan-1", "g", [{ id: "a", description: "A", status: "in_progress" }]),
    calls([
      { id: "lookup-1", name: "agentic_echo", args: { value: "x" } },
      { id: "plan-2", name: PLAN_TOOL_ID, args: { goal: "g", steps: [{ id: "a", description: "A", status: "completed" }, { id: "b", description: "B", status: "in_progress" }] } },
    ]),
    answer("done"),
  ]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), createEchoToolPlugin(), planningPlugin()]);
  const result = await new DefaultAgentLoop(router, new InMemorySessionStore(), { maxSteps: 6 })
    .runTurn({ sessionId: "reordered-stamp", content: "work", security: security() });
  const lookupResult = payload(result.events.find((event) => event.type === "tool/result" && event.callId === "lookup-1"));
  assert.equal(lookupResult.workStepId, "b", "the work counts toward the step the update moves into progress");
  const order = result.events.filter((event) => event.callId === "lookup-1" || event.callId === "plan-2").map((event) => `${event.callId} ${event.type}`);
  assert.ok(order.indexOf("lookup-1 tool/result") < order.indexOf("plan-2 work/plan-updated"), "the completion applied after the call's result");
  const plans = result.events.filter((event) => event.type === "work/plan-updated" && event.callId === "plan-2").map((event) => payload(event));
  assert.deepEqual((plans[0]?.steps as { status: string }[] | undefined)?.map((step) => step.status), ["completed", "in_progress"], "the work succeeded, so the update applied");
  await host.shutdown();
});

test("the plan survives an approval continuation: reopened as the policy's workPlan on the resumed step, reported as a restore on the stream", async () => {
  const { adapter } = scriptedModel([
    planStep("plan-1", "g", [{ id: "confirm", description: "Confirm the write", status: "in_progress" }]),
    () => ({ type: "final", content: null, toolCalls: [{ id: "write-1", name: "test_write", arguments: '{"value":"v"}' }], finishReason: "tool_calls" }),
    answer("done"),
  ]);
  const seenWorkPlans: unknown[] = [];
  const policy: TurnControlPolicy = {
    id: "test.plan-visible", revision: "v1",
    beforeModelStep: async (state) => { seenWorkPlans.push(state.workPlan); return {}; },
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), planningPlugin(), toolPlugin("write", [writeTool()])]);
  const store = new InMemorySessionStore();
  const paused = await new DefaultAgentLoop(router, store, {}, { turnControlPolicy: policy }).runTurn({
    sessionId: "plan-resume", content: "work", security: security(),
  });
  assert.equal(paused.outcome, "awaiting_approval");
  const pausedWorkPlan = seenWorkPlans.at(-1) as { planId: string; steps: { id: string; status: string }[] } | undefined;
  assert.deepEqual(pausedWorkPlan?.steps.map((step) => step.id), ["confirm"]);

  const progress: AgentProgressEvent[] = [];
  const resumed = await new DefaultAgentLoop(router, store, {}, { turnControlPolicy: policy }).resumeTurn({
    sessionId: "plan-resume", approvalId: paused.approval!.approvalId, decision: "approve", security: security(), idempotencyKey: "approve-1",
    onProgress: (event) => progress.push(event),
  });
  assert.equal(resumed.content, "done");
  const restoreFrame = progress.find((event): event is Extract<AgentProgressEvent, { type: "plan-updated" }> => event.type === "plan-updated" && event.cause === "restore");
  assert.ok(restoreFrame, "the reopened plan is reported at the start of the resumed operation");
  assert.equal(restoreFrame!.plan.planId, pausedWorkPlan?.planId);
  // The policy sees the same reopened plan at the resumed step's own first call.
  assert.deepEqual((seenWorkPlans.at(-1) as { steps: { id: string }[] } | undefined)?.steps.map((step) => step.id), ["confirm"]);
  await host.shutdown();
});

test("an unrelated later message starts a new plan and stops the previous one as dormant", async () => {
  const { adapter } = scriptedModel([
    // A step whose read did not go through is left open by the answer, so close() leaves the plan
    // active — exactly the leftover, unfinished plan the next unrelated task finds dormant.
    openStep("plan-1", "g1", [{ id: "a", description: "Việc thứ nhất", status: "in_progress" }, { id: "later", description: "Việc sau", status: "pending" }]),
    answer("Đợi anh/chị xác nhận."),
    planStep("plan-2", "g2", [{ id: "b", description: "Việc khác hẳn", status: "in_progress" }]),
    answer("Đã xử lý việc khác."),
  ]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), planningPlugin(), toolPlugin("lookup", [failingLookup])]);
  const store = new InMemorySessionStore();
  const agent = new DefaultAgentLoop(router, store);
  const first = await agent.runTurn({ sessionId: "dormant-plan", content: "task one", security: security() });
  assert.equal(first.outcome, "completed");
  const second = await agent.runTurn({ sessionId: "dormant-plan", content: "task two, unrelated", security: security() });
  const plans = planPayloads(second.events);
  const stopped = plans.find((plan) => plan.cause === "terminal" && plan.state === "stopped");
  const proposed = plans.find((plan) => plan.cause === "proposal");
  assert.ok(stopped, "the dormant plan from task one was closed as stopped");
  assert.notEqual(stopped!.planId, proposed!.planId);
  assert.deepEqual((proposed!.steps as { id: string }[]).map((step) => step.id), ["b"]);
  await host.shutdown();
});

test("a plan that replaced a dormant one, then itself left open (its own terminal close() finds nothing changed), is still restored as dormant for the next task (§10.7)", async () => {
  const { adapter } = scriptedModel([
    // Task one's plan is left open the same way as the test above.
    openStep("plan-1", "g1", [{ id: "a", description: "Việc thứ nhất", status: "in_progress" }, { id: "later", description: "Việc sau", status: "pending" }]),
    answer("Đợi anh/chị xác nhận."),
    // Task two's proposal does not match task one's wording, so it retires task one's plan — and
    // is itself left open (its only step's read did not go through, no step without a call to
    // close), so closeForOutcome returns undefined and close() writes nothing for task two.
    openStep("plan-2", "g2", [{ id: "b", description: "Việc khác hẳn", status: "in_progress" }]),
    answer("Đã xử lý việc khác."),
    answer("Câu trả lời cho việc thứ ba."),
  ]);
  const seenWorkPlans: unknown[] = [];
  const policy: TurnControlPolicy = {
    id: "test.plan-visible-task-three", revision: "v1",
    beforeModelStep: async (state) => { seenWorkPlans.push(state.workPlan); return {}; },
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), planningPlugin(), toolPlugin("lookup", [failingLookup])]);
  const store = new InMemorySessionStore();
  const agent = new DefaultAgentLoop(router, store, {}, { turnControlPolicy: policy });
  const first = await agent.runTurn({ sessionId: "dormant-replacement", content: "task one", security: security() });
  assert.equal(first.outcome, "completed");
  const second = await agent.runTurn({ sessionId: "dormant-replacement", content: "task two, unrelated", security: security() });
  assert.equal(second.outcome, "completed");
  const secondPlans = planPayloads(second.events);
  const proposedSecond = secondPlans.find((plan) => plan.cause === "proposal");
  assert.equal(secondPlans.some((plan) => plan.cause === "terminal" && plan.planId === proposedSecond!.planId), false,
    "task two's own plan was left open: its terminal close() found nothing changed and wrote nothing");

  // The journal's own tail must end on task two's open plan, not on the closed dormant row it
  // replaced — the retirement is written first now, so a later restore reads the still-open plan.
  const journal = await store.load("dormant-replacement", security());
  const lastPlanEvent = [...journal].reverse().find((event) => event.type === "work/plan-updated");
  assert.equal((lastPlanEvent?.payload as { planId?: string } | undefined)?.planId, proposedSecond!.planId,
    "task two's plan is the last plan row in the journal, so it is the one a later restore reads");

  const third = await agent.runTurn({ sessionId: "dormant-replacement", content: "task three, unrelated again", security: security() });
  assert.equal(third.outcome, "completed");
  const restored = seenWorkPlans.at(-1) as { planId: string; state: string; steps: { id: string }[] } | undefined;
  assert.equal(restored?.planId, proposedSecond!.planId, "task two's plan, left open, is restored as task three's dormant plan");
  assert.equal(restored?.state, "active", "restored exactly as it was left: still open, never silently closed");
  await host.shutdown();
});

test("a policy fallback stops the plan, exactly as every other terminal closes it", async () => {
  const { adapter } = scriptedModel([
    planStep("plan-1", "g", [{ id: "a", description: "A", status: "in_progress" }]),
    () => ({ type: "final", content: null, toolCalls: [{ id: "c1", name: "agentic_echo", arguments: '{"value":"x"}' }], finishReason: "tool_calls" }),
  ]);
  const policy: TurnControlPolicy = {
    id: "test.no-business-calls", revision: "v1",
    beforeModelStep: async () => ({}),
    // The plan update is free to run; a real, acting call is refused every time, until the
    // objection is ignored enough that the runtime ends the turn on its own sentence.
    reviewToolCalls: async ({ toolCalls }) => toolCalls.some((call) => call.name !== PLAN_TOOL_ID)
      ? { decision: "continue", feedback: "No business call is allowed right now.", fallback: "Không thể tiếp tục lúc này." }
      : { decision: "accept" },
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), createEchoToolPlugin(), planningPlugin()]);
  const result = await new DefaultAgentLoop(router, new InMemorySessionStore(), {}, { turnControlPolicy: policy })
    .runTurn({ sessionId: "plan-fallback", content: "work", security: security() });
  assert.equal(result.outcome, "partial");
  assert.equal(result.content, "Không thể tiếp tục lúc này.");
  const stopped = planPayloads(result.events).find((plan) => plan.cause === "terminal");
  assert.equal(stopped?.state, "stopped");
  await host.shutdown();
});

test("a turn whose steps keep failing after proposing a plan ends unfinished and closes the plan; nothing proposed leaves it untouched", async () => {
  let step = 0;
  const throwsOnSecondStep: LlmAdapter = {
    id: "throws-after-plan", model: "throws-after-plan",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      step += 1;
      if (step === 1) {
        yield {
          type: "final", content: null,
          toolCalls: [{ id: "plan-1", name: PLAN_TOOL_ID, arguments: JSON.stringify({ goal: "g", steps: [{ id: "a", description: "A", status: "in_progress" }] }) }],
          finishReason: "tool_calls",
        };
        return;
      }
      throw new AgenticError("permanent", "the model adapter is unreachable");
    },
  };
  const { host, router } = await activeHost(throwsOnSecondStep, [createSystemPromptPlugin(), planningPlugin()]);
  const store = new InMemorySessionStore();
  // A failing step is retried, then closed by a summary step, then by the product's sentence: the turn ends
  // unfinished, not failed — and the plan it proposed is still closed, never left dangling active.
  const result = await new DefaultAgentLoop(router, store).runTurn({ sessionId: "plan-failed", content: "work", security: security() });
  assert.equal(result.outcome, "partial");
  const journal = await store.load("plan-failed", security());
  const closed = planPayloads(journal).find((plan) => plan.cause === "terminal");
  assert.equal(closed?.state, "stopped", "the proposal this operation made must be closed by the turn's end, not left dangling active");
  await host.shutdown();

  // Nothing to close: the very first step fails before any proposal or dispatch happened.
  const failsImmediately: LlmAdapter = {
    id: "fails-immediately", model: "fails-immediately",
    async *stream(): AsyncIterable<LlmStreamEvent> { throw new AgenticError("permanent", "no route to the model"); },
  };
  const { host: bare, router: bareRouter } = await activeHost(failsImmediately, [createSystemPromptPlugin(), planningPlugin()]);
  const bareStore = new InMemorySessionStore();
  assert.equal((await new DefaultAgentLoop(bareRouter, bareStore).runTurn({ sessionId: "nothing-proposed", content: "work", security: security() })).outcome, "partial");
  const bareJournal = await bareStore.load("nothing-proposed", security());
  assert.equal(bareJournal.some((event) => event.type === "work/plan-updated"), false);
  await bare.shutdown();
});

/** A model whose text arrives as deltas, the way a client's output draft is built, one scripted reply per call. */
function streamingModel(replies: readonly { readonly content: string | null; readonly toolCalls?: readonly { id: string; name: string; arguments: string }[] }[]) {
  const requests: Parameters<LlmAdapter["stream"]>[0][] = [];
  const adapter: LlmAdapter = {
    id: "streaming", model: "streaming", features: { toolChoice: true },
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      requests.push(request);
      const reply = replies[Math.min(requests.length, replies.length) - 1]!;
      if (reply.content) yield { type: "text-delta", delta: reply.content };
      const toolCalls = [...(reply.toolCalls ?? [])];
      yield { type: "final", content: reply.content, toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", ...(toolCalls.length ? {} : { status: "completed" as const }) };
    },
  };
  return { adapter, requests };
}

/** Runs one turn under `policy` and returns the two public channels in arrival order beside the result. */
async function runKept(sessionId: string, model: ReturnType<typeof streamingModel>, policy: TurnControlPolicy, options: { readonly maxSteps?: number; readonly askUser?: boolean } = {}) {
  const { askUser, ...loopOptions } = options;
  const { host, router } = await activeHost(model.adapter, [createSystemPromptPlugin(), createEchoToolPlugin(), planningPlugin(),
    ...(askUser ? [toolPlugin("ask-user", [createUserInputTool()])] : [])]);
  const wire: string[] = [];
  const narrated: string[] = [];
  const kinds: unknown[] = [];
  try {
    const result = await new DefaultAgentLoop(router, new InMemorySessionStore(), { maxSteps: 8, ...loopOptions }, { turnControlPolicy: policy }).runTurn({
      sessionId, content: "work", security: security(),
      onOutput: (event) => { if (event.type !== "assistant-output-delta") wire.push(`${event.type}${"status" in event ? `:${event.status}` : ""}#${event.outputId}`); },
      onNarration: (event) => {
        if (event.type === "assistant-narration-delta") narrated.push(event.delta);
        else {
          if (event.type === "assistant-narration-start") kinds.push(event.kind);
          wire.push(`${event.type}${"status" in event ? `:${event.status}` : ""}#${event.narrationId}`);
        }
      },
      onProgress: (event) => { if (event.type === "answer-revision-requested") wire.push(event.type); },
    });
    return { result, wire, narrated, kinds };
  } finally { await host.shutdown(); }
}

/** The frames a kept draft leaves, in the order a client needs them: narration under the draft's own id, then the draft's end. */
function keptFrames(wire: readonly string[]): readonly string[][] {
  return wire.flatMap((frame, index) => frame.startsWith("assistant-narration-start#")
    ? [[frame, wire[index + 1]!, wire[index + 2]!].map((each) => each.replace(/#.*$/u, `#${each.endsWith(frame.slice(frame.indexOf("#"))) ? "same" : "other"}`))] : []);
}

test("a policy that keeps drafts leaves a sent-back answer on screen as narration instead of retracting it", async () => {
  // Items differ as a real list's do: one line repeated word for word is a looping generation, which the runtime cuts.
  const DRAFT = `Em đã nhặt xong danh mục.\n${Array.from({ length: 120 }, (_, i) => `- Nhiệm vụ ${i + 1}: chi thường xuyên theo biểu chi tiết.\n`).join("")}`.trim();
  assert.ok(DRAFT.length > 5_000, "long enough to be a whole report, not a sentence");
  const model = streamingModel([{ content: DRAFT }, { content: "Kết quả cuối cùng, đầy đủ." }]);
  const policy: TurnControlPolicy = {
    id: "test.keeps", revision: "v1", keepDraftsAsNarration: true, beforeModelStep: async () => ({}),
    reviewTerminal: async ({ candidate }) => candidate.content === DRAFT ? { decision: "continue", feedback: "Two sheets are still unread." } : { decision: "accept" },
  };
  const { result, wire, narrated, kinds } = await runKept("kept-terminal", model, policy);
  assert.equal(result.content, "Kết quả cuối cùng, đầy đủ.");
  assert.equal(result.outcome, "completed");
  assert.equal(wire.includes("answer-revision-requested"), false, "nothing on screen is announced as under review");
  assert.deepEqual(keptFrames(wire), [["assistant-narration-start#same", "assistant-narration-end:completed#same", "assistant-output-end:discarded#same"]],
    "narration frames carry the draft's own output id and precede its end, so a client moves the text instead of dropping it");
  assert.deepEqual(narrated, [DRAFT], "the whole draft, whatever its length");
  assert.deepEqual(wire.filter((frame) => frame.startsWith("assistant-output-end")).map((frame) => frame.split("#")[0]), ["assistant-output-end:discarded", "assistant-output-end:completed"]);

  const narration = result.events.find((event) => event.type === "assistant/narration");
  const sentBack = result.events.find((event) => event.type === "step/end" && payload(event).reason === "turn-control-continue");
  assert.equal(payload(narration).content, DRAFT, "journaled, so a reload shows what the live turn showed");
  assert.equal(narration?.stepId, sentBack?.stepId, "in the step that was sent back");
  assert.deepEqual(kinds, ["draft"], "the live narration is marked as a draft");
  assert.equal(payload(narration).draft, true, "and so is its journal entry, so history shows the same label");
  assert.equal(result.events.some((event) => event.type === "assistant/message" && payload(event).content === DRAFT), false, "a draft is not the turn's answer");
  assert.equal(projectTurnWork(result.events)[0]?.narration, undefined, "and not the turn's announcement either");

  const feedback = model.requests[1]!.messages.find((message) => message.role === "system" && /still unread/u.test(message.content ?? ""));
  assert.match(feedback?.content ?? "", /shown to the user as progress[\s\S]*Your final answer must stand on its own and state the full result/u);
  assert.doesNotMatch(feedback?.content ?? "", /withheld from the user|do not repeat/iu);
});

test("text beside a refused call, a choice violation and the turn-control fallback keep the draft the same way", async () => {
  const echo = (id: string) => [{ id, name: "agentic_echo", arguments: '{"value":"write"}' }];
  // Text beside a call the policy refuses: the call never runs, the sentence stays.
  const refused = streamingModel([{ content: "Em trình danh mục để anh/chị xác nhận.", toolCalls: echo("c1") }, { content: "Xong." }]);
  let reviews = 0;
  const gate: TurnControlPolicy = {
    id: "test.gate", revision: "v1", keepDraftsAsNarration: true, beforeModelStep: async () => ({}),
    reviewToolCalls: async () => (reviews += 1) === 1 ? { decision: "continue", feedback: "Read the remaining pages before writing." } : { decision: "accept" },
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const first = await runKept("kept-tool-call", refused, gate);
  assert.deepEqual(first.narrated, ["Em trình danh mục để anh/chị xác nhận."]);
  assert.deepEqual(keptFrames(first.wire), [["assistant-narration-start#same", "assistant-narration-end:completed#same", "assistant-output-end:discarded#same"]]);
  assert.equal(first.result.events.some((event) => event.type === "tool/intent"), false, "the refused call was not dispatched");
  assert.equal(first.wire.includes("answer-revision-requested"), false);

  // A required call the model answered in prose: core raises the objection itself, under the same policy.
  const prose = streamingModel([{ content: "Em sẽ đọc tiếp các biểu còn lại." }, { content: null, toolCalls: echo("c2") }, { content: "Xong." }]);
  let steps = 0;
  const required: TurnControlPolicy = {
    id: "test.required", revision: "v1", keepDraftsAsNarration: true,
    beforeModelStep: async () => (steps += 1) <= 2 ? { toolChoice: "required" } : {},
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const second = await runKept("kept-choice-violation", prose, required);
  assert.deepEqual(second.narrated, ["Em sẽ đọc tiếp các biểu còn lại."]);
  assert.equal(second.result.content, "Xong.");
  assert.ok(second.result.events.some((event) => event.type === "turn/control-decision" && payload(event).phase === "choice-violation"));
  assert.equal(second.wire.includes("answer-revision-requested"), false);

  // The same objection ignored to the end: every lap's draft is kept, the last one beside the fallback that ends the turn.
  const stubborn = streamingModel([{ content: "Bản nháp một." }, { content: "Bản nháp hai." }, { content: "Bản nháp ba." }]);
  const objecting: TurnControlPolicy = {
    id: "test.fallback", revision: "v1", keepDraftsAsNarration: true, beforeModelStep: async () => ({}),
    reviewTerminal: async () => ({ decision: "continue", feedback: "Period 11/2026 is not in the data.", fallback: "Dữ liệu chỉ ghi nhận kỳ 08/2026." }),
  };
  const third = await runKept("kept-fallback", stubborn, objecting);
  assert.equal(third.result.content, "Dữ liệu chỉ ghi nhận kỳ 08/2026.");
  assert.equal(third.result.outcome, "partial");
  assert.deepEqual(third.narrated, ["Bản nháp một.", "Bản nháp hai.", "Bản nháp ba."]);
  assert.equal(third.wire.includes("answer-revision-requested"), false);
  assert.equal(third.wire.some((frame) => frame.startsWith("assistant-narration-end:discarded")), false);
  assert.deepEqual(third.result.events.filter((event) => event.type === "assistant/narration").map((event) => payload(event).content), ["Bản nháp một.", "Bản nháp hai.", "Bản nháp ba."]);
  assert.equal(projectTurnWork(third.result.events)[0]?.narration, undefined, "a draft kept beside the fallback is not the announcement");
  // Feedback is never compacted: only the newest kept draft is still quoted on the third lap.
  const quoted = stubborn.requests[2]!.messages.filter((message) => message.role === "system" && /shown to the user as progress/u.test(message.content ?? ""));
  assert.equal(quoted.length, 1);
  assert.match(quoted[0]!.content ?? "", /Bản nháp hai\./u);
  assert.equal(stubborn.requests[2]!.messages.filter((message) => /not in the data/u.test(message.content ?? "")).length, 2, "both objections stand; one quote");
});

test("work remains: the model's new reads between answers do not buy a fourth objection to an answer", async () => {
  // Only reads the runtime makes for the policy reset the stalled-lap count: reset by every new read, it would send a
  // complete answer back again and again.
  const read = (id: string, value: string) => ({ content: null, toolCalls: [{ id, name: "agentic_echo", arguments: JSON.stringify({ value }) }] });
  const model = streamingModel([{ content: "Đáp một." }, read("r1", "một"), { content: "Đáp hai." }, read("r2", "hai"), { content: "Đáp ba." }, read("r3", "ba"), { content: "Đáp bốn." }, { content: "Đáp kết." }]);
  const { result } = await runKept("work-remains-reads", model, remaining("test.reads", "terminal"), { maxSteps: 20 });
  assert.equal(result.outcome, "partial");
  assert.equal(objections(result).filter((event) => payload(event).phase === "terminal").length, 3, "three objections, though each lap read something new");
  assert.equal(model.requests.length, 8, "three answer-and-read laps, the fourth answer, closing step");
  assert.equal(model.requests.at(-1)!.tools.length, 0, "the last request is the closing step");
});

/** A policy whose objection is "the work is not finished": the generic completion gate, not a judgement of the answer. */
function remaining(id: string, phase: "terminal" | "tool-call"): TurnControlPolicy {
  const objection = { decision: "continue" as const, feedback: "Hai biểu còn chưa đọc.", fallback: "Lưu ý: còn 2 biểu chưa đọc.", workRemains: true };
  return { id, revision: "v1", keepDraftsAsNarration: true, beforeModelStep: async () => ({}),
    ...(phase === "tool-call" ? { reviewToolCalls: async () => objection } : {}),
    reviewTerminal: async () => phase === "terminal" ? objection : { decision: "accept" } };
}
const objections = (result: { readonly events: readonly SessionEvent[] }) => result.events.filter((event) => event.type === "turn/control-decision" && payload(event).decision === "continue");

test("work remains: the model decides, its fallback is never handed to it, and three laps with nothing new end in a closing step with the notice under it", async () => {
  const model = streamingModel([{ content: "Bản một." }, { content: "Bản hai." }, { content: "Bản ba." }, { content: "Bản bốn." }, { content: "Bản kết." }]);
  const { result, narrated } = await runKept("work-remains-unmoved", model, remaining("test.work", "terminal"));
  assert.equal(result.outcome, "partial");
  assert.equal(result.content, "Bản kết.\n\nLưu ý: còn 2 biểu chưa đọc.", "the closing answer stands, what the runtime established goes under it");
  assert.equal(model.requests.length, 5, "three laps that moved nothing, the stalled answer, then one closing step");
  assert.ok(model.requests.every((request) => request.toolChoice === undefined || request.toolChoice === "auto" || request.toolChoice === "none"), "never forced to a tool");
  assert.equal(model.requests.some((request) => request.messages.some((message) => (message.content ?? "").includes("còn 2 biểu chưa đọc"))), false,
    "the user-facing sentence is never offered to the model as a way out");
  assert.deepEqual(narrated, ["Bản một.", "Bản hai.", "Bản ba.", "Bản bốn."], "the stalled answer stays on screen as narration");
  assert.ok(objections(result).every((event) => payload(event).workRemains === true));
  assert.equal(result.events.some((event) => event.type === "turn/control-decision" && payload(event).decision === "close"
    && payload(event).reason === "work-remains-unmoved"), true);
  const closing = model.requests.at(-1)!;
  assert.equal(closing.tools.length, 0, "the closing step offers no tools");
  const instruction = closing.messages.map((message) => message.content ?? "").join("\n");
  assert.match(instruction, /Runtime stop cause: work-remains-unmoved/u);
  assert.match(instruction, /Hai biểu còn chưa đọc\./u, "what remains, as the policy sees it");
  assert.match(instruction, /the one concrete next step/u);
  assert.match(instruction, /Do not repeat that list/u, "told the runtime's own notice follows");
  assert.match(instruction, /never ask the user to send another message/u, "a closing never hands the continuation back");
  assert.doesNotMatch(instruction, /can be continued in the next message/u);
});

test("work remains: a closing step may still ask the user with a form, and the turn then waits on the answer", async () => {
  const ask = [{ id: "ask-1", name: "request_user_input", arguments: JSON.stringify({ message: "Tháng trước phân bổ theo nguồn nào?",
    fields: [{ id: "nguon", label: "Nguồn kinh phí", type: "select", choices: [{ value: "11", label: "Nguồn 11" }, { value: "12", label: "Nguồn 12" }] }] }) }];
  const model = streamingModel([{ content: "Bản một." }, { content: "Bản hai." }, { content: "Bản ba." }, { content: "Bản bốn." }, { content: null, toolCalls: ask }]);
  const { result } = await runKept("work-remains-ask", model, remaining("test.work", "terminal"), { askUser: true });
  const closing = model.requests.at(-1)!;
  assert.deepEqual(closing.tools.map((tool) => tool.name), ["request_user_input"], "the closing step offers only the ask-the-user form");
  const instruction = closing.messages.map((message) => message.content ?? "").join("\n");
  assert.match(instruction, /The only tool still offered is request_user_input: it puts something to the user, as its own description says;/u);
  assert.match(instruction, /offering the likely values so the user can pick one or type another, or hand the result to the user, with request_user_input\./u);
  assert.equal(result.outcome, "awaiting_interaction", "the form is raised and the turn waits on the answer");
});

test("work remains: a closing step without a policy notice is not told one follows", async () => {
  const quiet: TurnControlPolicy = { id: "test.quiet", revision: "v1", keepDraftsAsNarration: true, beforeModelStep: async () => ({}),
    reviewTerminal: async () => ({ decision: "continue", feedback: "Hai biểu còn chưa đọc.", workRemains: true }) };
  const model = streamingModel([{ content: "Bản một." }, { content: "Bản hai." }, { content: "Bản ba." }, { content: "Bản bốn." }, { content: "Bản kết." }]);
  const { result } = await runKept("work-remains-quiet", model, quiet);
  assert.equal(result.content, "Bản kết.");
  assert.doesNotMatch(model.requests.at(-1)!.messages.map((message) => message.content ?? "").join("\n"), /Do not repeat that list/u);
});

test("work remains: the model's own read does not buy more objections to its answers, and the last step ends on the answer whatever the count", async () => {
  // The model's read in step two does not reset the count: if it did, every such read would buy three more laps.
  const echo = [{ id: "e1", name: "agentic_echo", arguments: '{"value":"page 2"}' }];
  const model = streamingModel([{ content: "Bản một." }, { content: null, toolCalls: echo }, { content: "Bản hai." }, { content: "Bản ba." }, { content: "Bản bốn." }, { content: "Bản kết." }]);
  const { result } = await runKept("work-remains-moved", model, remaining("test.work", "terminal"));
  assert.equal(model.requests.length, 6, "three objected answers around the read, the fourth answer, then the closing step");
  assert.equal(result.content, "Bản kết.\n\nLưu ý: còn 2 biểu chưa đọc.");
  const last = streamingModel([{ content: "Bản một." }, { content: "Bản cuối." }]);
  const ended = await runKept("work-remains-final", last, remaining("test.work", "terminal"), { maxSteps: 2 });
  assert.equal(ended.result.outcome, "partial");
  assert.match(ended.result.content, /Lưu ý: còn 2 biểu chưa đọc\.$/u, "no step after the last one: accepted with the notice, never failed");
  assert.equal(ended.result.events.some((event) => event.type === "turn/failed"), false);
});

test("work remains on refused calls: nothing is dispatched, and past the bound the turn ends on the policy's sentence", async () => {
  const write = (id: string) => [{ id, name: "agentic_echo", arguments: '{"value":"write"}' }];
  const model = streamingModel([{ content: null, toolCalls: write("w1") }, { content: null, toolCalls: write("w2") }, { content: null, toolCalls: write("w3") }, { content: null, toolCalls: write("w4") }]);
  const { result } = await runKept("work-remains-calls", model, remaining("test.gate", "tool-call"));
  assert.equal(result.events.some((event) => event.type === "tool/intent"), false, "a refused call never runs");
  assert.equal(result.outcome, "partial");
  assert.equal(result.content, "Lưu ý: còn 2 biểu chưa đọc.");
  assert.equal(model.requests.length, 4);
});

test("restating the same plan is not a repeated action: never blocked as a cycle, never a failure note", async () => {
  // Identical plan updates are neither blocked as a cycle nor answered by the ledger with "N failures on this target;
  // stop retrying it. Use a different route" beside the plan.
  const same = (id: string) => planStep(id, "Đối soát", [{ id: "a", description: "Đọc bảng", status: "in_progress" }]);
  const { adapter, requests } = scriptedModel([same("p1"), same("p2"), same("p3"), same("p4"), answer("Xong.")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), planningPlugin()]);
  try {
    const result = await new DefaultAgentLoop(router, new InMemorySessionStore(), { maxSteps: 10 }, {}).runTurn({ sessionId: `restate-${Math.random()}`, content: "đối soát", security: security() });
    const refused = result.events.filter((event) => event.type === "tool/result" && /cycle-detected|Repeated tool call blocked/u.test(JSON.stringify(event.payload)));
    assert.equal(refused.length, 0, "no restatement is refused");
    assert.ok(requests.every((request) => !request.messages.some((message) => /Runtime check/u.test(message.content ?? ""))), "no failure note");
  } finally { await host.shutdown(); }
});
