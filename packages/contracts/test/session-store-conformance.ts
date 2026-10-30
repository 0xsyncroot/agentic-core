import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AgenticError, MAX_SESSION_READ_EVENTS, type EventDraft, type RuntimeSnapshot, type SecurityContext, type SessionStore } from "@0xsyncroot/contracts";

/**
 * The SessionStore contract as executable cases. Every store — in-memory, Redis, MySQL — runs these
 * unchanged, so "same observable semantics" is checked rather than claimed.
 */
export const runtime: RuntimeSnapshot = {
  id: "conformance", coreVersion: "1.0.0", pluginSetId: "test", policyRevision: "test", memoryPolicyRevision: "test",
  createdAt: new Date(0).toISOString(),
};
export const security = (tenantId: string, actorId: string): SecurityContext =>
  ({ tenantId, actorId, permissions: new Set(["*"]), correlationId: crypto.randomUUID(), purpose: "conformance" });
export const input = (n: number, turnId = `turn-${n}`): EventDraft => ({ type: "user/input", turnId, payload: { content: `message ${n}`, source: "test" } });
const note = (turnId?: string): EventDraft => ({ type: "ext/note", ...(turnId ? { turnId } : {}), payload: { content: "x" } });
export const checkpoint = (summary: string, covered: number, turnId?: string): EventDraft => ({
  type: "context/checkpoint", ...(turnId ? { turnId } : {}),
  payload: { summary, summaryHash: "h", coveredThroughSeq: covered, compactorRevision: "c", projectorRevision: "p", formatVersion: 1, inputDigest: "d" },
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * A store judges a lease on a wall clock (its own, or its server's), and a wall clock can step back while the test
 * sleeps. Waits until that clock is past `iso`, for at most `budgetMs` of the monotonic clock; when the budget ends
 * it returns and the caller's assertion decides, so a store whose clock runs ahead of this host is no worse off.
 */
async function untilWallClockPasses(iso: string, budgetMs = 5_000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (Date.now() <= Date.parse(iso) && performance.now() < deadline) await sleep(10);
}
export const sid = () => `s-${crypto.randomUUID()}`;
const conflict = (pattern: RegExp) => (error: unknown) => error instanceof AgenticError && error.code === "conflict" && pattern.test(error.message);

/** The cases both backends must pass unchanged: this is what "same observable semantics" means. */
export function conformance(name: string, make: () => SessionStore): void {
  describe(`${name} session store`, () => {
    const owner = security("tenant-a", "user-a");
    const ctx = { security: owner, runtime };
    const claim = (store: SessionStore, sessionId: string, key: string, ttl = 5_000, turnId = `t-${key}`, fingerprint = "fp") =>
      store.claimTurn({ sessionId, turnId, ownerId: "w1", idempotencyKey: key, requestFingerprint: fingerprint, leaseTtlMs: ttl, startEvents: [input(1, turnId)] }, ctx);

    test("append numbers events densely and enforces compare-and-set", async () => {
      const store = make(); const id = sid();
      assert.equal(await store.append(id, 0, [input(1), input(2)], "k1", ctx), 2);
      assert.equal(await store.append(id, 2, [input(3)], "k2", ctx), 3);
      await assert.rejects(store.append(id, 2, [input(4)], "k3", ctx), conflict(/Session CAS conflict: expected 2, actual 3/u));
      await assert.rejects(store.append(sid(), 5, [input(1)], "k4", ctx), conflict(/expected 5, actual 0/u));
      const events = await store.load(id, owner);
      assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
      assert.ok(events.every((event) => event.integrityHash.length === 64 && event.tenantId === "tenant-a" && event.sessionId === id));
      assert.deepEqual(await store.load(sid(), owner), []);
    });

    test("an idempotent retry returns the first result; the same key with other content conflicts", async () => {
      const store = make(); const id = sid();
      assert.equal(await store.append(id, 0, [input(1)], "same", ctx), 1);
      assert.equal(await store.append(id, 0, [input(1)], "same", ctx), 1, "replay must not append again");
      assert.equal((await store.load(id, owner)).length, 1);
      await assert.rejects(store.append(id, 0, [input(2)], "same", ctx), conflict(/Idempotency key was reused with a different append operation/u));
    });

    test("loadRecent, loadSince and their bounds", async () => {
      const store = make(); const id = sid();
      await store.append(id, 0, Array.from({ length: 12 }, (_, i) => input(i + 1)), "seed", ctx);
      assert.deepEqual((await store.loadRecent(id, 3, owner)).map((event) => event.seq), [10, 11, 12]);
      assert.deepEqual((await store.loadRecent(id, 50, owner)).length, 12);
      assert.deepEqual((await store.loadSince(id, 9, owner, 10)).map((event) => event.seq), [10, 11, 12]);
      assert.deepEqual((await store.loadSince(id, 3, owner, 4)).map((event) => event.seq), [4, 5, 6, 7]);
      assert.deepEqual(await store.loadSince(id, 12, owner, 10), []);
      assert.deepEqual(await store.loadSince(sid(), 0, owner, 10), []);
      await assert.rejects(store.loadRecent(id, 0, owner), /limit must be from 1 to 1000/u);
      await assert.rejects(store.loadSince(id, 0, owner, MAX_SESSION_READ_EVENTS + 1), /limit must be from 1 to 1000/u);
      await assert.rejects(store.loadSince(id, -1, owner, 10), /afterSeq/u);
    });

    test("loadContext returns the latest checkpoint and bounds the tail", async () => {
      const store = make(); const id = sid();
      await store.append(id, 0, [input(1), checkpoint("first", 1, "turn-1"), input(2),
        checkpoint("second", 3, "turn-2"), input(3)], "ctx", ctx);
      const view = await store.loadContext(id, owner);
      assert.equal(view.checkpoint?.seq, 4);
      assert.deepEqual(view.events.map((event) => event.seq), [1, 2, 3, 4, 5]);
      assert.equal(view.truncatedBeforeSeq, undefined);
      const big = sid();
      await store.append(big, 0, Array.from({ length: MAX_SESSION_READ_EVENTS + 5 }, (_, i) => input(i + 1)), "big", ctx);
      const bounded = await store.loadContext(big, owner);
      assert.equal(bounded.events.length, MAX_SESSION_READ_EVENTS);
      assert.equal(bounded.truncatedBeforeSeq, 6);
      assert.deepEqual(await store.loadContext(sid(), owner), { events: [] });
    });

    test("claim, append under the lease, renew and finish", async () => {
      const store = make(); const id = sid();
      const first = await claim(store, id, "req-1");
      assert.equal(first.kind, "acquired");
      if (first.kind !== "acquired") return;
      assert.equal(first.seq, 1);
      assert.equal(first.lease.fencingToken, "1");
      await assert.rejects(store.append(id, 1, [input(2)], "u", ctx), conflict(/Unleased append is forbidden/u));
      const again = await claim(store, id, "req-1");
      assert.equal(again.kind, "in-progress");
      const other = await claim(store, id, "req-2");
      assert.equal(other.kind, "in-progress");
      assert.equal(await store.appendLeased(first.lease, 1, [note(first.lease.turnId)], "l1", ctx), 2);
      const renewed = await store.renewTurn(first.lease, 10_000, owner);
      assert.ok(Date.parse(renewed.expiresAt) > Date.parse(first.lease.expiresAt));
      await assert.rejects(store.finishTurn(first.lease, 2, note(first.lease.turnId), ctx), /terminal event/u);
      assert.equal(await store.finishTurn(first.lease, 2, { type: "turn/end", turnId: first.lease.turnId, payload: { status: "completed" } }, ctx), 3);
      assert.deepEqual(await claim(store, id, "req-1"), { kind: "completed", turnId: first.lease.turnId, seq: 3 });
      await assert.rejects(claim(store, id, "req-1", 5_000, "t", "other-fp"), conflict(/reused with a different request/u));
      await assert.rejects(store.appendLeased(first.lease, 3, [input(9)], "l2", ctx), conflict(/Turn lease lost/u));
      const next = await claim(store, id, "req-3");
      assert.equal(next.kind === "acquired" && next.lease.fencingToken, "2");
    });

    test("an expired lease is repaired by the next claim and rejects its old owner", async () => {
      const store = make(); const id = sid();
      const first = await claim(store, id, "req-a", 120);
      assert.equal(first.kind, "acquired");
      if (first.kind !== "acquired") return;
      await sleep(250);
      await untilWallClockPasses(first.lease.expiresAt);
      await assert.rejects(store.appendLeased(first.lease, 1, [input(2)], "late", ctx), conflict(/Turn lease (lost or )?expired/u));
      await assert.rejects(store.renewTurn(first.lease, 1_000, owner), conflict(/Turn lease (lost or )?expired/u));
      const second = await claim(store, id, "req-b");
      assert.equal(second.kind, "acquired");
      const types = (await store.load(id, owner)).map((event) => event.type);
      assert.deepEqual(types, ["user/input", "turn/failed", "user/input"]);
      assert.deepEqual(await claim(store, id, "req-a", 120, "t-req-a"), { kind: "failed", turnId: "t-req-a", code: "worker-lost" });
    });

    test("tenants and owners are isolated", async () => {
      const store = make(); const id = sid();
      await store.append(id, 0, [input(1)], "k", ctx);
      assert.deepEqual(await store.load(id, security("tenant-b", "user-a")), []);
      assert.equal(await store.append(id, 0, [input(7)], "k", { security: security("tenant-b", "user-a"), runtime }), 1);
      // SQL engines answer "nothing here" so an id never reveals that another user owns it; the
      // in-memory and Redis stores refuse. Either way the other owner sees no event.
      const seen = await store.load(id, security("tenant-a", "user-b")).catch((error: unknown) => {
        assert.ok(error instanceof AgenticError && error.code === "denied", String(error)); return [];
      });
      assert.deepEqual(seen, []);
      await assert.rejects(store.append(id, 1, [input(2)], "k9", { security: security("tenant-a", "user-b"), runtime }), /owner boundary/u);
      assert.equal((await store.load(id, owner)).length, 1);
    });

    test("a session is bound to one agent profile", async () => {
      const store = make(); const id = sid();
      await store.claimTurn({ sessionId: id, turnId: "t1", ownerId: "w", idempotencyKey: "a", requestFingerprint: "f", agentProfileId: "p1", leaseTtlMs: 5_000, startEvents: [input(1, "t1")] }, ctx);
      await assert.rejects(store.claimTurn({ sessionId: id, turnId: "t2", ownerId: "w", idempotencyKey: "b", requestFingerprint: "f", agentProfileId: "p2", leaseTtlMs: 5_000, startEvents: [] }, ctx), /different agent profile/u);
    });

    test("listSessions pages newest first for the owner and profile", async () => {
      const store = make(); if (!store.listSessions) return;
      const who = security(`tenant-${crypto.randomUUID()}`, "lister"); const c = { security: who, runtime };
      const ids = [sid(), sid(), sid()];
      for (const id of ids) { await store.append(id, 0, [input(1)], `k-${id}`, c); await sleep(5); }
      const untitled = sid();
      await store.append(untitled, 0, [note()], "noinput", c);
      // Every session with an event is listed, newest first; one without a user input has no title.
      const page1 = await store.listSessions({ limit: 2 }, who);
      assert.deepEqual(page1.map((entry) => entry.sessionId), [untitled, ids[2]]);
      assert.equal(page1[0]?.firstInput, undefined);
      assert.deepEqual(page1[1]?.firstInput, { content: "message 1", source: "test" });
      const last = page1[1]!;
      const page2 = await store.listSessions({ limit: 2, before: { createdAt: last.createdAt, sessionId: last.sessionId } }, who);
      assert.deepEqual(page2.map((entry) => entry.sessionId), [ids[1], ids[0]]);
      assert.deepEqual(await store.listSessions({ limit: 5 }, security(who.tenantId, "other")), []);
      await assert.rejects(store.listSessions({ limit: 0 }, who), /page size/u);
    });
  });
}
