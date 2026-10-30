import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SHARD_ID, UNRELEASED_RELEASE_ID, type MemberRole, type ShardDirectory, type TurnFact } from "@0xsyncroot/contracts";
import {
  ActorPseudonyms, MAX_USAGE_SERIES_POINTS, REVIEW_READER_ROLE, ReviewHttpHandlers, ReviewQueryService, STATS_READER_ROLE, StaticTokenAuthenticator, UsageStatsService,
} from "../src/index.js";
import { MemoryLeases, MemoryPrincipals, MemoryReview } from "./review-fixture.js";
import { MemoryUsage } from "./usage-fixture.js";

const PSEUDONYMS = new ActorPseudonyms("k".repeat(32), "1");
const TOKEN = "t".repeat(32);
const MESSAGES = { unauthorized: "u", forbidden: "f", validation: "v", not_found: "n", internal: "i" };
const REVISION = "rev-1";
const NOW = new Date("2026-11-01T00:00:00.000Z");

/** A fact with the given overrides; a key mapped to undefined is left out, as an absent measure is. */
const fact = (tenantId: string, actorId: string, startedAt: string, extra: { [K in keyof TurnFact]?: TurnFact[K] | undefined } = {}): TurnFact => withoutUndefined({
  tenantId, sessionId: `s-${actorId}`, turnId: `turn-${startedAt}-${actorId}`, agentId: "agent-a", channel: "live", releaseId: UNRELEASED_RELEASE_ID,
  runtimeSnapshotId: "r", origin: "user", actorKey: PSEUDONYMS.actorKey(tenantId, actorId), actorKeyVersion: "1", startedAt,
  endedAt: startedAt, status: "completed", responseMs: 3000, firstOutputMs: 1000, steps: 1, toolCalls: 0, toolFailed: 0, toolRefused: 0, cards: 0,
  inputTokens: 0, outputTokens: 0, sourceLastSeq: 1, ...extra,
});
function withoutUndefined(value: Record<string, unknown>): TurnFact {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as unknown as TurnFact;
}

const shards = (ids: readonly string[]): ShardDirectory => ({
  shards: async () => ids.map((shardId) => ({ shardId, status: "active" as const, weight: 1 })),
  shardOf: async () => ids[0] ?? DEFAULT_SHARD_ID, mapVersion: async () => 0,
});

async function rig(roles: readonly MemberRole[] = [{ scopeKind: "platform", scopeId: "", role: STATS_READER_ROLE }], shardIds = [DEFAULT_SHARD_ID]) {
  const leases = new MemoryLeases();
  const principals = new MemoryPrincipals();
  await principals.ensureSeed({ principalId: "p1", issuer: "local", subject: "s", displayName: "Admin" }, roles);
  const stores = new Map(shardIds.map((id) => [id, { usage: new MemoryUsage(leases), projection: new MemoryReview(leases) }]));
  const stats = new UsageStatsService({
    directory: shards(shardIds), principals, projectorId: "review", revision: REVISION, now: () => NOW,
    shard: (shardId) => { const store = stores.get(shardId); if (!store) throw new Error(`no shard ${shardId}`); return store; },
  });
  const review = new ReviewQueryService({ directory: shards(shardIds), shard: () => { throw new Error("unused"); }, principals, agentNames: {} });
  const handlers = new ReviewHttpHandlers({ authenticator: new StaticTokenAuthenticator([{ token: TOKEN, principalId: "p1" }]), service: review, stats, messages: MESSAGES });
  const put = async (shardId: string, facts: TurnFact[]) => { const store = stores.get(shardId)!; await store.usage.saveTurnFacts(facts, REVISION, { workerKind: "w", fencingToken: "1" }); };
  return { stores, principals, handlers, leases, put, auth: `Bearer ${TOKEN}` };
}

const OCTOBER = { from: "2026-10-01T00:00:00+07:00", to: "2026-11-01T00:00:00+07:00" };

/** The memory fence check needs a held lease named like the save's fence. */
const hold = (leases: MemoryLeases) => leases.held.set("w", { workerKind: "w", owner: "o", fencingToken: "1", expiresAt: "2999-01-01T00:00:00.000Z" });

test("overview counts usage turns, distinct tenants and users, means as sum over count, and the watermark", async () => {
  const { stores, handlers, leases, put, auth } = await rig();
  hold(leases);
  await put(DEFAULT_SHARD_ID, [
    fact("t1", "a", "2026-09-20T03:00:00.000Z"),
    fact("t1", "a", "2026-10-02T03:00:00.000Z", { firstOutputMs: 2000, responseMs: 5000 }),
    fact("t1", "a", "2026-10-03T03:00:00.000Z"),
    fact("t2", "b", "2026-10-05T03:00:00.000Z", { firstOutputMs: undefined }),
    fact("t2", "b", "2026-10-06T03:00:00.000Z", { origin: "continuation", firstOutputMs: 90000 }),
    fact("t3", "c", "2026-11-02T03:00:00.000Z"),
  ]);
  stores.get(DEFAULT_SHARD_ID)!.projection.marks.set("review", { projectorId: "review", watermarkAt: "2026-10-31T10:00:00.000000Z", projectorRevision: REVISION });
  const response = await handlers.statsOverview(auth, OCTOBER);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    from: "2026-09-30T17:00:00.000Z", to: "2026-10-31T17:00:00.000Z", tenantsUsed: 2, tenantsActivated: 2, activeUsers: 2, turns: 3,
    avgFirstOutputMs: 1500, avgResponseMs: 3667, updatedAt: "2026-10-31T10:00:00.000Z",
  });
});

test("an empty range has null means; a watermark of another revision is not an update time", async () => {
  const { stores, handlers, auth } = await rig();
  stores.get(DEFAULT_SHARD_ID)!.projection.marks.set("review", { projectorId: "review", watermarkAt: "2026-10-31T10:00:00.000Z", projectorRevision: "old" });
  const body = (await handlers.statsOverview(auth, OCTOBER)).body as Record<string, unknown>;
  assert.deepEqual([body.turns, body.avgFirstOutputMs, body.avgResponseMs, body.updatedAt], [0, null, null, null]);
});

test("series gives Monday weeks cut to the range, empty ones included, counted exactly per bucket", async () => {
  const { handlers, leases, put, auth } = await rig();
  hold(leases);
  await put(DEFAULT_SHARD_ID, [fact("t1", "a", "2026-10-01T03:00:00.000Z"), fact("t1", "a", "2026-10-02T03:00:00.000Z"), fact("t2", "b", "2026-10-13T03:00:00.000Z")]);
  const body = (await handlers.statsSeries(auth, { ...OCTOBER, bucket: "week" })).body as { bucket: string; points: Record<string, unknown>[]; updatedAt: unknown };
  assert.equal(body.bucket, "week");
  assert.deepEqual(body.points.map((point) => [point.start, point.end, point.turns, point.activeUsers, point.tenantsActivated]), [
    ["2026-09-30T17:00:00.000Z", "2026-10-04T17:00:00.000Z", 2, 1, 1],
    ["2026-10-04T17:00:00.000Z", "2026-10-11T17:00:00.000Z", 0, 0, 1],
    ["2026-10-11T17:00:00.000Z", "2026-10-18T17:00:00.000Z", 1, 1, 2],
    ["2026-10-18T17:00:00.000Z", "2026-10-25T17:00:00.000Z", 0, 0, 2],
    ["2026-10-25T17:00:00.000Z", "2026-10-31T17:00:00.000Z", 0, 0, 2],
  ]);
  assert.equal(body.updatedAt, null);
});

test("shards are added up and the update time is the earliest shard watermark", async () => {
  const { stores, handlers, leases, put, auth } = await rig(undefined, ["a", "b"]);
  hold(leases);
  await put("a", [fact("t1", "x", "2026-10-02T03:00:00.000Z", { responseMs: 1000 })]);
  await put("b", [fact("t2", "x", "2026-10-02T03:00:00.000Z", { responseMs: 2000 })]);
  stores.get("a")!.projection.marks.set("review", { projectorId: "review", watermarkAt: "2026-10-31T10:00:00.000Z", projectorRevision: REVISION });
  stores.get("b")!.projection.marks.set("review", { projectorId: "review", watermarkAt: "2026-10-30T10:00:00.000Z", projectorRevision: REVISION });
  const body = (await handlers.statsOverview(auth, OCTOBER)).body as Record<string, unknown>;
  assert.deepEqual([body.tenantsUsed, body.activeUsers, body.turns, body.avgResponseMs, body.updatedAt], [2, 2, 2, 1500, "2026-10-30T10:00:00.000Z"]);
});

test("an agent-scoped reader sees its agents only; every read leaves one audit row", async () => {
  const { stores, principals, handlers, leases, put, auth } = await rig([{ scopeKind: "agent", scopeId: "agent-b", role: STATS_READER_ROLE }]);
  hold(leases);
  await put(DEFAULT_SHARD_ID, [fact("t1", "a", "2026-10-02T03:00:00.000Z"), fact("t1", "b", "2026-10-03T03:00:00.000Z", { agentId: "agent-b" })]);
  assert.equal(((await handlers.statsOverview(auth, OCTOBER)).body as { turns: number }).turns, 1);
  await handlers.statsSeries(auth, { ...OCTOBER, bucket: "day" });
  assert.deepEqual(stores.get(DEFAULT_SHARD_ID)!.usage.queries.map((query) => query.agentIds), [["agent-b"], ["agent-b"]]);
  assert.deepEqual(principals.audits.map((row) => [row.action, row.targetKind, row.targetId, row.principalId, row.actorScope]),
    [["stats.overview", "usage_stats", "*", "p1", "console"], ["stats.series", "usage_stats", "*", "p1", "console"]]);
  assert.deepEqual(JSON.parse(principals.audits[1]?.detail ?? "{}"), { from: "2026-09-30T17:00:00.000Z", to: "2026-10-31T17:00:00.000Z", bucket: "day" });
});

test("the audit row is written before the figures are read, so a read that fails still leaves it", async () => {
  const { stores, principals, handlers, leases, auth } = await rig();
  hold(leases);
  const order: string[] = [];
  const usage = stores.get(DEFAULT_SHARD_ID)!.usage;
  const audit = principals.audit.bind(principals);
  principals.audit = async (row) => { order.push(row.action); return audit(row); };
  const overview = usage.overview.bind(usage);
  usage.overview = async (query) => { order.push("read overview"); return overview(query); };
  usage.series = async () => { order.push("read series"); throw new Error("shard down"); };
  assert.equal((await handlers.statsOverview(auth, OCTOBER)).status, 200);
  assert.equal((await handlers.statsSeries(auth, { ...OCTOBER, bucket: "day" })).status, 500);
  assert.deepEqual(order, ["stats.overview", "read overview", "stats.series", "read series"]);
  assert.equal(principals.audits.length, 2);
  usage.overview = async () => { throw new Error("shard down"); };
  assert.equal((await handlers.statsOverview(auth, OCTOBER)).status, 500);
  assert.deepEqual(principals.audits.map((row) => row.action), ["stats.overview", "stats.series", "stats.overview"], "a failing overview still leaves its row");
});

test("a reader without the stats role is refused and leaves no audit; bad input is validation", async () => {
  const reviewer = await rig([{ scopeKind: "platform", scopeId: "", role: REVIEW_READER_ROLE }]);
  assert.equal((await reviewer.handlers.statsOverview(reviewer.auth, OCTOBER)).status, 403);
  for (const query of [{}, { from: OCTOBER.to, to: OCTOBER.from }]) {
    assert.equal((await reviewer.handlers.statsOverview(reviewer.auth, query)).status, 403, `no role and ${JSON.stringify(query)} is forbidden, not validation`);
  }
  assert.equal((await reviewer.handlers.statsSeries(reviewer.auth, { ...OCTOBER, bucket: "month" })).status, 403, "the role is checked before the bucket");
  assert.equal(reviewer.principals.audits.length, 0);
  const { handlers, auth } = await rig();
  assert.equal((await handlers.statsOverview(undefined, OCTOBER)).status, 401);
  for (const query of [{}, { from: OCTOBER.from }, { ...OCTOBER, from: "2026-10-01" }, { from: OCTOBER.to, to: OCTOBER.from }, { ...OCTOBER, from: [OCTOBER.from, OCTOBER.from] }]) {
    assert.equal((await handlers.statsOverview(auth, query)).status, 400, JSON.stringify(query));
  }
  for (const bucket of [undefined, "month", ""]) assert.equal((await handlers.statsSeries(auth, { ...OCTOBER, bucket })).status, 400, String(bucket));
  assert.deepEqual((await handlers.statsSeries(auth, { ...OCTOBER, bucket: "month" })).body, { error: { code: "validation", message: "v" } });
});

test("a stats-only reader signs in through /me and is refused the conversations; a principal with no known role is refused /me", async () => {
  const { handlers, auth } = await rig();
  assert.deepEqual(await handlers.me(auth), { status: 200, body: { principalId: "p1", displayName: "Admin", roles: [STATS_READER_ROLE] } });
  assert.equal((await handlers.sessions(auth, {})).status, 403);
  const stranger = await rig([{ scopeKind: "platform", scopeId: "", role: "billing.writer" }]);
  assert.equal((await stranger.handlers.me(stranger.auth)).status, 403);
  const scoped = await rig([{ scopeKind: "agent", scopeId: "agent-b", role: STATS_READER_ROLE }]);
  assert.deepEqual(((await scoped.handlers.me(scoped.auth)).body as { roles: string[] }).roles, [`${STATS_READER_ROLE}@agent-b`]);
});

test(`a series is refused as validation beyond ${MAX_USAGE_SERIES_POINTS} points and answered up to them`, async () => {
  const { handlers, auth, principals } = await rig();
  const local = (day: number) => new Date(Date.UTC(2026, 0, 1 + day) - 7 * 3_600_000).toISOString();
  const days = (count: number) => ({ from: local(0), to: local(count), bucket: "day" });
  const full = await handlers.statsSeries(auth, days(MAX_USAGE_SERIES_POINTS));
  assert.equal(full.status, 200);
  assert.equal((full.body as { points: unknown[] }).points.length, MAX_USAGE_SERIES_POINTS);
  assert.deepEqual(await handlers.statsSeries(auth, days(MAX_USAGE_SERIES_POINTS + 1)), { status: 400, body: { error: { code: "validation", message: "v" } } });
  assert.equal((await handlers.statsSeries(auth, { from: local(1), to: local(0), bucket: "day" })).status, 400, "a reversed range stays validation");
  assert.equal((await handlers.statsSeries(auth, { from: "1970-01-01T00:00:00Z", to: "2999-01-01T00:00:00Z", bucket: "week" })).status, 400);
  assert.equal((await handlers.statsSeries(auth, { from: "1970-01-01T00:00:00Z", to: "2999-01-01T00:00:00Z", bucket: "day" })).status, 400);
  const midweek = { from: "2026-01-07T00:00:00+07:00", to: new Date(Date.parse("2026-01-07T00:00:00+07:00") + 399 * 7 * 86_400_000).toISOString(), bucket: "week" };
  const weeks = await handlers.statsSeries(auth, midweek);
  assert.equal((weeks.body as { points: unknown[] }).points.length, MAX_USAGE_SERIES_POINTS, "a range cut mid-week counts its partial first and last weeks");
  assert.equal(principals.audits.filter((row) => row.action === "stats.series").length, 2, "a refused series reads nothing and records nothing");
});
