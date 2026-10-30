import assert from "node:assert/strict";
import { test } from "node:test";
import { projectTurnWork, type AgentNarrationEvent, type SessionEvent, type ToolDefinition } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { InMemorySessionStore } from "@0xsyncroot/persistence-memory";
import { createSystemPromptPlugin } from "@0xsyncroot/plugins-base";
import { PLAN_TOOL_ID, activeHost, answer, calls, planningPlugin, scriptedModel, security, toolPlugin } from "./turn-harness.js";

/**
 * A progressing step adds its sentence; only a step that ran without progress replaces the stuck sentence before it.
 *
 * Core decides it on the step's outcome, after the step ran: a step that told a sentence and made no progress supersedes the
 * sentence before it, when no step since that one made progress (a dispatched call returned an observation the turn had not
 * seen). The words are never read: a stuck sentence and a progressing one differ only in what the screen returned.
 */

/** A screen read whose result is the scripted screen for its query: the same screen again is no progress. */
function screenTool(screens: Readonly<Record<string, string>>): ToolDefinition {
  return {
    id: "test_look", version: "1.0.0", description: "reads the screen",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    outputSchema: {}, requiredPermissions: [], sideEffect: "none", timeoutMs: 1_000,
    execute: async (invocation) => ({ screen: screens[(invocation.arguments as { query: string }).query] ?? "unknown" }),
  };
}

const look = (id: string, query: string) => ({ id, name: "test_look", args: { query } });
const plan = (id: string, ...more: string[]) => ({ id, name: PLAN_TOOL_ID, args: { goal: "Save the batch",
  steps: [{ id: "save", description: "Save the batch", status: "in_progress" }, ...more.map((description, index) => ({ id: `more-${index}`, description, status: "pending" }))] } });
const SCREENS = { list: "list", "covered-1": "list", saved: "detail", confirmed: "confirmed" };

async function run(sessionId: string, script: Parameters<typeof scriptedModel>[0]) {
  const { adapter } = scriptedModel(script);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), planningPlugin(), toolPlugin("screen", [screenTool(SCREENS)])]);
  const live: AgentNarrationEvent[] = [];
  const result = await new DefaultAgentLoop(router, new InMemorySessionStore(), { maxSteps: 12 })
    .runTurn({ sessionId, content: "save the batch", security: security(), onNarration: (event) => live.push(event) });
  await host.shutdown();
  return { result, live };
}

/** What the chat keeps, read from the journal: every narration, less those a later event says left it. */
function journalChat(events: readonly SessionEvent[]): string[] {
  const gone = new Set(events.filter((event) => event.type === "assistant/narration-superseded").map((event) => (event.payload as { narrationId: string }).narrationId));
  return events.filter((event) => event.type === "assistant/narration")
    .map((event) => event.payload as { narrationId: string; content: string })
    .filter((narration) => !gone.has(narration.narrationId)).map((narration) => narration.content);
}

/** What the chat keeps, read from the live frames alone. */
function liveChat(live: readonly AgentNarrationEvent[]): string[] {
  const told = new Map<string, string>();
  for (const event of live) {
    if (event.type === "assistant-narration-delta") told.set(event.narrationId, (told.get(event.narrationId) ?? "") + event.delta);
    if (event.type === "assistant-narration-superseded") told.delete(event.narrationId);
  }
  return [...told.values()];
}

test("three stuck steps then progress: the chat keeps the announcement, the last stuck sentence and the progressing one", async () => {
  const { result, live } = await run("narration-stuck-then-progress", [
    calls([plan("p1")], "I will save the batch."),
    calls([look("l1", "list")], "Opening the list."),
    calls([look("l2", "covered-1")], "The save button is covered."),
    calls([{ id: "m1", name: "test_missing", args: {} }], "Trying another way to reach it."),
    // A plan the model changed: refunded, no stall, and no progress either.
    calls([plan("p2", "Close the list first")]),
    calls([{ id: "m2", name: "test_missing", args: {} }], "The list still covers the save button."),
    calls([look("l4", "saved")], "The list is closed; saving now."),
    calls([look("l5", "confirmed")], "The batch is saved."),
    answer("Saved."),
  ]);
  assert.equal(result.content, "Saved.");
  const expected = [
    // The plan announcement opens the account and is never superseded.
    "I will save the batch.",
    // Its step read a screen the turn had not seen: the stuck sentence after it supersedes nothing.
    "Opening the list.",
    // Superseded "The save button is covered." (the same screen again) and "Trying another way…" (a call the step lacked is
    // refused); it was refused too, and the plan-only step between made no progress either.
    "The list still covers the save button.",
    // Its own step progressed, so it supersedes nothing: the last stuck sentence stays above it.
    "The list is closed; saving now.",
    "The batch is saved.",
  ];
  assert.deepEqual(journalChat(result.events), expected, "after a reload");
  assert.deepEqual(liveChat(live), expected, "live");

  const superseded = result.events.filter((event) => event.type === "assistant/narration-superseded");
  const idOf = (content: string) => (result.events.find((event) => event.type === "assistant/narration" && (event.payload as { content: string }).content === content)!
    .payload as { narrationId: string }).narrationId;
  assert.deepEqual(superseded.map((event) => event.payload), [
    { narrationId: idOf("The save button is covered."), by: idOf("Trying another way to reach it.") },
    { narrationId: idOf("Trying another way to reach it."), by: idOf("The list still covers the save button.") },
  ]);
  assert.deepEqual(live.filter((event) => event.type === "assistant-narration-superseded").map((event) => event.type === "assistant-narration-superseded" && { narrationId: event.narrationId, by: event.by }),
    superseded.map((event) => event.payload), "live says exactly what the journal holds");
  for (const event of superseded) {
    const told = result.events.find((item) => item.type === "assistant/narration" && (item.payload as { narrationId: string }).narrationId === (event.payload as { by: string }).by)!;
    const end = result.events.find((item) => item.seq === event.seq + 1)!;
    assert.equal(event.stepId, told.stepId, "journaled in the step that told the superseding sentence");
    assert.deepEqual([end.type, end.stepId], ["step/end", event.stepId], "in the same append as that step's end, after its calls ran");
  }
  assert.deepEqual(projectTurnWork(result.events)[0]?.narration, { narrationId: idOf("I will save the batch."), content: "I will save the batch." },
    "the account still opens on the announcement");
});

test("three stuck steps alone: the chat keeps the announcement and the last stuck sentence", async () => {
  const { result, live } = await run("narration-stuck-only", [
    calls([plan("p1")], "I will save the batch."),
    calls([{ id: "m1", name: "test_missing", args: {} }], "Looking for the save button."),
    calls([{ id: "m2", name: "test_missing", args: {} }], "The save button is still covered."),
    calls([{ id: "m3", name: "test_missing", args: {} }], "The list still covers the save button."),
    answer("I could not reach the save button."),
  ]);
  const expected = ["I will save the batch.", "The list still covers the save button."];
  assert.deepEqual(journalChat(result.events), expected, "after a reload");
  assert.deepEqual(liveChat(live), expected, "live");
});

test("a step that progressed without a sentence of its own keeps the stuck sentence before it", async () => {
  const { result, live } = await run("narration-silent-progress", [
    calls([plan("p1")], "I will save the batch."),
    calls([{ id: "m1", name: "test_missing", args: {} }], "Looking for the save button."),
    calls([look("l1", "list")]),
    calls([{ id: "m2", name: "test_missing", args: {} }], "The save button is covered."),
    answer("I could not reach the save button."),
  ]);
  const expected = ["I will save the batch.", "Looking for the save button.", "The save button is covered."];
  assert.deepEqual(journalChat(result.events), expected, "after a reload");
  assert.deepEqual(liveChat(live), expected, "live");
});
