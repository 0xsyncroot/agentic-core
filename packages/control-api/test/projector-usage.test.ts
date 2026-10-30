import assert from "node:assert/strict";
import test from "node:test";
import { AgenticError, type ChangedSession, type SessionEvent } from "@0xsyncroot/contracts";
import { ActorPseudonyms, compilePersonalFields, projectorRevision, ReviewProjector, type PersonalFieldConfig, type TranscriptWording } from "../src/index.js";
import { event, MemoryJournal, MemoryLeases, MemoryReview } from "./review-fixture.js";
import { MemoryUsage } from "./usage-fixture.js";

const CONFIG: PersonalFieldConfig = { labels: { "person-name": "Name", money: "Amount", identifier: "Code", coefficient: "Rate" }, money: { atLeast: 10000 }, names: { honorifics: [], minWords: 2 }, tools: {} };
const WORDING: TranscriptWording = { toolLabels: {}, failure: { default: "failed" }, encrypted: "sealed" };
const PSEUDONYMS = new ActorPseudonyms("k".repeat(32), "1");
const REVISION = projectorRevision(CONFIG, WORDING, PSEUDONYMS.keyFingerprint);

const HOUR = 3_600_000;
/** Long after the fixture streams went quiet, so their open turns count as abandoned. */
const LATER = "2026-10-01T12:00:00.000Z";

function rig(revision = REVISION, shared?: { journal: MemoryJournal; leases: MemoryLeases; review: MemoryReview; usage: MemoryUsage }) {
  const leases = shared?.leases ?? new MemoryLeases();
  const journal = shared?.journal ?? new MemoryJournal();
  const review = shared?.review ?? new MemoryReview(leases);
  const usage = shared?.usage ?? new MemoryUsage(leases);
  const clock = { now: LATER };
  const projector = new ReviewProjector({
    projectorId: "review", revision, owner: "worker-1", leaseTtlMs: 60000, defaultAgentId: "agent-default", pseudonyms: PSEUDONYMS,
    fields: compilePersonalFields(CONFIG), wording: WORDING, abandonAfterMs: HOUR, now: () => new Date(clock.now),
  });
  return { journal, leases, review, usage, clock, run: () => projector.runOnce({ journal, projection: review, query: review, leases, usage }) };
}

const changed = (sessionId: string, currentSeq: number, lastAppendedAt: string, agentProfileId: string | null = null): ChangedSession =>
  ({ tenantId: "t1", sessionId, ownerActorId: "actor-1", agentProfileId, currentSeq, lastAppendedAt });

/** A closed user turn, a paused turn and its closed resume, then a turn still open; events one second apart. */
const stream = (sessionId: string): SessionEvent[] => [
  event(1, "turn/start", { inputIdempotencyKey: "k1" }, { sessionId }),
  event(2, "user/input", { content: "hello", source: "external" }, { sessionId }),
  event(3, "assistant/message", { content: "Hi." }, { sessionId }),
  event(4, "turn/end", { status: "completed" }, { sessionId }),
  event(5, "turn/start", { inputIdempotencyKey: "k2" }, { sessionId, turnId: "turn-2" }),
  event(6, "approval/requested", { approvalId: "a1" }, { sessionId, turnId: "turn-2" }),
  event(7, "turn/end", { status: "awaiting_approval" }, { sessionId, turnId: "turn-2" }),
  event(8, "turn/start", { inputIdempotencyKey: "k3", continuation: { pauseKind: "approval", pauseId: "a1" } }, { sessionId, turnId: "turn-3" }),
  event(9, "turn/end", { status: "completed" }, { sessionId, turnId: "turn-3" }),
  event(10, "turn/start", { inputIdempotencyKey: "k4" }, { sessionId, turnId: "turn-4" }),
];

test("a projected stream saves one fact per turn under the run's revision, its agent the stream's; an idle open turn is abandoned", async () => {
  const { journal, review, usage, run } = rig();
  journal.put(changed("s1", 10, "2026-10-01T08:00:00.000Z", "agent-a"), stream("s1"));
  await run();
  assert.deepEqual([...usage.facts.keys()], ["t1|s1|turn-1", "t1|s1|turn-2", "t1|s1|turn-3", "t1|s1|turn-4"]);
  assert.deepEqual([...usage.facts.values()].map((fact) => [fact.agentId, fact.origin, fact.status, fact.cards]), [
    ["agent-a", "user", "completed", 0], ["agent-a", "user", "awaiting_approval", 1], ["agent-a", "continuation", "completed", 0],
    ["agent-a", "user", "abandoned", 0],
  ]);
  assert.equal(usage.facts.get("t1|s1|turn-4")?.responseMs, undefined);
  assert.deepEqual(new Set(usage.revisions.values()), new Set([REVISION]));
  assert.equal(review.cursors.get("t1|s1|review")?.projectedSeq, 10);
});

test("a young open turn is saved as open, and a later run closes it as abandoned without any new event", async () => {
  const { journal, review, usage, clock, run } = rig();
  journal.put(changed("s1", 10, "2026-10-01T08:00:10.000Z"), stream("s1"));
  clock.now = "2026-10-01T08:30:00.000Z";
  await run();
  const open = usage.facts.get("t1|s1|turn-4");
  assert.equal(open?.status, "open");
  assert.equal(open?.endedAt, "2026-10-01T08:00:10.000000Z", "an open turn stands at its own last event");
  assert.equal(review.cursors.get("t1|s1|review")?.projectedSeq, 10, "the cursor passes the open turn");
  assert.equal((await usage.overview({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" })).turns, 2,
    "statistics skip the open turn");
  const saves = usage.saves;
  clock.now = "2026-10-01T09:00:10.000Z";
  await run();
  assert.equal(usage.facts.get("t1|s1|turn-4")?.status, "open", "exactly the threshold is not past it");
  clock.now = "2026-10-01T09:00:10.001Z";
  await run();
  assert.equal(usage.saves, saves, "the stream is not read again");
  assert.deepEqual(usage.facts.get("t1|s1|turn-4"), { ...open, status: "abandoned" });
});

test("the sweep closes a hung turn of a stream never stamped, once a watermark exists", async () => {
  const { journal, usage, clock, run } = rig();
  journal.put({ ...changed("old", 10, "2026-10-01T08:00:10.000Z"), lastAppendedAt: null }, stream("old"));
  clock.now = "2026-10-01T08:30:00.000Z";
  await run();
  assert.equal(usage.facts.get("t1|old|turn-4")?.status, "open");
  journal.put(changed("busy", 9, "2026-10-01T08:40:00.000Z"), stream("busy").slice(0, 9));
  clock.now = "2026-10-01T09:30:00.000Z";
  await run();
  assert.equal(usage.facts.get("t1|old|turn-4")?.status, "abandoned", "the stamp walk never lists this stream");
});

test("a turn/end appended later replaces the open fact", async () => {
  const { journal, usage, clock, run } = rig();
  const events = stream("s1");
  journal.put(changed("s1", 10, "2026-10-01T08:00:10.000Z"), events);
  clock.now = "2026-10-01T08:05:00.000Z";
  await run();
  assert.equal(usage.facts.get("t1|s1|turn-4")?.status, "open");
  events.push(event(11, "assistant/message", { content: "Done." }, { turnId: "turn-4" }), event(12, "turn/end", { status: "completed" }, { turnId: "turn-4" }));
  journal.put(changed("s1", 12, "2026-10-01T08:00:12.000Z"), events);
  await run();
  assert.equal(usage.facts.get("t1|s1|turn-4")?.status, "completed");
  assert.equal(usage.facts.get("t1|s1|turn-4")?.responseMs, 2000);
  clock.now = "2026-10-01T10:00:00.000Z";
  await run();
  assert.equal(usage.facts.get("t1|s1|turn-4")?.status, "completed", "the sweep touches open facts only");
});

test("the sweep pages through every old open fact of the shard and leaves young ones open", async () => {
  const { journal, usage, clock, run } = rig();
  journal.put(changed("s1", 10, "2026-10-01T08:00:10.000Z"), stream("s1"));
  clock.now = "2026-10-01T08:30:00.000Z";
  await run();
  const template = usage.facts.get("t1|s1|turn-4");
  assert.ok(template);
  for (let index = 0; index < 600; index += 1) usage.facts.set(`t1|bulk|turn-${index}`, { ...template, sessionId: "bulk", turnId: `turn-${index}` });
  usage.facts.set("t1|young|turn-1", { ...template, sessionId: "young", turnId: "turn-1", endedAt: "2026-10-01T11:30:00.000000Z" });
  clock.now = LATER;
  assert.equal((await run()).completed, true);
  assert.equal(usage.abandons, 601);
  assert.equal(usage.facts.get("t1|young|turn-1")?.status, "open");
});

test("a sweep that lost the lease abandons nothing and the run reports it was cut short", async () => {
  const { journal, leases, usage, clock, run } = rig();
  journal.put(changed("s1", 10, "2026-10-01T08:00:10.000Z"), stream("s1"));
  clock.now = "2026-10-01T08:30:00.000Z";
  await run();
  clock.now = LATER;
  const list = usage.listOpenTurnFacts.bind(usage);
  usage.listOpenTurnFacts = async (query) => { leases.held.clear(); return list(query); };
  assert.equal((await run()).completed, false);
  assert.equal(usage.facts.get("t1|s1|turn-4")?.status, "open");
});

test("a rerun over the same journal saves nothing; a close appended later replaces the abandoned fact", async () => {
  const { journal, usage, run } = rig();
  const events = stream("s1");
  journal.put(changed("s1", 10, "2026-10-01T08:00:00.000Z"), events);
  await run();
  const saves = usage.saves;
  await run();
  assert.equal(usage.saves, saves, "a stream whose cursor is current is not read");
  events.push(event(11, "assistant/message", { content: "Done." }, { turnId: "turn-4" }), event(12, "turn/end", { status: "partial" }, { turnId: "turn-4" }));
  journal.put(changed("s1", 12, "2026-10-01T08:01:00.000Z"), events);
  await run();
  assert.equal(usage.saves, saves + 1);
  assert.equal(usage.facts.size, 4);
  assert.equal(usage.facts.get("t1|s1|turn-4")?.status, "partial");
  assert.equal(usage.facts.get("t1|s1|turn-4")?.responseMs, 2000);
});

test("a refused save leaves the stream's cursor and transcript where they were, and the next run saves it", async () => {
  const { journal, review, usage, run } = rig();
  journal.put(changed("s1", 10, "2026-10-01T08:00:00.000Z"), stream("s1"));
  usage.failNext = new AgenticError("transient", "usage store down", true);
  const first = await run();
  assert.deepEqual(first.failed.map((item) => item.sessionId), ["s1"]);
  assert.ok(!review.cursors.has("t1|s1|review"), "the cursor moves only after the facts are saved");
  assert.ok(!review.sessions.has("t1|s1"));
  assert.equal(usage.facts.size, 0);
  assert.deepEqual((await run()).failed, []);
  assert.equal(usage.facts.size, 4);
  assert.equal(review.cursors.get("t1|s1|review")?.projectedSeq, 10);
});

test("a new revision rebuilds every stream and saves its facts again under that revision", async () => {
  const before = rig();
  before.journal.put(changed("s1", 10, "2026-10-01T08:00:00.000Z"), stream("s1"));
  await before.run();
  const after = rig("next-revision", before);
  await after.run();
  assert.equal(before.usage.saves, 2);
  assert.deepEqual(new Set(before.usage.revisions.values()), new Set(["next-revision"]));
});

test("a lost lease writes no facts", async () => {
  const { journal, leases, usage, run } = rig();
  journal.put(changed("s1", 10, "2026-10-01T08:00:00.000Z"), stream("s1"));
  const read = journal.eventsAfter.bind(journal);
  journal.eventsAfter = async (tenantId, sessionId, afterSeq, limit) => { leases.held.clear(); return read(tenantId, sessionId, afterSeq, limit); };
  assert.equal((await run()).completed, false);
  assert.equal(usage.facts.size, 0);
});
