import { after, describe } from "node:test";
import { createPool, type Pool } from "mysql2/promise";
import { conformance } from "../../contracts/test/session-store-conformance.js";
import { MySqlSessionStore } from "../src/session-store.js";

// The same cases the in-memory and Redis stores pass, against a real MySQL (deploy/local: 8.0.33).
const url = process.env.TEST_MYSQL_URL;

describe("mysql session store", { skip: url ? false : "TEST_MYSQL_URL is not set" }, () => {
  let pool: Pool | undefined;
  after(async () => { await pool?.end(); });
  conformance("mysql", () => new MySqlSessionStore(pool ??= createPool({ uri: url!, timezone: "Z", supportBigNumbers: true, bigNumberStrings: true })));
});
