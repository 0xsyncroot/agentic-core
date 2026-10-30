import { AgenticError } from "../errors/agentic-error.js";
import { reviewCount, reviewHash, reviewIdentifier, reviewOneOf, reviewPageSize, reviewTime } from "./rules.js";
import {
  USAGE_RESPONSE_BUCKETS_MS, type OpenTurnFact, type OpenTurnFactQuery, type TurnFact, type UsageBucket, type UsageDailyGroup, type UsageQuery, type UsageSeriesQuery,
} from "./usage.js";

/**
 * The usage rules every engine applies: the input checks, the calendar of Asia/Ho_Chi_Minh (UTC+7, no daylight saving) that
 * days and weeks follow, and the one recomputation of daily groups from facts, so engines agree to the last count.
 */

const LOCAL_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const STATUSES = ["completed", "partial", "awaiting_approval", "awaiting_interaction", "failed", "abandoned", "open"] as const;
/** The most open facts one sweep page lists. */
export const OPEN_TURN_FACT_PAGE_MAX = 500;
const SECONDS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/u;

function invalid(field: string, rule: string): never { throw new AgenticError("validation", `${field} ${rule}`); }

/** Milliseconds since the epoch of a canonical review time, to the second; days and weeks start on whole seconds. */
const secondsOf = (iso: string) => Date.parse(`${SECONDS.exec(iso)![1]}Z`);
const dayText = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const canonical = (ms: number) => reviewTime(new Date(ms).toISOString(), "time");
/** The UTC instant at which a local day `YYYY-MM-DD` begins. */
const localMidnight = (day: string) => Date.parse(`${day}T00:00:00Z`) - LOCAL_OFFSET_MS;

/** The local calendar day, `YYYY-MM-DD`, of a review time. */
export function usageDay(iso: string): string {
  return dayText(secondsOf(reviewTime(iso, "time")) + LOCAL_OFFSET_MS);
}

/** The key of the bucket a local day falls in: the day itself, or the Monday that starts its week. */
export function usageBucketKey(day: string, bucket: UsageBucket): string {
  if (bucket === "day") return day;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return dayText(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS);
}

/** The buckets of `[from, to)` in order: whole local days or Monday weeks, the first and last cut to the range. */
export function usageBuckets(from: string, to: string, bucket: UsageBucket): { readonly start: string; readonly end: string }[] {
  const start = reviewTime(from, "from"); const end = reviewTime(to, "to");
  if (start >= end) invalid("to", "must be later than from");
  const buckets: { start: string; end: string }[] = [];
  let current = start;
  while (current < end) {
    const next = canonical(localMidnight(usageBucketKey(usageDay(current), bucket)) + (bucket === "day" ? DAY_MS : 7 * DAY_MS));
    const cut = next < end ? next : end;
    buckets.push({ start: current, end: cut });
    current = cut;
  }
  return buckets;
}

function optionalTime(value: string | undefined, field: string): { [key: string]: string } {
  return value === undefined ? {} : { [field]: reviewTime(value, field) };
}

function optionalCount(value: number | undefined, field: string): { [key: string]: number } {
  return value === undefined ? {} : { [field]: reviewCount(value, field) };
}

/** Facts in the canonical form, refusing two facts for the same (tenant, session, turn). */
export function checkedTurnFacts(facts: readonly TurnFact[]): TurnFact[] {
  const keys = new Set<string>();
  return facts.map((fact) => {
    const checked: TurnFact = {
      tenantId: reviewIdentifier(fact.tenantId, "tenantId", 191), sessionId: reviewIdentifier(fact.sessionId, "sessionId", 191),
      turnId: reviewIdentifier(fact.turnId, "turnId", 191), agentId: reviewIdentifier(fact.agentId, "agentId", 100),
      channel: reviewOneOf(fact.channel, "channel", ["live", "preview"]), releaseId: reviewIdentifier(fact.releaseId, "releaseId", 36),
      runtimeSnapshotId: reviewIdentifier(fact.runtimeSnapshotId, "runtimeSnapshotId", 191),
      origin: reviewOneOf(fact.origin, "origin", ["user", "continuation"]), actorKey: reviewHash(fact.actorKey, "actorKey"),
      actorKeyVersion: reviewIdentifier(fact.actorKeyVersion, "actorKeyVersion", 16), startedAt: reviewTime(fact.startedAt, "startedAt"),
      ...optionalTime(fact.firstOutputAt, "firstOutputAt"), ...optionalTime(fact.endedAt, "endedAt"),
      status: reviewOneOf(fact.status, "status", STATUSES),
      ...optionalCount(fact.responseMs, "responseMs"), ...optionalCount(fact.firstOutputMs, "firstOutputMs"),
      steps: reviewCount(fact.steps, "steps"), toolCalls: reviewCount(fact.toolCalls, "toolCalls"), toolFailed: reviewCount(fact.toolFailed, "toolFailed"),
      toolRefused: reviewCount(fact.toolRefused, "toolRefused"), cards: reviewCount(fact.cards, "cards"),
      inputTokens: reviewCount(fact.inputTokens, "inputTokens"), outputTokens: reviewCount(fact.outputTokens, "outputTokens"),
      sourceLastSeq: reviewCount(fact.sourceLastSeq, "sourceLastSeq"),
    };
    if (checked.status === "open" && checked.endedAt === undefined) invalid("endedAt", "must be the time of the last event of an open turn");
    const key = JSON.stringify([checked.tenantId, checked.sessionId, checked.turnId]);
    if (keys.has(key)) invalid("facts", "must not repeat a (tenantId, sessionId, turnId)");
    keys.add(key);
    return checked;
  });
}

function checkedTurnKey(turn: Pick<OpenTurnFact, "tenantId" | "sessionId" | "turnId">): Pick<OpenTurnFact, "tenantId" | "sessionId" | "turnId"> {
  return {
    tenantId: reviewIdentifier(turn.tenantId, "tenantId", 191), sessionId: reviewIdentifier(turn.sessionId, "sessionId", 191),
    turnId: reviewIdentifier(turn.turnId, "turnId", 191),
  };
}

/** The (tenant, session, turn) keys a sweep closes, refusing one named twice. */
export function checkedTurnKeys(turns: readonly Pick<OpenTurnFact, "tenantId" | "sessionId" | "turnId">[]): Pick<OpenTurnFact, "tenantId" | "sessionId" | "turnId">[] {
  if (!Array.isArray(turns)) invalid("turns", "must be a list of turn keys");
  const keys = new Set<string>();
  return turns.map((turn) => {
    const checked = checkedTurnKey(turn);
    const key = JSON.stringify([checked.tenantId, checked.sessionId, checked.turnId]);
    if (keys.has(key)) invalid("turns", "must not repeat a (tenantId, sessionId, turnId)");
    keys.add(key);
    return checked;
  });
}

export function checkedOpenTurnFactQuery(query: OpenTurnFactQuery): OpenTurnFactQuery {
  const before = reviewTime(query.before, "before"); const limit = reviewPageSize(query.limit, "limit", OPEN_TURN_FACT_PAGE_MAX);
  if (query.after === undefined) return { before, limit };
  return { before, limit, after: { ...checkedTurnKey(query.after), endedAt: reviewTime(query.after.endedAt, "after.endedAt") } };
}

/** The order the sweep lists open facts in: oldest last event first, then (tenantId, sessionId, turnId). */
export function compareOpenTurnFacts(left: OpenTurnFact, right: OpenTurnFact): number {
  for (const field of ["endedAt", "tenantId", "sessionId", "turnId"] as const) if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  return 0;
}

function checkedAgentIds(agentIds: readonly string[] | undefined): { agentIds?: readonly string[] } {
  if (agentIds === undefined) return {};
  if (!Array.isArray(agentIds)) invalid("agentIds", "must be a list of agent ids");
  return { agentIds: [...new Set(agentIds.map((agentId) => reviewIdentifier(agentId, "agentIds", 100)))].sort() };
}

export function checkedUsageQuery(query: UsageQuery): UsageQuery {
  const from = reviewTime(query.from, "from"); const to = reviewTime(query.to, "to");
  if (from >= to) invalid("to", "must be later than from");
  return { from, to, ...checkedAgentIds(query.agentIds) };
}

export function checkedUsageSeriesQuery(query: UsageSeriesQuery): UsageSeriesQuery {
  return { ...checkedUsageQuery(query), bucket: reviewOneOf(query.bucket, "bucket", ["day", "week"]) };
}

/** What a daily group is recomputed from: the fields of each fact of its (tenant, agent, day). */
export type UsageFactCounts = Pick<TurnFact, "channel" | "releaseId" | "origin" | "status" | "responseMs" | "cards" | "toolCalls">;

/** The histogram slot of a response time: the first bound it does not exceed, or the last slot. */
export function usageResponseSlot(responseMs: number): number {
  const slot = USAGE_RESPONSE_BUCKETS_MS.findIndex((bound) => responseMs <= bound);
  return slot === -1 ? USAGE_RESPONSE_BUCKETS_MS.length : slot;
}

/** A group with every count zero: what a stored group becomes when none of its facts remain in it. */
export function emptyUsageGroup(group: Pick<UsageDailyGroup, "tenantId" | "agentId" | "day" | "channel" | "releaseId" | "origin">, projectorRevision: string): UsageDailyGroup {
  return {
    tenantId: group.tenantId, agentId: group.agentId, day: group.day, channel: group.channel, releaseId: group.releaseId, origin: group.origin,
    turns: 0, completed: 0, partial: 0, paused: 0, failed: 0, cards: 0, toolCalls: 0, responseMsSum: 0, responseCount: 0,
    responseHistogram: Array.from({ length: USAGE_RESPONSE_BUCKETS_MS.length + 1 }, () => 0), projectorRevision,
  };
}

/** The key that orders and identifies a group within its (tenant, agent, day). */
export const usageGroupKey = (group: Pick<UsageDailyGroup, "channel" | "releaseId" | "origin">) => JSON.stringify([group.channel, group.releaseId, group.origin]);

/** The daily groups of one (tenant, agent, day), recomputed from its facts but the open ones, ordered by (channel, releaseId, origin). */
export function usageDailyGroups(scope: Pick<UsageDailyGroup, "tenantId" | "agentId" | "day">, facts: readonly UsageFactCounts[], projectorRevision: string): UsageDailyGroup[] {
  const groups = new Map<string, { -readonly [K in keyof UsageDailyGroup]: UsageDailyGroup[K] } & { responseHistogram: number[] }>();
  for (const fact of facts) {
    if (fact.status === "open") continue;
    const key = usageGroupKey(fact);
    let group = groups.get(key);
    if (!group) {
      const empty = emptyUsageGroup({ ...scope, channel: fact.channel, releaseId: fact.releaseId, origin: fact.origin }, projectorRevision);
      group = { ...empty, responseHistogram: [...empty.responseHistogram] };
      groups.set(key, group);
    }
    group.turns += 1;
    if (fact.status === "completed") group.completed += 1;
    else if (fact.status === "partial") group.partial += 1;
    else if (fact.status === "awaiting_approval" || fact.status === "awaiting_interaction") group.paused += 1;
    else if (fact.status === "failed") group.failed += 1;
    group.cards += fact.cards;
    group.toolCalls += fact.toolCalls;
    if (fact.responseMs !== undefined) {
      group.responseMsSum += fact.responseMs;
      group.responseCount += 1;
      group.responseHistogram[usageResponseSlot(fact.responseMs)]! += 1;
    }
  }
  return [...groups].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, group]) => group);
}
