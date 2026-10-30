import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPABILITIES, type JudgmentPort, type JudgmentRequest, type TurnControlPolicy, type TurnControlServices } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { InMemorySessionStore } from "@0xsyncroot/persistence-memory";
import { JUDGMENT_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { activeHost, answer, call, scriptedModel, security, toolPlugin, writeTool } from "../../core/test/turn-harness.js";
import { withActionGate } from "../src/index.js";

const state = (calls: { name: string; arguments: string }[]) => ({
  turnId: "t1", taskTurnIds: ["t1"], directive: {},
  availableTools: [{ id: "write_x", version: "1", sideEffect: "idempotent" }, { id: "read_x", version: "1", sideEffect: "none" }],
  context: { events: [
    { eventId: "e1", seq: 1, turnId: "t1", type: "user/input", payload: { content: "Sửa tỷ lệ hưởng của An thành 85%" } },
    { eventId: "e2", seq: 2, turnId: "t1", type: "tool/result", payload: { toolId: "read_x", dispatched: true, state: "succeeded", result: { id: "E1", name: "An" } } },
  ] },
  toolCalls: calls.map((c, i) => ({ id: `c${i}`, ...c })),
}) as unknown as Parameters<NonNullable<TurnControlPolicy["reviewToolCalls"]>>[0];
const inner: TurnControlPolicy = { id: "p", revision: "1", beforeModelStep: async () => ({}), reviewTerminal: async () => ({ decision: "accept" }) };
const judgeWith = (p: Record<string, number>, seen: unknown[]): TurnControlServices => ({
  judge: async (seam: string, request: JudgmentRequest) => {
    seen.push({ seam, state: request.state });
    return { modelId: "f", answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul" as const, noul: p[id] ?? 0 }])) };
  },
});
const signal = new AbortController().signal;
const write = [{ name: "write_x", arguments: '{"Value":0.85}' }];
const DOUBT = { requested: 1, invented: 0.97, ambiguous: 0 };

test("on: a confidently doubted write is sent back with the reason and the form-tool instruction", async () => {
  const seen: unknown[] = [];
  const gate = withActionGate(inner, { mode: "on", fallback: "Chưa ghi.", gates: (id) => id === "write_x", describeTool: () => "Value is a raw 0-100 number" });
  const decision = await gate.reviewToolCalls!(state(write), signal, judgeWith(DOUBT, seen));
  assert.equal(decision.decision, "continue");
  if (decision.decision !== "continue") return;
  assert.match(decision.feedback, /stated by neither the user nor the evidence/u);
  assert.match(decision.feedback, /form tool/u);
  assert.equal(decision.fallback, "Chưa ghi.");
  const asked = seen[0] as { seam: string; state: { request: string; action: { description: string } } };
  assert.equal(asked.seam, "action-gate");
  assert.match(asked.state.request, /85%/u);
  assert.equal(asked.state.action.description, "Value is a raw 0-100 number");
  assert.equal(JSON.stringify(asked.state).includes("assistant"), false, "the judge never reads the agent's prose");
});

test("the description is asked with the reviewed state, so the judge reads the one of the runtime the step runs on", async () => {
  const seen: unknown[] = [];
  const asked: string[] = [];
  const byRuntime = new Map([["r1", "Value is a raw 0-100 number"], ["r2", "Value is a fraction"]]);
  const gate = withActionGate(inner, { mode: "on", fallback: "x", gates: (id) => id === "write_x",
    describeTool: (toolId, reviewed) => { asked.push(`${reviewed.runtime.id}:${toolId}`); return byRuntime.get(reviewed.runtime.id); } });
  for (const runtimeId of ["r1", "r2"]) await gate.reviewToolCalls!({ ...state(write), runtime: { id: runtimeId } } as ReturnType<typeof state>, signal, judgeWith(DOUBT, seen));
  assert.deepEqual(asked, ["r1:write_x", "r2:write_x"]);
  assert.deepEqual(seen.map((s) => (s as { state: { action: { description: string } } }).state.action.description), ["Value is a raw 0-100 number", "Value is a fraction"]);
});

test("shadow asks and reports but never blocks; a clear write and a read pass untouched", async () => {
  const reports: string[][] = [];
  const shadow = withActionGate(inner, { fallback: "x", gates: (id) => id === "write_x", onJudged: (r) => reports.push([...r.reasons]) });
  assert.deepEqual(await shadow.reviewToolCalls!(state(write), signal, judgeWith(DOUBT, [])), { decision: "accept" });
  await new Promise((resolve) => setImmediate(resolve)); // shadow judges in the background: the report comes after the review has returned
  assert.equal(reports[0]!.length, 1);
  const on = withActionGate(inner, { mode: "on", fallback: "x", gates: (id) => id === "write_x" });
  assert.deepEqual(await on.reviewToolCalls!(state(write), signal, judgeWith({ requested: 1, invented: 0.01, ambiguous: 0 }, [])), { decision: "accept" });
  const seen: unknown[] = [];
  assert.deepEqual(await on.reviewToolCalls!(state([{ name: "read_x", arguments: "{}" }]), signal, judgeWith(DOUBT, seen)), { decision: "accept" });
  assert.equal(seen.length, 0, "reads are not judged");
});

test("no judge, a failed judgment, or the product's own objection: the gate stays out of the way", async () => {
  const on = withActionGate(inner, { mode: "on", fallback: "x" });
  assert.deepEqual(await on.reviewToolCalls!(state(write), signal, {}), { decision: "accept" });
  assert.deepEqual(await on.reviewToolCalls!(state(write), signal, { judge: async () => undefined }), { decision: "accept" });
  const objecting: TurnControlPolicy = { ...inner, reviewToolCalls: async () => ({ decision: "continue", feedback: "không ghi đè" }) };
  const seen: unknown[] = [];
  const decision = await withActionGate(objecting, { mode: "on", fallback: "x", gates: () => true }).reviewToolCalls!(state(write), signal, judgeWith(DOUBT, seen));
  assert.deepEqual([decision.decision, seen.length], ["continue", 0]);
});

test("a call the product did not name as a data write is never judged, whatever its side effect", async () => {
  const seen: unknown[] = [];
  const gate = withActionGate(inner, { mode: "on", fallback: "x" });
  assert.deepEqual(await gate.reviewToolCalls!(state(write), signal, judgeWith(DOUBT, seen)), { decision: "accept" });
  assert.equal(seen.length, 0, "no gates named: nothing is judged");
  const screenOnly = withActionGate(inner, { mode: "on", fallback: "x", gates: (id) => id.startsWith("payroll_") });
  assert.deepEqual(await screenOnly.reviewToolCalls!(state(write), signal, judgeWith(DOUBT, seen)), { decision: "accept" });
  assert.equal(seen.length, 0, "a screen action is not a payroll write");
});

test("shadow: the write does not wait for the judgment; it is reported when it comes", async () => {
  const reports: string[][] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const asked: string[] = [];
  const slow: TurnControlServices = { judge: async (seam: string, request: JudgmentRequest) => {
    asked.push(seam); await held;
    return { modelId: "f", answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul" as const, noul: DOUBT[id as keyof typeof DOUBT] ?? 0 }])) };
  } };
  const gate = withActionGate(inner, { fallback: "x", gates: (id) => id === "write_x", onJudged: (r) => reports.push([...r.reasons]) });
  assert.deepEqual(await gate.reviewToolCalls!(state(write), signal, slow), { decision: "accept" }, "returns while the judgment is still out");
  assert.deepEqual([asked, reports.length], [["action-gate"], 0]);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.length, 1, "the late judgment still labels the write");
});

test("shadow: a judgment that fails after the review returned (turn over, lease refused) is swallowed, never an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const failing: TurnControlServices = { judge: async () => { await new Promise((resolve) => setImmediate(resolve)); throw new Error("lease expired"); } };
    const reports: unknown[] = [];
    const gate = withActionGate(inner, { fallback: "x", gates: (id) => id === "write_x", onJudged: (r) => reports.push(r) });
    assert.deepEqual(await gate.reviewToolCalls!(state([...write, ...write]), signal, failing), { decision: "accept" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual([unhandled.length, reports.length], [0, 0]);
  } finally { process.off("unhandledRejection", onUnhandled); }
});

test("on: the write still waits for the judgment, one call after another", async () => {
  const order: string[] = [];
  const judge: TurnControlServices = { judge: async (_seam: string, request: JudgmentRequest) => {
    order.push("start"); await new Promise((resolve) => setImmediate(resolve)); order.push("end");
    return { modelId: "f", answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul" as const, noul: id === "requested" ? 1 : 0 }])) };
  } };
  const gate = withActionGate(inner, { mode: "on", fallback: "x", gates: (id) => id === "write_x" });
  assert.deepEqual(await gate.reviewToolCalls!(state([...write, ...write]), signal, judge), { decision: "accept" });
  assert.deepEqual(order, ["start", "end", "start", "end"]);
});

test("shadow in a real turn: the turn reaches the write's approval without waiting; a judgment that lands after the turn ended leaves no row and no crash", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let answered = 0;
  const port: JudgmentPort = { providerId: "fake", model: "fake-1", judge: async (request) => {
    await held;
    answered += 1;
    return { modelId: "fake-1", answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul" as const, noul: DOUBT[id as keyof typeof DOUBT] ?? 0 }])) };
  } };
  const judgment: PluginDescriptor = {
    trustTier: "platform-core",
    manifest: { manifestVersion: 1, id: "io.syncroot.test.judgment", version: "1.0.0", publisher: "test", coreApi: "^1.0.0", artifact: { digest: "builtin:judgment", signature: "test" },
      requires: {}, provides: { [CAPABILITIES.judgment]: { version: "1.0.0", cardinality: "single" } }, permissions: {} },
    plugin: { validate: async () => ({ valid: true }), activate: async (context) => { context.registrations.provide(JUDGMENT_CAPABILITY, port); return { dispose: () => undefined }; } },
  };
  let written = 0;
  const { adapter } = scriptedModel([call("c1", "test_write", { value: "85" }), answer("Đã ghi.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("write", [writeTool(() => { written += 1; })]), judgment]);
  const store = new InMemorySessionStore();
  try {
    const policy = withActionGate(inner, { fallback: "x", gates: (id) => id === "test_write" });
    const agent = new DefaultAgentLoop(router, store, {}, { turnControlPolicy: policy });
    // The write waits for the user's approval: the turn ends there, with the gate's judgment still out.
    const paused = await agent.runTurn({ sessionId: "shadow-gate", content: "Ghi 85", security: security() });
    assert.equal(paused.outcome, "awaiting_approval", "the turn reached the write's approval without waiting for the judgment");
    const before = (await store.load("shadow-gate", security())).length;
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await store.load("shadow-gate", security());
    assert.equal(answered, 1, "the late judgment did come back");
    assert.equal(after.length, before, "nothing is journaled once the turn has ended");
    assert.deepEqual(unhandled, []);
    const resumed = await agent.resumeTurn({ sessionId: "shadow-gate", approvalId: paused.approval!.approvalId, decision: "approve", security: security(), idempotencyKey: "ok" });
    assert.deepEqual([resumed.content, written], ["Đã ghi.", 1]);
  } finally { process.off("unhandledRejection", onUnhandled); release(); await host.shutdown(); }
});
