import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@0xsyncroot/contracts";
import { PublicAgentStreamWriter } from "../src/public-agent-stream.js";
import { visibleMessages } from "../src/history-view.js";

// Only a step that ran without progress drops the stuck sentence before it. Core
// journals and sends which narration left the chat; these boundaries let the two ids through live and leave it out on reload.

test("a superseded frame crosses with its two public ids and nothing else", () => {
  const published: { event: string; payload: Record<string, unknown> }[] = [];
  const writer = new PublicAgentStreamWriter((event, payload) => published.push({ event, payload: payload as Record<string, unknown> }));
  writer.narration({ type: "assistant-narration-superseded", turnId: "turn", narrationId: "n-1", audience: "user", by: "n-2" });
  writer.narration({ type: "assistant-narration-superseded", turnId: "turn", narrationId: "n-2", audience: "user", by: "not public id" });
  writer.narration({ type: "assistant-narration-superseded", turnId: "turn", narrationId: "not public id", audience: "user", by: "n-3" });
  assert.deepEqual(published, [{ event: "assistant-narration-superseded",
    payload: { type: "assistant-narration-superseded", turnId: "turn", narrationId: "n-1", audience: "user", by: "n-2" } }],
  "the client drops n-1; an id the client would refuse never crosses");
});

test("history leaves a superseded narration out of the list and the timeline, keeping each kept one's id", () => {
  const event = (type: string, payload: unknown, seq: number, turnId = "turn") =>
    ({ type, payload, seq, turnId, stepId: `step-${seq}`, sessionId: "s", occurredAt: "2026-10-19T00:00:00.000Z" }) as SessionEvent;
  const events = [event("turn/start", {}, 1), event("user/input", { content: "lập đợt chi trả" }, 2),
    event("assistant/narration", { narrationId: "n-0", audience: "user", content: "Em sẽ lập đợt chi trả." }, 3),
    event("assistant/narration", { narrationId: "n-1", audience: "user", content: "Em tìm nút Lưu." }, 4),
    event("assistant/narration", { narrationId: "n-2", audience: "user", content: "Nút Lưu vẫn bị che." }, 5),
    event("assistant/narration-superseded", { narrationId: "n-1", by: "n-2" }, 6),
    event("assistant/narration", { narrationId: "n-3", audience: "user", content: "Em đóng danh sách rồi bấm Lưu." }, 7),
    event("assistant/message", { content: "Đã lưu.", toolCalls: [] }, 8), event("turn/end", { status: "completed" }, 9),
    // Another turn's event drops nothing here.
    event("assistant/narration-superseded", { narrationId: "n-3", by: "n-9" }, 10, "other-turn")];
  const assistant = visibleMessages(events).find((message) => message.role === "assistant") as
    { narrations: Record<string, unknown>[]; work: { timeline: Record<string, unknown>[] } };
  assert.deepEqual(assistant.narrations.map((narration) => narration.narrationId), ["n-0", "n-2", "n-3"]);
  assert.deepEqual(assistant.work.timeline.filter((item) => item.type === "narration").map((item) => item.narrationId), ["n-0", "n-2", "n-3"]);
});
