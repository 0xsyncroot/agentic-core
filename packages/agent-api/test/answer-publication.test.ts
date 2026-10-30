import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@0xsyncroot/contracts";
import { PublicAgentStreamWriter } from "../src/public-agent-stream.js";
import { visibleMessages } from "../src/history-view.js";
import { resultPayload } from "../src/result-payload.js";

const channel = { turnId: "turn", outputId: "draft", audience: "user" as const };
const narration = { turnId: "turn", narrationId: "draft", audience: "user" as const };
function recording() {
  const published: { event: string; payload: any }[] = [];
  const writer = new PublicAgentStreamWriter((event, payload) => published.push({ event, payload }));
  const narrated = () => published.filter((e) => e.event === "assistant-narration-delta").map((e) => e.payload.delta).join("");
  return { published, writer, narrated };
}

test("an answer streams as it is written, and a draft kept as narration stays on the wire under its own id", () => {
  const { published, writer, narrated } = recording();
  writer.output({ type: "assistant-output-start", ...channel });
  writer.output({ type: "assistant-output-delta", ...channel, delta: "Em đã nhặt " });
  assert.deepEqual(published.map((e) => e.event), ["assistant-output-start", "assistant-output-delta"], "nothing is held back until review");
  writer.output({ type: "assistant-output-delta", ...channel, delta: "xong danh mục." });
  // Core's frames for a kept draft: narration under the draft's id, then the draft's own end.
  writer.narration({ type: "assistant-narration-start", ...narration });
  for (const delta of ["Em đã nhặt xong danh mục. <|chan", "nel>thought private reasoning<chan", "nel|> Đọc tiếp."]) {
    writer.narration({ type: "assistant-narration-delta", ...narration, delta });
  }
  writer.narration({ type: "assistant-narration-end", ...narration, status: "completed" });
  writer.output({ type: "assistant-output-end", ...channel, status: "discarded" });
  assert.deepEqual(published.slice(-2).map((e) => [e.event, e.payload.status]), [["assistant-narration-end", "completed"], ["assistant-output-end", "discarded"]]);
  assert.equal(narrated(), "Em đã nhặt xong danh mục.  Đọc tiếp.");
  assert.doesNotMatch(JSON.stringify(published), /private reasoning|channel>/);
});

test("a narration longer than 20 000 characters is cut with an ellipsis and completed, never discarded", () => {
  const { published, writer, narrated } = recording();
  writer.narration({ type: "assistant-narration-start", ...narration });
  // A kept draft arrives as one delta; a streamed narration arrives in many. Both meet the bound mid-delta.
  writer.narration({ type: "assistant-narration-delta", ...narration, delta: "a".repeat(6_000) });
  assert.equal(narrated().length, 6_000, "a 6 000-character draft crosses whole");
  writer.narration({ type: "assistant-narration-delta", ...narration, delta: "b".repeat(19_000) });
  writer.narration({ type: "assistant-narration-delta", ...narration, delta: "c".repeat(500) });
  writer.narration({ type: "assistant-narration-end", ...narration, status: "completed" });
  assert.equal(narrated().length, 20_000);
  assert.equal(narrated(), `${"a".repeat(6_000)}${"b".repeat(13_999)}…`);
  assert.deepEqual(published.filter((e) => e.event === "assistant-narration-end").map((e) => e.payload.status), ["completed"]);
  assert.equal(published.filter((e) => e.event === "assistant-narration-delta").length, 2, "nothing follows the cut");

  const single = recording();
  single.writer.narration({ type: "assistant-narration-start", ...narration });
  single.writer.narration({ type: "assistant-narration-delta", ...narration, delta: "x".repeat(25_000) });
  single.writer.narration({ type: "assistant-narration-end", ...narration, status: "completed" });
  assert.equal(single.narrated(), `${"x".repeat(19_999)}…`);
  assert.deepEqual(single.published.at(-1)?.payload.status, "completed");
  // Exactly at the bound nothing is cut, and a pair split by the cut is dropped whole.
  const exact = recording();
  exact.writer.narration({ type: "assistant-narration-start", ...narration });
  exact.writer.narration({ type: "assistant-narration-delta", ...narration, delta: "y".repeat(20_000) });
  assert.equal(exact.narrated(), "y".repeat(20_000));
  const pair = recording();
  pair.writer.narration({ type: "assistant-narration-start", ...narration });
  pair.writer.narration({ type: "assistant-narration-delta", ...narration, delta: `${"z".repeat(19_998)}😀😀` });
  assert.equal(pair.narrated(), `${"z".repeat(19_998)}…`);
});

test("an answer past the output bound is still ended discarded, and a cancelled stream ends its drafts", () => {
  const { published, writer } = recording();
  writer.output({ type: "assistant-output-start", ...channel });
  writer.output({ type: "assistant-output-delta", ...channel, delta: "x".repeat(256_001) });
  assert.deepEqual(published.map((e) => [e.event, e.payload.status]), [["assistant-output-start", undefined], ["assistant-output-end", "discarded"]]);
  writer.output({ type: "assistant-output-start", ...channel });
  writer.output({ type: "assistant-output-delta", ...channel, delta: "pending" });
  writer.discardOutputs();
  writer.output({ type: "assistant-output-end", ...channel, status: "completed" });
  assert.deepEqual(published.slice(-1).map((e) => [e.event, e.payload.status]), [["assistant-output-end", "discarded"]], "ended once, as discarded");
});

test("history and replay remove old private blocks without changing source events or user quotes", () => {
  const raw = "<|channel>thought private planning<channel|>Em đã đọc biểu.";
  const event = (type: string, payload: unknown, seq: number) => ({ type, payload, seq, turnId: "turn", sessionId: "s", occurredAt: "2026-10-08T00:00:00.000Z" }) as SessionEvent;
  const events = [event("turn/start", {}, 1), event("user/input", { content: raw }, 2),
    event("assistant/narration", { narrationId: "n", audience: "user", content: raw }, 3),
    event("assistant/message", { content: raw, toolCalls: [] }, 4), event("turn/end", { status: "completed" }, 5)];
  const before = JSON.stringify(events);
  const messages = visibleMessages(events);
  assert.equal(messages[0]!.content, raw, "user-provided text is unchanged");
  assert.equal(messages[1]!.content, "Em đã đọc biểu.");
  assert.doesNotMatch(JSON.stringify(messages[1]), /private planning|channel>/);
  assert.equal(JSON.stringify(events), before, "journal and integrity hashes stay untouched");
  const result = resultPayload({ content: raw, events, turnId: "turn", sessionId: "s", outcome: "completed" } as never, performance.now());
  assert.equal(result.content, "Em đã đọc biểu.");
});

test("a reloaded turn says what the live stream said: a failure by its reason, a budget stop by the product's sentence", () => {
  const event = (type: string, payload: unknown, seq: number, turnId = "turn") => ({ type, payload, seq, turnId, sessionId: "s", occurredAt: "2026-10-08T00:00:00.000Z" }) as SessionEvent;
  const messages = { generic: "Có lỗi.", byCode: { permanent: "Không xử lý được yêu cầu." }, byReason: { "dependency-unavailable": "Dịch vụ đọc tài liệu đang không kết nối được." },
    emptyAnswer: { stopped: "Em đã dừng ở giới hạn xử lý của một lượt." } } as never;
  const failed = [event("turn/start", {}, 1), event("user/input", { content: "đọc hồ sơ" }, 2),
    event("turn/failed", { code: "permanent", reason: "dependency-unavailable", message: "MCP connection unavailable" }, 3)];
  assert.equal(visibleMessages(failed, { businessMessages: messages }).at(-1)!.content, "Dịch vụ đọc tài liệu đang không kết nối được.", "the reason's sentence, as live");
  assert.deepEqual(visibleMessages(failed, { businessMessages: messages }).at(-1)!.failure, { code: "permanent" }, "the classified code crosses as structure");
  const cancelled = [event("turn/start", {}, 1), event("user/input", { content: "đọc hồ sơ" }, 2), event("turn/failed", { code: "cancelled", message: "Operation cancelled" }, 3)];
  assert.deepEqual(visibleMessages(cancelled).at(-1)!.failure, { code: "cancelled" }, "a user's stop is told apart without reading its sentence");
  assert.doesNotMatch(JSON.stringify(visibleMessages(cancelled)), /Operation cancelled/, "the runtime's message never crosses");
  // The budget took a step's tool calls away: the journaled text is the runtime's transcript note, never an answer.
  const stopped = [event("turn/start", {}, 1), event("user/input", { content: "đọc hồ sơ" }, 2),
    event("assistant/message", { content: "The turn reached its execution budget before a final answer could be produced.", toolCalls: [], finishReason: "step-budget" }, 3),
    event("turn/end", { status: "partial" }, 4)];
  assert.equal(visibleMessages(stopped, { businessMessages: messages }).at(-1)!.content, "Em đã dừng ở giới hạn xử lý của một lượt.");
  assert.equal(visibleMessages(stopped, { businessMessages: messages }).at(-1)!.failure, undefined, "a turn that ended is no failure");
  assert.doesNotMatch(JSON.stringify(visibleMessages(stopped)), /execution budget/, "no product sentence still never shows the runtime's English note");
});
