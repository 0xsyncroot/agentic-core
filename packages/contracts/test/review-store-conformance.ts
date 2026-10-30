import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AgenticError, type LeaseFence, type ReviewAccessRecord, type ReviewJournalSource, type ReviewProjectionStore, type ReviewQueryStore,
  type ReviewSessionRecord, type ReviewTranscriptEntry, type SessionStore, type WorkerLeaseStore,
} from "@0xsyncroot/contracts";
import { input, runtime, security } from "./session-store-conformance.js";

/**
 * The review ports as executable cases. Every engine runs them unchanged against a store that may already hold other
 * tests' rows, so each case works in tenants of its own and never assumes the shard is empty.
 */
export interface ReviewEngine {
  readonly sessions: SessionStore;
  readonly journal: ReviewJournalSource;
  readonly projection: ReviewProjectionStore;
  readonly query: ReviewQueryStore;
  readonly leases: WorkerLeaseStore;
  /**
   * The same journal written the way the append path wrote it before the stamp existed, so the stream is never stamped;
   * absent where every append is stamped.
   */
  readonly unstampedSessions?: SessionStore;
  /** Ends the named lease now, by the clock the store judges leases with. */
  expire(workerKind: string): Promise<void>;
  /** Stores a tenant's profile the way the profile writer would. */
  profile(tenantId: string, displayName: string): Promise<void>;
  /** The access rows stored for the tenant, oldest first. */
  accessLog(tenantId: string): Promise<readonly ReviewAccessRecord[]>;
}

const unique = () => crypto.randomUUID();
const fails = (code: string) => (error: unknown) => error instanceof AgenticError && error.code === code;
/** The canonical form stores return: ISO 8601 UTC with exactly six fractional digits. */
export const micro = (iso: string) => { const [whole, fraction = ""] = iso.replace(/Z$/u, "").split("."); return `${whole}.${fraction.padEnd(6, "0")}Z`; };
const at = (minute: number, second = 0) => `2026-01-01T00:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000000Z`;

function header(tenantId: string, sessionId: string, overrides: Partial<ReviewSessionRecord> = {}): ReviewSessionRecord {
  return { tenantId, sessionId, agentId: "agent-a", channel: "live", actorKey: "a".repeat(64), actorKeyVersion: "k1", startedAt: at(1), lastTurnAt: at(2), answers: 1, transcriptMaskVersion: "m1", ...overrides };
}
/** The header before any transcript is complete: no mask version. */
function unmasked({ transcriptMaskVersion: _mask, ...record }: ReviewSessionRecord): ReviewSessionRecord { return record; }
function entry(entrySeq: number, overrides: Partial<ReviewTranscriptEntry> = {}): ReviewTranscriptEntry {
  return { maskVersion: "m1", entrySeq, turnId: "t1", role: entrySeq % 2 === 1 ? "user" : "assistant", bodyFormat: "text", body: `body ${entrySeq}`, maskedValues: 0, sourceHash: "b".repeat(64), at: at(1, entrySeq), ...(entrySeq % 2 === 0 ? { answerIndex: entrySeq / 2 } : {}), ...overrides };
}
const cursorOf = (tenantId: string, sessionId: string, projectedSeq: number) => ({ tenantId, sessionId, projectorId: "review", projectedSeq, projectorRevision: "r1" });

export function reviewStoreConformance(name: string, make: () => Promise<ReviewEngine>): void {
  describe(`${name} review stores`, () => {
    const fenced = async (engine: ReviewEngine): Promise<LeaseFence> => {
      const lease = await engine.leases.acquire(`projector-${unique()}`, "worker-1", 60_000);
      assert.ok(lease);
      return { workerKind: lease.workerKind, fencingToken: lease.fencingToken };
    };

    test("changedSince lists stamped streams oldest first, once each across pages, and a new append moves a stream last", async () => {
      const engine = await make(); const tenant = `tenant-${unique()}`;
      const since = new Date(Date.now() - 2_000).toISOString();
      for (const sessionId of ["s-1", "s-2", "s-3"]) await engine.sessions.append(sessionId, 0, [input(1)], `k-${sessionId}`, { security: security(tenant, "owner-1"), runtime });
      await engine.sessions.append("s-1", 1, [input(2)], "k-s-1-again", { security: security(tenant, "owner-1"), runtime });
      const seen: string[] = []; let after;
      for (;;) {
        const page = await engine.journal.changedSince(since, 2, after);
        assert.ok(page.length <= 2);
        for (let index = 1; index < page.length; index += 1) assert.ok(page[index - 1]!.lastAppendedAt <= page[index]!.lastAppendedAt);
        for (const item of page) if (item.tenantId === tenant) {
          seen.push(item.sessionId);
          assert.equal(item.ownerActorId, "owner-1");
          assert.equal(item.currentSeq, item.sessionId === "s-1" ? 2 : 1);
          assert.equal(item.lastAppendedAt, micro(item.lastAppendedAt));
          assert.ok(item.lastAppendedAt >= micro(since));
        }
        if (page.length < 2) break;
        after = page.at(-1)!;
      }
      assert.deepEqual(seen, ["s-2", "s-3", "s-1"]);
    });

    test("streamsByKey lists every stream in key order, stamped or not, once each across pages", async () => {
      const engine = await make(); const tenant = `tenant-${unique()}`; const context = { security: security(tenant, "owner-1"), runtime };
      await engine.sessions.append("s-a", 0, [input(1)], "k-a", context);
      await (engine.unstampedSessions ?? engine.sessions).append("s-b", 0, [input(1)], "k-b", context);
      await engine.sessions.append("s-c", 0, [input(1)], "k-c", context);
      await engine.sessions.append("s-c", 1, [input(2)], "k-c-again", context);
      const first = await engine.journal.streamsByKey(2, { tenantId: tenant, sessionId: "0" });
      assert.deepEqual(first.map((item) => [item.tenantId, item.sessionId]), [[tenant, "s-a"], [tenant, "s-b"]]);
      const second = await engine.journal.streamsByKey(2, first.at(-1)!);
      assert.ok(second.length >= 1 && second.length <= 2);
      assert.deepEqual(second[0] && [second[0].tenantId, second[0].sessionId], [tenant, "s-c"]);
      assert.ok(second.slice(1).every((item) => item.tenantId !== tenant));
      const [a, b] = first; const c = second[0]!;
      for (const item of [a!, b!, c]) { assert.equal(item.ownerActorId, "owner-1"); assert.equal(item.agentProfileId, null); }
      assert.deepEqual([a!.currentSeq, b!.currentSeq, c.currentSeq], [1, 1, 2]);
      for (const { lastAppendedAt } of [a!, c]) { assert.ok(lastAppendedAt); assert.equal(lastAppendedAt, micro(lastAppendedAt)); }
      if (engine.unstampedSessions) assert.equal(b!.lastAppendedAt, null);
      const stamped = await engine.journal.changedSince(new Date(Date.now() - 60_000).toISOString(), 1000);
      if (engine.unstampedSessions) assert.ok(!stamped.some((item) => item.tenantId === tenant && item.sessionId === "s-b"));
    });

    test("eventsAfter returns one stream's events past the given seq in journal order; other tenants and unknown streams read empty", async () => {
      const engine = await make(); const tenant = `tenant-${unique()}`;
      for (let seq = 0; seq < 5; seq += 1) await engine.sessions.append("s", seq, [input(seq + 1)], `k${seq}`, { security: security(tenant, "owner"), runtime });
      const events = await engine.journal.eventsAfter(tenant, "s", 1, 3);
      assert.deepEqual(events.map((event) => event.seq), [2, 3, 4]);
      assert.deepEqual(events.map((event) => (event.payload as { content: string }).content), ["message 2", "message 3", "message 4"]);
      assert.deepEqual((await engine.journal.eventsAfter(tenant, "s", 4, 10)).map((event) => event.seq), [5]);
      assert.deepEqual(await engine.journal.eventsAfter(`tenant-${unique()}`, "s", 0, 10), []);
      assert.deepEqual(await engine.journal.eventsAfter(tenant, "missing", 0, 10), []);
    });

    test("journal pages outside 1 to 1000 are refused as validation", async () => {
      const engine = await make();
      for (const limit of [0, 1001, 1.5]) {
        await assert.rejects(engine.journal.changedSince(new Date().toISOString(), limit), fails("validation"));
        await assert.rejects(engine.journal.eventsAfter("t", "s", 0, limit), fails("validation"));
        await assert.rejects(engine.journal.streamsByKey(limit), fails("validation"));
      }
      await assert.rejects(engine.journal.streamsByKey(10, { tenantId: "", sessionId: "s" }), fails("validation"));
      await assert.rejects(engine.journal.streamsByKey(10, { tenantId: "t", sessionId: "" }), fails("validation"));
      await assert.rejects(engine.journal.changedSince("yesterday", 10), fails("validation"));
    });

    test("replace stores header, entries and cursor together, and rerunning it changes nothing", async () => {
      const engine = await make(); const tenant = `tenant-${unique()}`; const fence = await fenced(engine);
      const entries = [entry(1), entry(2, { toolLabels: [{ toolId: "lookup", label: "Lookup" }] })];
      await engine.projection.replace(header(tenant, "s"), entries, cursorOf(tenant, "s", 2), fence);
      await engine.projection.replace(header(tenant, "s"), entries, cursorOf(tenant, "s", 2), fence);
      assert.deepEqual(await engine.projection.cursor(tenant, "s", "review"), cursorOf(tenant, "s", 2));
      assert.deepEqual(await engine.query.transcript(tenant, "s", "m1"), entries);
      assert.deepEqual(await engine.query.session(tenant, "s"), header(tenant, "s"));
      assert.equal(await engine.query.session(`tenant-${unique()}`, "s"), undefined);
      assert.equal(await engine.projection.cursor(tenant, "s", "other"), undefined);
    });

    test("a later replace adds entries, moves the header and cursor, and keeps the first startedAt", async () => {
      const engine = await make(); const tenant = `tenant-${unique()}`; const fence = await fenced(engine);
      await engine.projection.replace(unmasked(header(tenant, "s")), [entry(1)], cursorOf(tenant, "s", 1), fence);
      const later = header(tenant, "s", { startedAt: at(9), lastTurnAt: at(5), answers: 2 });
      await engine.projection.replace(later, [entry(1), entry(2), entry(3)], cursorOf(tenant, "s", 3), fence);
      assert.deepEqual(await engine.query.session(tenant, "s"), { ...later, startedAt: at(1) });
      assert.deepEqual((await engine.query.transcript(tenant, "s", "m1")).map((item) => item.entrySeq), [1, 2, 3]);
      assert.deepEqual(await engine.query.transcript(tenant, "s", "m2"), []);
      assert.equal((await engine.projection.cursor(tenant, "s", "review"))?.projectedSeq, 3);
    });

    test("an entry stored with other content is a conflict, and nothing of that replace is kept", async () => {
      const engine = await make(); const tenant = `tenant-${unique()}`; const fence = await fenced(engine);
      await engine.projection.replace(header(tenant, "s"), [entry(1)], cursorOf(tenant, "s", 1), fence);
      await assert.rejects(engine.projection.replace(header(tenant, "s", { answers: 5 }), [entry(1, { body: "changed" }), entry(2)], cursorOf(tenant, "s", 2), fence), fails("conflict"));
      assert.equal((await engine.query.session(tenant, "s"))?.answers, 1);
      assert.deepEqual((await engine.query.transcript(tenant, "s", "m1")).map((item) => item.body), ["body 1"]);
      assert.equal((await engine.projection.cursor(tenant, "s", "review"))?.projectedSeq, 1);
      await engine.projection.replace(header(tenant, "s"), [entry(1, { maskVersion: "m2", body: "changed" })], cursorOf(tenant, "s", 1), fence);
      assert.deepEqual((await engine.query.transcript(tenant, "s", "m2")).map((item) => item.body), ["changed"]);
    });

    test("a cursor of another session, a non-canonical value or an unknown role is refused as validation", async () => {
      const engine = await make(); const tenant = `tenant-${unique()}`; const fence = await fenced(engine);
      await assert.rejects(engine.projection.replace(header(tenant, "s"), [], cursorOf(tenant, "other", 1), fence), fails("validation"));
      await assert.rejects(engine.projection.replace(header(tenant, "s"), [], cursorOf("another", "s", 1), fence), fails("validation"));
      await assert.rejects(engine.projection.replace(header(tenant, "s", { startedAt: "soon" }), [], cursorOf(tenant, "s", 1), fence), fails("validation"));
      await assert.rejects(engine.projection.replace(header(tenant, "s"), [entry(1, { role: "robot" as never })], cursorOf(tenant, "s", 1), fence), fails("validation"));
      await assert.rejects(engine.projection.replace(header(tenant, "s", { actorKey: "short" }), [], cursorOf(tenant, "s", 1), fence), fails("validation"));
      assert.equal(await engine.query.session(tenant, "s"), undefined);
    });

    test("writes under a fence that is not the current lease are refused as conflict", async () => {
      const engine = await make(); const tenant = `tenant-${unique()}`; const kind = `projector-${unique()}`;
      const first = (await engine.leases.acquire(kind, "worker-1", 60_000))!;
      const stale: LeaseFence = { workerKind: kind, fencingToken: first.fencingToken };
      await assert.rejects(engine.projection.replace(header(tenant, "s"), [], cursorOf(tenant, "s", 0), { workerKind: `projector-${unique()}`, fencingToken: "1" }), fails("conflict"));
      await engine.expire(kind);
      await assert.rejects(engine.projection.replace(header(tenant, "s"), [], cursorOf(tenant, "s", 0), stale), fails("conflict"));
      const second = (await engine.leases.acquire(kind, "worker-2", 60_000))!;
      await assert.rejects(engine.projection.saveWatermark({ projectorId: "review", watermarkAt: at(1), projectorRevision: "r1" }, stale), fails("conflict"));
      await engine.projection.replace(header(tenant, "s"), [], cursorOf(tenant, "s", 0), { workerKind: kind, fencingToken: second.fencingToken });
      assert.ok(await engine.query.session(tenant, "s"));
    });

    test("the watermark reads back as saved and moves on the next save", async () => {
      const engine = await make(); const fence = await fenced(engine); const projectorId = `projector-${unique()}`;
      assert.equal(await engine.projection.watermark(projectorId), undefined);
      await engine.projection.saveWatermark({ projectorId, watermarkAt: "2026-01-01T00:00:00.123456Z", projectorRevision: "r1" }, fence);
      assert.deepEqual(await engine.projection.watermark(projectorId), { projectorId, watermarkAt: "2026-01-01T00:00:00.123456Z", projectorRevision: "r1" });
      await engine.projection.saveWatermark({ projectorId, watermarkAt: at(3), projectorRevision: "r2" }, fence);
      assert.deepEqual(await engine.projection.watermark(projectorId), { projectorId, watermarkAt: at(3), projectorRevision: "r2" });
    });

    test("listSessions pages newest first with the tenant's name and the masked start of the first user entry", async () => {
      const engine = await make(); const tenant = `tenant-${unique()}`; const agentId = `agent-${unique()}`; const fence = await fenced(engine);
      await engine.profile(tenant, "Unit One");
      const starts = { "s-a": at(1), "s-b": at(3), "s-c": at(2) } as const;
      for (const [sessionId, startedAt] of Object.entries(starts)) {
        await engine.projection.replace(header(tenant, sessionId, { agentId, startedAt }), [entry(2), entry(3, { body: `hello from ${sessionId}` }), entry(5)], cursorOf(tenant, sessionId, 5), fence);
      }
      const first = await engine.query.listSessions({ tenantId: tenant, agentId, limit: 2, previewChars: 7 });
      assert.deepEqual(first.items.map((item) => [item.sessionId, item.tenantName, item.preview]), [["s-b", "Unit One", "hello f"], ["s-c", "Unit One", "hello f"]]);
      assert.deepEqual(first.next, { startedAt: at(2), tenantId: tenant, sessionId: "s-c" });
      const second = await engine.query.listSessions({ tenantId: tenant, agentId, limit: 2, previewChars: 2000, after: first.next });
      assert.deepEqual(second.items.map((item) => [item.sessionId, item.preview]), [["s-a", "hello from s-a"]]);
      assert.equal(second.next, undefined);
      assert.deepEqual(second.items[0], { ...header(tenant, "s-a", { agentId, startedAt: at(1) }), tenantName: "Unit One", preview: "hello from s-a" });
    });

    test("listSessions filters by agent, start range and literal session id prefix; a header without transcript has no preview", async () => {
      const engine = await make(); const tenant = `tenant-${unique()}`; const agentId = `agent-${unique()}`; const fence = await fenced(engine);
      for (const [sessionId, minute] of [["s-1", 1], ["s-2", 2], ["s_3", 3], ["t-4", 4]] as const) {
        await engine.projection.replace(unmasked(header(tenant, sessionId, { agentId, startedAt: at(minute) })), [], cursorOf(tenant, sessionId, 0), fence);
      }
      const ids = async (query: { from?: string; to?: string; sessionIdPrefix?: string; agentId?: string }) =>
        (await engine.query.listSessions({ tenantId: tenant, agentId, limit: 200, previewChars: 10, ...query })).items.map((item) => item.sessionId);
      assert.deepEqual(await ids({}), ["t-4", "s_3", "s-2", "s-1"]);
      assert.deepEqual(await ids({ from: at(2), to: at(4) }), ["s_3", "s-2"]);
      assert.deepEqual(await ids({ sessionIdPrefix: "s-" }), ["s-2", "s-1"]);
      assert.deepEqual(await ids({ sessionIdPrefix: "s_" }), ["s_3"]);
      assert.deepEqual(await ids({ sessionIdPrefix: "S-" }), []);
      assert.deepEqual(await ids({ sessionIdPrefix: "%" }), []);
      assert.deepEqual(await ids({ agentId: `agent-${unique()}` }), []);
      const [item] = (await engine.query.listSessions({ tenantId: tenant, agentId, sessionIdPrefix: "t-", limit: 1, previewChars: 10 })).items;
      assert.equal(item?.preview, undefined); assert.equal(item?.tenantName, undefined);
      assert.equal("preview" in item!, false); assert.equal("tenantName" in item!, false);
    });

    test("listSessions bounds are refused as validation", async () => {
      const engine = await make();
      for (const [limit, previewChars] of [[0, 10], [201, 10], [10, 0], [10, 2001]] as const) {
        await assert.rejects(engine.query.listSessions({ limit, previewChars }), fails("validation"));
      }
      await assert.rejects(engine.query.listSessions({ limit: 10, previewChars: 10, from: "later" }), fails("validation"));
    });

    test("recordAccess appends one row per call and returns a distinct id", async () => {
      const engine = await make(); const tenant = `tenant-${unique()}`; const principalId = unique();
      const opened: ReviewAccessRecord = { tenantId: tenant, principalId, sessionId: "s", action: "session.open", purpose: "review", at: "2026-01-01T00:00:00.000001Z" };
      const listed: ReviewAccessRecord = { tenantId: tenant, principalId, action: "session.list", purpose: "review", detail: "{\"q\":\"s\"}", at: at(2) };
      const ids = [await engine.query.recordAccess(opened), await engine.query.recordAccess(listed)];
      assert.equal(new Set(ids).size, 2);
      for (const id of ids) assert.ok(id.length > 0 && id.length <= 36, id);
      assert.deepEqual(await engine.accessLog(tenant), [opened, listed]);
      await assert.rejects(engine.query.recordAccess({ ...opened, at: "now" }), fails("validation"));
    });
  });
}
