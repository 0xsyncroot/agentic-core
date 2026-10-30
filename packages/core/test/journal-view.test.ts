import assert from "node:assert/strict";
import { test } from "node:test";
import { createEchoToolPlugin } from "@0xsyncroot/adapter-echo";
import { MAX_SESSION_READ_EVENTS, type LlmAdapter, type RuntimeSnapshot, type TurnControlPolicy } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { createSystemPromptPlugin } from "@0xsyncroot/plugins-base";
import { requestDigest } from "../src/agent/request-digest.js";
import { TurnJournalView } from "../src/agent/turn-journal-view.js";
import { SpyStore, activeHost, answer, call, scriptedModel, security, toolPlugin, writeTool } from "./turn-harness.js";

const runtime: RuntimeSnapshot = {
  id: "runtime-test", coreVersion: "1.0.0", pluginSetId: "test", policyRevision: "test-policy",
  memoryPolicyRevision: "test-memory", createdAt: new Date(0).toISOString(),
};

async function seqOf(store: SpyStore, sessionId: string): Promise<number> {
  return (await store.inner.load(sessionId, security())).length;
}

/** Appends `count` ordinary finished turns outside any lease, as an old session would hold them. */
async function seedTurns(store: SpyStore, sessionId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const turnId = `seed-${index}`;
    await store.inner.append(sessionId, await seqOf(store, sessionId), [
      { type: "turn/start", turnId, payload: { inputIdempotencyKey: turnId } },
      { type: "user/input", turnId, payload: { content: `old ${index}`, source: "external" } },
      { type: "assistant/message", turnId, stepId: `s-${index}`, requestId: `r-${index}`, payload: { content: `answer ${index}`, toolCalls: [] } },
      { type: "turn/end", turnId, payload: { status: "completed", steps: 1 } },
    ], `seed:${turnId}`, { security: security(), runtime });
  }
}

test("an operation reads the session once and then only what it wrote: run, pause, resume and a new turn never load it whole", async () => {
  let executions = 0;
  const { adapter } = scriptedModel([
    call("write-1", "test_write", { value: "v" }),
    answer("written"),
    answer("hello again"),
  ]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("write", [writeTool(() => { executions += 1; })])]);
  const store = new SpyStore();
  await seedTurns(store, "a8", 40);
  const agent = new DefaultAgentLoop(router, store);
  const operations: { readonly name: string; readonly run: () => Promise<{ readonly outcome: string; readonly approval?: { readonly approvalId: string } }> }[] = [];
  let approvalId = "";
  operations.push({ name: "run", run: async () => {
    const paused = await agent.runTurn({ sessionId: "a8", content: "write it", security: security(), idempotencyKey: "a8-run" });
    approvalId = paused.approval!.approvalId;
    return paused;
  } });
  operations.push({ name: "resume", run: () => agent.resumeTurn({ sessionId: "a8", approvalId, decision: "approve", security: security(), idempotencyKey: "a8-resume" }) });
  operations.push({ name: "new turn", run: () => agent.runTurn({ sessionId: "a8", content: "hi", security: security(), idempotencyKey: "a8-next" }) });
  const outcomes: string[] = [];
  for (const operation of operations) {
    const before = await seqOf(store, "a8");
    store.reset();
    outcomes.push((await operation.run()).outcome);
    const written = await seqOf(store, "a8") - before;
    assert.equal(store.loads, 0, `${operation.name}: no full-session load`);
    assert.equal(store.contextReads, 1, `${operation.name}: one bounded read seeds the operation`);
    // Every later read returns only rows written since the view last looked: never a row twice.
    assert.ok(store.rowsRead <= Math.min(before, MAX_SESSION_READ_EVENTS) + written,
      `${operation.name}: read ${store.rowsRead} rows for a window of ${before} and ${written} written`);
  }
  assert.deepEqual(outcomes, ["awaiting_approval", "completed", "completed"]);
  assert.equal(executions, 1);
  await host.shutdown();
});

test("a turn's result carries only its own events, and a replay returns exactly those — from the full session only when the turn left the window", async () => {
  const { adapter } = scriptedModel([answer("first"), answer("second")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin()]);
  const store = new SpyStore();
  const agent = new DefaultAgentLoop(router, store);
  const first = await agent.runTurn({ sessionId: "scoped", content: "one", security: security(), idempotencyKey: "scoped-1" });
  const second = await agent.runTurn({ sessionId: "scoped", content: "two", security: security(), idempotencyKey: "scoped-2" });
  assert.ok(second.events.every((event) => event.turnId === second.turnId));
  assert.equal(second.events[0]?.type, "turn/start");
  assert.equal(second.events.at(-1)?.type, "turn/end");
  store.reset();
  const replay = await agent.runTurn({ sessionId: "scoped", content: "two", security: security(), idempotencyKey: "scoped-2" });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.events, second.events);
  assert.equal(store.loads, 0, "a recent turn replays from the bounded view");

  await seedTurns(store, "scoped", Math.ceil(MAX_SESSION_READ_EVENTS / 4) + 1);
  store.reset();
  const old = await agent.runTurn({ sessionId: "scoped", content: "one", security: security(), idempotencyKey: "scoped-1" });
  assert.equal(old.replayed, true);
  assert.deepEqual(old.events, first.events);
  assert.equal(old.content, "first");
  assert.equal(store.loads, 1, "only a turn outside the window costs the full read");
  await host.shutdown();
});

test("the view hands out frozen snapshots, catches up with what was written, and starts over after a full page", async () => {
  const store = new SpyStore();
  await seedTurns(store, "view", 2);
  const head = { seq: await seqOf(store, "view") };
  const view = await TurnJournalView.open(store, "view", security());
  view.follow(head);
  const before = await view.events();
  assert.equal(Object.isFrozen(before), true);
  assert.equal(before.length, 8);
  await store.inner.append("view", head.seq, [{ type: "user/input", turnId: "late", payload: { content: "late", source: "external" } }], "late", { security: security(), runtime });
  store.reset();
  assert.equal((await view.events()).length, 8, "a view reads nothing while its writer has not moved");
  assert.equal(store.sinceReads, 0);
  head.seq += 1;
  const after = await view.events();
  assert.deepEqual(after.map((event) => event.seq), [...before.map((event) => event.seq), 9]);
  assert.equal(before.length, 8, "a snapshot already handed out never changes");
  assert.deepEqual([store.sinceReads, store.rowsRead], [1, 1]);

  const burst = Array.from({ length: MAX_SESSION_READ_EVENTS }, (_, index): { type: string; turnId: string; payload: { content: string; source: string } } =>
    ({ type: "user/input", turnId: "burst", payload: { content: String(index), source: "external" } }));
  await store.inner.append("view", head.seq, burst, "burst", { security: security(), runtime });
  head.seq += MAX_SESSION_READ_EVENTS;
  store.reset();
  const reloaded = await view.events();
  assert.deepEqual([store.sinceReads, store.contextReads], [1, 1], "a full page cannot say whether more follow, so the view reloads the tail");
  assert.equal(reloaded.length, MAX_SESSION_READ_EVENTS);
  assert.equal(reloaded.at(-1)?.seq, head.seq);
  assert.equal((await view.context()).truncatedBeforeSeq, reloaded[0]?.seq);
});

test("request/prepared journals a digest of the request, keyed to the full body the adapter received", async () => {
  const received: Parameters<LlmAdapter["stream"]>[0][] = [];
  const { adapter, requests } = scriptedModel([call("echo-1", "agentic_echo", { value: "pong" }, "checking"), answer("done")]);
  const recording: LlmAdapter = { ...adapter, stream: (request, signal) => { received.push(request); return adapter.stream(request, signal); } };
  const { host, router } = await activeHost(recording, [createSystemPromptPlugin(), createEchoToolPlugin()]);
  const result = await new DefaultAgentLoop(router, new SpyStore()).runTurn({
    sessionId: "digest", content: "ping", security: security(), applicationContext: { untrusted: { screen: "payroll" } },
  });
  assert.equal(result.content, "done");
  const digests = result.events.filter((event) => event.type === "request/prepared");
  assert.equal(digests.length, 2);
  for (const [index, event] of digests.entries()) {
    const payload = event.payload as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), [
      "attemptId", "contentHash", "messageCount", "messageManifest", "messagesChars", "model", "modelRoute", "parameters",
      "requestId", "requestedToolChoice", "runtimeSnapshotId", "stepId", "systemHash", "toolChoice", "toolChoiceEnforcement",
      "toolIds", "toolsHash", "turnId",
    ]);
    const sent = received[index]!;
    assert.equal(payload.contentHash, sent.contentHash, "the journal and the tracing adapter share one key");
    assert.equal(payload.messageCount, sent.messages.length);
    assert.equal(sent.messages.length > 0 && Array.isArray(sent.tools), true, "the adapter still receives the full request");
    assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") <= 4_096, `digest is ${JSON.stringify(payload).length} chars`);
    assert.equal(JSON.stringify(payload).includes("pong\""), false, "no message body is journaled");
  }
  const manifest = (digests[1]!.payload as { messageManifest: { role: string; toolCallIds?: string[]; chars: number; sha256: string }[] }).messageManifest;
  assert.deepEqual(manifest.filter((entry) => entry.toolCallIds?.includes("echo-1")).map((entry) => entry.role), ["assistant", "tool"],
    "the manifest shows each call answered exactly once");
  assert.ok(manifest.every((entry) => entry.chars > 0 && /^[0-9a-f]{16}$/u.test(entry.sha256)));
  assert.deepEqual((digests[0]!.payload as Record<string, unknown>).toolIds, ["agentic_echo"]);
  assert.equal(requests.length, 2);
  await host.shutdown();
});

test("a request of a working session — thirty messages, thirty tools, a long prompt — still journals under 4 KB", () => {
  const tools = Array.from({ length: 30 }, (_, index) => ({ name: `payroll_tool_${index}`, description: "d".repeat(400), inputSchema: {} }));
  const messages = [
    { role: "system" as const, content: "p".repeat(12_000), context: { trust: "instruction" as const, retention: "required" as const, provenance: "runtime-system-prompt" } },
    ...Array.from({ length: 10 }, (_, index) => [
      { role: "user" as const, content: `question ${index} `.repeat(40) },
      { role: "assistant" as const, content: null, toolCalls: [{ id: `call_0_${index}`, name: "payroll_tool_1", arguments: "{\"Year\":2026}" }] },
      { role: "tool" as const, toolCallId: `call_0_${index}`, content: "r".repeat(3_000) },
    ]).flat(),
  ];
  const digest = requestDigest({
    requestId: crypto.randomUUID(), attemptId: crypto.randomUUID(), turnId: crypto.randomUUID(), stepId: crypto.randomUUID(),
    runtimeSnapshotId: "runtime-test", model: "deepseek-chat", messages, tools, parameters: { temperature: 0.2 }, contentHash: "c".repeat(64),
  }, {
    modelRoute: { providerId: "deepseek", adapterId: "deepseek", modelId: "deepseek-chat", routeRevision: "route-v1", metadataSource: "adapter-catalog" },
    requestedToolChoice: undefined, toolChoiceEnforcement: "none",
  });
  assert.equal(digest.messageCount, 31);
  assert.ok(Buffer.byteLength(JSON.stringify(digest), "utf8") <= 4_096, `digest is ${JSON.stringify(digest).length} bytes`);
});

test("the journal keeps facts, not noise: no per-call work decisions, no running rows, no default policy decisions", async () => {
  const { adapter } = scriptedModel([
    call("echo-1", "agentic_echo", { value: "same" }),
    call("echo-2", "agentic_echo", { value: "same" }),
    answer("done"),
  ]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), createEchoToolPlugin()]);
  let steps = 0;
  const policy: TurnControlPolicy = {
    id: "test.quiet", revision: "v1",
    // Only the second step is narrowed; the others leave every choice to the model.
    beforeModelStep: async () => (steps += 1) === 2 ? { allowedToolIds: ["agentic_echo"] } : {},
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { turnControlPolicy: policy })
    .runTurn({ sessionId: "noise", content: "echo twice", security: security() });
  assert.equal(result.content, "done");
  assert.equal(result.events.some((event) => event.type === "work/decision"), false);
  assert.equal(result.events.some((event) => event.type === "tool/state" && (event.payload as Record<string, unknown>).state === "running"), false);
  const beforeModel = result.events.filter((event) => event.type === "turn/control-decision" && (event.payload as Record<string, unknown>).phase === "before-model");
  assert.equal(beforeModel.length, 1, "only the step whose directive changed something is recorded");
  assert.deepEqual((beforeModel[0]!.payload as Record<string, unknown>).allowedToolIds, ["agentic_echo"]);
  const gains = result.events.filter((event) => event.type === "tool/result").map((event) => (event.payload as Record<string, unknown>).informationGain);
  assert.deepEqual(gains, ["new", "repeated"], "what the turn learned is stamped on the result itself");
  assert.equal((result.events.find((event) => event.type === "turn/end")?.payload as Record<string, unknown>).decision, "finish");
  await host.shutdown();
});
