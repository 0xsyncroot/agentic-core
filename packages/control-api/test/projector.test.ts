import assert from "node:assert/strict";
import test from "node:test";
import type { ChangedSession, SessionEvent, ShardStream } from "@0xsyncroot/contracts";
import { ActorPseudonyms, compilePersonalFields, projectorRevision, ReviewProjector, type PersonalFieldConfig, type TranscriptWording } from "../src/index.js";
import { event, MemoryJournal, MemoryLeases, MemoryReview } from "./review-fixture.js";
import { MemoryUsage } from "./usage-fixture.js";

const CONFIG: PersonalFieldConfig = {
  labels: { "person-name": "Name", money: "Amount", identifier: "Code", coefficient: "Rate" },
  money: { atLeast: 10000 },
  names: { honorifics: [], minWords: 2 },
  tools: { profile: { paths: { "data.FullName": "person-name" } } },
};
const WORDING: TranscriptWording = { toolLabels: {}, failure: { default: "failed" }, encrypted: "sealed" };
const KEY = "k".repeat(32);
const FINGERPRINT = new ActorPseudonyms(KEY, "1").keyFingerprint;

function rig(config = CONFIG, pageSize = 1000) {
  const journal = new MemoryJournal();
  const leases = new MemoryLeases();
  const review = new MemoryReview(leases);
  const projector = new ReviewProjector({
    projectorId: "review", revision: projectorRevision(config, WORDING, FINGERPRINT), owner: "worker-1", leaseTtlMs: 60000, defaultAgentId: "agent-default",
    pseudonyms: new ActorPseudonyms(KEY, "1"), fields: compilePersonalFields(config), wording: WORDING, pageSize, abandonAfterMs: 0,
  });
  const ports = { journal, projection: review, query: review, leases, usage: new MemoryUsage(leases) };
  return { journal, leases, review, projector, run: () => projector.runOnce(ports) };
}

const changed = (sessionId: string, currentSeq: number, lastAppendedAt: string, agentProfileId: string | null = null): ChangedSession =>
  ({ tenantId: "t1", sessionId, ownerActorId: "owner-1", agentProfileId, currentSeq, lastAppendedAt });

const unstamped = (sessionId: string, currentSeq = 4): ShardStream =>
  ({ tenantId: "t1", sessionId, ownerActorId: "owner-1", agentProfileId: null, currentSeq, lastAppendedAt: null });

/** Counts `streamsByKey` calls, so a test sees whether a run read the shard by key. */
function countKeyReads(journal: MemoryJournal): { calls: number } {
  const count = { calls: 0 };
  const read = journal.streamsByKey.bind(journal);
  journal.streamsByKey = async (limit, after) => { count.calls += 1; return read(limit, after); };
  return count;
}

const conversation = (sessionId: string): SessionEvent[] => [
  event(1, "turn/start", { runtimeBinding: { agentProfileId: "agent-from-turn" } }, { sessionId }),
  event(2, "user/input", { content: "Find Lê Văn Nam", source: "external" }, { sessionId }),
  event(3, "tool/result", { toolId: "profile", result: { data: { FullName: "Lê Văn Nam" } } }, { sessionId }),
  event(4, "assistant/message", { content: "Lê Văn Nam is on file." }, { sessionId }),
];

test("a run projects changed streams under the lease and saves the watermark", async () => {
  const { journal, review, leases, run } = rig();
  journal.put(changed("s1", 4, "2026-10-01T08:00:00.000Z"), conversation("s1"));
  journal.put(changed("s2", 4, "2026-10-01T08:05:00.000Z", "agent-a"), conversation("s2"));
  assert.deepEqual(await run(), { leased: true, seen: 2, rebuilt: 2, completed: true, failed: [] });
  const s1 = review.sessions.get("t1|s1");
  assert.equal(s1?.agentId, "agent-from-turn");
  assert.equal(review.sessions.get("t1|s2")?.agentId, "agent-a");
  assert.equal(s1?.actorKey, new ActorPseudonyms(KEY, "1").actorKey("t1", "owner-1"));
  assert.equal(s1?.answers, 1);
  const entries = await review.transcript("t1", "s1", s1?.transcriptMaskVersion ?? "");
  assert.deepEqual(entries.map((entry) => entry.body), ["Find [Name 1]", "", "[Name 1] is on file."]);
  assert.equal(review.marks.get("review")?.watermarkAt, "2026-10-01T08:05:00.000Z");
  assert.equal(review.cursors.get("t1|s1|review")?.projectedSeq, 4);
  assert.equal(leases.held.size, 0, "the lease is released");
});

test("a second run over the same journal writes nothing; the overlap reads late stamps again", async () => {
  const { journal, review, run } = rig();
  journal.put(changed("s1", 4, "2026-10-01T08:00:00.000Z"), conversation("s1"));
  await run();
  const writes = review.writes;
  assert.deepEqual(await run(), { leased: true, seen: 1, rebuilt: 0, completed: true, failed: [] });
  assert.equal(review.writes, writes);
  journal.put(changed("late", 4, "2026-10-01T07:51:00.000Z"), conversation("late"));
  journal.put(changed("too-late", 4, "2026-10-01T07:49:00.000Z"), conversation("too-late"));
  assert.equal((await run()).rebuilt, 1);
  assert.ok(review.sessions.has("t1|late"));
  assert.ok(!review.sessions.has("t1|too-late"));
});

test("an appended turn keeps the mask version; a changed earlier entry gets a new one", async () => {
  const { journal, review, run } = rig();
  const events = conversation("s1");
  journal.put(changed("s1", 4, "2026-10-01T08:00:00.000Z"), events);
  await run();
  const first = review.sessions.get("t1|s1")?.transcriptMaskVersion;
  events.push(event(5, "user/input", { content: "thanks", source: "external" }, { turnId: "turn-2" }));
  journal.put(changed("s1", 5, "2026-10-01T08:01:00.000Z"), events);
  await run();
  assert.equal(review.sessions.get("t1|s1")?.transcriptMaskVersion, first);
  assert.equal((await review.transcript("t1", "s1", first ?? "")).length, 4);
  events.push(event(6, "tool/result", { toolId: "profile", result: { data: { FullName: "Thanks Giving" } } }, { turnId: "turn-2" }),
    event(7, "assistant/narration-superseded", { narrationId: "none", by: "x" }, { turnId: "turn-2" }));
  events[4] = event(5, "user/input", { content: "thanks Thanks Giving", source: "external" }, { turnId: "turn-2" });
  journal.put(changed("s1", 7, "2026-10-01T08:02:00.000Z"), events);
  await run();
  const second = review.sessions.get("t1|s1")?.transcriptMaskVersion;
  assert.notEqual(second, first);
  assert.equal((await review.transcript("t1", "s1", second ?? "")).find((entry) => entry.entrySeq === 5)?.body, "thanks [Name 2]");
});

test("a new configuration rebuilds every stream from the start", async () => {
  const before = rig();
  before.journal.put(changed("s1", 4, "2026-10-01T08:00:00.000Z"), conversation("s1"));
  await before.run();
  const changedConfig = { ...CONFIG, tools: {} };
  const projector = new ReviewProjector({
    projectorId: "review", revision: projectorRevision(changedConfig, WORDING, FINGERPRINT), owner: "worker-1", leaseTtlMs: 60000, defaultAgentId: "d",
    pseudonyms: new ActorPseudonyms(KEY, "1"), fields: compilePersonalFields(changedConfig), wording: WORDING, abandonAfterMs: 0,
  });
  before.review.marks.set("review", { projectorId: "review", watermarkAt: "2030-01-01T00:00:00.000Z", projectorRevision: "old" });
  const result = await projector.runOnce({ journal: before.journal, projection: before.review, query: before.review, leases: before.leases, usage: new MemoryUsage(before.leases) });
  assert.equal(result.rebuilt, 1);
  const version = before.review.sessions.get("t1|s1")?.transcriptMaskVersion ?? "";
  assert.ok(version.startsWith(projectorRevision(changedConfig, WORDING, FINGERPRINT)));
  assert.equal((await before.review.transcript("t1", "s1", version))[0]?.body, "Find Lê Văn Nam");
});

test("a new pseudonym key is a new revision, so rotating the key rebuilds every stream", () => {
  const rotated = new ActorPseudonyms("x".repeat(32), "2").keyFingerprint;
  assert.notEqual(projectorRevision(CONFIG, WORDING, rotated), projectorRevision(CONFIG, WORDING, FINGERPRINT));
  assert.equal(projectorRevision(CONFIG, WORDING, FINGERPRINT), projectorRevision({ ...CONFIG }, { ...WORDING }, FINGERPRINT));
});

test("a held lease reads nothing and a lost lease saves no watermark", async () => {
  const { journal, review, leases, run } = rig(CONFIG, 1);
  journal.put(changed("s1", 4, "2026-10-01T08:00:00.000Z"), conversation("s1"));
  journal.put(changed("s2", 4, "2026-10-01T08:01:00.000Z"), conversation("s2"));
  await leases.acquire("review-projector:review", "someone-else");
  assert.deepEqual(await run(), { leased: false, seen: 0, rebuilt: 0, completed: false, failed: [] });
  leases.held.clear();
  leases.loseOnRenew = true;
  const mark = { projectorId: "review", watermarkAt: "2026-10-01T07:00:00.000Z", projectorRevision: projectorRevision(CONFIG, WORDING, FINGERPRINT) };
  review.marks.set("review", mark);
  assert.deepEqual(await run(), { leased: true, seen: 1, rebuilt: 1, completed: false, failed: [] });
  assert.deepEqual(review.marks.get("review"), mark, "the watermark is not moved");
});

test("paging walks every changed stream and every event page", async () => {
  const { journal, review, run } = rig(CONFIG, 2);
  for (let index = 0; index < 5; index += 1) journal.put(changed(`s${index}`, 4, `2026-10-01T08:0${index}:00.000Z`), conversation(`s${index}`));
  const long = Array.from({ length: 1205 }, (_, index) => event(index + 1, "user/input", { content: `m${index}`, source: "external" }, { sessionId: "long" }));
  journal.put(changed("long", 1205, "2026-10-01T08:09:00.000Z"), long);
  assert.equal((await run()).rebuilt, 6);
  assert.equal(review.sessions.size, 6);
  assert.equal(review.cursors.get("t1|long|review")?.projectedSeq, 1205);
});

test("a failing stream is reported and skipped; the watermark stops at the earliest failure", async () => {
  const { journal, review, run } = rig();
  journal.put(changed("s1", 4, "2026-10-01T08:00:00.000Z"), conversation("s1"));
  journal.put(changed("s2", 4, "2026-10-01T08:01:00.000Z"), conversation("s2"));
  journal.put(changed("s3", 4, "2026-10-01T08:02:00.000Z"), conversation("s3"));
  journal.put(changed("s4", 4, "2026-10-01T08:03:00.000Z"), conversation("s4"));
  journal.failing.add("s2");
  journal.failing.add("s4");
  const first = await run();
  assert.deepEqual({ ...first, failed: first.failed.map((item) => item.sessionId) }, { leased: true, seen: 4, rebuilt: 2, completed: true, failed: ["s2", "s4"] });
  assert.match(first.failed[0]?.reason ?? "", /unreadable/u);
  assert.ok(review.sessions.has("t1|s3"), "streams after a failure are still projected");
  assert.ok(!review.cursors.has("t1|s2|review"), "a failed stream keeps its cursor");
  assert.equal(review.marks.get("review")?.watermarkAt, "2026-10-01T08:01:00.000Z");
  journal.failing.clear();
  const second = await run();
  assert.deepEqual(second, { leased: true, seen: 4, rebuilt: 2, completed: true, failed: [] });
  assert.equal(review.marks.get("review")?.watermarkAt, "2026-10-01T08:03:00.000Z");
});

test("a lease lost while writing one stream ends the run instead of counting as a failed stream", async () => {
  const { journal, review, leases, run } = rig();
  journal.put(changed("s1", 4, "2026-10-01T08:00:00.000Z"), conversation("s1"));
  journal.put(changed("s2", 4, "2026-10-01T08:01:00.000Z"), conversation("s2"));
  const read = journal.eventsAfter.bind(journal);
  journal.eventsAfter = async (tenantId, sessionId, afterSeq, limit) => {
    if (sessionId === "s2") leases.held.clear();
    return read(tenantId, sessionId, afterSeq, limit);
  };
  assert.deepEqual(await run(), { leased: true, seen: 2, rebuilt: 1, completed: false, failed: [] });
  assert.equal(review.marks.size, 0);
  assert.ok(!review.sessions.has("t1|s2"));
});

test("a first run also projects streams never stamped; a later run lists only stamped ones", async () => {
  const { journal, review, run } = rig();
  journal.put(unstamped("u1"), conversation("u1"));
  journal.put(changed("s1", 4, "2026-10-01T08:00:00.000Z"), conversation("s1"));
  const keyReads = countKeyReads(journal);
  assert.deepEqual(await run(), { leased: true, seen: 2, rebuilt: 2, completed: true, failed: [] });
  assert.equal(keyReads.calls, 1);
  assert.equal(review.sessions.get("t1|u1")?.answers, 1);
  assert.equal(review.marks.get("review")?.watermarkAt, "2026-10-01T08:00:00.000Z");
  assert.deepEqual(await run(), { leased: true, seen: 1, rebuilt: 0, completed: true, failed: [] });
  assert.equal(keyReads.calls, 1, "the key pass runs once per revision");
});

test("a shard of unstamped streams only still saves a watermark, so the key pass is not repeated", async () => {
  const { journal, review, run } = rig();
  journal.put(unstamped("u1"), conversation("u1"));
  const keyReads = countKeyReads(journal);
  assert.equal((await run()).rebuilt, 1);
  assert.equal(review.marks.get("review")?.watermarkAt, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(await run(), { leased: true, seen: 0, rebuilt: 0, completed: true, failed: [] });
  assert.equal(keyReads.calls, 1);
});

test("a failing unstamped stream saves no watermark; the next run reads by key again and projects it", async () => {
  const { journal, review, run } = rig();
  journal.put(unstamped("u1"), conversation("u1"));
  journal.put(unstamped("u2"), conversation("u2"));
  journal.put(changed("s1", 4, "2026-10-01T08:00:00.000Z"), conversation("s1"));
  journal.failing.add("u1");
  const keyReads = countKeyReads(journal);
  const first = await run();
  assert.deepEqual({ ...first, failed: first.failed.map((item) => item.sessionId) }, { leased: true, seen: 3, rebuilt: 2, completed: true, failed: ["u1"] });
  assert.equal(review.marks.size, 0);
  journal.failing.clear();
  assert.deepEqual(await run(), { leased: true, seen: 3, rebuilt: 1, completed: true, failed: [] });
  assert.equal(keyReads.calls, 2);
  assert.ok(review.sessions.has("t1|u1"));
  assert.equal(review.marks.get("review")?.watermarkAt, "2026-10-01T08:00:00.000Z");
});

test("a stream stamped while the key pass runs is caught by the stamp pass of the same run", async () => {
  const { journal, review, run } = rig(CONFIG, 1);
  const events = conversation("u1");
  journal.put(unstamped("u1"), events);
  journal.put(unstamped("u2"), conversation("u2"));
  const read = journal.streamsByKey.bind(journal);
  journal.streamsByKey = async (limit, after) => {
    if (after?.sessionId === "u1") {
      events.push(event(5, "user/input", { content: "thanks", source: "external" }, { sessionId: "u1", turnId: "turn-2" }));
      journal.put(changed("u1", 5, "2026-10-01T08:10:00.000Z"), events);
    }
    return read(limit, after);
  };
  assert.deepEqual(await run(), { leased: true, seen: 3, rebuilt: 3, completed: true, failed: [] });
  assert.equal(review.cursors.get("t1|u1|review")?.projectedSeq, 5);
  assert.equal(review.marks.get("review")?.watermarkAt, "2026-10-01T08:10:00.000Z");
});

test("a lease lost during the key pass ends the run with no watermark", async () => {
  const { journal, review, leases, run } = rig();
  journal.put(unstamped("u1"), conversation("u1"));
  leases.loseOnRenew = true;
  assert.deepEqual(await run(), { leased: true, seen: 1, rebuilt: 1, completed: false, failed: [] });
  assert.equal(review.marks.size, 0);
});
