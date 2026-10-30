import type { UsageBucket } from "@0xsyncroot/contracts";

/** The usage statistics HTTP shapes (`/admin/v1/stats`). Instants are UTC ISO strings; `to` is exclusive. */

/** A parsed `[from, to)` range of a statistics request. */
export interface UsageRange {
  readonly from: string;
  readonly to: string;
}

/** A parsed series request: the range and its bucket. */
export interface UsageSeriesRange extends UsageRange {
  readonly bucket: UsageBucket;
}

/** Distinct counts over one range, exact, never added up from smaller periods. */
export interface UsageCountsWire {
  readonly tenantsUsed: number;
  readonly tenantsActivated: number;
  readonly activeUsers: number;
  readonly turns: number;
}

/**
 * `GET /stats/overview`. Means are whole milliseconds over the turns that have the measure, null when none has it.
 * `updatedAt` is the earliest projector watermark of the current revision across shards; null until every shard has one.
 */
export interface UsageOverviewWire extends UsageRange, UsageCountsWire {
  readonly avgFirstOutputMs: number | null;
  readonly avgResponseMs: number | null;
  readonly updatedAt: string | null;
}

export interface UsagePointWire extends UsageCountsWire {
  readonly start: string;
  readonly end: string;
}

/** `GET /stats/series`: every bucket of the range in order, empty ones included. */
export interface UsageSeriesWire {
  readonly bucket: UsageBucket;
  readonly points: readonly UsagePointWire[];
  readonly updatedAt: string | null;
}
