import {
  checkedTurnFacts, usageBuckets, type LeaseFence, type OpenTurnFact, type OpenTurnFactQuery, type TurnFact, type UsageCounts, type UsagePoint, type UsageProjectionStore, type UsageQuery,
  type UsageQueryStore, type UsageSeriesQuery, type UsageTotals,
} from "@0xsyncroot/contracts";
import type { MemoryLeases } from "./review-fixture.js";

/** In-test usage store with the documented semantics: fenced upserts by turn, and exact counts over the usage turns. */
export class MemoryUsage implements UsageProjectionStore, UsageQueryStore {
  readonly facts = new Map<string, TurnFact>();
  readonly revisions = new Map<string, string>();
  saves = 0;
  abandons = 0;
  /** When set, the next save throws, as a refused write does. */
  failNext: Error | undefined;
  readonly queries: (UsageQuery | UsageSeriesQuery)[] = [];
  constructor(private readonly leases: MemoryLeases) {}

  async saveTurnFacts(facts: readonly TurnFact[], projectorRevision: string, fence: LeaseFence): Promise<void> {
    this.leases.check(fence);
    if (this.failNext) { const error = this.failNext; this.failNext = undefined; throw error; }
    for (const fact of checkedTurnFacts(facts)) {
      const key = `${fact.tenantId}|${fact.sessionId}|${fact.turnId}`;
      this.facts.set(key, fact);
      this.revisions.set(key, projectorRevision);
    }
    this.saves += 1;
  }

  async listOpenTurnFacts(query: OpenTurnFactQuery): Promise<readonly OpenTurnFact[]> {
    const key = (fact: OpenTurnFact) => `${fact.endedAt}|${fact.tenantId}|${fact.sessionId}|${fact.turnId}`;
    return [...this.facts.values()].flatMap(({ tenantId, sessionId, turnId, endedAt, status }) =>
      (status === "open" && endedAt !== undefined && Date.parse(endedAt) < Date.parse(query.before) ? [{ tenantId, sessionId, turnId, endedAt }] : []))
      .filter((fact) => !query.after || key(fact) > key(query.after)).sort((a, b) => (key(a) < key(b) ? -1 : 1)).slice(0, query.limit);
  }

  async abandonOpenTurnFacts(turns: readonly Pick<OpenTurnFact, "tenantId" | "sessionId" | "turnId">[], before: string, projectorRevision: string, fence: LeaseFence): Promise<number> {
    this.leases.check(fence);
    let closed = 0;
    for (const turn of turns) {
      const key = `${turn.tenantId}|${turn.sessionId}|${turn.turnId}`;
      const fact = this.facts.get(key);
      if (fact?.status !== "open" || fact.endedAt === undefined || Date.parse(fact.endedAt) >= Date.parse(before)) continue;
      const { responseMs: _responseMs, ...rest } = fact;
      this.facts.set(key, { ...rest, status: "abandoned" });
      this.revisions.set(key, projectorRevision);
      closed += 1;
    }
    this.abandons += closed;
    return closed;
  }

  #usage(query: UsageQuery, from: string, to: string): TurnFact[] {
    return [...this.facts.values()].filter((fact) => fact.status !== "open" && fact.origin === "user" && fact.channel === "live"
      && (!query.agentIds || query.agentIds.includes(fact.agentId)) && Date.parse(fact.startedAt) < Date.parse(to)
      && Date.parse(fact.startedAt) >= Date.parse(from));
  }

  #counts(query: UsageQuery, from: string, to: string): UsageCounts {
    const inRange = this.#usage(query, from, to);
    return {
      tenantsUsed: new Set(inRange.map((fact) => fact.tenantId)).size,
      tenantsActivated: new Set(this.#usage(query, "1970-01-01T00:00:00.000Z", to).map((fact) => fact.tenantId)).size,
      activeUsers: new Set(inRange.map((fact) => `${fact.tenantId}|${fact.actorKey}`)).size,
      turns: inRange.length,
    };
  }

  async overview(query: UsageQuery): Promise<UsageTotals> {
    this.queries.push(query);
    const inRange = this.#usage(query, query.from, query.to);
    const first = inRange.filter((fact) => fact.firstOutputMs !== undefined);
    const response = inRange.filter((fact) => fact.responseMs !== undefined);
    return {
      ...this.#counts(query, query.from, query.to),
      firstOutputMsSum: first.reduce((sum, fact) => sum + (fact.firstOutputMs ?? 0), 0), firstOutputCount: first.length,
      responseMsSum: response.reduce((sum, fact) => sum + (fact.responseMs ?? 0), 0), responseCount: response.length,
    };
  }

  async series(query: UsageSeriesQuery): Promise<readonly UsagePoint[]> {
    this.queries.push(query);
    return usageBuckets(query.from, query.to, query.bucket).map((bucket) => ({ ...bucket, ...this.#counts(query, bucket.start, bucket.end) }));
  }
}
