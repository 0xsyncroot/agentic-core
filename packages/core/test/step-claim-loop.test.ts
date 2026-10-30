import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITIES, type JsonValue, type JudgmentPort, type JudgmentRequest, type ToolDefinition } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { JUDGMENT_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { activeHost, answer, call, planningPlugin, planStep, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/**
 * A plan step marked completed is read against the turn's latest results, for any tool: in `on` a
 * step whose outcome the evidence does not show is noted beside the plan update the model reads
 * next; in `shadow` the judgment is journaled and nothing changes. A step completed earlier is not
 * asked about again.
 */

function judgment(judge: (request: JudgmentRequest) => Record<string, unknown>, asked: JudgmentRequest[]): PluginDescriptor {
  return {
    trustTier: "platform-core",
    manifest: { manifestVersion: 1, id: "io.syncroot.test.judgment", version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
      artifact: { digest: "builtin:judgment", signature: "test" }, requires: {},
      provides: { [CAPABILITIES.judgment]: { version: "1.0.0", cardinality: "single" } }, permissions: {} },
    plugin: { validate: async () => ({ valid: true }), activate: async (context) => {
      const port: JudgmentPort = { providerId: "fake", model: "fake", judge: async (request) => { asked.push(request); return { modelId: "fake", answers: judge(request) as never }; } };
      context.registrations.provide(JUDGMENT_CAPABILITY, port);
      return { dispose: () => undefined };
    } },
  };
}

const pressTool: ToolDefinition = {
  id: "test_press", version: "1", description: "press", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {},
  execute: async () => ({ status: "succeeded", dialog: "Bạn có chắc chắn muốn xóa?" }) as JsonValue,
};
const shown = (top: number) => ({ shown: { type: "score", score: 2 * top, confidence: Math.max(top, 1 - top),
  legend: { 0: "The evidence does not show the step done: it shows another state, an error, an unfinished action or nothing about it.", 1: "The evidence suggests the step but does not show its outcome.", 2: "The evidence shows the outcome of the step." },
  probabilities: { 0: 1 - top, 1: 0, 2: top } } });

async function run(mode: "on" | "shadow", top: number) {
  const asked: JudgmentRequest[] = [];
  const { adapter, requests } = scriptedModel([
    planStep("p1", "Xóa bảng", [{ id: "s1", description: "Mở bảng", status: "completed" }, { id: "s2", description: "Xóa bảng lương tháng 9", status: "in_progress" }]),
    call("c1", "test_press", { label: "Xóa" }),
    planStep("p2", "Xóa bảng", [{ id: "s1", description: "Mở bảng", status: "completed" }, { id: "s2", description: "Xóa bảng lương tháng 9", status: "completed" }]),
    answer("Đã xóa."),
  ]);
  const store = new SpyStore();
  const { host, router } = await activeHost(adapter, [planningPlugin(), toolPlugin("press", [pressTool]), judgment(() => shown(top), asked)]);
  try {
    await new DefaultAgentLoop(router, store, {}, { judgmentSeams: { stepClaim: mode } }).runTurn({ sessionId: "claims", content: "xóa bảng lương tháng 9", security: security() });
    const events = await store.load("claims", security());
    const notes = events.filter((event) => event.type === "tool/result").map((event) => (event.payload as { note?: string }).note ?? "");
    return { asked: asked.filter((request) => "shown" in request.questions), notes, seen: requests.at(-1)!.messages.map((message) => message.content ?? "").join("\n") };
  } finally { await host.shutdown(); }
}

test("on: a step the evidence does not show done is noted beside the plan update, read against the latest result", async () => {
  const { asked, notes, seen } = await run("on", 0);
  assert.equal(asked.length, 1, "only the step this update completes; the first update had no evidence yet");
  const state = asked[0]!.state as { step: string; evidence: { tool: string; result: string }[] };
  assert.equal(state.step, "Xóa bảng lương tháng 9");
  assert.deepEqual(state.evidence.map((entry) => entry.tool), ["test_press"]);
  assert.match(notes.at(-1)!, /does not show "Xóa bảng lương tháng 9" done yet/u);
  assert.match(seen, /does not show "Xóa bảng lương tháng 9" done yet/u, "the model reads it in its next step");
});

test("a shown step passes silently; shadow asks and journals but notes nothing", async () => {
  assert.equal((await run("on", 0.9)).notes.some((note) => note.includes("does not show")), false);
  const shadow = await run("shadow", 0);
  assert.equal(shadow.asked.length, 1);
  assert.equal(shadow.notes.some((note) => note.includes("does not show")), false);
});
