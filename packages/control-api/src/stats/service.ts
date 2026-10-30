import type { AdminPrincipalStore, ReviewProjectionStore, ShardDirectory, UsageCounts, UsageQuery, UsageQueryStore } from "@0xsyncroot/contracts";
import { reviewReach, STATS_READER_ROLE, type ReviewReach } from "../review/access.js";
import type { UsageOverviewWire, UsagePointWire, UsageRange, UsageSeriesRange, UsageSeriesWire } from "./wire.js";

/** One shard's ports, as the statistics read them. */
export interface UsageStatsShard {
  readonly usage: UsageQueryStore;
  readonly projection: Pick<ReviewProjectionStore, "watermark">;
}

export interface UsageStatsServiceOptions {
  readonly directory: ShardDirectory;
  /** The ports of a shard the directory names; an unknown shard id throws. */
  readonly shard: (shardId: string) => UsageStatsShard;
  readonly principals: AdminPrincipalStore;
  /** The projector whose watermark tells how fresh the figures are, and its current revision. */
  readonly projectorId: string;
  readonly revision: string;
  readonly now?: () => Date;
}

const iso = (time: string) => new Date(time).toISOString();
const mean = (sum: number, count: number) => (count > 0 ? Math.round(sum / count) : null);
const counts = (value: UsageCounts) => ({ tenantsUsed: value.tenantsUsed, tenantsActivated: value.tenantsActivated, activeUsers: value.activeUsers, turns: value.turns });
const add = (a: UsageCounts, b: UsageCounts): UsageCounts => ({
  tenantsUsed: a.tenantsUsed + b.tenantsUsed, tenantsActivated: a.tenantsActivated + b.tenantsActivated,
  activeUsers: a.activeUsers + b.activeUsers, turns: a.turns + b.turns,
});

/**
 * Usage statistics across shards. A tenant lives on one shard, so distinct tenants and users of the shards add up exactly.
 * Every read first loads the caller's reach under the stats role (an agent-scoped reader sees its agents only), then reads
 * its range, so a caller without the role is refused whatever input it sent, then writes one control-plane audit row before
 * any figure is read, so a read that fails is still recorded.
 */
export class UsageStatsService {
  readonly #now: () => Date;

  constructor(private readonly options: UsageStatsServiceOptions) {
    this.#now = options.now ?? (() => new Date());
  }

  /** `rangeOf` parses the request's range; it runs only once the caller holds the role and may throw a validation error. */
  async overview(principalId: string, rangeOf: () => UsageRange): Promise<UsageOverviewWire> {
    const reach = await reviewReach(this.options.principals, principalId, STATS_READER_ROLE);
    const range = rangeOf();
    await this.#audit(reach, "stats.overview", range);
    const shards = await this.#shards();
    const totals = await Promise.all(shards.map((shard) => shard.usage.overview(this.#query(reach, range))));
    const sum = (pick: (value: (typeof totals)[number]) => number) => totals.reduce((total, value) => total + pick(value), 0);
    const updatedAt = await this.#updatedAt(shards);
    return {
      from: range.from, to: range.to,
      ...counts(totals.reduce<UsageCounts>(add, { tenantsUsed: 0, tenantsActivated: 0, activeUsers: 0, turns: 0 })),
      avgFirstOutputMs: mean(sum((value) => value.firstOutputMsSum), sum((value) => value.firstOutputCount)),
      avgResponseMs: mean(sum((value) => value.responseMsSum), sum((value) => value.responseCount)),
      updatedAt,
    };
  }

  /** As `overview`, per bucket. */
  async series(principalId: string, rangeOf: () => UsageSeriesRange): Promise<UsageSeriesWire> {
    const reach = await reviewReach(this.options.principals, principalId, STATS_READER_ROLE);
    const range = rangeOf();
    await this.#audit(reach, "stats.series", range);
    const shards = await this.#shards();
    const perShard = await Promise.all(shards.map((shard) => shard.usage.series({ ...this.#query(reach, range), bucket: range.bucket })));
    const points = new Map<string, UsagePointWire>();
    for (const point of perShard.flat()) {
      const start = iso(point.start);
      const before = points.get(start);
      points.set(start, { start, end: iso(point.end), ...counts(before ? add(before, point) : point) });
    }
    const updatedAt = await this.#updatedAt(shards);
    return { bucket: range.bucket, points: [...points.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)), updatedAt };
  }

  #query(reach: ReviewReach, range: UsageRange): UsageQuery {
    return { from: range.from, to: range.to, ...(reach.agents ? { agentIds: [...reach.agents].sort() } : {}) };
  }

  async #shards(): Promise<UsageStatsShard[]> {
    return (await this.options.directory.shards()).map((entry) => this.options.shard(entry.shardId));
  }

  /** The earliest watermark of the current revision; null while any shard has none, since its figures are not complete. */
  async #updatedAt(shards: readonly UsageStatsShard[]): Promise<string | null> {
    const marks = await Promise.all(shards.map((shard) => shard.projection.watermark(this.options.projectorId)));
    let earliest: number | undefined;
    for (const mark of marks) {
      if (mark?.projectorRevision !== this.options.revision) return null;
      const time = Date.parse(mark.watermarkAt);
      if (earliest === undefined || time < earliest) earliest = time;
    }
    return earliest === undefined ? null : new Date(earliest).toISOString();
  }

  async #audit(reach: ReviewReach, action: string, detail: UsageRange | UsageSeriesRange): Promise<void> {
    await this.options.principals.audit({
      scopeKind: "platform", scopeId: "", principalId: reach.principal.principalId, actorScope: "console", action,
      targetKind: "usage_stats", targetId: "*", detail: JSON.stringify(detail), at: this.#now().toISOString(),
    });
  }
}
