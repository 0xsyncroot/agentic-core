import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { RuntimeSnapshot, SecurityContext, SessionDirectoryCursor } from "@0xsyncroot/contracts";
import { Pool } from "pg";
import { PostgresSessionStore } from "../src/session-store.js";
const url = process.env.TEST_DATABASE_URL;

test("session directory pages by creation/id and respects tenant, owner and profile", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url! });
  const sessions = new PostgresSessionStore(pool);
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
  } finally { await pool.end(); }
});
