import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@0xsyncroot/contracts";
import { ActorPseudonyms, extractTurnFacts, type TurnFactContext } from "../src/index.js";
import { event } from "./review-fixture.js";

const PSEUDONYMS = new ActorPseudonyms("k".repeat(32), "1");
/** The idle instant lies an hour after the fixture turns, so their open turns count as abandoned unless a test moves it. */
const CONTEXT: TurnFactContext = { tenantId: "t1", sessionId: "s1", defaultAgentId: "agent-default", pseudonyms: PSEUDONYMS, idleBefore: "2026-10-01T09:00:00.000Z" };
const facts = (events: readonly SessionEvent[], context = CONTEXT) => extractTurnFacts(events, context);

/** Event at a given second after the fixture's base instant, in turn `turnId`. */
const at = (seq: number, second: number, type: string, payload: unknown, turnId = "turn-1", extra: Partial<SessionEvent> = {}): SessionEvent =>
  event(seq, type, payload, { turnId, occurredAt: new Date(Date.UTC(2026, 9, 1, 8, 0, second)).toISOString(), ...extra });

const userTurn = (): SessionEvent[] => [
  at(1, 0, "turn/start", { inputIdempotencyKey: "k1", runtimeBinding: { tenantId: "t1", agentProfileId: "agent-a", routeRevision: "r", runtimeSnapshotId: "snap-1" } }),
  at(2, 0, "user/input", { content: "hello", source: "external" }),
  at(3, 1, "step/start", { index: 1 }),
  at(4, 3, "assistant/message", { content: null, toolCalls: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] }),
  at(5, 3, "usage/recorded", { providerId: "p", model: "m", inputTokens: 100, outputTokens: 20, totalTokens: 120, reported: true }),
  at(6, 4, "tool/result", { callId: "c1", executionId: "x1", toolId: "a", state: "succeeded", dispatched: true }),
  at(7, 4, "tool/result", { callId: "c2", executionId: "x2", toolId: "b", state: "failed", dispatched: true }),
  at(8, 4, "tool/result", { callId: "c3", executionId: "x3", toolId: "c", state: "denied", dispatched: false }),
  at(9, 5, "step/end", { status: "completed" }),
  at(10, 5, "step/start", { index: 2 }),
  at(11, 7, "assistant/narration", { narrationId: "n1", audience: "user", content: "  " }),
  at(12, 9, "assistant/message", { content: "Here it is." }),
  at(13, 9, "usage/recorded", { providerId: "p", model: "m", inputTokens: 300, outputTokens: 40, totalTokens: 340, reported: true }),
  at(14, 10, "step/end", { status: "completed" }),
  at(15, 12, "turn/end", { status: "completed", steps: 2 }),
];

test("a closed user turn yields one fact with its times, counts and tokens", () => {
  const [fact, ...rest] = facts(userTurn(), CONTEXT);
  assert.equal(rest.length, 0);
  assert.deepEqual(fact, {
    tenantId: "t1", sessionId: "s1", turnId: "turn-1", agentId: "agent-a", channel: "live", releaseId: "00000000-0000-7000-8000-000000000000",
    runtimeSnapshotId: "r", origin: "user", actorKey: PSEUDONYMS.actorKey("t1", "actor-1"), actorKeyVersion: "1",
    startedAt: "2026-10-01T08:00:00.000Z", firstOutputAt: "2026-10-01T08:00:09.000Z", endedAt: "2026-10-01T08:00:12.000Z", status: "completed",
    responseMs: 12000, firstOutputMs: 9000, steps: 2, toolCalls: 3, toolFailed: 1, toolRefused: 1, cards: 0, inputTokens: 400, outputTokens: 60,
    sourceLastSeq: 15,
  });
});

test("first output is the first narration or message with text, the opening narration included", () => {
  const events = userTurn();
  events.splice(2, 0, at(0, 2, "assistant/narration", { narrationId: "opening:turn-1", audience: "user", content: "On it.", opening: true }));
  const renumbered = events.map((item, index) => ({ ...item, seq: index + 1 }));
  assert.equal(facts(renumbered, CONTEXT)[0]?.firstOutputMs, 2000);
});

test("a draft the review sent back is no output: first output is the accepted answer the user saw", () => {
  const events: SessionEvent[] = [
    at(1, 0, "turn/start", { inputIdempotencyKey: "k1" }),
    at(2, 2, "assistant/message", { content: "Draft answer.", toolCalls: [] }),
    at(3, 4, "assistant/message", { content: "Calling.", toolCalls: [{ id: "c1" }] }),
    at(4, 6, "assistant/message", { content: "Over budget.", finishReason: "step-budget" }),
    at(5, 8, "assistant/message", { content: "Accepted answer." }),
    at(6, 9, "turn/end", { status: "completed" }),
  ];
  assert.equal(facts(events)[0]?.firstOutputMs, 8000, "a sent-back draft, a message with calls and a step-budget cut are not shown");
  const narrated = [...events.slice(0, 2), at(0, 3, "assistant/narration", { narrationId: "n1", audience: "user", content: "Checking." }), ...events.slice(2)]
    .map((item, index) => ({ ...item, seq: index + 1 }));
  assert.equal(facts(narrated)[0]?.firstOutputMs, 3000, "a narration with text is shown when it is journaled");
  const unanswered = events.filter((item) => item.seq !== 5);
  assert.equal(facts(unanswered)[0]?.firstOutputAt, undefined, "a turn whose last message is cut by the step budget showed no answer");
});

test("a turn without text has no first output, and an awaiting turn counts its card", () => {
  const events: SessionEvent[] = [
    at(1, 0, "turn/start", { inputIdempotencyKey: "k1" }),
    at(2, 1, "assistant/message", { content: "", toolCalls: [{ id: "c1" }] }),
    at(3, 2, "approval/requested", { approvalId: "a1" }),
    at(4, 3, "turn/end", { status: "awaiting_approval" }),
  ];
  const [fact] = facts(events, CONTEXT);
  assert.equal(fact?.firstOutputAt, undefined);
  assert.equal(fact?.firstOutputMs, undefined);
  assert.equal(fact?.status, "awaiting_approval");
  assert.equal(fact?.cards, 1);
  assert.equal(fact?.agentId, "agent-default", "a turn without a runtime binding belongs to the stream's agent");
});

test("a resume is its own turn with origin continuation; a failed turn is status failed", () => {
  const events: SessionEvent[] = [
    ...userTurn(),
    at(20, 30, "turn/start", { inputIdempotencyKey: "k2", continuation: { pauseKind: "approval", pauseId: "a1", fromTurnId: "turn-1", rootTurnId: "turn-1" } }, "turn-2"),
    at(21, 31, "interaction/requested", { interactionId: "i1" }, "turn-2"),
    at(22, 35, "turn/failed", { code: "boom", message: "x", retryable: false }, "turn-2"),
  ];
  const found = facts(events, CONTEXT);
  assert.deepEqual(found.map((fact) => [fact.turnId, fact.origin, fact.status, fact.responseMs, fact.cards]),
    [["turn-1", "user", "completed", 12000, 0], ["turn-2", "continuation", "failed", 5000, 1]]);
  assert.equal(found[1]?.sourceLastSeq, 22);
});

test("a close without a start and events without a turn yield nothing", () => {
  const events: SessionEvent[] = [
    at(3, 2, "turn/end", { status: "completed" }, "orphan"),
    (({ turnId: _turnId, ...rest }) => rest)(at(4, 3, "user/input", { content: "x", source: "test" })),
  ];
  assert.deepEqual(facts(events), []);
});

test("a turn without a close whose last event is past the threshold is abandoned at that event, with no response time", () => {
  const events: SessionEvent[] = [
    ...userTurn(),
    at(20, 30, "turn/start", { inputIdempotencyKey: "k2" }, "turn-2"),
    at(21, 33, "assistant/narration", { narrationId: "n", audience: "user", content: "Working." }, "turn-2"),
    at(22, 35, "tool/result", { callId: "c", executionId: "x", toolId: "a", state: "outcome_unknown" }, "turn-2"),
  ];
  const abandoned = facts(events).find((fact) => fact.turnId === "turn-2");
  assert.equal(abandoned?.status, "abandoned");
  assert.equal(abandoned?.endedAt, "2026-10-01T08:00:35.000Z");
  assert.equal(abandoned?.responseMs, undefined);
  assert.equal(abandoned?.firstOutputMs, 3000);
  assert.equal(abandoned?.toolFailed, 1);
  assert.equal(abandoned?.sourceLastSeq, 22);
});

test("a turn without a close whose last event is within the threshold is open at that event; the turn's own last event decides", () => {
  const events: SessionEvent[] = [
    ...userTurn(),
    at(20, 30, "turn/start", { inputIdempotencyKey: "k2" }, "turn-2"),
    at(21, 31, "turn/start", { inputIdempotencyKey: "k3" }, "turn-3"),
    at(22, 32, "turn/end", { status: "completed" }, "turn-3"),
  ];
  const young = facts(events, { ...CONTEXT, idleBefore: "2026-10-01T08:00:30.000Z" });
  assert.deepEqual(young.map((fact) => [fact.turnId, fact.status]), [["turn-1", "completed"], ["turn-2", "open"], ["turn-3", "completed"]]);
  const open = young.find((fact) => fact.turnId === "turn-2");
  assert.equal(open?.endedAt, "2026-10-01T08:00:30.000Z");
  assert.equal(open?.responseMs, undefined);
  assert.equal(open?.sourceLastSeq, 20);
  assert.equal(facts(events, { ...CONTEXT, idleBefore: "2026-10-01T08:00:30.001Z" }).find((fact) => fact.turnId === "turn-2")?.status,
    "abandoned", "a newer event of another turn does not keep this one open");
});

test("only the first close of a turn counts, and the same events give the same facts in any order", () => {
  const events = [...userTurn(), at(16, 40, "turn/end", { status: "partial" })];
  const forward = facts(events, CONTEXT);
  assert.equal(forward[0]?.status, "completed");
  assert.equal(forward[0]?.endedAt, "2026-10-01T08:00:12.000Z");
  assert.equal(forward[0]?.sourceLastSeq, 15);
  assert.deepEqual(facts([...events].reverse(), CONTEXT), forward);
});

test("the actor is the turn's own actor, and an encrypted message is not counted as output", () => {
  const events = userTurn().map((item) => (item.seq === 1 ? { ...item, actorId: "actor-2" } : item));
  const sealed = events.map((item) => (item.seq === 12 ? { ...item, payload: { _protected: "gateway-envelope-v1", algorithm: "A256GCM", keyId: "k", nonce: "n", ciphertext: "c", tag: "t" } as SessionEvent["payload"] } : item));
  const [fact] = facts(sealed, CONTEXT);
  assert.equal(fact?.actorKey, PSEUDONYMS.actorKey("t1", "actor-2"));
  assert.equal(fact?.firstOutputAt, undefined);
});
