import type { TurnEndStatus } from "../sessions/core-events.js";
import type { LeaseFence, ReviewChannel } from "./review.js";

/**
 * Usage statistics ports: one fact per closed turn, daily groups recomputed from those facts, and the console's counts over
 * a time range. A day is the calendar day in Asia/Ho_Chi_Minh (UTC+7 all year), and a week starts on its Monday.
 *
 * Counts read from one shard. A tenant lives in exactly one shard, so distinct tenants and distinct (tenant, actor key)
 * pairs of different shards never overlap: a caller adds the shards' counts and sums and stays exact. Averages are left to
 * the caller as sum / count for the same reason.
 */

/** Why a turn ran: the person asked, or a paused turn was resumed as a turn of its own. */
export type TurnOrigin = "user" | "continuation";

/**
 * How a turn closed: its end status, `failed`, or `abandoned` for a turn that never closed and was given up. `open` is a turn
 * seen without a close yet; usage counts and daily groups leave it out until it closes or the sweep abandons it.
 */
export type TurnFactStatus = TurnEndStatus | "failed" | "abandoned" | "open";

/** The release id every fact carries before releases exist; never null, because it is part of the daily key. */
export const UNRELEASED_RELEASE_ID = "00000000-0000-7000-8000-000000000000";

/** Upper bounds, in milliseconds and inclusive, of the response-time histogram; one more bucket counts everything slower. */
export const USAGE_RESPONSE_BUCKETS_MS = Object.freeze([500, 1_000, 2_000, 3_000, 5_000, 8_000, 13_000, 20_000, 30_000, 60_000, 120_000, 300_000] as const);

/**
 * One turn. The store derives its day from `startedAt`. Durations are absent where the turn has none to measure. An `open`
 * fact must carry `endedAt`, the time of the turn's last event so far, which is where the sweep ends it if it stays open.
 */
export interface TurnFact {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentId: string;
  readonly channel: ReviewChannel;
  readonly releaseId: string;
  readonly runtimeSnapshotId: string;
  readonly origin: TurnOrigin;
  /** 64 lowercase hex characters, the same pseudonym the review header carries. */
  readonly actorKey: string;
  readonly actorKeyVersion: string;
  readonly startedAt: string;
  readonly firstOutputAt?: string;
  readonly endedAt?: string;
  readonly status: TurnFactStatus;
  readonly responseMs?: number;
  readonly firstOutputMs?: number;
  readonly steps: number;
  readonly toolCalls: number;
  readonly toolFailed: number;
  readonly toolRefused: number;
  readonly cards: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Journal sequence of the event that closed the turn. */
  readonly sourceLastSeq: number;
}

/**
 * One daily group, as recomputed from the facts of its (tenant, agent, day), `open` facts left out. `turns` counts every status; `abandoned` turns
 * are `turns` minus the four status counts. `paused` counts both awaiting statuses. Response sums, counts and the histogram
 * cover the facts that have `responseMs`; `responseHistogram` has one count per bound of `USAGE_RESPONSE_BUCKETS_MS` plus one.
 * A group whose facts all moved elsewhere stays stored with every count zero: groups are never deleted.
 */
export interface UsageDailyGroup {
  readonly tenantId: string;
  readonly agentId: string;
  /** `YYYY-MM-DD` in Asia/Ho_Chi_Minh. */
  readonly day: string;
  readonly channel: ReviewChannel;
  readonly releaseId: string;
  readonly origin: TurnOrigin;
  readonly turns: number;
  readonly completed: number;
  readonly partial: number;
  readonly paused: number;
  readonly failed: number;
  readonly cards: number;
  readonly toolCalls: number;
  readonly responseMsSum: number;
  readonly responseCount: number;
  readonly responseHistogram: readonly number[];
  readonly projectorRevision: string;
}

/** One open fact, as the sweep lists it: oldest `endedAt` first, ties in (tenantId, sessionId, turnId) order. */
export interface OpenTurnFact {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly endedAt: string;
}

/** A page of open facts whose last event is before `before`; `after` is the last fact of the previous page. */
export interface OpenTurnFactQuery {
  readonly before: string;
  /** 1 to 500. */
  readonly limit: number;
  readonly after?: OpenTurnFact;
}

/** The projector's writes of usage facts into one shard. */
export interface UsageProjectionStore {
  /**
   * One transaction under `fence`: upserts each fact by (tenant, session, turn), then recomputes every daily group of each
   * (tenant, agent, day) the facts are in now or were in before. Rerunning with the same input changes nothing. A projector
   * saves a closed turn's fact before it moves that stream's cursor past the turn, so a crash between the two repeats the
   * save instead of losing it. Two facts for one turn in a call are refused with `validation`.
   */
  saveTurnFacts(facts: readonly TurnFact[], projectorRevision: string, fence: LeaseFence): Promise<void>;
  /**
   * Open facts of every tenant in this shard whose last event is before the cutoff. A session without new events is never
   * read again, so this listing is how a turn that was young when projected is found once it is old.
   */
  listOpenTurnFacts(query: OpenTurnFactQuery): Promise<readonly OpenTurnFact[]>;
  /**
   * One transaction under `fence`: each named fact that is still `open` with `endedAt` before `before` becomes `abandoned`,
   * keeping `endedAt` as its end and dropping any response time, and the daily groups of each closed fact's (tenant, agent,
   * day) are recomputed. A fact that closed or got a newer event since it was listed is left as it is, so a rerun closes
   * nothing more. Returns how many facts it closed.
   */
  abandonOpenTurnFacts(
    turns: readonly Pick<OpenTurnFact, "tenantId" | "sessionId" | "turnId">[], before: string, projectorRevision: string, fence: LeaseFence,
  ): Promise<number>;
}

/**
 * A half-open range `[from, to)` of turn start times. Only usage turns count: `origin` `user` on the `live` channel, any
 * status but `open`. `agentIds` limits the agents; absent means every agent, and an empty list matches nothing.
 */
export interface UsageQuery {
  readonly from: string;
  readonly to: string;
  readonly agentIds?: readonly string[];
}

export type UsageBucket = "day" | "week";

export interface UsageSeriesQuery extends UsageQuery {
  readonly bucket: UsageBucket;
}

/** Distinct counts over a range, exact: never added up from smaller periods. */
export interface UsageCounts {
  /** Tenants with at least one usage turn in the range. */
  readonly tenantsUsed: number;
  /** Tenants with at least one usage turn that started before the range ends, at any time before. */
  readonly tenantsActivated: number;
  /** Distinct (tenant, actor key) pairs with a usage turn in the range. */
  readonly activeUsers: number;
  readonly turns: number;
}

export interface UsageTotals extends UsageCounts {
  readonly firstOutputMsSum: number;
  /** Usage turns in the range that have `firstOutputMs`. */
  readonly firstOutputCount: number;
  readonly responseMsSum: number;
  readonly responseCount: number;
}

/** One bucket of a series; `start` and `end` are the bucket's bounds cut to the query's range. */
export interface UsagePoint extends UsageCounts {
  readonly start: string;
  readonly end: string;
}

/** The console's reads of usage in one shard. */
export interface UsageQueryStore {
  overview(query: UsageQuery): Promise<UsageTotals>;
  /** Every bucket of the range in order, empty ones included, with the bounds `usageBuckets` gives. */
  series(query: UsageSeriesQuery): Promise<readonly UsagePoint[]>;
}
