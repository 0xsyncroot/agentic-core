import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { UsageDailyGroup } from "@0xsyncroot/contracts";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { usageStoreConformance } from "../../contracts/test/usage-store-conformance.js";
import { MySqlUsageStore, MySqlWorkerLeaseStore } from "../src/index.js";
import { ADMIN_PASSWORD, ADMIN_USER, appUrl, openPool, ownerUrl, provision, urlAs } from "./mysql-fixture.js";

const ISO = (column: string) => `DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%s.%fZ')`;
const TABLES = ["turn_fact", "tenant_usage_daily", "tenant_item_usage_daily"] as const;

describe("mysql usage stores", { skip: appUrl && ownerUrl ? false : "TEST_MYSQL_URL and TEST_MYSQL_OWNER_URL are not set" }, () => {
  let app: Pool; let admin: Pool;
  before(async () => {
    await provision();
    app = openPool(appUrl!); admin = openPool(urlAs(appUrl!, ADMIN_USER, ADMIN_PASSWORD));
  });
  after(async () => { await Promise.all([app?.end(), admin?.end()]); });

  usageStoreConformance("mysql", async () => {
    const usage = new MySqlUsageStore(admin);
    return {
      projection: usage, query: usage, leases: new MySqlWorkerLeaseStore(admin),
      daily: async (tenantId, agentId, day) => {
        const [rows] = await admin.execute<RowDataPacket[]>(
          `SELECT channel, release_id, origin, turns, completed, partial, paused, failed, cards, tool_calls, resp_ms_sum, resp_count, resp_hist, projector_revision
             FROM agentic_tenant_usage_daily WHERE tenant_id = ? AND agent_id = ? AND day = ? ORDER BY channel, release_id, origin`, [tenantId, agentId, day]);
        return rows.map((row): UsageDailyGroup => ({
          tenantId, agentId, day, channel: row.channel, releaseId: row.release_id, origin: row.origin, turns: Number(row.turns), completed: Number(row.completed),
          partial: Number(row.partial), paused: Number(row.paused), failed: Number(row.failed), cards: Number(row.cards), toolCalls: Number(row.tool_calls),
          responseMsSum: Number(row.resp_ms_sum), responseCount: Number(row.resp_count), responseHistogram: JSON.parse(row.resp_hist), projectorRevision: row.projector_revision,
        }));
      },
      ending: async (tenantId, sessionId, turnId) => {
        const [rows] = await admin.execute<RowDataPacket[]>(
          `SELECT status, ${ISO("ended_at")} AS ended_at, response_ms, first_output_ms FROM agentic_turn_fact WHERE tenant_id = ? AND session_id = ? AND turn_id = ?`,
          [tenantId, sessionId, turnId]);
        const row = rows[0];
        if (!row) return undefined;
        return {
          status: row.status, ...(row.ended_at === null ? {} : { endedAt: row.ended_at }), ...(row.response_ms === null ? {} : { responseMs: Number(row.response_ms) }),
          ...(row.first_output_ms === null ? {} : { firstOutputMs: Number(row.first_output_ms) }),
        };
      },
    };
  });

  test("the console's account writes the usage tables but deletes nothing there, and the agent's account cannot reach them", async () => {
    /** 1142 refuses a table, 1143 a column the account may not change. */
    const refused = (pool: Pool, statement: string, errno = 1142) => assert.rejects(pool.query(statement), (error: { errno?: number }) => error.errno === errno, statement);
    for (const table of TABLES) {
      await admin.query(`SELECT 1 FROM agentic_${table} LIMIT 1`);
      await refused(admin, `DELETE FROM agentic_${table} WHERE 1 = 0`);
      await refused(app, `SELECT 1 FROM agentic_${table} LIMIT 1`);
      await refused(app, `DELETE FROM agentic_${table} WHERE 1 = 0`);
    }
    await admin.query("UPDATE agentic_turn_fact SET status = status WHERE 1 = 0");
    await admin.query("UPDATE agentic_tenant_usage_daily SET turns = turns, updated_at = updated_at WHERE 1 = 0");
    await admin.query("UPDATE agentic_tenant_item_usage_daily SET calls = calls, updated_at = updated_at WHERE 1 = 0");
    await refused(admin, "UPDATE agentic_turn_fact SET tenant_id = tenant_id WHERE 1 = 0", 1143);
    await refused(admin, "UPDATE agentic_tenant_usage_daily SET day = day WHERE 1 = 0", 1143);
  });
});
