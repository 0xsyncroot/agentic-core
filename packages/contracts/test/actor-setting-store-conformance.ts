import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AgenticError, type ActorSettingStore } from "@0xsyncroot/contracts";

/**
 * The ActorSettingStore contract as executable cases. Every engine — in-memory, Redis, MySQL, PostgreSQL, SQL Server — runs
 * these unchanged, so a deployment that changes its database keeps the same settings behaviour.
 */
const scope = (tenantId: string, actorId: string) => ({ tenantId, actorId });
const unique = () => crypto.randomUUID();
const failsWith = (code: string) => (error: unknown) => error instanceof AgenticError && error.code === code;

export function actorSettingConformance(name: string, make: () => ActorSettingStore): void {
  describe(`${name} actor setting store`, () => {
    test("a setting nobody wrote reads as absent; a written one reads back as it was stored", async () => {
      const store = make(); const who = scope(`tenant-${unique()}`, `actor-${unique()}`);
      assert.equal(await store.get(who, "approval-mode"), undefined);
      const written = await store.put(who, "approval-mode", "standing");
      assert.equal(written.key, "approval-mode");
      assert.equal(written.value, "standing");
      assert.ok(written.revision.length > 0 && written.revision.length <= 64, written.revision);
      assert.ok(Number.isFinite(Date.parse(written.updatedAt)), written.updatedAt);
      assert.deepEqual(await store.get(who, "approval-mode"), written);
    });

    test("each write gets a new revision and the newest value wins", async () => {
      const store = make(); const who = scope(`tenant-${unique()}`, `actor-${unique()}`);
      const first = await store.put(who, "approval-mode", "standing");
      const second = await store.put(who, "approval-mode", "ask");
      assert.notEqual(second.revision, first.revision);
      assert.equal((await store.get(who, "approval-mode"))?.value, "ask");
      assert.ok(Date.parse(second.updatedAt) >= Date.parse(first.updatedAt));
    });

    test("tenants, people and keys are kept apart, whatever characters their ids hold", async () => {
      const store = make(); const tenant = `t:{${unique()}}|x`; const actor = `a|b:{c}-${unique()}`;
      await store.put(scope(tenant, actor), "approval-mode", "standing");
      assert.equal(await store.get(scope(tenant, `${actor}-other`), "approval-mode"), undefined, "another person in the tenant");
      assert.equal(await store.get(scope(`${tenant}-other`, actor), "approval-mode"), undefined, "the same id in another tenant");
      assert.equal(await store.get(scope(tenant, actor), "other.key"), undefined, "another key of the same person");
      // "t:{…}" + "|" + "x|a|b…" joins to the same text as the tenant and actor above.
      assert.equal(await store.get(scope(tenant.slice(0, -2), `x|${actor}`), "approval-mode"), undefined, "ids that concatenate alike");
      assert.equal((await store.get(scope(tenant, actor), "approval-mode"))?.value, "standing");
    });

    test("a write that names the revision it read goes through only while that revision is current", async () => {
      const store = make(); const who = scope(`tenant-${unique()}`, `actor-${unique()}`);
      await assert.rejects(store.put(who, "approval-mode", "standing", "never-written"), failsWith("conflict"), "a missing setting has no revision");
      const first = await store.put(who, "approval-mode", "standing");
      const second = await store.put(who, "approval-mode", "ask", first.revision);
      assert.equal(second.value, "ask");
      await assert.rejects(store.put(who, "approval-mode", "standing", first.revision), failsWith("conflict"), "a stale revision");
      assert.deepEqual(await store.get(who, "approval-mode"), second, "a refused write changes nothing");
    });

    test("only text of the bounded size is stored: a flag, an oversize value or a malformed key is refused", async () => {
      const store = make(); const who = scope(`tenant-${unique()}`, `actor-${unique()}`);
      await assert.rejects(store.put(who, "approval-mode", true as never), failsWith("validation"));
      await assert.rejects(store.put(who, "approval-mode", "x".repeat(257)), failsWith("validation"));
      await assert.rejects(store.put(who, "Approval Mode", "ask"), failsWith("validation"));
      await assert.rejects(store.get(scope("", "actor"), "approval-mode"), failsWith("validation"));
      assert.equal((await store.put(who, "approval-mode", "x".repeat(256))).value.length, 256, "the bound itself is stored");
      assert.equal((await store.put(who, "flag", "0")).value, "0", "a value that looks like a flag stays the text it was");
      assert.equal((await store.get(who, "flag"))?.value, "0");
    });
  });
}
