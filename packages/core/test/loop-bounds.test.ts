import assert from "node:assert/strict";
import test from "node:test";
import { AgenticError, type AgentProgressEvent, type JsonValue, type LlmAdapter, type PreparedLlmRequest, type SessionEvent, type ToolDefinition, type TurnControlPolicy } from "@0xsyncroot/contracts";
import { DefaultAgentLoop, type ContinueQuestionWording } from "@0xsyncroot/core";
import { resolveAgentOptions } from "../src/agent/agent-options.js";
import { activeHost, answer, call, calls, planningPlugin, planStep, PLAN_TOOL_ID, scriptedModel, security, SpyStore, toolPlugin, writeTool } from "./turn-harness.js";

/**
 * The loop's own bounds: a turn whose model keeps doing the same unproductive thing must end in a handful of model calls,
 * and an answer it ends on must be the model's — never the runtime's English note, never a draft the review already sent
 * back. Each test pins one such case (docs/incidents/2026-10-14-core-loop-bounds-audit.md).
 */
const read: ToolDefinition = {
  id: "test_read", version: "1", description: "read", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {}, execute: async (invocation) => ({ page: (invocation.arguments as { page?: number }).page ?? 0 }) as JsonValue,
};
const SAME = "The tool is not available, so this cannot be done.";
/** Drafts that each say something new: the gate's objections are spent without any answer coming back unmoved. */
const MOVING = ["Draft one.", "Draft two.", "Draft three.", "Draft four."].map((text) => answer(text));
const WORDING: ContinueQuestionWording = { question: "Go on?", continueLabel: "Go on", stopLabel: "Stop", stopped: "Stopped." };

const decisions = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "turn/control-decision")
  .map((event) => `${(event.payload as { phase: string }).phase}:${(event.payload as { decision: string }).decision}`);
/** Which control decisions carry the policy's `delivered`, in journal order. */
const deliveredRows = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "turn/control-decision")
  .map((event) => (event.payload as { delivered?: unknown }).delivered === true);
const turnEnd = (events: readonly SessionEvent[]) => events.find((event) => event.type === "turn/end")?.payload as Record<string, unknown>;
const narrated = (progress: readonly { readonly type: string; readonly delta?: string }[]) =>
  progress.filter((event) => event.type === "assistant-narration-delta").map((event) => event.delta);

test("A: a model that keeps calling a tool the turn does not have ends in a handful of calls, not 151", async () => {
  for (const sameArguments of [false, true]) {
    const ghosts = Array.from({ length: 150 }, (_value, index) => call(`g${index}`, "ghost_tool", sameArguments ? {} : { index }));
    const { adapter, requests } = scriptedModel([...ghosts, answer("done")]);
    const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read])]);
    try {
      const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48 })
        .runTurn({ sessionId: `ghost-${sameArguments}`, content: "read", security: security() });
      // Refunded three times like any refused step, then stalls; the allowance runs out and the last step has no tools.
      assert.ok(requests.length <= 8, `${requests.length} model calls`);
      assert.equal(result.outcome, "partial");
      assert.equal(requests.at(-1)!.tools.length, 0, "the turn ends on a step without tools");
      if (sameArguments) {
        const third = result.events.filter((event) => event.type === "tool/result")[2]!.payload as { error: { message: string } };
        assert.match(third.error.message, /Repeated tool call blocked: ghost_tool/u, "the repeat guard counts calls to a tool the step lacks");
      }
    } finally { await host.shutdown(); }
  }
});

test("A: calls to a tool the step lacks count against the tool-call ceiling", async () => {
  const ghosts = Array.from({ length: 80 }, (_value, index) => call(`g${index}`, "ghost_tool", { index }));
  const { adapter, requests } = scriptedModel([...ghosts, answer("done")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read])]);
  try {
    // A wide allowance, so only the ceiling (4 calls) stops it.
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 70, initialStepBudget: 70, maxToolCalls: 4 })
      .runTurn({ sessionId: "ghost-ceiling", content: "read", security: security() });
    assert.ok(requests.length <= 20, `${requests.length} model calls`);
    assert.equal(turnEnd(result.events).reason, "tool-call-limit");
  } finally { await host.shutdown(); }
});

test("I: a model that only restates the same plan stalls instead of being refunded to the tool-call cap", async () => {
  const steps = [{ id: "s1", description: "read", status: "in_progress" }];
  for (const withGhost of [false, true]) {
    const replies = Array.from({ length: 400 }, (_value, index) => withGhost
      ? calls([{ id: `p${index}`, name: PLAN_TOOL_ID, args: { goal: "goal", steps } }, { id: `g${index}`, name: "ghost_tool", args: {} }])
      : planStep(`p${index}`, "goal", steps));
    const { adapter, requests } = scriptedModel([...replies, answer("done")]);
    const { host, router } = await activeHost(adapter, [planningPlugin(), toolPlugin("tools", [read])]);
    try {
      const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48, maxToolCalls: 64 })
        .runTurn({ sessionId: `plan-only-${withGhost}`, content: "read", security: security() });
      assert.ok(requests.length <= 8, `${requests.length} model calls (was 258)`);
      assert.equal(result.outcome, "partial");
    } finally { await host.shutdown(); }
  }
});

test("I: a plan update that changes the plan is still free", async () => {
  // Four plan updates, each moving a step on, then the answer: under a two-step allowance only refunds let it get there.
  const plan = (index: number) => planStep(`p${index}`, "goal", [0, 1, 2, 3].map((step) => ({
    id: `s${step}`, description: `step ${step}`, status: step < index ? "completed" : step === index ? "in_progress" : "pending" })));
  const { adapter, requests } = scriptedModel([plan(0), plan(1), plan(2), plan(3), answer("all four done")]);
  const { host, router } = await activeHost(adapter, [planningPlugin(), toolPlugin("tools", [read])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48, initialStepBudget: 2 })
      .runTurn({ sessionId: "plan-moves", content: "read", security: security() });
    assert.equal(result.content, "all four done");
    assert.equal(requests.length, 5);
    assert.ok(requests.slice(0, 4).every((request) => request.tools.length > 0), "no plan step became the final step");
  } finally { await host.shutdown(); }
});

test("D: two step failures far apart do not end a turn that recovered from the first", async () => {
  const requests: unknown[] = [];
  let n = 0;
  const adapter: LlmAdapter = {
    id: "flaky", model: "flaky",
    async *stream(request) {
      requests.push(request); n += 1;
      if (n === 1 || n === 5) throw new AgenticError("permanent", `boom ${n}`);
      if (n <= 8 && request.tools.length > 0) {
        yield { type: "final", content: null, toolCalls: [{ id: `c${n}`, name: "test_read", arguments: JSON.stringify({ page: n }) }], finishReason: "tool_calls", status: "tool_calls" };
        return;
      }
      yield { type: "final", content: `answer at call ${n}`, toolCalls: [], finishReason: "stop", status: "completed" };
    },
  };
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48, maxLlmAttempts: 1 })
      .runTurn({ sessionId: "flaky", content: "read", security: security() });
    assert.equal(result.outcome, "completed", "was partial on 'step-failure (permanent)' after the second failure");
    assert.equal(result.content, "answer at call 9");
  } finally { await host.shutdown(); }
});

test("D: a step whose end cannot be journaled failed, so after an earlier failure the next step closes the turn", async () => {
  const requests: PreparedLlmRequest[] = [];
  const adapter: LlmAdapter = {
    id: "flaky", model: "flaky",
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) throw new AgenticError("permanent", "boom");
      if (request.tools.some((tool) => tool.name === "test_read")) {
        yield { type: "final", content: null, toolCalls: [{ id: `c${requests.length}`, name: "test_read", arguments: JSON.stringify({ page: requests.length }) }], finishReason: "tool_calls", status: "tool_calls" };
        return;
      }
      yield { type: "final", content: "what was done", toolCalls: [], finishReason: "stop", status: "completed" };
    },
  };
  // The retried step's calls run, then its step/end append fails: the step did not run to its end.
  const store = new SpyStore();
  let endFailed = false;
  store.appendLeased = async (...args) => {
    const ends = args[2].some((draft) => draft.type === "step/end" && (draft.payload as { reason?: string }).reason === "tool-results");
    if (ends && !endFailed) { endFailed = true; throw new AgenticError("transient", "journal write failed"); }
    return store.inner.appendLeased(...args);
  };
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read])]);
  try {
    const result = await new DefaultAgentLoop(router, store, { maxSteps: 48, maxLlmAttempts: 1 })
      .runTurn({ sessionId: "end-append-fails", content: "read", security: security() });
    assert.equal(endFailed, true);
    assert.equal(requests.length, 3);
    assert.equal(requests[2]!.tools.some((tool) => tool.name === "test_read"), false, "the third step is the closing step");
    assert.equal(result.content, "what was done");
    assert.equal(turnEnd(result.events).reason, "step-failure:transient");
  } finally { await host.shutdown(); }
});

test("E: an answer beside a plan update that the review sends back is not left in the transcript", async () => {
  for (const keepDraftsAsNarration of [true, false]) {
    let reviews = 0;
    const policy: TurnControlPolicy = {
      id: "p", revision: "v1", keepDraftsAsNarration, beforeModelStep: async () => ({}),
      reviewTerminal: async () => (reviews += 1) === 1 ? { decision: "continue", feedback: "OBJECTION: figure unchecked.", fallback: "FB" } : { decision: "accept" },
    };
    const { adapter, requests } = scriptedModel([
      call("c1", "test_read", { page: 1 }),
      planStep("p1", "goal", [{ id: "s1", description: "read", status: "completed" }], "ANSWER-1 rejected"),
      answer("ANSWER-2 accepted"),
    ]);
    const { host, router } = await activeHost(adapter, [planningPlugin(), toolPlugin("tools", [read])]);
    try {
      const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 8 }, { turnControlPolicy: policy })
        .runTurn({ sessionId: `planning-answer-${keepDraftsAsNarration}`, content: "read", security: security() });
      assert.equal(result.content, "ANSWER-2 accepted");
      const transcript = requests[2]!.messages.filter((message) => message.role === "assistant").map((message) => message.content ?? "");
      assert.equal(transcript.some((content) => content.includes("ANSWER-1")), false, "the objection says it is not in the conversation; now it is not");
      assert.deepEqual(result.events.filter((event) => event.type === "assistant/message").map((event) => (event.payload as { content: unknown }).content),
        [null, null, "ANSWER-2 accepted"]);
    } finally { await host.shutdown(); }
  }
});

test("E: an accepted answer beside a plan update is journaled as the turn's answer, without a policy too", async () => {
  const { adapter } = scriptedModel([call("c1", "test_read", { page: 1 }), planStep("p1", "goal", [{ id: "s1", description: "read", status: "completed" }], "Read: page 1.")]);
  const { host, router } = await activeHost(adapter, [planningPlugin(), toolPlugin("tools", [read])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 8 }).runTurn({ sessionId: "planning-answer-plain", content: "read", security: security() });
    assert.equal(result.content, "Read: page 1.");
    const messages = result.events.filter((event) => event.type === "assistant/message").map((event) => event.payload as { content: unknown; toolCalls: unknown[] });
    assert.deepEqual(messages.map((message) => message.content), [null, null, "Read: page 1."]);
    assert.equal(messages[1]!.toolCalls.length, 1, "the plan call is journaled with its step; the answer after it");
  } finally { await host.shutdown(); }
});

test("F: a silent tool call on the final step is reviewed as no answer, and the runtime's note is never narrated", async () => {
  const seen: unknown[] = [];
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1", keepDraftsAsNarration: true, beforeModelStep: async () => ({}),
    reviewTerminal: async (state) => { seen.push(state.candidate.content); return { decision: "continue", feedback: "Objection X.", fallback: "The product's sentence." }; },
  };
  const { adapter } = scriptedModel([call("c1", "test_read", { page: 1 })]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read])]);
  const progress: AgentProgressEvent[] = [];
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 1, initialStepBudget: 1 }, { turnControlPolicy: policy })
      .runTurn({ sessionId: "silent-final", content: "read", security: security(), onNarration: (event) => progress.push(event as never) });
    assert.deepEqual(seen, [null], "the policy saw the model's words — none — not 'The turn reached its execution budget…'");
    assert.deepEqual(narrated(progress as never), [], "nothing English was kept on screen as a draft");
    assert.equal(result.content, "The product's sentence.");
  } finally { await host.shutdown(); }
});

test("G: the closing step's answer stands, as partial with the fallback beneath it, and is not reported as a safety limit", async () => {
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1", keepDraftsAsNarration: true, beforeModelStep: async () => ({}),
    reviewTerminal: async (state) => state.finalStep
      ? { decision: "continue", feedback: "Read the data back before concluding.", fallback: "FALLBACK: not confirmed." }
      : { decision: "continue", feedback: "Work remains.", fallback: "Not done yet.", workRemains: true },
  };
  // Four drafts that each moved spend the objections; the work closes and the closing step answers.
  const { adapter, requests } = scriptedModel([call("c1", "test_read", { page: 1 }), ...MOVING, answer(SAME)]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read])]);
  const progress: AgentProgressEvent[] = [];
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48 }, { turnControlPolicy: policy, continueQuestion: WORDING })
      .runTurn({ sessionId: "closing", content: "open the sheet", security: security(), onProgress: (event) => progress.push(event) });
    assert.equal(result.content, `${SAME}\n\nFALLBACK: not confirmed.`, "was the fallback alone, after a verification step with no tools");
    assert.equal(result.outcome, "partial");
    assert.equal(requests.length, 6, `${requests.length} model calls`);
    assert.equal(requests.at(-1)!.tools.length, 0);
    assert.equal(decisions(result.events).at(-1), "terminal:accept");
    assert.equal(turnEnd(result.events).decision, "partial", "stalled work is no safety budget");
    assert.equal(progress.some((event) => event.type === "work-decision" && event.decision === "budget-reached"), false);
    assert.equal(result.interaction, undefined, "no plan: the gate's end alone is no evidence that work is left");
  } finally { await host.shutdown(); }
});

test("G: a closing answer the policy accepts itself is not followed by \"go on?\"", async () => {
  // The gate closes the work once its objections are spent and the policy proves the blocker on the closing step, accepting it
  // as partial: no "continue?" card may then offer the same refusal again.
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1", keepDraftsAsNarration: true, beforeModelStep: async () => ({}),
    reviewTerminal: async (state) => state.finalStep
      ? { decision: "accept", outcome: "partial", reason: "blocker-proven" }
      : { decision: "continue", feedback: "Work remains.", fallback: "Not done yet.", workRemains: true },
  };
  const { adapter, requests } = scriptedModel([call("c1", "test_read", { page: 1 }), ...MOVING, answer(SAME)]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48 }, { turnControlPolicy: policy, continueQuestion: WORDING })
      .runTurn({ sessionId: "closing-proven", content: "open the sheet", security: security() });
    assert.deepEqual(decisions(result.events), ["terminal:continue", "terminal:continue", "terminal:continue", "terminal:close", "terminal:accept"]);
    assert.equal(requests.length, 6, `${requests.length} model calls`);
    assert.equal(result.outcome, "partial");
    assert.equal(result.content, SAME);
    assert.equal(result.interaction, undefined, "nothing a further lap could do");
  } finally { await host.shutdown(); }
});

test("H: the same answer back after a work-remains objection, with nothing new between, closes the laps now", async () => {
  let reviews = 0;
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1", keepDraftsAsNarration: true, beforeModelStep: async () => ({}),
    reviewTerminal: async () => { reviews += 1; return { decision: "continue", feedback: "Work remains: the sheet is not opened.", fallback: "The sheet is not open yet.", workRemains: true }; },
  };
  const { adapter, requests } = scriptedModel([call("c1", "test_read", { page: 1 }), answer(SAME)]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read])]);
  const progress: unknown[] = [];
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48 }, { turnControlPolicy: policy })
      .runTurn({ sessionId: "same-answer", content: "open the sheet", security: security(), onNarration: (event) => progress.push(event) });
    assert.equal(requests.length, 4, "one read, two drafts and the closing step (was six calls)");
    assert.deepEqual(decisions(result.events), ["terminal:continue", "terminal:close", "terminal:accept"]);
    const objection = result.events.find((event) => event.type === "turn/control-decision")!.payload as { contentHash?: unknown };
    assert.equal(typeof objection.contentHash, "string", "the objection carries what it was about");
    assert.deepEqual(narrated(progress as never), [SAME], "the identical second draft is not narrated again");
    assert.equal(result.content, `${SAME}\n\nThe sheet is not open yet.`);
  } finally { await host.shutdown(); }
});

test("H: a delivered answer back unmoved after its objection stands as partial with the notice: no closing step", async () => {
  // The policy's judge read the answer as a result with a figure still open (`delivered`): a closing step would only rewrite it.
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1", keepDraftsAsNarration: true, beforeModelStep: async () => ({}),
    reviewTerminal: async () => ({ decision: "continue", feedback: "Work remains: the total is not reconciled.", fallback: "The total is not reconciled yet.", workRemains: true, delivered: true }),
  };
  const report = "Sheet read: 12 people, total 48.000.000.";
  const { adapter, requests } = scriptedModel([call("c1", "test_read", { page: 1 }), answer(report), answer(report), answer("Closing.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48 }, { turnControlPolicy: policy })
      .runTurn({ sessionId: "same-delivered", content: "read the sheet", security: security() });
    assert.equal(requests.length, 3, "one read and two drafts; the closing step is not asked");
    assert.deepEqual(decisions(result.events), ["terminal:continue", "terminal:accept"]);
    assert.deepEqual(deliveredRows(result.events), [true, true], "both rows say the policy marked the answer delivered: a replay decides as the gate did");
    assert.equal(result.outcome, "partial");
    assert.equal(result.content, `${report}\n\nThe total is not reconciled yet.`);
  } finally { await host.shutdown(); }
});

test("H: a delivered answer sent beside a plan update stands the same way, its accept row marked delivered", async () => {
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1", beforeModelStep: async () => ({}),
    reviewTerminal: async () => ({ decision: "continue", feedback: "Work remains: the total is not reconciled.", fallback: "Not reconciled yet.", workRemains: true, delivered: true }),
  };
  const report = "Sheet read: 12 people.";
  const done = [{ id: "s1", description: "read", status: "completed" }];
  const { adapter } = scriptedModel([call("c1", "test_read", { page: 1 }), planStep("p1", "goal", done, report), planStep("p2", "goal", done, report), answer("Closing.")]);
  const { host, router } = await activeHost(adapter, [planningPlugin(), toolPlugin("tools", [read])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48 }, { turnControlPolicy: policy })
      .runTurn({ sessionId: "same-delivered-beside-plan", content: "read the sheet", security: security() });
    assert.deepEqual(decisions(result.events), ["terminal:continue", "terminal:accept"]);
    assert.deepEqual(deliveredRows(result.events), [true, true]);
    assert.equal(result.content, `${report}\n\nNot reconciled yet.`);
  } finally { await host.shutdown(); }
});

test("H: an answer that changed after the objection is not taken as the same answer", async () => {
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1", beforeModelStep: async () => ({}),
    reviewTerminal: async () => ({ decision: "continue", feedback: "Work remains.", fallback: "Not done.", workRemains: true }),
  };
  const { adapter, requests } = scriptedModel([call("c1", "test_read", { page: 1 }), answer("first try"), answer("second try"), answer("third try"), answer("fourth try"), answer("closing")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48 }, { turnControlPolicy: policy })
      .runTurn({ sessionId: "changing-answer", content: "open the sheet", security: security() });
    assert.equal(decisions(result.events).filter((decision) => decision === "terminal:continue").length, 3, "the lap bound, as before");
    assert.equal(requests.length, 6);
  } finally { await host.shutdown(); }
});

test("H: objections spent on a delivered answer that kept moving close the work; every row the gate writes says delivered", async () => {
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1", beforeModelStep: async () => ({}),
    reviewTerminal: async () => ({ decision: "continue", feedback: "Work remains.", fallback: "Not done.", workRemains: true, delivered: true }),
  };
  const { adapter } = scriptedModel([call("c1", "test_read", { page: 1 }), answer("first try"), answer("second try"), answer("third try"), answer("fourth try"), answer("closing")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48 }, { turnControlPolicy: policy })
      .runTurn({ sessionId: "changing-delivered", content: "open the sheet", security: security() });
    assert.deepEqual(decisions(result.events), ["terminal:continue", "terminal:continue", "terminal:continue", "terminal:close", "terminal:accept"]);
    assert.deepEqual(deliveredRows(result.events), [true, true, true, true, true]);
  } finally { await host.shutdown(); }
});

test("A: a call refused twice while the step did not offer it runs once it is offered", async () => {
  // Unoffered refusals keep their own repeat count: shared with real calls', a write a policy held back for two steps (a
  // read-back owed) would be blocked as a repeat on the step that offers it again.
  let executed = 0;
  const update: ToolDefinition = { ...read, id: "test_update", execute: async () => { executed += 1; return { updated: true }; } };
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1", reviewTerminal: async () => ({ decision: "accept" }),
    beforeModelStep: async (state) => state.stepIndex <= 2 ? { allowedToolIds: ["test_read"] } : {},
  };
  const same = { employee: "NV002", allowance: 500_000 };
  const { adapter } = scriptedModel([call("u1", "test_update", same), call("u2", "test_update", same), call("u3", "test_update", same), answer("Updated.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read, update])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 8 }, { turnControlPolicy: policy })
      .runTurn({ sessionId: "offered-later", content: "update NV002", security: security() });
    assert.equal(executed, 1, "the third call, offered, is executed");
    const last = result.events.filter((event) => event.type === "tool/result").at(-1)!.payload as { state: string };
    assert.equal(last.state, "succeeded");
    assert.equal(result.content, "Updated.");
  } finally { await host.shutdown(); }
});

test("I: a changing plan beside a tool the step lacks is not refunded as planning", async () => {
  // Planning-only is read from every call of the step, not the dispatched ones alone; otherwise [ghost + plan that changes]
  // is refunded every step and only the tool-call cap ends it.
  const replies = Array.from({ length: 400 }, (_value, index) => calls([
    { id: `p${index}`, name: PLAN_TOOL_ID, args: { goal: "goal", steps: [{ id: "s1", description: `attempt ${index}`, status: "in_progress" }] } },
    { id: `g${index}`, name: "ghost_tool", args: { index } },
  ]));
  const { adapter, requests } = scriptedModel([...replies, answer("done")]);
  const { host, router } = await activeHost(adapter, [planningPlugin(), toolPlugin("tools", [read])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48, maxToolCalls: 64 })
      .runTurn({ sessionId: "ghost-plan", content: "read", security: security() });
    assert.ok(requests.length <= 8, `${requests.length} model calls`);
    assert.equal(result.outcome, "partial");
  } finally { await host.shutdown(); }
});

test("the step ceiling is always a number: there is no unbounded setting", () => {
  assert.throws(() => resolveAgentOptions({ maxSteps: "progressive" as never }), /maxSteps must be a positive integer/u);
  assert.equal(resolveAgentOptions({ maxSteps: 48 }).maxSteps, 48);
});

test("time never makes a step final: under the shortest silence window a working step keeps its tools", async () => {
  // The window is the silence watch's bound alone. A step-time reserve once made every step of a short window final, so no
  // tool ever ran; the watch now ends a quiet turn from outside the loop, and the loop counts steps and calls only.
  const { adapter, requests } = scriptedModel([call("c1", "test_read", { page: 1 }), answer("Đã đọc trang 1.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { turnTimeoutMs: 10_000 })
      .runTurn({ sessionId: "short-window", content: "read", security: security() });
    assert.deepEqual(requests[0]!.tools.map((tool) => tool.name), ["test_read"], "the first step is offered its tool");
    assert.equal(result.outcome, "completed");
    assert.equal(result.content, "Đã đọc trang 1.");
    assert.equal(result.events.filter((event) => event.type === "tool/result").length, 1);
  } finally { await host.shutdown(); }
});

/** Objects to every closing step's answer, as a policy that wants the data read back before the turn concludes. */
const readBackPolicy: TurnControlPolicy = {
  id: "p", revision: "v1", keepDraftsAsNarration: true, beforeModelStep: async () => ({}),
  reviewTerminal: async (state) => state.finalStep
    ? { decision: "continue", feedback: "Read the data back before concluding.", fallback: "FALLBACK: not confirmed." }
    : { decision: "accept" },
};

test("the read-back step follows a write the user approved; time never refuses it, and it runs with its tools", async () => {
  // The write ran when the turn resumed, before the loop's first step: the coordinator ran it, so the resumed turn's closing
  // step may buy one tool-calling step to read the data back. Only the step ceiling and the once-per-turn rule bound that
  // grant; the silence window is the watch's bound alone and never refuses it.
  const { adapter, requests } = scriptedModel([call("w1", "test_write", { value: "v" }), answer("Saved."), call("c1", "test_read", { page: 1 }), answer("Saved and read back.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read, writeTool()])]);
  const store = new SpyStore();
  try {
    const paused = await new DefaultAgentLoop(router, store, { maxSteps: 48 }, { turnControlPolicy: readBackPolicy })
      .runTurn({ sessionId: "read-back", content: "save and check", security: security() });
    assert.equal(paused.outcome, "awaiting_approval");
    const result = await new DefaultAgentLoop(router, store, { maxSteps: 48, initialStepBudget: 1, turnTimeoutMs: 10_000 }, { turnControlPolicy: readBackPolicy })
      .resumeTurn({ sessionId: "read-back", approvalId: paused.approval!.approvalId, decision: "approve", security: security(), idempotencyKey: "approve-1" });
    assert.equal(requests.length, 4, "the objection bought a step instead of ending the turn on the fallback");
    assert.equal(requests[1]!.tools.length, 0, "the resumed turn's first step is a closing step");
    assert.ok(requests[2]!.tools.some((tool) => tool.name === "test_read"), "the bought step is offered its tools");
    assert.equal(result.outcome, "completed");
    assert.equal(result.content, "Saved and read back.");
  } finally { await host.shutdown(); }
});

test("no read-back step without a write: the objection to a closing step's answer ends the turn on the policy's fallback", async () => {
  const { adapter, requests } = scriptedModel([answer("Saved."), call("c1", "test_read", { page: 1 }), answer("Saved and read back.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48, initialStepBudget: 1 }, { turnControlPolicy: readBackPolicy })
      .runTurn({ sessionId: "nothing-written", content: "check", security: security() });
    assert.equal(requests.length, 1, "nothing was written, so no step is bought to read it back");
    assert.equal(result.outcome, "partial");
    assert.equal(turnEnd(result.events).reason, "turn-control-fallback");
  } finally { await host.shutdown(); }
});

test("G: a draft whose objection would leave only a step without tools stands as partial with the notice, never sent back", async () => {
  const policy: TurnControlPolicy = {
    id: "p", revision: "v1", keepDraftsAsNarration: true, beforeModelStep: async () => ({}),
    reviewTerminal: async (state) => state.finalStep ? { decision: "accept" }
      : { decision: "continue", feedback: "Work remains.", fallback: "Not done yet.", workRemains: true, delivered: true },
  };
  // The plan update beside the draft spends the ceiling of two: sent back, the draft would meet a closing step with no tools.
  const { adapter, requests } = scriptedModel([call("c1", "test_read", { page: 1 }),
    planStep("p1", "goal", [{ id: "s1", description: "read", status: "in_progress" }], "Read page 1; the rest is still open."), answer("Closing.")]);
  const { host, router } = await activeHost(adapter, [planningPlugin(), toolPlugin("tools", [read])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48, maxToolCalls: 2 }, { turnControlPolicy: policy })
      .runTurn({ sessionId: "draft-at-ceiling", content: "read", security: security() });
    assert.deepEqual(decisions(result.events), ["terminal:accept"]);
    assert.equal(requests.length, 2, "no step after the draft");
    assert.equal(result.outcome, "partial");
    assert.equal(result.content, "Read page 1; the rest is still open.\n\nNot done yet.");
    assert.equal(turnEnd(result.events).decision, "partial", "stalled work is no safety budget");
  } finally { await host.shutdown(); }
});

test("G: below the edge a delivered draft is still sent back; at the allowance edge it stands; an undelivered one gets its closing step", async () => {
  const policy = (delivered: boolean): TurnControlPolicy => ({
    id: "p", revision: "v1", beforeModelStep: async () => ({}),
    reviewTerminal: async (state) => state.finalStep ? { decision: "accept" }
      : { decision: "continue", feedback: "Work remains.", fallback: "Not done yet.", workRemains: true, ...(delivered ? { delivered: true as const } : {}) },
  });
  // Four steps granted, no progress: the third draft (step 3) is the last whose objection would still leave a step with tools.
  const turn = async (delivered: boolean) => {
    const { adapter, requests } = scriptedModel([answer("Draft 1."), answer("Draft 2."), answer("Draft 3."), answer("Closing.")]);
    const { host, router } = await activeHost(adapter, [toolPlugin("tools", [read])]);
    try {
      const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 4, initialStepBudget: 4 }, { turnControlPolicy: policy(delivered) })
        .runTurn({ sessionId: `draft-at-edge-${delivered}`, content: "read", security: security() });
      return { result, requests };
    } finally { await host.shutdown(); }
  };
  const stands = await turn(true);
  assert.deepEqual(decisions(stands.result.events), ["terminal:continue", "terminal:continue", "terminal:accept"]);
  assert.deepEqual(deliveredRows(stands.result.events), [true, true, true]);
  assert.equal(stands.requests.length, 3);
  assert.ok(stands.requests.every((request) => request.tools.length > 0), "no step without tools ran");
  assert.equal(stands.result.content, "Draft 3.\n\nNot done yet.");
  const closes = await turn(false);
  assert.equal(closes.requests.length, 4, "a draft that delivers nothing is sent on to the closing step, which writes the answer");
  assert.equal(closes.requests.at(-1)!.tools.length, 0);
  assert.equal(closes.result.content, "Closing.");
  assert.deepEqual(deliveredRows(closes.result.events).filter(Boolean), [], "an undelivered answer's rows say nothing of delivery");
});
