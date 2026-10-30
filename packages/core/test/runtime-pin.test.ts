import assert from "node:assert/strict";
import { test } from "node:test";
import { AgenticError, type RunTurnInput, type RuntimeSnapshot, type SessionEvent, type TurnAdmissionController } from "@0xsyncroot/contracts";
import { DefaultAgentLoop, PluginHost, TenantRuntimeRouter, acquireRuntimeView, type RuntimeProvider, type RuntimeResolutionRequest, type RuntimeViewLease } from "@0xsyncroot/core";
import { createSystemPromptPlugin, createUserInputToolsPlugin } from "@0xsyncroot/plugins-base";
import { runAgentOperation } from "../src/agent/agent-operation.js";
import { routePin, type PauseRecord } from "../src/agent/continuation-binding.js";
import { SpyStore, activeHost, answer, call, scriptedModel, security, toolPlugin, writeTool } from "./turn-harness.js";

/**
 * A resume asks its provider for the route its pause was raised under, read from the journal by core alone; a new turn
 * asks for the live route. The operation acquires its runtime once, lazily, and releases it however the work ends.
 */

const R1 = "harness:policy-a:model-a:release-1:switches-1";
const R2 = "harness:policy-a:model-a:release-2:switches-1";

/** A provider that serves several route revisions at once, asynchronously, the way a catalog-backed one rebuilds a release. */
function releases(host: PluginHost, served: readonly string[], honourPins = true) {
  const state = { live: served[0]!, open: 0, requests: [] as RuntimeResolutionRequest[] };
  const provider: RuntimeProvider = {
    acquireRuntime: async (request) => {
      state.requests.push(request);
      const routeRevision = honourPins && request.pin !== undefined && served.includes(request.pin) ? request.pin : state.live;
      const lease = new TenantRuntimeRouter([{ tenantId: "tenant-a", agentProfileId: "default", provider: host, routeRevision }]).acquireRuntime(request);
      state.open += 1;
      return { ...lease, release: () => { state.open -= 1; lease.release(); } };
    },
  };
  return { state, provider };
}

function startBinding(events: readonly SessionEvent[]): unknown {
  return (events.find((event) => event.type === "turn/start")?.payload as Record<string, unknown> | undefined)?.runtimeBinding;
}

test("an approval resumes on the route its pause was raised under, never on a pin sent with the request", async () => {
  const { adapter } = scriptedModel([call("write-1", "test_write", { value: "v" }), answer("written")]);
  const { host } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("write", [writeTool()])]);
  const { state, provider } = releases(host, [R1, R2]);
  try {
    const agent = new DefaultAgentLoop(provider, new SpyStore());
    const paused = await agent.runTurn({ sessionId: "pinned", content: "write it", security: security() });
    assert.equal(paused.outcome, "awaiting_approval");
    state.live = R2;
    const resumed = await agent.resumeTurn({
      sessionId: "pinned", approvalId: paused.approval!.approvalId, decision: "approve", security: security(), idempotencyKey: "approve-1",
      ...({ pin: R2 } as object),
    });
    assert.equal(resumed.outcome, "completed");
    assert.deepEqual(state.requests.map((request) => request.pin), [undefined, R1], "the new turn asks for no pin; the resume asks for its pause's");
    assert.equal(Object.hasOwn(state.requests[0]!, "pin"), false, "a new turn's request carries no pin at all");
    assert.equal((startBinding(resumed.events) as Record<string, unknown>).routeRevision, R1);
    assert.equal(state.open, 0);
  } finally { await host.shutdown(); }
});

test("an answered question resumes on the route its pause was raised under", async () => {
  const question = { message: "Which region?", fields: [{ id: "region", label: "Region", type: "text", required: true }] };
  const { adapter } = scriptedModel([call("ask-1", "request_user_input", question), answer("done")]);
  const { host } = await activeHost(adapter, [createSystemPromptPlugin(), createUserInputToolsPlugin()]);
  const { state, provider } = releases(host, [R1, R2]);
  try {
    const agent = new DefaultAgentLoop(provider, new SpyStore());
    const paused = await agent.runTurn({ sessionId: "asked", content: "look it up", security: security() });
    assert.equal(paused.outcome, "awaiting_interaction");
    state.live = R2;
    const resumed = await agent.resumeInteraction({
      sessionId: "asked", interactionId: paused.interaction!.interactionId, action: "accept", content: { region: "north" },
      security: security(), idempotencyKey: "answer-1",
    });
    assert.equal(resumed.outcome, "completed");
    assert.deepEqual(state.requests.map((request) => request.pin), [undefined, R1]);
    assert.equal(state.open, 0);
  } finally { await host.shutdown(); }
});

test("a pin the provider cannot serve leases the live route, and the resume is refused as stale with its lease released", async () => {
  const { adapter } = scriptedModel([call("write-1", "test_write", { value: "v" }), answer("written")]);
  const { host } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("write", [writeTool()])]);
  const { state, provider } = releases(host, [R1, R2], false);
  try {
    const store = new SpyStore();
    const agent = new DefaultAgentLoop(provider, store);
    const paused = await agent.runTurn({ sessionId: "unserved", content: "write it", security: security() });
    state.live = R2;
    const before = (await store.inner.load("unserved", security())).length;
    await assert.rejects(agent.resumeTurn({
      sessionId: "unserved", approvalId: paused.approval!.approvalId, decision: "approve", security: security(), idempotencyKey: "approve-1",
    }), (error: unknown) => error instanceof AgenticError && error.code === "conflict" && error.reason === "stale-binding");
    assert.equal(state.requests.at(-1)?.pin, R1, "core passed the pin through; the provider chose not to honour it");
    assert.equal(state.open, 0, "the refused resume released its lease");
    assert.equal((await store.inner.load("unserved", security())).length, before, "nothing written");
  } finally { await host.shutdown(); }
});

test("a resume of a pause that is gone is refused as expired before any runtime is leased", async () => {
  const { adapter } = scriptedModel([answer("hello")]);
  const { host } = await activeHost(adapter, [createSystemPromptPlugin()]);
  const { state, provider } = releases(host, [R1]);
  try {
    const agent = new DefaultAgentLoop(provider, new SpyStore());
    await agent.runTurn({ sessionId: "gone", content: "hi", security: security() });
    await assert.rejects(agent.resumeTurn({
      sessionId: "gone", approvalId: "no-such-approval", decision: "approve", security: security(), idempotencyKey: "approve-1",
    }), (error: unknown) => error instanceof AgenticError && error.code === "conflict" && error.reason === "expired");
    assert.equal(state.requests.length, 1, "only the new turn leased a runtime");
  } finally { await host.shutdown(); }
});

const SNAPSHOT = { id: "snap-1" } as RuntimeSnapshot;
const COMMAND: RunTurnInput = { sessionId: "s", content: "c", security: security(), idempotencyKey: "k" };

/** A lease counter over a fake generation, and the admission settlements the operation reported. */
function operationContext(asynchronous: boolean) {
  const state = { acquired: 0, released: 0, settled: [] as string[] };
  const lease = (): RuntimeViewLease => ({
    snapshot: SNAPSHOT, capabilities: {} as RuntimeViewLease["capabilities"],
    binding: { tenantId: "tenant-a", agentProfileId: "default", routeRevision: "r", runtimeSnapshotId: SNAPSHOT.id },
    release: () => { state.released += 1; },
  });
  const admission: TurnAdmissionController = {
    acquire: async () => ({ settle: async (settlement) => { state.settled.push(settlement.outcome); } }),
  } as TurnAdmissionController;
  const runtimeProvider: RuntimeProvider = {
    acquireRuntime: () => { state.acquired += 1; return asynchronous ? Promise.resolve(lease()) : lease(); },
  };
  return { state, context: { operation: "run-turn" as const, runtimeProvider, admission, telemetry: undefined } };
}

test("the operation releases its lease when the work fails after acquiring it, for a sync and an async provider", async () => {
  for (const asynchronous of [false, true]) {
    const { state, context } = operationContext(asynchronous);
    await assert.rejects(runAgentOperation(context, COMMAND, async (acquire) => { await acquire(); throw new Error("work failed"); }), /work failed/);
    assert.deepEqual([state.acquired, state.released, state.settled], [1, 1, ["failed"]]);
  }
});

test("work that never acquires leases nothing, and a second acquire in one operation is refused", async () => {
  const idle = operationContext(false);
  const result = { outcome: "completed", content: "", events: [] } as never;
  assert.equal(await runAgentOperation(idle.context, COMMAND, async () => result), result);
  assert.deepEqual([idle.state.acquired, idle.state.released], [0, 0]);
  const twice = operationContext(true);
  await assert.rejects(runAgentOperation(twice.context, COMMAND, async (acquire) => { await acquire(); await acquire("r"); return result; }),
    (error: unknown) => error instanceof AgenticError && error.code === "permanent");
  assert.deepEqual([twice.state.acquired, twice.state.released], [1, 1], "the refused second acquire reached no provider");
});

test("an async provider's lease is validated like a sync one, and released when it binds another request", async () => {
  let released = 0;
  const foreign: RuntimeProvider = {
    acquireRuntime: async () => ({
      snapshot: SNAPSHOT, capabilities: {} as RuntimeViewLease["capabilities"],
      binding: { tenantId: "tenant-b", agentProfileId: "default", routeRevision: "r", runtimeSnapshotId: SNAPSHOT.id },
      release: () => { released += 1; },
    }),
  };
  await assert.rejects(acquireRuntimeView(foreign, { security: security() }), (error: unknown) => error instanceof AgenticError && error.code === "denied");
  assert.equal(released, 1);
});

test("the pin is the route revision the pause recorded, or nothing when the record holds none", () => {
  const record = (payload: Record<string, unknown>): PauseRecord => ({ kind: "approval", pauseId: "a", event: {} as SessionEvent, payload });
  assert.equal(routePin(record({ runtimeRouteRevision: R1 })), R1, "colons inside the revision are kept: the provider parses it");
  assert.equal(routePin(record({})), undefined);
  assert.equal(routePin(record({ runtimeRouteRevision: "" })), undefined);
  assert.equal(routePin(record({ runtimeRouteRevision: 7 })), undefined);
});
