import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AgenticError, UNRELEASED_RELEASE_ID, usageBuckets, type LeaseFence, type TurnFact, type UsageDailyGroup, type UsageProjectionStore,
  type UsageQueryStore, type WorkerLeaseStore,
} from "@0xsyncroot/contracts";

/**
 * The usage ports as executable cases. Every engine runs them against a store that may hold other tests' rows, so each case
 * works under agents of its own and, where it reads every agent, compares counts before and after its own writes.
 */
export interface UsageEngine {
  readonly projection: UsageProjectionStore;
  readonly query: UsageQueryStore;
  readonly leases: WorkerLeaseStore;
  /** The daily groups stored for one (tenant, agent, day), ordered by (channel, releaseId, origin). */
  daily(tenantId: string, agentId: string, day: string): Promise<readonly UsageDailyGroup[]>;
  /** How one stored fact ends, or undefined when none is stored. */
  ending(tenantId: string, sessionId: string, turnId: string): Promise<UsageEnding | undefined>;
}

export type UsageEnding = Pick<TurnFact, "status" | "endedAt" | "responseMs" | "firstOutputMs">;

const unique = () => crypto.randomUUID();
const fails = (code: string) => (error: unknown) => error instanceof AgenticError && error.code === code;
/** A pseudonymous actor key from one hex digit. */
const key = (digit: string) => digit.repeat(64);
/** The local day the cases start on, a Monday, so day 7 starts the next week. */
const MONDAY = Date.UTC(2031, 2, 10);
/** Local day `MONDAY + day` as `YYYY-MM-DD`. */
const dayOf = (day: number) => new Date(MONDAY + day * 86_400_000).toISOString().slice(0, 10);
/** Local time `hour:minute:second.micro` on day `day`: a local day starts at 17:00 UTC of the UTC day before. */
const at = (day: number, hour: number, minute = 0, second = 0, micro = 0) =>
  new Date(MONDAY + day * 86_400_000 + ((hour - 7) * 60 + minute) * 60_000 + second * 1_000).toISOString().replace(/\.\d{3}Z$/u, `.${String(micro).padStart(6, "0")}Z`);
const lastMicroOfDay = (day: number) => at(day, 23, 59, 59, 999_999);

/** `value` without the optional fields `fields`: a turn that has nothing to measure for them. */
function without(value: TurnFact, ...fields: ("responseMs" | "firstOutputMs" | "firstOutputAt" | "endedAt")[]): TurnFact {
  const copy: { -readonly [K in keyof TurnFact]: TurnFact[K] } = { ...value };
  for (const field of fields) delete copy[field];
  return copy;
}

function fact(agentId: string, tenantId: string, actor: string, startedAt: string, overrides: Partial<TurnFact> = {}): TurnFact {
  return {
    tenantId, sessionId: `s-${unique()}`, turnId: `t-${unique()}`, agentId, channel: "live", releaseId: UNRELEASED_RELEASE_ID, runtimeSnapshotId: "rt-1",
    origin: "user", actorKey: key(actor), actorKeyVersion: "k1", startedAt, endedAt: startedAt, status: "completed", responseMs: 1_200, firstOutputMs: 400,
    firstOutputAt: startedAt, steps: 2, toolCalls: 3, toolFailed: 0, toolRefused: 0, cards: 1, inputTokens: 1_000, outputTokens: 200, sourceLastSeq: 9, ...overrides,
  };
}

export function usageStoreConformance(name: string, make: () => Promise<UsageEngine>): void {
  describe(`${name} usage stores`, () => {
    const fenced = async (engine: UsageEngine): Promise<LeaseFence> => {
      const lease = await engine.leases.acquire(`usage-${unique()}`, "worker-1", 60_000);
      assert.ok(lease);
      return { workerKind: lease.workerKind, fencingToken: lease.fencingToken };
    };
    const range = (agentIds: readonly string[], from = at(0, 0), to = at(7, 0)) => ({ from, to, agentIds });

    test("saving recomputes the daily groups of each touched day from the facts, and a rerun changes nothing", async () => {
      const engine = await make(); const fence = await fenced(engine); const agent = `agent-${unique()}`; const tenant = `tenant-${unique()}`;
      const facts = [
        fact(agent, tenant, "a", at(0, 9), { responseMs: 400 }), fact(agent, tenant, "a", at(0, 10), { status: "partial", responseMs: 2_500, cards: 2 }),
        fact(agent, tenant, "b", at(0, 11), { status: "awaiting_approval", responseMs: 400_000 }),
        fact(agent, tenant, "b", at(0, 12), { status: "awaiting_interaction", responseMs: 500 }),
        fact(agent, tenant, "b", at(0, 13), { status: "failed", responseMs: 501 }),
        without(fact(agent, tenant, "b", at(0, 14), { status: "abandoned" }), "responseMs", "endedAt"),
        fact(agent, tenant, "b", at(0, 15), { origin: "continuation", responseMs: 1_000 }),
        fact(agent, tenant, "b", at(0, 16), { channel: "preview" }),
      ];
      await engine.projection.saveTurnFacts(facts, "r1", fence);
      const groups = await engine.daily(tenant, agent, dayOf(0));
      const histogram = (slots: Record<number, number>) => Array.from({ length: 13 }, (_, slot) => slots[slot] ?? 0);
      const base = { tenantId: tenant, agentId: agent, day: dayOf(0), releaseId: UNRELEASED_RELEASE_ID, projectorRevision: "r1" };
      assert.deepEqual(groups, [
        { ...base, channel: "live", origin: "continuation", turns: 1, completed: 1, partial: 0, paused: 0, failed: 0, cards: 1, toolCalls: 3,
          responseMsSum: 1_000, responseCount: 1, responseHistogram: histogram({ 1: 1 }) },
        { ...base, channel: "live", origin: "user", turns: 6, completed: 1, partial: 1, paused: 2, failed: 1, cards: 7, toolCalls: 18,
          responseMsSum: 400 + 2_500 + 400_000 + 500 + 501, responseCount: 5, responseHistogram: histogram({ 0: 2, 1: 1, 3: 1, 12: 1 }) },
        { ...base, channel: "preview", origin: "user", turns: 1, completed: 1, partial: 0, paused: 0, failed: 0, cards: 1, toolCalls: 3,
          responseMsSum: 1_200, responseCount: 1, responseHistogram: histogram({ 2: 1 }) },
      ]);
      const before = await engine.query.overview(range([agent]));
      await engine.projection.saveTurnFacts(facts, "r1", fence);
      assert.deepEqual(await engine.daily(tenant, agent, dayOf(0)), groups);
      assert.deepEqual(await engine.query.overview(range([agent])), before);
      assert.equal(before.turns, 6);
    });

    test("a fact that moves to another day or agent leaves its old group stored at zero and counts once in the new one", async () => {
      const engine = await make(); const fence = await fenced(engine); const agent = `agent-${unique()}`; const tenant = `tenant-${unique()}`;
      const moving = fact(agent, tenant, "a", lastMicroOfDay(0));
      await engine.projection.saveTurnFacts([moving], "r1", fence);
      assert.equal((await engine.daily(tenant, agent, dayOf(0)))[0]!.turns, 1);
      await engine.projection.saveTurnFacts([{ ...moving, startedAt: at(1, 0) }], "r2", fence);
      const [old] = await engine.daily(tenant, agent, dayOf(0));
      assert.deepEqual({ turns: old!.turns, completed: old!.completed, responseCount: old!.responseCount, revision: old!.projectorRevision, hist: old!.responseHistogram.every((n) => n === 0) },
        { turns: 0, completed: 0, responseCount: 0, revision: "r2", hist: true });
      assert.equal((await engine.daily(tenant, agent, dayOf(1)))[0]!.turns, 1);
      assert.equal((await engine.query.overview(range([agent]))).turns, 1);
      const other = `agent-${unique()}`;
      await engine.projection.saveTurnFacts([{ ...moving, startedAt: at(1, 0), agentId: other }], "r3", fence);
      assert.deepEqual((await engine.daily(tenant, agent, dayOf(1))).map((group) => [group.turns, group.projectorRevision]), [[0, "r3"]]);
      assert.deepEqual((await engine.daily(tenant, other, dayOf(1))).map((group) => group.turns), [1]);
      assert.equal((await engine.query.overview(range([agent]))).turns, 0);
      assert.equal((await engine.query.overview(range([other]))).turns, 1);
    });

    test("writes under a fence that is not the current lease, or with one turn twice, are refused and store nothing", async () => {
      const engine = await make(); const fence = await fenced(engine); const agent = `agent-${unique()}`; const tenant = `tenant-${unique()}`;
      const one = fact(agent, tenant, "a", at(0, 9));
      await assert.rejects(engine.projection.saveTurnFacts([one], "r1", { ...fence, fencingToken: String(BigInt(fence.fencingToken) + 1n) }), fails("conflict"));
      await assert.rejects(engine.projection.saveTurnFacts([one, { ...one, status: "failed" }], "r1", fence), fails("validation"));
      await assert.rejects(engine.projection.saveTurnFacts([{ ...one, actorKey: "A".repeat(64) }], "r1", fence), fails("validation"));
      assert.equal((await engine.query.overview(range([agent]))).turns, 0);
      assert.deepEqual(await engine.daily(tenant, agent, dayOf(0)), []);
    });

    test("distinct tenants and (tenant, actor) pairs are exact across day, week and tenant boundaries", async () => {
      const engine = await make(); const fence = await fenced(engine); const agent = `agent-${unique()}`;
      const [a, b] = [`tenant-a-${unique()}`, `tenant-b-${unique()}`];
      await engine.projection.saveTurnFacts([
        fact(agent, a, "c", lastMicroOfDay(0)), fact(agent, a, "c", at(1, 0)), // one person either side of local midnight
        fact(agent, b, "c", at(1, 8)), // the same pseudonym in another tenant is another person
        fact(agent, a, "d", at(6, 23)), fact(agent, a, "d", at(7, 1)), // last day of the week, then the next Monday
        fact(agent, a, "e", at(1, 9), { origin: "continuation" }), fact(agent, b, "e", at(1, 9), { channel: "preview" }), // not usage turns
      ], "r1", fence);
      const overview = await engine.query.overview(range([agent], at(0, 0), at(14, 0)));
      assert.deepEqual({ tenantsUsed: overview.tenantsUsed, activeUsers: overview.activeUsers, turns: overview.turns }, { tenantsUsed: 2, activeUsers: 3, turns: 5 });
      const days = await engine.query.series({ ...range([agent], at(0, 0), at(3, 0)), bucket: "day" });
      assert.deepEqual(days.map(({ start, end, tenantsUsed, activeUsers, turns }) => ({ start, end, tenantsUsed, activeUsers, turns })), [
        { start: at(0, 0), end: at(1, 0), tenantsUsed: 1, activeUsers: 1, turns: 1 },
        { start: at(1, 0), end: at(2, 0), tenantsUsed: 2, activeUsers: 2, turns: 2 },
        { start: at(2, 0), end: at(3, 0), tenantsUsed: 0, activeUsers: 0, turns: 0 },
      ]);
      const weeks = await engine.query.series({ ...range([agent], at(1, 0), at(9, 0)), bucket: "week" });
      assert.deepEqual(weeks.map(({ start, end, tenantsUsed, activeUsers, turns }) => ({ start, end, tenantsUsed, activeUsers, turns })), [
        { start: at(1, 0), end: at(7, 0), tenantsUsed: 2, activeUsers: 3, turns: 3 }, // the turn a microsecond before `from` is out
        { start: at(7, 0), end: at(9, 0), tenantsUsed: 1, activeUsers: 1, turns: 1 },
      ]);
      assert.deepEqual(weeks.map(({ start, end }) => ({ start, end })), usageBuckets(at(1, 0), at(9, 0), "week"));
    });

    test("the range is half-open and activation counts every tenant with a usage turn before the range ends", async () => {
      const engine = await make(); const fence = await fenced(engine); const agent = `agent-${unique()}`;
      const [early, inside, late, previewOnly] = [`t-early-${unique()}`, `t-in-${unique()}`, `t-late-${unique()}`, `t-pre-${unique()}`];
      await engine.projection.saveTurnFacts([
        fact(agent, early, "a", at(-30, 9)), fact(agent, inside, "a", at(2, 0)), fact(agent, inside, "b", at(4, 0, 0, 0, 1)),
        fact(agent, late, "a", at(4, 0)), fact(agent, previewOnly, "a", at(1, 0), { channel: "preview" }),
      ], "r1", fence);
      const overview = await engine.query.overview(range([agent], at(2, 0), at(4, 0)));
      assert.deepEqual({ used: overview.tenantsUsed, activated: overview.tenantsActivated, users: overview.activeUsers, turns: overview.turns },
        { used: 1, activated: 2, users: 1, turns: 1 });
      const points = await engine.query.series({ ...range([agent], at(1, 0), at(5, 0)), bucket: "day" });
      assert.deepEqual(points.map((point) => [point.tenantsUsed, point.tenantsActivated]), [[0, 1], [1, 2], [0, 2], [2, 3]]);
    });

    test("agentIds limits the agents: empty matches nothing, absent matches every agent, and a tenant on two agents counts once", async () => {
      const engine = await make(); const fence = await fenced(engine); const [one, two] = [`agent-1-${unique()}`, `agent-2-${unique()}`];
      const tenant = `tenant-${unique()}`;
      const window = { from: at(0, 0), to: at(1, 0) };
      const everyBefore = await engine.query.overview(window);
      await engine.projection.saveTurnFacts([fact(one, tenant, "a", at(0, 8)), fact(two, tenant, "a", at(0, 9)), fact(two, tenant, "b", at(0, 10))], "r1", fence);
      const counts = async (agentIds?: readonly string[]) => {
        const totals = await engine.query.overview(agentIds === undefined ? window : { ...window, agentIds });
        return [totals.tenantsUsed, totals.activeUsers, totals.turns];
      };
      assert.deepEqual(await counts([]), [0, 0, 0]);
      assert.deepEqual(await counts([one]), [1, 1, 1]);
      assert.deepEqual(await counts([one, two, one]), [1, 2, 3]);
      const every = await counts();
      assert.deepEqual(every, [everyBefore.tenantsUsed + 1, everyBefore.activeUsers + 2, everyBefore.turns + 3]);
    });

    test("sums cover only the turns that have the duration, and a range without turns sums to zero", async () => {
      const engine = await make(); const fence = await fenced(engine); const agent = `agent-${unique()}`; const tenant = `tenant-${unique()}`;
      const silent = without(fact(agent, tenant, "a", at(0, 9), { responseMs: 7_000 }), "firstOutputMs", "firstOutputAt");
      const open = without(fact(agent, tenant, "a", at(0, 10), { status: "abandoned", firstOutputMs: 900 }), "responseMs", "endedAt");
      await engine.projection.saveTurnFacts([fact(agent, tenant, "a", at(0, 8), { responseMs: 3_000, firstOutputMs: 300 }), silent, open], "r1", fence);
      const totals = await engine.query.overview(range([agent]));
      assert.deepEqual({ ...totals }, {
        tenantsUsed: 1, tenantsActivated: 1, activeUsers: 1, turns: 3, firstOutputMsSum: 1_200, firstOutputCount: 2, responseMsSum: 10_000, responseCount: 2,
      });
      assert.deepEqual({ ...(await engine.query.overview(range([agent], at(20, 0), at(21, 0)))) }, {
        tenantsUsed: 0, tenantsActivated: 1, activeUsers: 0, turns: 0, firstOutputMsSum: 0, firstOutputCount: 0, responseMsSum: 0, responseCount: 0,
      });
    });

    test("open facts count nowhere, and the sweep lists the old ones a page at a time across tenants, oldest last event first", async () => {
      const engine = await make(); const fence = await fenced(engine); const agent = `agent-${unique()}`;
      const [a, b] = [`tenant-a-${unique()}`, `tenant-b-${unique()}`];
      const open = (tenant: string, hour: number, lastEvent: string) =>
        without(fact(agent, tenant, "a", at(0, hour), { status: "open", endedAt: lastEvent, firstOutputMs: 300 }), "responseMs");
      const facts = [open(a, 9, at(0, 9, 30)), open(b, 9, at(0, 9, 30)), open(a, 10, at(0, 10, 30)), open(b, 11, at(0, 12)), fact(agent, a, "a", at(0, 8))];
      await engine.projection.saveTurnFacts(facts, "r1", fence);
      const totals = await engine.query.overview(range([agent]));
      assert.deepEqual([totals.tenantsUsed, totals.tenantsActivated, totals.activeUsers, totals.turns, totals.firstOutputCount], [1, 1, 1, 1, 1]);
      assert.deepEqual((await engine.daily(a, agent, dayOf(0))).map((group) => group.turns), [1]);
      assert.deepEqual(await engine.daily(b, agent, dayOf(0)), []);
      const cutoff = at(0, 11);
      const listed: string[] = []; let pages = 0;
      let page = await engine.projection.listOpenTurnFacts({ before: cutoff, limit: 1 });
      while (page.length > 0) {
        pages += 1;
        assert.equal(page.length, 1);
        listed.push(...page.filter((turn) => turn.tenantId === a || turn.tenantId === b).map((turn) => `${turn.tenantId === a ? "a" : "b"}@${turn.endedAt}`));
        page = await engine.projection.listOpenTurnFacts({ before: cutoff, limit: 1, after: page[page.length - 1]! });
      }
      const tie = [a, b].sort().map((tenant) => `${tenant === a ? "a" : "b"}@${at(0, 9, 30)}`);
      assert.deepEqual(listed, [...tie, `a@${at(0, 10, 30)}`]);
      assert.ok(pages >= 3);
      await assert.rejects(engine.projection.listOpenTurnFacts({ before: cutoff, limit: 0 }), fails("validation"));
      await assert.rejects(engine.projection.saveTurnFacts([without(open(a, 13, at(0, 13)), "endedAt")], "r1", fence), fails("validation"));
      assert.equal(await engine.projection.abandonOpenTurnFacts(facts.slice(0, 4), at(1, 0), "r2", fence), 4);
    });

    test("the sweep abandons an open fact at its last event once, recomputes its day, and leaves young and closed facts alone", async () => {
      const engine = await make(); const fence = await fenced(engine); const agent = `agent-${unique()}`; const tenant = `tenant-${unique()}`;
      const open = (hour: number, lastEvent: string) =>
        without(fact(agent, tenant, "a", at(0, hour), { status: "open", endedAt: lastEvent, firstOutputMs: 300 }), "responseMs");
      const [old, young, done] = [open(9, at(0, 9, 30)), open(10, at(0, 12)), fact(agent, tenant, "a", at(0, 8), { responseMs: 2_000 })];
      await engine.projection.saveTurnFacts([old, young, done], "r1", fence);
      const turns = [old, young, done].map(({ tenantId, sessionId, turnId }) => ({ tenantId, sessionId, turnId }));
      await assert.rejects(engine.projection.abandonOpenTurnFacts(turns, at(0, 11), "r2", { ...fence, fencingToken: String(BigInt(fence.fencingToken) + 1n) }), fails("conflict"));
      await assert.rejects(engine.projection.abandonOpenTurnFacts([turns[0]!, turns[0]!], at(0, 11), "r2", fence), fails("validation"));
      assert.equal((await engine.ending(tenant, old.sessionId, old.turnId))?.status, "open");
      assert.equal(await engine.projection.abandonOpenTurnFacts(turns, at(0, 11), "r2", fence), 1);
      assert.deepEqual({ ...(await engine.ending(tenant, old.sessionId, old.turnId)) }, { status: "abandoned", endedAt: at(0, 9, 30), firstOutputMs: 300 });
      assert.deepEqual({ ...(await engine.ending(tenant, young.sessionId, young.turnId)) }, { status: "open", endedAt: at(0, 12), firstOutputMs: 300 });
      assert.equal((await engine.ending(tenant, done.sessionId, done.turnId))?.status, "completed");
      const [group] = await engine.daily(tenant, agent, dayOf(0));
      assert.deepEqual([group!.turns, group!.completed, group!.responseCount, group!.projectorRevision], [2, 1, 1, "r2"]);
      assert.equal((await engine.query.overview(range([agent]))).turns, 2);
      assert.equal(await engine.projection.abandonOpenTurnFacts(turns, at(0, 11), "r2", fence), 0);
      assert.deepEqual(await engine.daily(tenant, agent, dayOf(0)), [group]);
      await engine.projection.saveTurnFacts([{ ...old, status: "completed", endedAt: at(0, 13), responseMs: 9_000 }], "r3", fence);
      assert.equal((await engine.ending(tenant, old.sessionId, old.turnId))?.status, "completed");
      assert.equal(await engine.projection.abandonOpenTurnFacts(turns, at(1, 0), "r3", fence), 1);
      assert.equal((await engine.query.overview(range([agent]))).turns, 3);
    });

    test("queries refuse an empty or reversed range, an unknown bucket and a non-ASCII agent id", async () => {
      const engine = await make();
      await assert.rejects(engine.query.overview({ from: at(1, 0), to: at(1, 0) }), fails("validation"));
      await assert.rejects(engine.query.overview({ from: at(2, 0), to: at(1, 0) }), fails("validation"));
      await assert.rejects(engine.query.overview({ from: dayOf(0), to: at(1, 0) }), fails("validation"));
      await assert.rejects(engine.query.series({ from: at(0, 0), to: at(1, 0), bucket: "month" as "day" }), fails("validation"));
      await assert.rejects(engine.query.overview({ from: at(0, 0), to: at(1, 0), agentIds: ["tác-tử"] }), fails("validation"));
    });
  });
}
