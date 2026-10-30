import assert from "node:assert/strict";
import test from "node:test";
import { buildTranscript, compilePersonalFields, type PersonalFieldConfig, type TranscriptWording } from "../src/index.js";
import { event } from "./review-fixture.js";

const FIELDS = compilePersonalFields({
  labels: { "person-name": "Name", money: "Amount", identifier: "Code", coefficient: "Rate" },
  money: { atLeast: 10000 },
  names: { honorifics: [], minWords: 2 },
  tools: { profile: { paths: { "data.FullName": "person-name", "data.Salary": "money" } } },
} satisfies PersonalFieldConfig);
const WORDING: TranscriptWording = {
  toolLabels: { profile: "Read profile" }, failure: { default: "The turn failed.", codes: { cancelled: "Stopped." } }, encrypted: "Content is encrypted.",
};

test("the transcript shows what the chat showed, in journal order", () => {
  const built = buildTranscript([
    event(1, "turn/start", {}),
    event(2, "user/input", { content: "Salary of Lê Văn Nam?", source: "external" }),
    event(3, "assistant/narration", { narrationId: "n1", audience: "user", content: "Looking it up." }),
    event(4, "assistant/narration", { narrationId: "n2", audience: "user", content: "draft words", draft: true }),
    event(5, "assistant/narration", { narrationId: "n3", audience: "user", content: "taken back" }),
    event(6, "assistant/message", { content: "Looking it up.", toolCalls: [{ id: "c1" }] }),
    event(7, "tool/result", { toolId: "profile", callId: "c1", result: { data: { FullName: "Lê Văn Nam", Salary: 12500000, Note: "secret note" } } }),
    event(8, "tool/result", { toolId: "profile", callId: "c2", result: {} }),
    event(9, "tool/result", { toolId: "other", callId: "c3", result: { text: "raw" } }),
    event(10, "assistant/narration-superseded", { narrationId: "n3", by: "n1" }),
    event(11, "assistant/message", { content: "Sent back draft: 12.500.000" }),
    event(12, "assistant/message", { content: "Lê Văn Nam earns 12.500.000 đ." }),
    event(13, "turn/start", {}, { turnId: "turn-2", occurredAt: "2026-10-01T09:00:00.000Z" }),
    event(14, "user/input", { content: { ciphertext: "x" }, source: "external" }, { turnId: "turn-2" }),
    event(15, "turn/failed", { code: "cancelled", message: "SQL error at row 3" }, { turnId: "turn-2" }),
  ], FIELDS, WORDING);
  assert.deepEqual(built.entries.map((entry) => [entry.entrySeq, entry.role, entry.body, entry.answerIndex ?? null]), [
    [2, "user", "Salary of [Name 1]?", null],
    [3, "assistant", "Looking it up.", null],
    [7, "tool", "", null],
    [12, "assistant", "[Name 1] earns [Amount 1] đ.", 1],
    [15, "system", "Stopped.", null],
  ]);
  assert.deepEqual(built.entries[2]?.toolLabels, [{ toolId: "profile", label: "Read profile" }, { toolId: "other", label: "other" }]);
  assert.equal(built.answers, 1);
  assert.equal(built.startedAt, "2026-10-01T08:00:01.000Z");
  assert.equal(built.lastTurnAt, "2026-10-01T09:00:00.000Z");
  assert.equal(built.entries[3]?.maskedValues, 2);
  assert.match(built.entries[2]?.sourceHash ?? "", /^[0-9a-f]{64}$/u);
  const all = JSON.stringify(built);
  for (const hidden of ["secret note", "raw", "draft words", "taken back", "SQL error", "Sent back"]) assert.ok(!all.includes(hidden), hidden);
});

test("a run of calls is split per turn and a turn ending on a tool call shows no answer", () => {
  const built = buildTranscript([
    event(1, "tool/result", { toolId: "profile", result: {} }),
    event(2, "tool/result", { toolId: "profile", result: {} }, { turnId: "turn-2" }),
    event(3, "assistant/message", { content: "calling", toolCalls: [{ id: "c" }] }, { turnId: "turn-2" }),
    event(4, "assistant/message", { content: "stopped", finishReason: "step-budget" }, { turnId: "turn-3" }),
    event(5, "tool/result", { toolId: "profile", bestEffort: true, skipped: "failed", result: {} }, { turnId: "turn-3" }),
  ], FIELDS, WORDING);
  assert.deepEqual(built.entries.map((entry) => [entry.entrySeq, entry.turnId, entry.role]), [[1, "turn-1", "tool"], [2, "turn-2", "tool"]]);
  assert.equal(built.answers, 0);
});

test("the same journal builds the same entries", () => {
  const events = [event(1, "user/input", { content: "hello", source: "external" }), event(2, "assistant/message", { content: "hi" })];
  assert.deepEqual(buildTranscript(events, FIELDS, WORDING), buildTranscript([...events].reverse(), FIELDS, WORDING));
});

test("an encrypted event shows the product's sentence in its place and nothing of the envelope", () => {
  const sealed = (keyId: string) => ({ _protected: "gateway-envelope-v1", algorithm: "A256GCM", keyId, nonce: "bm9uY2U=", ciphertext: `c2VjcmV0-${keyId}`, tag: "dGFn" });
  const built = buildTranscript([
    event(1, "turn/start", sealed("k1")),
    event(2, "user/input", sealed("k2")),
    event(3, "assistant/narration", sealed("k3")),
    event(4, "assistant/message", sealed("k4")),
    event(5, "tool/result", sealed("k5")),
    event(6, "assistant/message", sealed("k6")),
    event(7, "user/input", { content: "Salary of Lê Văn Nam?", source: "external" }, { turnId: "turn-2" }),
    event(8, "tool/result", { toolId: "profile", result: { data: { FullName: "Lê Văn Nam" } } }, { turnId: "turn-2" }),
    event(9, "assistant/message", { content: "Lê Văn Nam is on file." }, { turnId: "turn-2" }),
    event(10, "turn/failed", sealed("k10"), { turnId: "turn-3" }),
  ], FIELDS, WORDING);
  assert.deepEqual(built.entries.map((entry) => [entry.entrySeq, entry.role, entry.body, entry.answerIndex ?? null, entry.maskedValues]), [
    [2, "user", "Content is encrypted.", null, 0],
    [6, "assistant", "Content is encrypted.", null, 0],
    [7, "user", "Salary of [Name 1]?", null, 1],
    [8, "tool", "", null, 0],
    [9, "assistant", "[Name 1] is on file.", 1, 1],
    [10, "system", "The turn failed.", null, 0],
  ]);
  assert.equal(built.answers, 1, "an encrypted message is not counted as an answer: whether the chat showed it is unknown");
  assert.ok(!JSON.stringify(built).includes("c2VjcmV0"), "no ciphertext leaves the builder");
});
