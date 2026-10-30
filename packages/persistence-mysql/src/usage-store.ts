import {
  checkedOpenTurnFactQuery, checkedTurnFacts, checkedTurnKeys, checkedUsageQuery, checkedUsageSeriesQuery, emptyUsageGroup, reviewIdentifier,
  usageBucketKey, usageBuckets, usageDailyGroups, usageDay, usageGroupKey, type LeaseFence, type OpenTurnFact, type OpenTurnFactQuery,
  type ReviewChannel, type TurnFact, type TurnFactStatus, type TurnOrigin, type UsageBucket, type UsageDailyGroup, type UsagePoint,
  type UsageProjectionStore, type UsageQuery, type UsageQueryStore, type UsageSeriesQuery, type UsageTotals,
} from "@0xsyncroot/contracts";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { isoColumn, mysqlTime } from "./mysql-time.js";
import { assertFence } from "./review-rows.js";
import { withTransaction } from "./transaction.js";

type Scope = Pick<UsageDailyGroup, "tenantId" | "agentId" | "day">;

const FACT_COLUMNS = [
  "tenant_id", "session_id", "turn_id", "agent_id", "channel", "release_id", "runtime_snapshot_id", "origin", "actor_key", "actor_key_version", "day",
  "started_at", "first_output_at", "ended_at", "status", "response_ms", "first_output_ms", "steps", "tool_calls", "tool_failed", "tool_refused", "cards",
  "input_tokens", "output_tokens", "source_last_seq", "projector_revision",
] as const;
/** The key columns are written once; every other column follows the fact, which the console account's column grants also hold. */
const FACT_UPSERT = `INSERT INTO agentic_turn_fact (${FACT_COLUMNS.join(", ")}) VALUES (${FACT_COLUMNS.map(() => "?").join(", ")}) AS fresh
  ON DUPLICATE KEY UPDATE ${FACT_COLUMNS.slice(3).map((column) => `${column} = fresh.${column}`).join(", ")}`;

const GROUP_COUNTS = ["turns", "completed", "partial", "paused", "failed", "cards", "tool_calls", "resp_ms_sum", "resp_count"] as const;
const GROUP_UPSERT = `INSERT INTO agentic_tenant_usage_daily
    (tenant_id, agent_id, day, channel, release_id, origin, ${GROUP_COUNTS.join(", ")}, resp_hist, projector_revision, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ${GROUP_COUNTS.map(() => "?").join(", ")}, ?, ?, UTC_TIMESTAMP(6)) AS fresh
  ON DUPLICATE KEY UPDATE ${[...GROUP_COUNTS, "resp_hist", "projector_revision", "updated_at"].map((column) => `${column} = fresh.${column}`).join(", ")}`;

const groupValues = (group: UsageDailyGroup) => [
  group.turns, group.completed, group.partial, group.paused, group.failed, group.cards, group.toolCalls, group.responseMsSum, group.responseCount,
  JSON.stringify(group.responseHistogram), group.projectorRevision,
];
const scopeKey = (scope: Scope) => JSON.stringify([scope.tenantId, scope.agentId, scope.day]);
const optional = <T>(value: T | undefined) => (value === undefined ? null : value);
const optionalTime = (value: string | undefined, field: string) => (value === undefined ? null : mysqlTime(value, field));
const factValues = (fact: TurnFact, revision: string) => [
  fact.tenantId, fact.sessionId, fact.turnId, fact.agentId, fact.channel, fact.releaseId, fact.runtimeSnapshotId, fact.origin, fact.actorKey,
  fact.actorKeyVersion, usageDay(fact.startedAt), mysqlTime(fact.startedAt, "startedAt"), optionalTime(fact.firstOutputAt, "firstOutputAt"),
  optionalTime(fact.endedAt, "endedAt"), fact.status, optional(fact.responseMs), optional(fact.firstOutputMs), fact.steps, fact.toolCalls, fact.toolFailed,
  fact.toolRefused, fact.cards, fact.inputTokens, fact.outputTokens, fact.sourceLastSeq, revision,
];

/** The local bucket key of a `day` column, the same key `usageBucketKey` gives. */
const bucketColumn = (bucket: UsageBucket) =>
  bucket === "day" ? "DATE_FORMAT(day, '%Y-%m-%d')" : "DATE_FORMAT(DATE_SUB(day, INTERVAL WEEKDAY(day) DAY), '%Y-%m-%d')";

/** Usage turns of the query's agents: closed turns of `origin` user on the live channel. An empty agent list is answered before any SQL. */
function usageFilter(query: UsageQuery): { readonly sql: string; readonly params: string[] } {
  const agents = query.agentIds === undefined ? "" : ` AND agent_id IN (${query.agentIds.map(() => "?").join(", ")})`;
  return { sql: `FROM agentic_turn_fact WHERE origin = 'user' AND channel = 'live' AND status <> 'open'${agents}`, params: [...(query.agentIds ?? [])] };
}

/**
 * Rows of `[from, to)`; `started_at` decides. The `day` bounds narrow key `agent_day_actor` only when agentIds are given:
 * no key starts with `day`, so a query without agentIds scans turn_fact.
 */
function inRange(query: UsageQuery): { readonly sql: string; readonly params: string[] } {
  const filter = usageFilter(query);
  return {
    sql: `${filter.sql} AND day BETWEEN ? AND ? AND started_at >= ? AND started_at < ?`,
    params: [...filter.params, usageDay(query.from), usageDay(query.to), mysqlTime(query.from, "from"), mysqlTime(query.to, "to")],
  };
}

const ZERO_TOTALS: UsageTotals = Object.freeze({
  tenantsUsed: 0, tenantsActivated: 0, activeUsers: 0, turns: 0, firstOutputMsSum: 0, firstOutputCount: 0, responseMsSum: 0, responseCount: 0,
});

/**
 * Usage facts, their daily groups and the console's counts, over one shard. A save checks its lease fence first, inside the
 * same transaction. Groups are compared before they are written, so a rerun issues no group write and `updated_at` moves
 * only when a group's content does; a group none of whose facts remain is written with zero counts, never deleted. Every
 * distinct count is one `COUNT(DISTINCT …)` over facts, so no count is added up from smaller periods.
 */
export class MySqlUsageStore implements UsageProjectionStore, UsageQueryStore {
  constructor(private readonly pool: Pool) {}

  async saveTurnFacts(facts: readonly TurnFact[], projectorRevision: string, fence: LeaseFence): Promise<void> {
    const checked = checkedTurnFacts(facts);
    const revision = reviewIdentifier(projectorRevision, "projectorRevision", 64);
    await withTransaction(this.pool, async (connection) => {
      await assertFence(connection, fence);
      const scopes = new Map<string, Scope>();
      const touch = (scope: Scope) => scopes.set(scopeKey(scope), scope);
      for (const fact of checked) {
        const [rows] = await connection.execute<RowDataPacket[]>(
          `SELECT agent_id, DATE_FORMAT(day, '%Y-%m-%d') AS day FROM agentic_turn_fact WHERE tenant_id = ? AND session_id = ? AND turn_id = ? FOR UPDATE`,
          [fact.tenantId, fact.sessionId, fact.turnId]);
        if (rows[0]) touch({ tenantId: fact.tenantId, agentId: rows[0].agent_id, day: rows[0].day });
        touch({ tenantId: fact.tenantId, agentId: fact.agentId, day: usageDay(fact.startedAt) });
        await connection.execute(FACT_UPSERT, factValues(fact, revision));
      }
      for (const scope of scopes.values()) await this.#recompute(connection, scope, revision);
    });
  }

  async listOpenTurnFacts(query: OpenTurnFactQuery): Promise<readonly OpenTurnFact[]> {
    const checked = checkedOpenTurnFactQuery(query);
    const after = checked.after === undefined ? "" : " AND (ended_at, tenant_id, session_id, turn_id) > (?, ?, ?, ?)";
    const afterParams = checked.after === undefined ? []
      : [mysqlTime(checked.after.endedAt, "after.endedAt"), checked.after.tenantId, checked.after.sessionId, checked.after.turnId];
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT tenant_id, session_id, turn_id, ${isoColumn("ended_at")} AS ended_at FROM agentic_turn_fact
        WHERE status = 'open' AND ended_at < ?${after} ORDER BY ended_at, tenant_id, session_id, turn_id LIMIT ${checked.limit}`,
      [mysqlTime(checked.before, "before"), ...afterParams]);
    return rows.map((row) => ({ tenantId: row.tenant_id, sessionId: row.session_id, turnId: row.turn_id, endedAt: row.ended_at }));
  }

  async abandonOpenTurnFacts(turns: readonly Pick<OpenTurnFact, "tenantId" | "sessionId" | "turnId">[], before: string, projectorRevision: string, fence: LeaseFence): Promise<number> {
    const checked = checkedTurnKeys(turns); const cutoff = mysqlTime(before, "before");
    const revision = reviewIdentifier(projectorRevision, "projectorRevision", 64);
    return withTransaction(this.pool, async (connection) => {
      await assertFence(connection, fence);
      const scopes = new Map<string, Scope>();
      let closed = 0;
      for (const turn of checked) {
        const key = [turn.tenantId, turn.sessionId, turn.turnId];
        const [rows] = await connection.execute<RowDataPacket[]>(
          `SELECT agent_id, DATE_FORMAT(day, '%Y-%m-%d') AS day FROM agentic_turn_fact
            WHERE tenant_id = ? AND session_id = ? AND turn_id = ? AND status = 'open' AND ended_at < ? FOR UPDATE`, [...key, cutoff]);
        if (!rows[0]) continue;
        await connection.execute(
          `UPDATE agentic_turn_fact SET status = 'abandoned', response_ms = NULL, projector_revision = ? WHERE tenant_id = ? AND session_id = ? AND turn_id = ?`,
          [revision, ...key]);
        const scope = { tenantId: turn.tenantId, agentId: String(rows[0].agent_id), day: String(rows[0].day) };
        scopes.set(scopeKey(scope), scope);
        closed += 1;
      }
      for (const scope of scopes.values()) await this.#recompute(connection, scope, revision);
      return closed;
    });
  }

  async overview(query: UsageQuery): Promise<UsageTotals> {
    const checked = checkedUsageQuery(query);
    if (checked.agentIds?.length === 0) return ZERO_TOTALS;
    const range = inRange(checked); const filter = usageFilter(checked);
    const [[totals], [[activated]]] = await Promise.all([
      this.pool.execute<RowDataPacket[]>(
        `SELECT COUNT(DISTINCT tenant_id) AS used, COUNT(DISTINCT tenant_id, actor_key) AS users, COUNT(*) AS turns,
                COALESCE(SUM(first_output_ms), 0) AS first_sum, COUNT(first_output_ms) AS first_count,
                COALESCE(SUM(response_ms), 0) AS response_sum, COUNT(response_ms) AS response_count ${range.sql}`, range.params),
      this.pool.execute<RowDataPacket[]>(`SELECT COUNT(DISTINCT tenant_id) AS tenants ${filter.sql} AND started_at < ?`, [...filter.params, mysqlTime(checked.to, "to")]),
    ]);
    const row = totals[0]!;
    return {
      tenantsUsed: Number(row.used), tenantsActivated: Number(activated!.tenants), activeUsers: Number(row.users), turns: Number(row.turns),
      firstOutputMsSum: Number(row.first_sum), firstOutputCount: Number(row.first_count),
      responseMsSum: Number(row.response_sum), responseCount: Number(row.response_count),
    };
  }

  async series(query: UsageSeriesQuery): Promise<readonly UsagePoint[]> {
    const checked = checkedUsageSeriesQuery(query);
    const buckets = usageBuckets(checked.from, checked.to, checked.bucket);
    const empty = { tenantsUsed: 0, tenantsActivated: 0, activeUsers: 0, turns: 0 };
    if (checked.agentIds?.length === 0) return buckets.map((bucket) => ({ ...bucket, ...empty }));
    const range = inRange(checked); const filter = usageFilter(checked); const column = bucketColumn(checked.bucket);
    const [[used], [firsts]] = await Promise.all([
      this.pool.execute<RowDataPacket[]>(
        `SELECT ${column} AS bucket, COUNT(DISTINCT tenant_id) AS used, COUNT(DISTINCT tenant_id, actor_key) AS users, COUNT(*) AS turns
           ${range.sql} GROUP BY bucket`, range.params),
      // Each tenant once, at its first usage turn: before the range (bucket '') or in the bucket that turn falls in.
      this.pool.execute<RowDataPacket[]>(
        `SELECT CASE WHEN first_at < ? THEN '' ELSE ${column} END AS bucket, COUNT(*) AS tenants
           FROM (SELECT tenant_id, MIN(started_at) AS first_at, MIN(day) AS day ${filter.sql} AND started_at < ? GROUP BY tenant_id) AS firsts
          GROUP BY bucket`, [mysqlTime(checked.from, "from"), ...filter.params, mysqlTime(checked.to, "to")]),
    ]);
    const counts = new Map(used.map((row) => [String(row.bucket), row] as const));
    const activations = new Map(firsts.map((row) => [String(row.bucket), Number(row.tenants)] as const));
    let activated = activations.get("") ?? 0;
    return buckets.map((bucket) => {
      const bucketKey = usageBucketKey(usageDay(bucket.start), checked.bucket);
      activated += activations.get(bucketKey) ?? 0;
      const row = counts.get(bucketKey);
      return row
        ? { ...bucket, tenantsUsed: Number(row.used), tenantsActivated: activated, activeUsers: Number(row.users), turns: Number(row.turns) }
        : { ...bucket, ...empty, tenantsActivated: activated };
    });
  }

  /** Recomputes every group of one (tenant, agent, day) from its facts and writes the groups whose content changed. */
  async #recompute(connection: PoolConnection, scope: Scope, revision: string): Promise<void> {
    const [facts] = await connection.execute<RowDataPacket[]>(
      `SELECT channel, release_id, origin, status, response_ms, cards, tool_calls FROM agentic_turn_fact WHERE tenant_id = ? AND agent_id = ? AND day = ?`,
      [scope.tenantId, scope.agentId, scope.day]);
    const groups = new Map(usageDailyGroups(scope, facts.map((row) => ({
      channel: row.channel as ReviewChannel, releaseId: String(row.release_id), origin: row.origin as TurnOrigin, status: row.status as TurnFactStatus,
      ...(row.response_ms === null ? {} : { responseMs: Number(row.response_ms) }), cards: Number(row.cards), toolCalls: Number(row.tool_calls),
    })), revision).map((group) => [usageGroupKey(group), group] as const));
    const [stored] = await connection.execute<RowDataPacket[]>(
      `SELECT channel, release_id, origin, ${GROUP_COUNTS.join(", ")}, resp_hist, projector_revision
         FROM agentic_tenant_usage_daily WHERE tenant_id = ? AND agent_id = ? AND day = ? FOR UPDATE`, [scope.tenantId, scope.agentId, scope.day]);
    const storedValues = new Map<string, string>();
    for (const row of stored) {
      const key = { channel: row.channel as ReviewChannel, releaseId: String(row.release_id), origin: row.origin as TurnOrigin };
      const groupKey = usageGroupKey(key);
      storedValues.set(groupKey, JSON.stringify([...GROUP_COUNTS.map((column) => Number(row[column])), String(row.resp_hist), String(row.projector_revision)]));
      if (!groups.has(groupKey)) groups.set(groupKey, emptyUsageGroup({ ...scope, ...key }, revision));
    }
    for (const [groupKey, group] of groups) {
      const values = groupValues(group);
      if (storedValues.get(groupKey) === JSON.stringify(values)) continue;
      await connection.execute(GROUP_UPSERT, [group.tenantId, group.agentId, group.day, group.channel, group.releaseId, group.origin, ...values]);
    }
  }
}
