import {
  AgenticError, checkedLeaseFence, checkedOpenTurnFactQuery, checkedTurnFacts, checkedTurnKeys, checkedUsageQuery, checkedUsageSeriesQuery,
  compareOpenTurnFacts, emptyUsageGroup, reviewIdentifier, reviewTime, usageBuckets, usageDailyGroups, usageDay, usageGroupKey, type LeaseFence,
  type OpenTurnFact, type OpenTurnFactQuery, type TurnFact, type UsageCounts, type UsageDailyGroup, type UsagePoint, type UsageProjectionStore, type UsageQuery, type UsageQueryStore, type UsageSeriesQuery, type UsageTotals,
} from "@0xsyncroot/contracts";
import { freezeDeep } from "./freeze.js";
import type { InMemoryWorkerLeaseStore } from "./worker-lease.js";

export interface InMemoryUsageStoreOptions {
  /** The leases fenced writes are checked against. */
  readonly leases: InMemoryWorkerLeaseStore;
}

interface StoredFact { readonly fact: TurnFact; readonly day: string }
type Scope = Pick<UsageDailyGroup, "tenantId" | "agentId" | "day">;

const key = (...parts: readonly string[]) => JSON.stringify(parts);
const scopeKey = (tenantId: string, agentId: string, day: string) => key(tenantId, agentId, day);
const isUsageTurn = (fact: TurnFact) => fact.origin === "user" && fact.channel === "live" && fact.status !== "open";

/**
 * Usage facts, their daily groups and the console's counts, in one process. A save checks the fence and every fact before it
 * changes anything, so a refused save leaves the store as it was, as the database engine's transaction does.
 */
export class InMemoryUsageStore implements UsageProjectionStore, UsageQueryStore {
  readonly #facts = new Map<string, StoredFact>();
  readonly #groups = new Map<string, ReadonlyMap<string, UsageDailyGroup>>();
  constructor(private readonly options: InMemoryUsageStoreOptions) {}

  async saveTurnFacts(facts: readonly TurnFact[], projectorRevision: string, fence: LeaseFence): Promise<void> {
    const checked = checkedTurnFacts(facts);
    const revision = reviewIdentifier(projectorRevision, "projectorRevision", 64);
    this.#assertFence(fence);
    const scopes = new Map<string, Scope>();
    for (const fact of checked) this.#store(fact, scopes);
    for (const [groupScope, scope] of scopes) this.#recompute(groupScope, scope, revision);
  }

  async listOpenTurnFacts(query: OpenTurnFactQuery): Promise<readonly OpenTurnFact[]> {
    const checked = checkedOpenTurnFactQuery(query);
    return [...this.#facts.values()]
      .filter(({ fact }) => fact.status === "open" && fact.endedAt! < checked.before)
      .map(({ fact }): OpenTurnFact => ({ tenantId: fact.tenantId, sessionId: fact.sessionId, turnId: fact.turnId, endedAt: fact.endedAt! }))
      .filter((turn) => checked.after === undefined || compareOpenTurnFacts(turn, checked.after) > 0)
      .sort(compareOpenTurnFacts).slice(0, checked.limit);
  }

  async abandonOpenTurnFacts(turns: readonly Pick<OpenTurnFact, "tenantId" | "sessionId" | "turnId">[], before: string, projectorRevision: string, fence: LeaseFence): Promise<number> {
    const checked = checkedTurnKeys(turns); const cutoff = reviewTime(before, "before");
    const revision = reviewIdentifier(projectorRevision, "projectorRevision", 64);
    this.#assertFence(fence);
    const scopes = new Map<string, Scope>();
    let closed = 0;
    for (const turn of checked) {
      const stored = this.#facts.get(key(turn.tenantId, turn.sessionId, turn.turnId))?.fact;
      if (stored?.status !== "open" || !(stored.endedAt! < cutoff)) continue;
      const { responseMs: _dropped, ...rest } = stored;
      this.#store({ ...rest, status: "abandoned" }, scopes);
      closed += 1;
    }
    for (const [groupScope, scope] of scopes) this.#recompute(groupScope, scope, revision);
    return closed;
  }

  /** The stored fact of one turn. */
  async turnFact(tenantId: string, sessionId: string, turnId: string): Promise<TurnFact | undefined> {
    return this.#facts.get(key(tenantId, sessionId, turnId))?.fact;
  }

  /** The daily groups stored for one (tenant, agent, day), ordered by (channel, releaseId, origin). */
  async dailyGroups(tenantId: string, agentId: string, day: string): Promise<readonly UsageDailyGroup[]> {
    const groups = this.#groups.get(scopeKey(tenantId, agentId, day));
    return groups ? [...groups].sort(([left], [right]) => (left < right ? -1 : 1)).map(([, group]) => group) : [];
  }

  async overview(query: UsageQuery): Promise<UsageTotals> {
    const checked = checkedUsageQuery(query);
    const inRange = this.#usageFacts(checked).filter((fact) => fact.startedAt >= checked.from && fact.startedAt < checked.to);
    const timed = (field: "firstOutputMs" | "responseMs") => inRange.filter((fact) => fact[field] !== undefined).map((fact) => fact[field]!);
    const firstOutput = timed("firstOutputMs"); const response = timed("responseMs");
    return {
      ...this.#counts(checked, checked.from, checked.to),
      firstOutputMsSum: firstOutput.reduce((sum, ms) => sum + ms, 0), firstOutputCount: firstOutput.length,
      responseMsSum: response.reduce((sum, ms) => sum + ms, 0), responseCount: response.length,
    };
  }

  async series(query: UsageSeriesQuery): Promise<readonly UsagePoint[]> {
    const checked = checkedUsageSeriesQuery(query);
    return usageBuckets(checked.from, checked.to, checked.bucket).map((bucket) => ({ ...bucket, ...this.#counts(checked, bucket.start, bucket.end) }));
  }

  #assertFence(fence: LeaseFence): void {
    const lease = checkedLeaseFence(fence);
    if (!this.options.leases.holds(lease)) throw new AgenticError("conflict", `The ${lease.workerKind} lease is not held under fencing token ${lease.fencingToken}`);
  }

  /** Stores one fact and notes the (tenant, agent, day) it leaves and the one it joins. */
  #store(fact: TurnFact, scopes: Map<string, Scope>): void {
    const factKey = key(fact.tenantId, fact.sessionId, fact.turnId);
    const before = this.#facts.get(factKey);
    if (before) scopes.set(scopeKey(before.fact.tenantId, before.fact.agentId, before.day), { tenantId: before.fact.tenantId, agentId: before.fact.agentId, day: before.day });
    const day = usageDay(fact.startedAt);
    scopes.set(scopeKey(fact.tenantId, fact.agentId, day), { tenantId: fact.tenantId, agentId: fact.agentId, day });
    this.#facts.set(factKey, freezeDeep({ fact, day }));
  }

  #recompute(groupScope: string, scope: Scope, revision: string): void {
    const facts = [...this.#facts.values()].filter((stored) => stored.day === scope.day && stored.fact.tenantId === scope.tenantId && stored.fact.agentId === scope.agentId);
    const groups = new Map(usageDailyGroups(scope, facts.map((stored) => stored.fact), revision).map((group) => [usageGroupKey(group), freezeDeep(group)] as const));
    for (const [groupKey, stored] of this.#groups.get(groupScope) ?? []) if (!groups.has(groupKey)) groups.set(groupKey, freezeDeep(emptyUsageGroup(stored, revision)));
    this.#groups.set(groupScope, groups);
  }

  #usageFacts(query: UsageQuery): TurnFact[] {
    const agents = query.agentIds === undefined ? undefined : new Set(query.agentIds);
    return [...this.#facts.values()].map((stored) => stored.fact).filter((fact) => isUsageTurn(fact) && (agents === undefined || agents.has(fact.agentId)));
  }

  #counts(query: UsageQuery, from: string, to: string): UsageCounts {
    const usage = this.#usageFacts(query);
    const inRange = usage.filter((fact) => fact.startedAt >= from && fact.startedAt < to);
    return {
      tenantsUsed: new Set(inRange.map((fact) => fact.tenantId)).size,
      tenantsActivated: new Set(usage.filter((fact) => fact.startedAt < to).map((fact) => fact.tenantId)).size,
      activeUsers: new Set(inRange.map((fact) => key(fact.tenantId, fact.actorKey))).size,
      turns: inRange.length,
    };
  }
}
