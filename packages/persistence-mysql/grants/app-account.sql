-- Narrow privileges for the account the service connects with.
--
-- The migration tool used to apply these itself, which meant migrating required a second,
-- administrative connection. Owning database accounts belongs to whoever owns the database, so
-- this is a script to run rather than something the application does at start-up — and the
-- adapter no longer inspects the account's grants either.
--
-- Run it as an account that may GRANT, AFTER both migration sets (shard and control plane) have created the tables, and
-- replace `agentic_app`@`%` and the schema name with yours. The column grant on
-- `last_appended_at` names a column migration 0005 adds, so this script fails before 0005 has run.
--
-- The service probes that column grant once at boot and stamps appends only when it passes.
-- Revoking it from a running service makes every append fail with 1143 until the service
-- restarts and its probe turns the stamp off; restart right after any revoke.
--
-- What it buys: the service can append to the event log and advance the few columns that are
-- genuinely mutable, and nothing else. It cannot rewrite a recorded event, edit a memory
-- revision, delete a row, or read the migration ledger — so a flaw reachable from the chat box
-- cannot quietly rewrite history that an auditor is expected to trust.

REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'agentic_app'@'%';

GRANT SELECT, INSERT ON `agentic`.`agentic_session_stream` TO 'agentic_app'@'%';
GRANT UPDATE(current_seq, owner_actor_id, agent_profile_id, lease_owner, lease_fencing_token, lease_expires_at, active_turn_id, active_idempotency_key,
  last_appended_at)
  ON `agentic`.`agentic_session_stream` TO 'agentic_app'@'%';

GRANT SELECT, INSERT ON `agentic`.`agentic_session_append_dedupe` TO 'agentic_app'@'%';
GRANT SELECT, INSERT ON `agentic`.`agentic_session_event` TO 'agentic_app'@'%';

GRANT SELECT, INSERT ON `agentic`.`agentic_session_turn_request` TO 'agentic_app'@'%';
GRANT UPDATE(status, finished_at, result_seq, error_code)
  ON `agentic`.`agentic_session_turn_request` TO 'agentic_app'@'%';

GRANT SELECT, INSERT ON `agentic`.`agentic_memory_record` TO 'agentic_app'@'%';
GRANT UPDATE(status, current_revision) ON `agentic`.`agentic_memory_record` TO 'agentic_app'@'%';

GRANT SELECT, INSERT ON `agentic`.`agentic_memory_revision` TO 'agentic_app'@'%';

GRANT SELECT, INSERT ON `agentic`.`agentic_memory_outbox` TO 'agentic_app'@'%';
GRANT UPDATE(processed_at) ON `agentic`.`agentic_memory_outbox` TO 'agentic_app'@'%';

-- Per-person settings (migration 0004): a person's own row is written again on every change, never deleted.
GRANT SELECT, INSERT ON `agentic`.`agentic_actor_setting` TO 'agentic_app'@'%';
GRANT UPDATE(setting_value, revision, updated_at) ON `agentic`.`agentic_actor_setting` TO 'agentic_app'@'%';

-- The catalog (control-plane migration 0002), read only: the releases the service is served from. Draft items are the
-- console's and stay unreadable here. A right to write build rows, generation status or checks is granted only together
-- with the feature of the service that writes them.
GRANT SELECT ON `agentic`.`agentic_catalog_agent` TO 'agentic_app'@'%';
GRANT SELECT ON `agentic`.`agentic_catalog_item_revision` TO 'agentic_app'@'%';
GRANT SELECT ON `agentic`.`agentic_catalog_release` TO 'agentic_app'@'%';
GRANT SELECT ON `agentic`.`agentic_catalog_release_item` TO 'agentic_app'@'%';
GRANT SELECT ON `agentic`.`agentic_catalog_release_check` TO 'agentic_app'@'%';
GRANT SELECT ON `agentic`.`agentic_catalog_channel` TO 'agentic_app'@'%';
GRANT SELECT ON `agentic`.`agentic_catalog_build` TO 'agentic_app'@'%';
GRANT SELECT ON `agentic`.`agentic_generation_status` TO 'agentic_app'@'%';

-- The review tables, worker leases, tenant profiles and shard routing belong to the operator console's
-- account (admin-account.sql); this account gets a right on one only when a feature of the service
-- writes or reads it.

FLUSH PRIVILEGES;
