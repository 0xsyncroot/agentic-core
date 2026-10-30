import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { RuntimeSnapshot, SecurityContext, SessionDirectoryCursor } from "@0xsyncroot/contracts";
import { createPool } from "mysql2/promise";
import { MySqlSessionStore } from "../src/session-store.js";
const url = process.env.TEST_MYSQL_URL;

test("session directory pages by creation/id and respects tenant, owner and profile", { skip: !url }, async () => {
  const pool = createPool({ uri: url!, timezone: "Z", supportBigNumbers: true, bigNumberStrings: true });
  const sessions = new MySqlSessionStore(pool);
  const security: SecurityContext = { tenantId: `directory-${randomUUID()}`, actorId: "owner", permissions: new Set(), purpose: "test", correlationId: "test" };
  const runtime: RuntimeSnapshot = { id: "test", coreVersion: "1", pluginSetId: "test", policyRevision: "test", memoryPolicyRevision: "test", createdAt: new Date().toISOString() };
  try {
    for (let index = 0; index < 19; index++) {
      const id = `session-${index}`;
      await sessions.claimTurn({ sessionId: id, turnId: id, ownerId: "worker", idempotencyKey: id, requestFingerprint: id,
        agentProfileId: index === 17 ? "other-profile" : "profile", leaseTtlMs: 5000,
        startEvents: [{ type: "user/input", turnId: id, payload: { content: `Review ${index}`, source: "test" } }] },
        { security: index === 18 ? { ...security, actorId: "other-owner" } : security, runtime });
    }
    const ids: string[] = [];
    let before: SessionDirectoryCursor | undefined;
    while (true) {
      const page = await sessions.listSessions({ limit: 7, agentProfileId: "profile", ...(before ? { before } : {}) }, security);
      assert.ok(page.every((entry) => typeof entry.firstInput === "object"));
      ids.push(...page.map((entry) => entry.sessionId));
      if (page.length < 7) break;
      before = page.at(-1)!;
    }
    assert.equal(ids.length, 17);
    assert.equal(new Set(ids).size, 17);
    assert.ok(!ids.includes("session-17") && !ids.includes("session-18"));
    assert.deepEqual(await sessions.listSessions({ limit: 7 }, { ...security, tenantId: "foreign" }), []);
    for (const outsider of [{ ...security, actorId: "foreign-owner" }, { ...security, tenantId: "foreign" }]) {
      assert.deepEqual(await sessions.listSessions({ limit: 7, agentProfileId: "profile" }, outsider), []);
      assert.deepEqual(await sessions.load("session-0", outsider), []);
      assert.deepEqual(await sessions.loadRecent("session-0", 7, outsider), []);
      assert.deepEqual(await sessions.loadSince("session-0", 0, outsider, 7), []);
      assert.deepEqual(await sessions.loadContext("session-0", outsider), { events: [] });
    }
    assert.equal((await sessions.load("session-0", security)).length, 1);
  } finally { await pool.end(); }
});

test("one first input that fails verification leaves its session untitled and does not fail the list", { skip: !url }, async () => {
  const pool = createPool({ uri: url!, timezone: "Z", supportBigNumbers: true, bigNumberStrings: true });
  const setup = createPool({ uri: process.env.TEST_MYSQL_OWNER_URL ?? url!, timezone: "Z" });
  const sessions = new MySqlSessionStore(pool);
  const security: SecurityContext = { tenantId: `directory-${randomUUID()}`, actorId: "owner", permissions: new Set(), purpose: "test", correlationId: "test" };
  const runtime: RuntimeSnapshot = { id: "test", coreVersion: "1", pluginSetId: "test", policyRevision: "test", memoryPolicyRevision: "test", createdAt: new Date().toISOString() };
  const warnings: string[] = [];
  const warn = console.warn;
  try {
    for (const id of ["good", "damaged"]) {
      await sessions.claimTurn({ sessionId: id, turnId: id, ownerId: "worker", idempotencyKey: id, requestFingerprint: id, leaseTtlMs: 5000,
        startEvents: [{ type: "user/input", turnId: id, payload: { content: `Review ${id}`, source: "test" } }] }, { security, runtime });
    }
    await setup.execute("UPDATE agentic_session_event SET integrity_hash=? WHERE tenant_id=? AND session_id=?", ["0".repeat(64), security.tenantId, "damaged"]);
    console.warn = (line: string) => { warnings.push(line); };
    const listed = await sessions.listSessions({ limit: 5 }, security);
    console.warn = warn;
    assert.deepEqual(Object.fromEntries(listed.map((entry) => [entry.sessionId, entry.firstInput])),
      { good: { content: "Review good", source: "test" }, damaged: {} });
    assert.equal(warnings.length, 1, "one log line names the unverifiable input");
    assert.equal(JSON.parse(warnings[0]!).sessionId, "damaged");
    assert.ok(!warnings[0]!.includes("Review"), "the log carries no document content");
    await assert.rejects(sessions.load("damaged", security), /integrity check failed/u, "opening it still refuses");
  } finally {
    console.warn = warn;
    try { await setup.execute("DELETE FROM agentic_session_stream WHERE tenant_id=?", [security.tenantId]); }
    finally { await Promise.all([pool.end(), setup.end()]); }
  }
});
