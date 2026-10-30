# @0xsyncroot/persistence-mysql

The MySQL adapter for the session journal, durable memory, the review projection and the control plane.

## Database accounts

Each account gets its rights from a script in `grants/`, run as an account that may GRANT. Table and column grants
need the tables to exist, so the order is fixed:

1. Create the accounts. Locally, `deploy/local/mysql-init/` does it at first boot:
   - `001_app_user.sql` gives the service account a schema-wide SELECT, INSERT and UPDATE.
   - `002_admin_user.sql` gives the console account no rights at all.
2. Migrate both schemas with `npm run db:migrate:mysql`. `DATABASE_URL` is the shard; `CATALOG_DATABASE_URL` is the
   control plane and defaults to the shard.
3. Apply `grants/app-account.sql` for the service account. Its column grant on `last_appended_at` needs migration
   0005, so the script fails before 0005 has run; its catalog block needs control-plane migration 0002.
4. Apply `grants/admin-account.sql` for the console account. Until this step every statement the console runs is
   refused. Its usage-statistics block needs migration 0006 and its catalog block control-plane migration 0002.

The console account reads the session journal and never writes it. No grant in either script includes DELETE.

## Catalog

Control-plane migration 0002 adds the catalog: agents, items with a draft pointer, revisions, releases with their items,
release checks, channels, build components and per-pod generation status. `MySqlCatalogStore` is the console's editor,
`MySqlCatalogReader` what the agent reads a release with, and `MySqlCatalogBuildRegistry` what a running service writes
about itself.

- Revisions, releases, release items, checks and build components are insert-only. The same body of an item is stored
  once; a release's `manifest_hash` covers its items' kinds, ids and body hashes.
- The console account inserts and updates only the columns that change: an item's draft and status, a channel's release
  and version, a release's revocation, an agent's release counter. Channels and drafts move by compare-and-set on
  `version`.
- The service account only reads, and not the draft table. No shipped account may write build or generation rows yet;
  that grant comes with the service that writes them.

## Usage statistics

Migration 0006 adds three shard tables that only the console account reaches: `turn_fact` (one row per turn),
`tenant_usage_daily` (groups per tenant, agent, local day, channel, release and origin) and `tenant_item_usage_daily`
(per tool or skill; created, not yet written). A day is the calendar day in Asia/Ho_Chi_Minh. `MySqlUsageStore` writes
facts under the projector's lease and recomputes each touched day from its facts; a group whose facts all moved stays
stored at zero, because no account may delete. Counts of distinct tenants and people are exact per shard, and a tenant
lives in one shard, so a caller adds shards' counts and sums.

Index use of the counts: with agentIds, the range counts narrow key `agent_day_actor (agent_id, day, …)`; without them,
the query scans `turn_fact`. The activated count (tenants with a usage turn before `to`, at any earlier time) has no
lower day bound, so it scans `turn_fact`, or all rows of the given agents. Measure these queries on production volume
before adding a `(status, day)` or `(day)` key.

A turn seen without its close is stored `open`, with `ended_at` at its last event so far, and counts nowhere. The
projector's sweep lists open facts older than a cutoff (`listOpenTurnFacts`, a keyset page over index
`open_sweep (status, ended_at)` across the shard's tenants) and closes them (`abandonOpenTurnFacts`): status becomes
`abandoned` at that same `ended_at`, the touched days are recomputed, and a rerun closes nothing more.

## The append stamp

At boot, `createMySqlPersistence` probes whether its account may write `agentic_session_stream.last_appended_at`.
The probe updates no row.
- If the probe passes, every append stamps the stream in the same UPDATE that moves `current_seq`.
- If the grant or the column is missing, the service boots with the stamp off, logs `mysql.append-stamp.disabled`, and
  appends exactly as before. The review projector then reaches those streams only through `streamsByKey`.

Operations note: revoking that column grant from a running service makes every append fail with MySQL error 1143.
The service's probe ran at boot and still says the stamp is on. Restart the service right after any such revoke; its
next probe turns the stamp off.
