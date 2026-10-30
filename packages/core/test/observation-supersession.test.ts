import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue, SessionEvent, ToolDefinition } from "@0xsyncroot/contracts";
import { ConversationProjector } from "../src/agent/conversation-projector.js";
import { supersessionOf } from "../src/agent/observation-supersession.js";
import { security } from "./turn-harness.js";

/**
 * A screen task makes a dozen observations of the same screen, each the size of a screen; only the
 * newest can be acted on. Each test states what the model must still be able to read.
 */
const SCREEN = (n: number): JsonValue => ({ status: "succeeded", data: { screen: "salary", nodes: Array.from({ length: 50 }, (_, i) => `row ${n}.${i}`) } });
const OBSERVES: ToolDefinition["observes"] = { channel: "screen", condense: (result) => {
  const r = result as { status: string; data?: { screen?: string; nodes?: unknown } };
  return r.data?.nodes ? { status: r.status, screen: r.data.screen ?? null } : undefined;
} };

function session(calls: readonly { readonly id: string; readonly result?: JsonValue; readonly observed?: boolean }[]) {
  const events: SessionEvent[] = [];
  const owner = security();
  const add = (type: string, envelope: Record<string, string>, payload: Record<string, unknown>) => events.push({
    eventId: `event-${events.length + 1}`, sessionId: "s", seq: events.length + 1, type, schemaVersion: 1, occurredAt: new Date(0).toISOString(),
    recordedAt: new Date(0).toISOString(), tenantId: owner.tenantId, actorId: owner.actorId, correlationId: owner.correlationId,
    runtimeSnapshotId: "rt", classification: "internal", payload, integrityHash: `h${events.length}`, turnId: "t", ...envelope,
  } as SessionEvent);
  add("turn/start", {}, { inputIdempotencyKey: "t" });
  add("user/input", {}, { content: "Mở tháng 9", source: "external" });
  for (const call of calls) {
    add("assistant/message", { stepId: call.id }, { content: null, toolCalls: [{ id: call.id, name: "ui_view", arguments: "{}" }] });
    const tool = { id: "ui_view", observes: call.observed === false ? undefined : OBSERVES } as unknown as ToolDefinition;
    add("tool/result", { stepId: call.id, callId: call.id }, { callId: call.id, toolId: "ui_view", state: "succeeded", dispatched: true,
      ...(call.result !== undefined ? { result: call.result } : {}), ...supersessionOf(tool, call.result) });
  }
  return events;
}
const toolTexts = (events: SessionEvent[]) => new ConversationProjector().project(events).filter((m) => m.role === "tool").map((m) => m.content as string);

test("older observations of a channel are read short, and the newest stays whole", () => {
  const texts = toolTexts(session([{ id: "a", result: SCREEN(1) }, { id: "b", result: SCREEN(2) }, { id: "c", result: SCREEN(3) }]));
  assert.equal(texts.length, 3);
  for (const old of texts.slice(0, 2)) {
    assert.match(old, /Older observation of the screen/u);
    assert.ok(old.length < 400, `a superseded observation is a few lines, not a screen (${old.length} chars)`);
    assert.doesNotMatch(old, /row \d\.\d/u);
  }
  assert.match(texts[0]!, /"status":"succeeded"/u, "what happened is kept");
  assert.match(texts[2]!, /row 3\.49/u, "the newest observation is whole");
});

test("a result with no observation neither replaces nor is replaced", () => {
  const texts = toolTexts(session([{ id: "a", result: SCREEN(1) }, { id: "b", result: { status: "refused", reasonCode: "target-covered" } }]));
  assert.match(texts[0]!, /row 1\.49/u, "a refused call that saw nothing does not hide the last screen the model saw");
  assert.match(texts[1]!, /target-covered/u);
});

test("a tool that declares no channel is never shortened", () => {
  const texts = toolTexts(session([{ id: "a", result: SCREEN(1), observed: false }, { id: "b", result: SCREEN(2), observed: false }]));
  assert.match(texts[0]!, /row 1\.49/u);
  assert.match(texts[1]!, /row 2\.49/u);
});

test("the journal keeps every observation whole; only the model's reading is short", () => {
  const events = session([{ id: "a", result: SCREEN(1) }, { id: "b", result: SCREEN(2) }]);
  const first = events.find((event) => event.type === "tool/result")!;
  assert.match(JSON.stringify((first.payload as { result: JsonValue }).result), /row 1\.49/u);
});
