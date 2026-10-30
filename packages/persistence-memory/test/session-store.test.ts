import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SESSION_READ_EVENTS, type RuntimeSnapshot, type SecurityContext } from "@0xsyncroot/contracts";
import { InMemorySessionStore } from "@0xsyncroot/persistence-memory";

const runtime: RuntimeSnapshot = {
  id: "memory-test", coreVersion: "1.0.0", pluginSetId: "memory", policyRevision: "test", memoryPolicyRevision: "test",
  createdAt: new Date(0).toISOString(),
};

function security(tenantId: string, actorId: string): SecurityContext {
  return { tenantId, actorId, permissions: new Set(["*"]), correlationId: crypto.randomUUID(), purpose: "memory-store-test" };
}

async function seed(store: InMemorySessionStore, owner: SecurityContext, count: number): Promise<void> {
  const drafts = Array.from({ length: count }, (_, index) => ({
    type: "user/input", turnId: `turn-${index + 1}`, payload: { content: `message ${index + 1}`, source: "test" },
  }));
  await store.append("session-since", 0, drafts, "seed", { security: owner, runtime });
}

test("loadSince returns what was written after a sequence, oldest first, and no more than asked", async () => {
  const store = new InMemorySessionStore();
  const owner = security("tenant-a", "user-a");
  await seed(store, owner, 12);
  assert.deepEqual((await store.loadSince("session-since", 9, owner, 10)).map((event) => event.seq), [10, 11, 12]);
  assert.deepEqual((await store.loadSince("session-since", 3, owner, 4)).map((event) => event.seq), [4, 5, 6, 7],
    "a full page means the caller cannot know more exist, which is its cue to reload the bounded context");
  assert.deepEqual(await store.loadSince("session-since", 12, owner, 10), [], "a view that is up to date reads nothing");
  assert.deepEqual(await store.loadSince("session-unknown", 0, owner, 10), []);

  const tail = await store.loadSince("session-since", 11, owner, 1);
  await store.append("session-since", 12, [{ type: "user/input", turnId: "turn-13", payload: { content: "later", source: "test" } }],
    "later", { security: owner, runtime });
  assert.deepEqual(tail.map((event) => event.seq), [12], "an earlier read is a snapshot, not a live window over the journal");
  assert.deepEqual((await store.loadSince("session-since", 12, owner, 10)).map((event) => event.seq), [13]);
});

test("loadSince keeps the session's tenant and owner boundary and the bounded-read limits", async () => {
  const store = new InMemorySessionStore();
  const owner = security("tenant-a", "user-a");
  await seed(store, owner, 2);
  await assert.rejects(store.loadSince("session-since", 0, security("tenant-a", "user-b"), 10), /owner boundary/u);
  assert.deepEqual(await store.loadSince("session-since", 0, security("tenant-b", "user-a"), 10), [],
    "another tenant's session of the same name is a different session");
  await assert.rejects(store.loadSince("session-since", 0, owner, 0), /limit must be from 1 to 1000/u);
  await assert.rejects(store.loadSince("session-since", 0, owner, MAX_SESSION_READ_EVENTS + 1), /limit must be from 1 to 1000/u);
  await assert.rejects(store.loadSince("session-since", -1, owner, 10), /afterSeq/u);
  await assert.rejects(store.loadSince("session-since", 1.5, owner, 10), /afterSeq/u);
});
