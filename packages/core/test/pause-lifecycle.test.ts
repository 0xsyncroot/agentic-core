import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgenticError, MAX_SESSION_READ_EVENTS,
  type AgenticErrorCode, type AgenticErrorReason, type ChatMessage, type RuntimeSnapshot, type SessionEvent,
} from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { createSystemPromptPlugin, createUserInputToolsPlugin } from "@0xsyncroot/plugins-base";
import { PAUSE_CLOSURE_MESSAGES } from "../src/agent/pause-closure.js";
import { SpyStore, activeHost, answer, call, scriptedModel, security, toolPlugin, writeTool } from "./turn-harness.js";

const runtime: RuntimeSnapshot = {
  id: "runtime-test", coreVersion: "1.0.0", pluginSetId: "test", policyRevision: "test-policy",
  memoryPolicyRevision: "test-memory", createdAt: new Date(0).toISOString(),
};

const REGION_QUESTION = {
  message: "Which region should I look up?",
  fields: [{
    id: "region", label: "Region", type: "select", required: true,
    choices: [{ value: "north", label: "North", description: "Units above the river" }, { value: "south", label: "South" }],
  }],
};

/** A refusal with exactly this code and reason — what the product maps to its own sentence. */
function refused(code: AgenticErrorCode, reason?: AgenticErrorReason) {
  return (error: unknown) => {
    assert.ok(error instanceof AgenticError, `expected an AgenticError, got ${String(error)}`);
    assert.deepEqual([error.code, error.reason], [code, reason]);
    return true;
  };
}

/** Every tool call of every assistant message is answered by exactly one tool message, right after it. */
function assertEveryCallAnsweredOnce(messages: readonly ChatMessage[]): void {
  for (const [index, message] of messages.entries()) {
    if (message.role === "tool") {
      const owner = messages.slice(0, index).reverse().find((candidate) => candidate.role !== "tool");
      assert.ok(owner?.toolCalls?.some((call) => call.id === message.toolCallId), `tool message ${message.toolCallId} answers no call`);
    }
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    const answers = [];
    for (const next of messages.slice(index + 1)) {
      if (next.role !== "tool") break;
      answers.push(next.toolCallId);
    }
    assert.deepEqual(answers.sort(), message.toolCalls.map((call) => call.id).sort(), "each call answered once");
  }
}

function payload(event: SessionEvent | undefined): Record<string, unknown> {
  return (event?.payload ?? {}) as Record<string, unknown>;
}

async function rows(store: SpyStore, sessionId: string): Promise<number> {
  return (await store.inner.load(sessionId, security())).length;
}

test("a message sent while a question is pending closes it: the call is answered once, and a later answer is refused as superseded", async () => {
  const { adapter, requests } = scriptedModel([call("ask-1", "request_user_input", REGION_QUESTION), answer("Here is the payroll summary.")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), createUserInputToolsPlugin()]);
  const store = new SpyStore();
  const agent = new DefaultAgentLoop(router, store);
  const paused = await agent.runTurn({ sessionId: "typed-over-form", content: "look something up", security: security() });
  assert.equal(paused.outcome, "awaiting_interaction");
  const next = await agent.runTurn({ sessionId: "typed-over-form", content: "never mind, show me the payroll summary", security: security() });
  assert.equal(next.content, "Here is the payroll summary.");

  assertEveryCallAnsweredOnce(requests[1]!.messages);
  const answered = requests[1]!.messages.find((message) => message.role === "tool" && message.toolCallId === "ask-1");
  assert.match(answered?.content ?? "", /sent a new message instead of answering this request, so it was withdrawn/u);

  const resolved = next.events.find((event) => event.type === "interaction/resolved");
  assert.deepEqual([payload(resolved).interactionId, payload(resolved).action, payload(resolved).reason, payload(resolved).resolvedBy],
    [paused.interaction!.interactionId, "cancel", "superseded", "runtime"]);
  const journal = await store.inner.load("typed-over-form", security());
  const requested = journal.find((event) => event.type === "interaction/requested")!;
  const closed = journal.filter((event) => event.type === "tool/result" && payload(event).callId === "ask-1");
  assert.equal(closed.length, 1);
  assert.deepEqual([closed[0]!.turnId, closed[0]!.stepId, closed[0]!.callId], [paused.turnId, requested.stepId, "ask-1"], "the paused call's own envelope");
  assert.deepEqual([payload(closed[0]).state, payload(closed[0]).dispatched, payload(closed[0]).executionId],
    ["cancelled", false, payload(requested).executionId]);
  assert.deepEqual(payload(closed[0]).closure, { pauseKind: "interaction", pauseId: paused.interaction!.interactionId, closedByTurnId: next.turnId });
  // The closure is the new turn's first write after its claim, before the model was asked anything.
  const claimedAt = journal.find((event) => event.turnId === next.turnId && event.type === "user/input")!.seq;
  assert.deepEqual(journal.filter((event) => event.seq > claimedAt).slice(0, 2).map((event) => event.type), ["interaction/resolved", "tool/result"]);

  const before = await rows(store, "typed-over-form");
  await assert.rejects(agent.resumeInteraction({
    sessionId: "typed-over-form", interactionId: paused.interaction!.interactionId, action: "accept", content: { region: "north" },
    security: security(), idempotencyKey: "late-click",
  }), refused("conflict", "superseded"));
  assert.equal(await rows(store, "typed-over-form"), before, "the refused click wrote nothing");
  await host.shutdown();
});

test("a message sent while an approval is pending closes it: the write never runs, and a later approval is refused as superseded", async () => {
  let executions = 0;
  const { adapter, requests } = scriptedModel([call("write-1", "test_write", { value: "v" }), answer("Okay, something else then.")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("write", [writeTool(() => { executions += 1; })])]);
  const store = new SpyStore();
  const agent = new DefaultAgentLoop(router, store);
  const paused = await agent.runTurn({ sessionId: "typed-over-approval", content: "write it", security: security() });
  assert.equal(paused.outcome, "awaiting_approval");
  const next = await agent.runTurn({ sessionId: "typed-over-approval", content: "actually, do something else", security: security() });
  assertEveryCallAnsweredOnce(requests[1]!.messages);
  const resolved = next.events.find((event) => event.type === "approval/resolved");
  assert.deepEqual([payload(resolved).decision, payload(resolved).reason, payload(resolved).resolvedBy], ["superseded", "superseded", "runtime"]);
  const before = await rows(store, "typed-over-approval");
  await assert.rejects(agent.resumeTurn({
    sessionId: "typed-over-approval", approvalId: paused.approval!.approvalId, decision: "approve", security: security(), idempotencyKey: "late-approve",
  }), refused("conflict", "superseded"));
  assert.equal(await rows(store, "typed-over-approval"), before);
  assert.equal(executions, 0, "an approval the user walked away from can never run the write");
  await host.shutdown();
});

test("a pause past its deadline when the user wrote something else is closed as expired, and a click on it says so", async () => {
  const { adapter, requests } = scriptedModel([call("write-1", "test_write", { value: "v" }), answer("noted")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("write", [writeTool()])]);
  const store = new SpyStore();
  const agent = new DefaultAgentLoop(router, store, { approvalTtlMs: 1 });
  const paused = await agent.runTurn({ sessionId: "late", content: "write it", security: security() });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const next = await agent.runTurn({ sessionId: "late", content: "hello?", security: security() });
  assert.equal(payload(next.events.find((event) => event.type === "approval/resolved")).reason, "expired");
  const answered = requests[1]!.messages.find((message) => message.role === "tool");
  assert.ok(answered?.content?.includes(JSON.stringify(PAUSE_CLOSURE_MESSAGES.expired)));
  await assert.rejects(agent.resumeTurn({
    sessionId: "late", approvalId: paused.approval!.approvalId, decision: "approve", security: security(), idempotencyKey: "late-approve",
  }), refused("conflict", "expired"));
  await host.shutdown();
});

test("a resume past its deadline, or for a request no longer in the window, is refused as expired with nothing written", async () => {
  const { adapter } = scriptedModel([call("ask-1", "request_user_input", REGION_QUESTION)]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), createUserInputToolsPlugin()]);
  const store = new SpyStore();
  // Only the question's deadline is short: it is its own setting, not the approval one.
  const agent = new DefaultAgentLoop(router, store, { interactionTtlMs: 1 });
  const paused = await agent.runTurn({ sessionId: "stale-form", content: "look it up", security: security() });
  await new Promise((resolve) => setTimeout(resolve, 5));
  let before = await rows(store, "stale-form");
  await assert.rejects(agent.resumeInteraction({
    sessionId: "stale-form", interactionId: paused.interaction!.interactionId, action: "accept", content: { region: "north" },
    security: security(), idempotencyKey: "too-late",
  }), refused("conflict", "expired"));
  assert.equal(await rows(store, "stale-form"), before);

  const fresh = await new DefaultAgentLoop(router, store).runTurn({ sessionId: "buried", content: "look it up", security: security() });
  const seq = await rows(store, "buried");
  const burst = Array.from({ length: MAX_SESSION_READ_EVENTS }, (_, index) => ({
    type: "extension/test/noise", turnId: "noise", payload: { index },
  }));
  await store.inner.append("buried", seq, burst, "bury", { security: security(), runtime });
  before = await rows(store, "buried");
  await assert.rejects(new DefaultAgentLoop(router, store).resumeInteraction({
    sessionId: "buried", interactionId: fresh.interaction!.interactionId, action: "accept", content: { region: "north" },
    security: security(), idempotencyKey: "buried-click",
  }), refused("conflict", "expired"));
  assert.equal(await rows(store, "buried"), before);
  await host.shutdown();
});

test("stale runtime, an answer already given and the wrong person are refused differently, each with nothing written", async () => {
  const { adapter } = scriptedModel([call("write-1", "test_write", { value: "v" }), answer("written")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("write", [writeTool()])]);
  const store = new SpyStore();
  const agent = new DefaultAgentLoop(router, store);
  const paused = await agent.runTurn({ sessionId: "binding", content: "write it", security: security() });
  const approve = (idempotencyKey: string, overrides = {}) => agent.resumeTurn({
    sessionId: "binding", approvalId: paused.approval!.approvalId, decision: "approve", security: security(overrides), idempotencyKey,
  });
  const before = await rows(store, "binding");
  await assert.rejects(approve("wrong-person", { actorId: "user-b" }), refused("denied"));
  router.replaceRoutes([{ tenantId: "tenant-a", agentProfileId: "default", provider: host, routeRevision: "test-route-v2" }]);
  await assert.rejects(approve("after-deploy"), refused("conflict", "stale-binding"));
  router.replaceRoutes([{ tenantId: "tenant-a", agentProfileId: "default", provider: host, routeRevision: "test-route-v1" }]);
  assert.equal(await rows(store, "binding"), before);
  assert.equal((await approve("first-click")).outcome, "completed");
  const settled = await rows(store, "binding");
  await assert.rejects(approve("second-click"), refused("conflict", "already-resolved"));
  assert.equal(await rows(store, "binding"), settled);
  await host.shutdown();
});

test("an answer the form does not accept is a validation error with nothing written", async () => {
  const { adapter } = scriptedModel([call("ask-1", "request_user_input", REGION_QUESTION)]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), createUserInputToolsPlugin()]);
  const store = new SpyStore();
  const agent = new DefaultAgentLoop(router, store);
  const paused = await agent.runTurn({ sessionId: "invalid-form", content: "look it up", security: security() });
  const before = await rows(store, "invalid-form");
  // A select is an open list (the person may write their own answer), so blank words and a wrong type are what it refuses.
  for (const content of [{ region: " " }, { region: 7 }, {}, { region: "north", extra: "x" }]) {
    await assert.rejects(agent.resumeInteraction({
      sessionId: "invalid-form", interactionId: paused.interaction!.interactionId, action: "accept", content,
      security: security(), idempotencyKey: `invalid-${JSON.stringify(content)}`,
    }), refused("validation"));
  }
  assert.equal(await rows(store, "invalid-form"), before);
  await host.shutdown();
});

for (const action of ["decline", "cancel"] as const) {
  test(`a question the user ${action}s keeps the tool's own result, tells the model what to do, and the turn goes on to an answer`, async () => {
    const { adapter, requests } = scriptedModel([call("ask-1", "request_user_input", REGION_QUESTION), answer("I will use all regions.")]);
    const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), createUserInputToolsPlugin()]);
    const agent = new DefaultAgentLoop(router, new SpyStore());
    const paused = await agent.runTurn({ sessionId: `skip-${action}`, content: "look it up", security: security() });
    const resumed = await agent.resumeInteraction({
      sessionId: `skip-${action}`, interactionId: paused.interaction!.interactionId, action, security: security(), idempotencyKey: `skip-${action}`,
    });
    assert.deepEqual([resumed.outcome, resumed.content], ["completed", "I will use all regions."]);
    const told = requests[1]!.messages.find((message) => message.role === "tool" && message.toolCallId === "ask-1")?.content ?? "";
    assert.ok(told.startsWith(JSON.stringify({ action, values: {} })), "the tool's own result comes first");
    assert.match(told, action === "decline"
      ? /The user chose to skip this question\. Do not ask it again in this task; continue with what you have, or ask in chat only if it is essential\./u
      : /The user dismissed this question without answering\. Do not ask it again in this task/u);
    const result = resumed.events.find((event) => event.type === "tool/result");
    assert.equal(typeof payload(result).note, "string", "the note is journaled, so every replay tells the model the same");
    assert.equal(payload(resumed.events.find((event) => event.type === "interaction/resolved")).echo, undefined);
    await host.shutdown();
  });
}

test("when lease recovery already closed the paused call, the closure resolves the pause but writes no second result", async () => {
  const { adapter, requests } = scriptedModel([answer("back again")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("write", [writeTool()])]);
  const store = new SpyStore();
  const context = { security: security(), runtime };
  const turnId = "lost-turn";
  const claim = await store.inner.claimTurn({
    sessionId: "recovered", turnId, ownerId: "lost-worker", idempotencyKey: "lost", requestFingerprint: "lost", leaseTtlMs: 5,
    startEvents: [
      { type: "turn/start", turnId, payload: { inputIdempotencyKey: "lost" } },
      { type: "user/input", turnId, payload: { content: "write it", source: "external" } },
    ],
  }, context);
  if (claim.kind !== "acquired") throw new Error("not acquired");
  const ids = { turnId, stepId: "lost-step", callId: "write-1" };
  const call = { callId: "write-1", executionId: "exec-lost", toolId: "test_write" };
  await store.inner.appendLeased(claim.lease, claim.seq, [
    { type: "step/start", turnId, stepId: "lost-step", payload: { index: 1 } },
    { type: "assistant/message", turnId, stepId: "lost-step", requestId: "req-1", payload: {
      content: null, toolCalls: [{ id: "write-1", name: "test_write", arguments: "{\"value\":\"v\"}" }],
    } },
    { type: "tool/intent", ...ids, payload: { ...call, arguments: "{\"value\":\"v\"}", sideEffect: "idempotent", state: "prepared" } },
    { type: "tool/state", ...ids, payload: { ...call, state: "awaiting_approval" } },
    { type: "approval/requested", ...ids, payload: {
      approvalId: "approval-lost", ...call, arguments: "{\"value\":\"v\"}", sideEffect: "idempotent", actionDigest: "digest", decisionId: "decision",
      policyRevision: "test-policy", runtimeSnapshotId: "runtime-test", runtimeRouteRevision: "test-route-v1", agentProfileId: "default",
      requestedBy: "user-a", grantRevision: "grant-1", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } },
  ], "lost-step", context);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const next = await new DefaultAgentLoop(router, store).runTurn({ sessionId: "recovered", content: "are you there?", security: security() });
  assert.equal(next.content, "back again");
  const journal = await store.inner.load("recovered", security());
  const results = journal.filter((event) => event.type === "tool/result" && payload(event).executionId === "exec-lost");
  assert.deepEqual(results.map((event) => payload(event).state), ["not_started"], "recovery's result stands alone");
  assert.equal(payload(next.events.find((event) => event.type === "approval/resolved")).reason, "superseded");
  assertEveryCallAnsweredOnce(requests[0]!.messages);
  await host.shutdown();
});

test("a question's turn has no content, live or replayed; its deadline is the interaction TTL, not the approval one", async () => {
  const { adapter } = scriptedModel([call("ask-1", "request_user_input", REGION_QUESTION)]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), createUserInputToolsPlugin()]);
  const agent = new DefaultAgentLoop(router, new SpyStore(), { approvalTtlMs: 60_000, interactionTtlMs: 3_600_000 });
  const startedAt = Date.now();
  const paused = await agent.runTurn({ sessionId: "quiet", content: "look it up", security: security(), idempotencyKey: "quiet" });
  assert.deepEqual([paused.outcome, paused.content], ["awaiting_interaction", ""]);
  const lifetime = Date.parse(paused.interaction!.expiresAt) - startedAt;
  assert.ok(lifetime > 3_000_000 && lifetime <= 3_600_000 + 1_000, `interaction lives ${lifetime}ms`);
  const replay = await agent.runTurn({ sessionId: "quiet", content: "look it up", security: security(), idempotencyKey: "quiet" });
  assert.deepEqual([replay.replayed, replay.outcome, replay.content], [true, "awaiting_interaction", ""]);
  await host.shutdown();
});
