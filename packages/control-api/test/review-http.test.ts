import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewSessionRecord, ReviewTranscriptEntry } from "@0xsyncroot/contracts";
import {
  parseSessionFilter, pseudonymOf, REVIEW_READER_ROLE, ReviewHttpHandlers, ReviewQueryService, StaticTokenAuthenticator, UsageStatsService, type ReviewErrorCode,
  type UsageStatsServiceOptions,
} from "../src/index.js";
import { MemoryLeases, MemoryPrincipals, MemoryReview, OneShard } from "./review-fixture.js";
import { MemoryUsage } from "./usage-fixture.js";

const TOKEN = "t".repeat(40);
const OTHER = "o".repeat(40);
const MESSAGES: Record<ReviewErrorCode, string> = { unauthorized: "U", forbidden: "F", validation: "V", not_found: "N", internal: "I" };
const KEY = "a".repeat(64);
const NOW = new Date("2026-10-02T00:00:00.000Z");

/** The stats routes are not under test here; the handlers still need a service to build. */
const statsOf = (principals: UsageStatsServiceOptions["principals"], leases = new MemoryLeases()) => new UsageStatsService({
  directory: new OneShard(), principals, projectorId: "review", revision: "rev",
  shard: () => ({ usage: new MemoryUsage(leases), projection: new MemoryReview(leases) }),
});

function record(sessionId: string, startedAt: string, extra: Partial<ReviewSessionRecord> = {}): ReviewSessionRecord {
  return { tenantId: "t1", sessionId, agentId: "agent-a", channel: "live", actorKey: KEY, actorKeyVersion: "1", startedAt, lastTurnAt: startedAt,
    answers: 1, transcriptMaskVersion: "m1.v", ...extra };
}
const entry = (seq: number, role: ReviewTranscriptEntry["role"], body: string, extra: Partial<ReviewTranscriptEntry> = {}): ReviewTranscriptEntry =>
  ({ maskVersion: "m1.v", entrySeq: seq, turnId: "turn-1", role, bodyFormat: role === "assistant" ? "markdown" : "text", body, maskedValues: 0,
    sourceHash: "h".repeat(64), at: "2026-10-01T08:00:00.000Z", ...extra });

async function rig() {
  const review = new MemoryReview(new MemoryLeases());
  const principals = new MemoryPrincipals();
  await principals.ensureSeed({ principalId: "p-reader", issuer: "local", subject: "reader", displayName: "Reader" },
    [{ scopeKind: "platform", scopeId: "", role: REVIEW_READER_ROLE }]);
  await principals.ensureSeed({ principalId: "p-scoped", issuer: "local", subject: "scoped", displayName: "Scoped" },
    [{ scopeKind: "agent", scopeId: "agent-b", role: REVIEW_READER_ROLE }]);
  await principals.ensureSeed({ principalId: "p-none", issuer: "local", subject: "none", displayName: "None" }, []);
  const service = new ReviewQueryService({ directory: new OneShard(), shard: () => review, principals, agentNames: { "agent-a": "Agent A" }, now: () => NOW });
  const authenticator = new StaticTokenAuthenticator([{ token: TOKEN, principalId: "p-reader" }, { token: OTHER, principalId: "p-none" },
    { token: "s".repeat(40), principalId: "p-scoped" }]);
  return { review, principals, http: new ReviewHttpHandlers({ authenticator, service, stats: statsOf(principals), messages: MESSAGES }) };
}
const bearer = (token: string) => `Bearer ${token}`;

test("a missing or wrong token is 401 and a principal without the reader role is 403", async () => {
  const { http } = await rig();
  assert.deepEqual(await http.me(undefined), { status: 401, body: { error: { code: "unauthorized", message: "U" } } });
  assert.equal((await http.me(bearer(`${TOKEN}x`))).status, 401);
  assert.equal((await http.me(`Basic ${TOKEN}`)).status, 401);
  assert.deepEqual(await http.sessions(bearer(OTHER), {}), { status: 403, body: { error: { code: "forbidden", message: "F" } } });
  assert.deepEqual(await http.me(bearer(TOKEN)), { status: 200, body: { principalId: "p-reader", displayName: "Reader", roles: [REVIEW_READER_ROLE] } });
  assert.deepEqual((await http.me(bearer("s".repeat(40)))).body, { principalId: "p-scoped", displayName: "Scoped", roles: [`${REVIEW_READER_ROLE}@agent-b`] });
  assert.deepEqual(http.health(), { status: 200, body: { status: "ok" } });
  assert.throws(() => new StaticTokenAuthenticator([{ token: "short", principalId: "p" }]), /32/u);
});

test("the list pages newest first with a cursor and leaves one audit row per call", async () => {
  const { http, review, principals } = await rig();
  for (let day = 1; day <= 5; day += 1) review.sessions.set(`t1|s${day}`, record(`s${day}`, `2026-10-0${day}T08:00:00.000Z`));
  review.entries.set("t1|s5|m1.v|1", entry(1, "user", "Hi [Name 1], ".repeat(30)));
  review.tenantNames.set("t1", "Tenant One");
  const first = await http.sessions(bearer(TOKEN), { limit: "2" });
  const body = first.body as { items: { sessionId: string; pseudonym: string; preview: string; tenantName?: string }[]; nextCursor?: string };
  assert.deepEqual(body.items.map((item) => item.sessionId), ["s5", "s4"]);
  assert.equal(body.items[0]?.pseudonym, pseudonymOf(KEY));
  assert.equal(body.items[0]?.preview.length, 160);
  assert.equal(body.items[0]?.tenantName, "Tenant One");
  assert.equal(body.items[1]?.preview, "");
  const second = (await http.sessions(bearer(TOKEN), { limit: "2", cursor: body.nextCursor })).body as typeof body;
  assert.deepEqual(second.items.map((item) => item.sessionId), ["s3", "s2"]);
  const last = (await http.sessions(bearer(TOKEN), { limit: "2", cursor: second.nextCursor })).body as typeof body;
  assert.deepEqual(last.items.map((item) => item.sessionId), ["s1"]);
  assert.equal(last.nextCursor, undefined);
  const range = (await http.sessions(bearer(TOKEN), { from: "2026-10-02T00:00:00Z", to: "2026-10-04T08:00:00.000Z", q: "s" })).body as typeof body;
  assert.deepEqual(range.items.map((item) => item.sessionId), ["s3", "s2"]);
  assert.equal(principals.audits.length, 4);
  assert.deepEqual({ ...principals.audits[0], detail: JSON.parse(principals.audits[0]?.detail ?? "{}") }, {
    scopeKind: "platform", scopeId: "", principalId: "p-reader", actorScope: "console", action: "review.list", targetKind: "review_session",
    targetId: "*", detail: { limit: 2 }, at: NOW.toISOString(),
  });
});

test("a scoped reader lists only its agents and cannot open another agent's conversation", async () => {
  const { http, review } = await rig();
  review.sessions.set("t1|a", record("a", "2026-10-01T08:00:00.000Z"));
  review.sessions.set("t1|b", record("b", "2026-10-01T09:00:00.000Z", { agentId: "agent-b" }));
  const scoped = bearer("s".repeat(40));
  assert.deepEqual(((await http.sessions(scoped, {})).body as { items: { sessionId: string }[] }).items.map((item) => item.sessionId), ["b"]);
  assert.equal((await http.session(scoped, "t1", "a")).status, 404);
  assert.equal((await http.session(scoped, "t1", "b")).status, 200);
});

test("opening a conversation writes the access row first and names the agent on its answers", async () => {
  const { http, review } = await rig();
  review.sessions.set("t1|s1", record("s1", "2026-10-01T08:00:00.000Z", { answers: 2 }));
  review.entries.set("t1|s1|m1.v|1", entry(1, "user", "Salary of [Name 1]?", { maskedValues: 1 }));
  review.entries.set("t1|s1|m1.v|2", entry(2, "tool", "", { toolLabels: [{ toolId: "profile", label: "Read profile" }] }));
  review.entries.set("t1|s1|m1.v|3", entry(3, "assistant", "[Name 1] earns [Amount 1].", { maskedValues: 2, answerIndex: 1 }));
  review.entries.set("t1|s1|other|1", entry(1, "user", "stale version"));
  const opened = await http.session(bearer(TOKEN), "t1", "s1");
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.body, {
    tenantId: "t1", sessionId: "s1", pseudonym: pseudonymOf(KEY), startedAt: "2026-10-01T08:00:00.000Z", maskVersion: "m1.v", answers: 2,
    entries: [
      { seq: 1, turnId: "turn-1", role: "user", at: "2026-10-01T08:00:00.000Z", text: "Salary of [Name 1]?" },
      { seq: 2, turnId: "turn-1", role: "tool", at: "2026-10-01T08:00:00.000Z", text: "", tools: [{ toolId: "profile", label: "Read profile" }] },
      { seq: 3, turnId: "turn-1", role: "assistant", at: "2026-10-01T08:00:00.000Z", text: "[Name 1] earns [Amount 1].", agentName: "Agent A" },
    ],
    masking: { values: 3 },
  });
  assert.deepEqual(review.access, [{ tenantId: "t1", principalId: "p-reader", sessionId: "s1", action: "open", purpose: "review", at: NOW.toISOString() }]);
  assert.equal((await http.session(bearer(TOKEN), "t1", "missing")).status, 404);
  review.sessions.set("t1|unbuilt", (({ transcriptMaskVersion: _mask, ...rest }) => rest)(record("unbuilt", "2026-10-01T08:00:00.000Z")));
  assert.equal((await http.session(bearer(TOKEN), "t1", "unbuilt")).status, 404);
  assert.equal(review.access.length, 3, "an open that finds nothing still records its attempt");
});

test("every read records its attempt first, so a read that fails still leaves its audit or access row", async () => {
  const { http, review, principals } = await rig();
  review.listSessions = async () => { throw new Error("shard down"); };
  review.session = async () => { throw new Error("shard down"); };
  assert.equal((await http.sessions(bearer(TOKEN), { tenantId: "t1", limit: "5" })).status, 500);
  assert.deepEqual(principals.audits.map((row) => [row.action, row.targetId, JSON.parse(row.detail ?? "{}")]), [["review.list", "t1", { tenantId: "t1", limit: 5 }]]);
  assert.equal((await http.session(bearer(TOKEN), "t1", "s1")).status, 500);
  assert.deepEqual(review.access.map((row) => [row.tenantId, row.sessionId, row.action]), [["t1", "s1", "open"]]);
  assert.equal((await http.sessions(bearer(TOKEN), { cursor: "not-a-cursor" })).status, 400);
  assert.equal(principals.audits.length, 1, "input refused as validation reads nothing and records nothing");
});

test("every route checks the role before its parameters: no role and bad input is 403, and nothing is recorded", async () => {
  const { http, principals, review } = await rig();
  const forbidden = { status: 403, body: { error: { code: "forbidden", message: "F" } } };
  for (const query of [{ limit: "0" }, { from: "yesterday" }, { tenantId: "a\u0000b" }, { cursor: "not-a-cursor" }]) {
    assert.deepEqual(await http.sessions(bearer(OTHER), query), forbidden, JSON.stringify(query));
  }
  assert.deepEqual(await http.session(bearer(OTHER), "t1", "x".repeat(201)), forbidden);
  assert.deepEqual(await http.session(bearer(OTHER), "", "s1"), forbidden);
  assert.deepEqual(await http.statsOverview(bearer(OTHER), { from: "x" }), forbidden);
  assert.deepEqual(await http.statsSeries(bearer(OTHER), { bucket: "month" }), forbidden);
  assert.deepEqual(await http.statsOverview(bearer(TOKEN), {}), forbidden, "the review role is not the stats role");
  assert.equal(principals.audits.length, 0);
  assert.equal(review.access.length, 0);
});

test("the list query is refused outside its documented range rather than clamped", async () => {
  const { http } = await rig();
  for (const query of [{ limit: "0" }, { limit: "51" }, { limit: "2.5" }, { limit: ["1", "2"] }, { from: "yesterday" }, { from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" },
    { tenantId: "a\u0000b" }, { q: "x".repeat(201) }, { cursor: "not-a-cursor" }]) {
    assert.deepEqual(await http.sessions(bearer(TOKEN), query), { status: 400, body: { error: { code: "validation", message: "V" } } }, JSON.stringify(query));
  }
  assert.equal((await http.session(bearer(TOKEN), "t1", "x".repeat(201))).status, 400);
  assert.deepEqual(parseSessionFilter({ from: "2026-10-01T07:00:00+07:00" }), { limit: 30, from: "2026-10-01T00:00:00.000Z" });
});

test("an unexpected failure is answered as internal and handed to the log hook", async () => {
  const seen: unknown[] = [];
  const principals = new MemoryPrincipals();
  principals.get = async () => { throw new Error("db down: secret detail"); };
  const http = new ReviewHttpHandlers({ authenticator: new StaticTokenAuthenticator([{ token: TOKEN, principalId: "p" }]), messages: MESSAGES,
    service: new ReviewQueryService({ directory: new OneShard(), shard: () => new MemoryReview(new MemoryLeases()), principals, agentNames: {} }),
    stats: statsOf(principals), onInternalError: (error) => seen.push(error) });
  assert.deepEqual(await http.me(bearer(TOKEN)), { status: 500, body: { error: { code: "internal", message: "I" } } });
  assert.equal(seen.length, 1);
});
