import assert from "node:assert/strict";
import { test } from "node:test";
import { createEchoToolPlugin } from "@0xsyncroot/adapter-echo";
import {
  AgenticError, turnContextSnapshotEventType,
  type AgentProgressEvent, type RuntimeSnapshot, type SessionEvent, type ToolDefinition, type ToolExecutionPolicy,
  type TurnContextProvider, type TurnControlPolicy,
} from "@0xsyncroot/contracts";
import { DefaultAgentLoop, PermissionToolExecutionPolicy } from "@0xsyncroot/core";
import { createSystemPromptPlugin } from "@0xsyncroot/plugins-base";
import { taskTurnIdsFor } from "../src/agent/task-turns.js";
import { TurnEventWriter } from "../src/agent/turn-event-writer.js";
import { TurnJournalView } from "../src/agent/turn-journal-view.js";
import { TurnTerminator, type TurnTerminalOutcome } from "../src/agent/turn-terminator.js";
import { SpyStore, activeHost, answer, call, scriptedModel, security, toolPlugin, writeTool } from "./turn-harness.js";

const runtime: RuntimeSnapshot = {
  id: "runtime-test", coreVersion: "1.0.0", pluginSetId: "test", policyRevision: "test-policy",
  memoryPolicyRevision: "test-memory", createdAt: new Date(0).toISOString(),
};

/** A turn claimed by hand, with the parts the runtime would build around it. */
async function claimedTurn(store: SpyStore, sessionId: string, leaseTtlMs = 10_000) {
  const turnId = `turn-${sessionId}`;
  const claim = await store.claimTurn({
    sessionId, turnId, ownerId: "worker", idempotencyKey: `key-${sessionId}`, requestFingerprint: "fingerprint", leaseTtlMs,
    startEvents: [{ type: "turn/start", turnId, payload: { inputIdempotencyKey: `key-${sessionId}` } }],
  }, { security: security(), runtime });
  if (claim.kind !== "acquired") throw new Error("not acquired");
  const view = await TurnJournalView.open(store, sessionId, security());
  const writer = new TurnEventWriter(store, sessionId, security(), runtime, claim.seq, claim.lease);
  view.follow(writer);
  const progress: AgentProgressEvent[] = [];
  const terminator = new TurnTerminator({
    input: { sessionId, content: "x", security: security(), onProgress: (event) => progress.push(event) }, turnId, writer, view,
  });
  return { turnId, writer, view, terminator, progress };
}

test("the terminator ends a turn after the step and what its collaborators close, in one append before the terminal", async () => {
  const store = new SpyStore();
  const { turnId, writer, terminator, progress } = await claimedTurn(store, "closing");
  const outcomes: TurnTerminalOutcome[] = [];
  terminator.attach({ close: async (outcome) => {
    outcomes.push(outcome);
    return [{ type: "extension/test/work-closed", turnId, payload: { kind: outcome.kind } }];
  } });
  await writer.append([{ type: "step/start", turnId, stepId: "s1", payload: { index: 1 } }], "step-start:s1");
  const result = await terminator.finishAnswer({
    stepId: "s1", stepIndex: 1, content: "answer", finishReason: "stop", outcome: "completed", decision: "finish",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  });
  assert.deepEqual(result.events.map((event) => event.type), ["turn/start", "step/start", "step/end", "extension/test/work-closed", "turn/end"]);
  assert.deepEqual((result.events.at(-1)!.payload as Record<string, unknown>).decision, "finish");
  assert.deepEqual(outcomes, [{ kind: "answer", outcome: "completed", decision: "finish" }]);
  assert.deepEqual(progress.map((event) => event.type), ["step-completed", "work-decision", "turn-completed"]);
});

test("a failing turn closes the calls it left open before it is recorded as failed", async () => {
  const store = new SpyStore();
  const { turnId, writer, terminator, progress } = await claimedTurn(store, "failing");
  const outcomes: TurnTerminalOutcome[] = [];
  terminator.attach({ close: async (outcome) => { outcomes.push(outcome); return []; } });
  const intent = (callId: string) => ({ type: "tool/intent", turnId, stepId: "s1", callId, payload: {
    callId, executionId: `exec-${callId}`, toolId: "tool", arguments: "{}", sideEffect: "idempotent", state: "prepared",
  } });
  await writer.append([intent("sent"), intent("queued"), { type: "tool/state", turnId, stepId: "s1", callId: "sent", payload: {
    callId: "sent", executionId: "exec-sent", toolId: "tool", state: "dispatching",
  } }], "calls");
  const failure = await terminator.fail(new AgenticError("transient", "store hiccup", true));
  assert.ok(failure instanceof AgenticError);
  const journal = await store.inner.load("failing", security());
  const results = journal.filter((event) => event.type === "tool/result");
  assert.deepEqual(results.map((event) => [event.callId, (event.payload as Record<string, unknown>).state]),
    [["sent", "outcome_unknown"], ["queued", "not_started"]]);
  assert.equal(journal.at(-1)?.type, "turn/failed");
  assert.deepEqual(outcomes, [{ kind: "failed", code: "transient" }]);
  assert.deepEqual(progress.map((event) => event.type), ["turn-failed"]);
});

test("a terminal that cannot be written still returns the original failure, with both as its cause", async () => {
  const store = new SpyStore();
  const { terminator, progress } = await claimedTurn(store, "lost", 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const failure = await terminator.fail(new AgenticError("transient", "original", true, { reason: "expired" }));
  assert.ok(failure instanceof AgenticError);
  assert.deepEqual([failure.code, failure.message, failure.retryable, failure.reason], ["transient", "original", true, "expired"]);
  assert.ok(failure.cause instanceof AggregateError);
  assert.equal((failure.cause.errors[0] as Error).message, "original");
  assert.match(String((failure.cause.errors[1] as Error).message), /lease/u);
  assert.deepEqual(progress, [], "a turn-failed report means the failure was written");
  const unclassified = await (await claimedTurn(store, "lost-plain", 5)).terminator.fail(new Error("plain"));
  assert.deepEqual([unclassified.code, unclassified.retryable], ["permanent", false], "an unclassified original is classified, never left raw");
});

test("a journal that cannot be read does not stop a failing turn from closing its known calls and recording the failure", async () => {
  const store = new SpyStore();
  const { turnId, writer, view, terminator, progress } = await claimedTurn(store, "unreadable");
  const outcomes: TurnTerminalOutcome[] = [];
  terminator.attach({ close: async (outcome) => { outcomes.push(outcome); return []; } });
  const intent = (callId: string) => ({ type: "tool/intent", turnId, stepId: "s1", callId, payload: {
    callId, executionId: `exec-${callId}`, toolId: "tool", arguments: "{}", sideEffect: "idempotent", state: "prepared",
  } });
  await writer.append([intent("sent"), { type: "tool/state", turnId, stepId: "s1", callId: "sent", payload: {
    callId: "sent", executionId: "exec-sent", toolId: "tool", state: "dispatching",
  } }], "held-calls");
  await view.events();
  await writer.append([intent("unseen")], "unseen-call");
  const unreadable = new AgenticError("permanent", "Session event integrity check failed: e1");
  store.loadSince = async () => { throw unreadable; };
  const original = new AgenticError("timeout", "model stalled", true, { outcome: "not-applied" });
  const failure = await terminator.fail(original);
  assert.ok(failure instanceof AgenticError, "never an AggregateError, which the wire reports as internal");
  assert.deepEqual([failure.code, failure.message, failure.retryable, failure.outcome], ["timeout", "model stalled", true, "not-applied"]);
  assert.ok(failure.cause instanceof AggregateError);
  assert.deepEqual(failure.cause.errors, [original, unreadable]);
  const journal = await store.inner.load("unreadable", security());
  assert.deepEqual(journal.filter((event) => event.type === "tool/result").map((event) => [event.callId, (event.payload as Record<string, unknown>).state]),
    [["sent", "outcome_unknown"]], "the call the view held is closed; the one it never saw cannot be");
  assert.equal(journal.at(-1)?.type, "turn/failed");
  assert.equal((journal.at(-1)!.payload as Record<string, unknown>).code, "timeout");
  assert.deepEqual(outcomes, [{ kind: "failed", code: "timeout" }]);
  assert.deepEqual(progress, [{ type: "turn-failed", turnId, code: "timeout" }]);
});

test("a turn whose journal becomes unreadable mid-run ends failed with a classified error and a recorded failure", async () => {
  const store = new SpyStore();
  const probe: ToolDefinition = {
    id: "test_probe", version: "1.0.0", description: "reads something", inputSchema: { type: "object" }, outputSchema: {},
    requiredPermissions: [], sideEffect: "none", timeoutMs: 1_000,
    execute: async () => { store.loadSince = async () => { throw new AgenticError("permanent", "Session event integrity check failed: e1"); }; return { ok: true }; },
  };
  const { adapter, requests } = scriptedModel([call("probe-1", "test_probe", {}), answer("done")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("probe", [probe])]);
  const progress: AgentProgressEvent[] = [];
  const failure = await new DefaultAgentLoop(router, store).runTurn({ sessionId: "mid-run", content: "go", security: security(), onProgress: (event) => progress.push(event) })
    .then(() => undefined, (error: unknown) => error);
  assert.ok(failure instanceof AgenticError, `got ${String(failure)}`);
  assert.equal(failure.code, "permanent");
  assert.equal(requests.length, 1, "the model was not asked again over a journal nobody can read");
  const journal = await store.inner.load("mid-run", security());
  assert.equal(journal.at(-1)?.type, "turn/failed");
  assert.equal(journal.filter((event) => event.type === "tool/result").length, 1);
  assert.ok(progress.some((event) => event.type === "turn-failed"));
  await host.shutdown();
});

test("a resume refused before its claim writes nothing: an expired approval, a stale runtime", async () => {
  const { adapter } = scriptedModel([call("write-1", "test_write", { value: "v" })]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("write", [writeTool()])]);
  const store = new SpyStore();
  const rows = async (sessionId: string) => (await store.inner.load(sessionId, security())).length;
  const expiring = new DefaultAgentLoop(router, store, { approvalTtlMs: 1 });
  const expired = await expiring.runTurn({ sessionId: "expired", content: "write", security: security() });
  const stale = await new DefaultAgentLoop(router, store).runTurn({ sessionId: "stale", content: "write", security: security() });
  const before = [await rows("expired"), await rows("stale")];
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(expiring.resumeTurn({
    sessionId: "expired", approvalId: expired.approval!.approvalId, decision: "approve", security: security(), idempotencyKey: "expired-resume",
  }), /expired/u);
  router.replaceRoutes([{ tenantId: "tenant-a", agentProfileId: "default", provider: host, routeRevision: "test-route-v2" }]);
  await assert.rejects(new DefaultAgentLoop(router, store).resumeTurn({
    sessionId: "stale", approvalId: stale.approval!.approvalId, decision: "approve", security: security(), idempotencyKey: "stale-resume",
  }), /binding is stale/u);
  assert.deepEqual([await rows("expired"), await rows("stale")], before, "no row was written for either refusal");
  await host.shutdown();
});

test("a resume records where it comes from, carries its task's context, and dispatches the call like any other", async () => {
  const { adapter, requests } = scriptedModel([call("write-1", "test_write", { value: "v" }), answer("done")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("write", [writeTool()])]);
  const seen: { readonly stage: string; readonly taskTurnIds: readonly string[] }[] = [];
  const provider: TurnContextProvider = {
    id: "test.task", revision: "v1",
    prepare: async ({ taskTurnIds }) => { seen.push({ stage: "provider", taskTurnIds }); return undefined; },
  };
  const policy: TurnControlPolicy = {
    id: "test.task-policy", revision: "v1",
    beforeModelStep: async (state) => { seen.push({ stage: "policy", taskTurnIds: state.taskTurnIds }); return {}; },
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const agent = new DefaultAgentLoop(router, new SpyStore(), {}, { turnContextProvider: provider, turnControlPolicy: policy });
  const context = { untrusted: { screen: "payroll", unit: "u-1" } };
  const paused = await agent.runTurn({ sessionId: "chain", content: "write", security: security(), applicationContext: context });
  const progress: AgentProgressEvent[] = [];
  const resumed = await agent.resumeTurn({
    sessionId: "chain", approvalId: paused.approval!.approvalId, decision: "approve", security: security(), idempotencyKey: "chain-resume",
    onProgress: (event) => progress.push(event),
  });
  const start = resumed.events.find((event) => event.type === "turn/start")!;
  const link = { pauseKind: "approval", pauseId: paused.approval!.approvalId, fromTurnId: paused.turnId, rootTurnId: paused.turnId };
  assert.deepEqual((start.payload as Record<string, unknown>).continuation, link);
  assert.deepEqual(progress[0], { type: "turn-started", turnId: resumed.turnId, continuation: link });
  assert.deepEqual(resumed.events.find((event) => event.type === "application/context")?.payload, context, "the task's context is copied into the resume");
  assert.deepEqual(seen.filter((entry) => entry.stage === "policy").map((entry) => entry.taskTurnIds), [[paused.turnId], [paused.turnId, resumed.turnId]]);
  assert.deepEqual(seen.filter((entry) => entry.stage === "provider").at(-1)?.taskTurnIds, [paused.turnId, resumed.turnId]);
  const contextMessages = requests[1]!.messages.filter((message) => message.context?.provenance === "application-context");
  assert.equal(contextMessages.length, 1, "the model reads the task's context once, not once per resume");
  // The resolution, the intent written again under the resuming turn and the dispatch boundary are one append.
  const types = resumed.events.map((event) => event.type);
  const resolvedAt = types.indexOf("approval/resolved");
  assert.deepEqual(types.slice(resolvedAt, resolvedAt + 4), ["approval/resolved", "tool/intent", "tool/policy-decision", "tool/state"]);
  const result = resumed.events.find((event) => event.type === "tool/result")!.payload as Record<string, unknown>;
  assert.deepEqual([result.state, result.executed, result.informationGain], ["succeeded", true, "new"]);
  assert.deepEqual(progress.filter((event) => event.type === "tool-completed").map((event) => "status" in event ? event.status : ""), ["succeeded"]);
  await host.shutdown();
});

test("a task chain follows the continuation links resume turns record, and stops at the view's edge", () => {
  const start = (turnId: string, continuation?: Record<string, string>) => ({
    type: "turn/start", turnId, payload: { inputIdempotencyKey: turnId, ...(continuation ? { continuation } : {}) },
  }) as unknown as SessionEvent;
  const link = (fromTurnId: string) => ({ pauseKind: "interaction", pauseId: `p-${fromTurnId}`, fromTurnId, rootTurnId: "root" });
  const events = [start("root"), start("r1", link("root")), start("r2", link("r1")), start("unrelated")];
  assert.deepEqual(taskTurnIdsFor(events, "r2"), ["root", "r1", "r2"]);
  assert.deepEqual(taskTurnIdsFor(events, "unrelated"), ["unrelated"], "a new message starts a new task");
  assert.deepEqual(taskTurnIdsFor(events.slice(2), "r2"), ["r1", "r2"], "a turn whose start left the window still counts; the ones before it cannot be known");
});

test("a tool that refuses its arguments never reaches an approval card, and the model reads why", async () => {
  let executed = 0;
  let authorized = 0;
  const strict: ToolDefinition = {
    ...writeTool(() => { executed += 1; }),
    validateArguments: (args) => {
      if ((args as Record<string, unknown>).value !== "valid") throw new Error("value must be a valid period");
    },
  };
  const { adapter, requests } = scriptedModel([call("write-1", "test_write", { value: "2026" }), answer("I need a valid period.")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("write", [strict])]);
  const baseline = new PermissionToolExecutionPolicy();
  const counting: ToolExecutionPolicy = {
    discover: (tools, context) => baseline.discover(tools, context),
    authorize: async (input) => { authorized += 1; return baseline.authorize(input); },
  };
  const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { toolExecutionPolicy: counting })
    .runTurn({ sessionId: "refused-args", content: "write", security: security() });
  assert.equal(result.outcome, "completed");
  assert.equal(result.approval, undefined);
  assert.equal(result.events.some((event) => event.type === "approval/requested"), false);
  const refused = result.events.find((event) => event.type === "tool/result")!.payload as Record<string, unknown>;
  assert.deepEqual([refused.state, refused.dispatched, (refused.error as Record<string, unknown>).code], ["not_started", false, "validation"]);
  assert.match(requests[1]!.messages.find((message) => message.role === "tool")?.content ?? "", /value must be a valid period/u);
  assert.deepEqual([executed, authorized], [0, 0], "neither the tool nor the policy was reached");
  await host.shutdown();
});

for (const sentence of ["The product's own sentence.", undefined]) {
  test(`a model that keeps ignoring the tool directive ends partial on ${sentence ? "the product's sentence" : "empty content"}`, async () => {
    const { adapter } = scriptedModel([answer("prose instead")], { toolChoice: true });
    const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), createEchoToolPlugin()]);
    const policy: TurnControlPolicy = {
      id: "test.required", revision: "v1",
      beforeModelStep: async () => ({ allowedToolIds: ["agentic_echo"], toolChoice: "required" }),
      reviewTerminal: async () => ({ decision: "accept" }),
      ...(sentence ? { fallbackText: () => sentence } : {}),
    };
    const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { turnControlPolicy: policy })
      .runTurn({ sessionId: "stubborn", content: "read it", security: security() });
    assert.equal(result.outcome, "partial");
    assert.equal(result.content, sentence ?? "");
    const end = result.events.at(-1)!;
    assert.deepEqual([end.type, (end.payload as Record<string, unknown>).decision], ["turn/end", "partial"]);
    assert.ok(result.events.some((event) => event.type === "turn/control-decision" && (event.payload as Record<string, unknown>).decision === "fallback"));
    await host.shutdown();
  });
}

test("an oversize turn-context snapshot is left out of the step instead of failing the turn", async () => {
  const { adapter, requests } = scriptedModel([answer("done")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin()]);
  const provider: TurnContextProvider = {
    id: "test.bulky", revision: "v1",
    prepare: async () => ({ classification: "internal", snapshot: { rows: "x".repeat(40_000) } }),
  };
  const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { turnContextProvider: provider })
    .runTurn({ sessionId: "bulky", content: "hi", security: security() });
  assert.equal(result.content, "done");
  assert.equal(result.events.some((event) => event.type === turnContextSnapshotEventType("test.bulky")), false);
  assert.equal(requests[0]!.messages.some((message) => message.context?.provenance?.startsWith("turn-context:")), false);
  await host.shutdown();
});
