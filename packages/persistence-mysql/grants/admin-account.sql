-- Privileges for the operator console's account (admin API, its projector and its workers).
--
-- Order: create the account (locally deploy/local/mysql-init/002_admin_user.sql, which grants nothing) -> migrate both
-- schemas -> this script. Run it as an account that may GRANT, AFTER both migration sets have created the tables, and replace
-- `agentic_admin`@`%` and the schema name with yours. With the control plane in its own database, the grants on the
-- control-plane tables name that database instead.
--
-- What it buys: the console reads the session journal and never writes it; it writes only its own projections, its
-- access log and the control-plane rows an operator changes. No table grants DELETE: removing something is a status
-- change, and purging is a maintenance account's job. Upserts update only the columns listed here, so an
-- `INSERT ... ON DUPLICATE KEY UPDATE` naming any other column is refused.

REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'agentic_admin'@'%';

-- The journal, read only.
GRANT SELECT ON `agentic`.`agentic_session_stream` TO 'agentic_admin'@'%';
GRANT SELECT ON `agentic`.`agentic_session_event` TO 'agentic_admin'@'%';
GRANT SELECT ON `agentic`.`agentic_session_turn_request` TO 'agentic_admin'@'%';

-- Control plane.
GRANT SELECT, INSERT ON `agentic`.`agentic_platform_principal` TO 'agentic_admin'@'%';
GRANT UPDATE(display_name, status, version, updated_at) ON `agentic`.`agentic_platform_principal` TO 'agentic_admin'@'%';
GRANT SELECT, INSERT ON `agentic`.`agentic_catalog_member` TO 'agentic_admin'@'%';
GRANT UPDATE(status, version, granted_by, updated_at) ON `agentic`.`agentic_catalog_member` TO 'agentic_admin'@'%';
GRANT SELECT, INSERT ON `agentic`.`agentic_catalog_audit` TO 'agentic_admin'@'%';
GRANT SELECT ON `agentic`.`agentic_shard` TO 'agentic_admin'@'%';
GRANT SELECT ON `agentic`.`agentic_shard_map` TO 'agentic_admin'@'%';
GRANT SELECT ON `agentic`.`agentic_shard_map_version` TO 'agentic_admin'@'%';

-- Catalog (control-plane migration 0002). Revisions, releases, their items and checks are insert-only; the console moves
-- draft pointers, channels and revocations through the listed columns. Build rows and generation status are the running
-- service's to write, so the console only reads them.
GRANT SELECT, INSERT ON `agentic`.`agentic_catalog_agent` TO 'agentic_admin'@'%';
GRANT UPDATE(status, release_counter, taxonomy_version, version, updated_at) ON `agentic`.`agentic_catalog_agent` TO 'agentic_admin'@'%';
GRANT SELECT, INSERT ON `agentic`.`agentic_catalog_item` TO 'agentic_admin'@'%';
GRANT UPDATE(draft_revision_id, status, version, updated_by, updated_at) ON `agentic`.`agentic_catalog_item` TO 'agentic_admin'@'%';
GRANT SELECT, INSERT ON `agentic`.`agentic_catalog_item_revision` TO 'agentic_admin'@'%';
GRANT SELECT, INSERT ON `agentic`.`agentic_catalog_release` TO 'agentic_admin'@'%';
GRANT UPDATE(status, revoked_by, revoked_at) ON `agentic`.`agentic_catalog_release` TO 'agentic_admin'@'%';
GRANT SELECT, INSERT ON `agentic`.`agentic_catalog_release_item` TO 'agentic_admin'@'%';
GRANT SELECT, INSERT ON `agentic`.`agentic_catalog_release_check` TO 'agentic_admin'@'%';
GRANT SELECT, INSERT ON `agentic`.`agentic_catalog_channel` TO 'agentic_admin'@'%';
GRANT UPDATE(release_id, version, updated_by, updated_at) ON `agentic`.`agentic_catalog_channel` TO 'agentic_admin'@'%';
GRANT SELECT ON `agentic`.`agentic_catalog_build` TO 'agentic_admin'@'%';
GRANT SELECT ON `agentic`.`agentic_generation_status` TO 'agentic_admin'@'%';

-- Shard: worker leases and the projector's position.
GRANT SELECT, INSERT ON `agentic`.`agentic_worker_lease` TO 'agentic_admin'@'%';
GRANT UPDATE(lease_owner, fencing_token, lease_expires_at) ON `agentic`.`agentic_worker_lease` TO 'agentic_admin'@'%';
GRANT SELECT, INSERT ON `agentic`.`agentic_projection_watermark` TO 'agentic_admin'@'%';
GRANT UPDATE(watermark_at, projector_revision, updated_at) ON `agentic`.`agentic_projection_watermark` TO 'agentic_admin'@'%';
GRANT SELECT, INSERT ON `agentic`.`agentic_projection_cursor` TO 'agentic_admin'@'%';
GRANT UPDATE(projected_seq, projector_revision, updated_at) ON `agentic`.`agentic_projection_cursor` TO 'agentic_admin'@'%';

-- Shard: what the console shows. Transcript entries and access rows are written once and never edited.
GRANT SELECT ON `agentic`.`agentic_tenant_profile` TO 'agentic_admin'@'%';
GRANT SELECT, INSERT ON `agentic`.`agentic_review_session` TO 'agentic_admin'@'%';
GRANT UPDATE(agent_id, channel, actor_key, actor_key_version, last_turn_at, answers, transcript_mask_version, version, updated_at)
  ON `agentic`.`agentic_review_session` TO 'agentic_admin'@'%';
GRANT SELECT, INSERT ON `agentic`.`agentic_review_transcript` TO 'agentic_admin'@'%';
GRANT SELECT, INSERT ON `agentic`.`agentic_review_access` TO 'agentic_admin'@'%';

-- Shard: usage statistics (migration 0006). Facts and daily groups are upserted and never deleted.
GRANT SELECT, INSERT ON `agentic`.`agentic_turn_fact` TO 'agentic_admin'@'%';
GRANT UPDATE(agent_id, channel, release_id, runtime_snapshot_id, origin, actor_key, actor_key_version, day, started_at, first_output_at, ended_at,
  status, response_ms, first_output_ms, steps, tool_calls, tool_failed, tool_refused, cards, input_tokens, output_tokens, source_last_seq, projector_revision)
  ON `agentic`.`agentic_turn_fact` TO 'agentic_admin'@'%';
GRANT SELECT, INSERT ON `agentic`.`agentic_tenant_usage_daily` TO 'agentic_admin'@'%';
GRANT UPDATE(turns, completed, partial, paused, failed, cards, tool_calls, resp_ms_sum, resp_count, resp_hist, projector_revision, updated_at)
  ON `agentic`.`agentic_tenant_usage_daily` TO 'agentic_admin'@'%';
GRANT SELECT, INSERT ON `agentic`.`agentic_tenant_item_usage_daily` TO 'agentic_admin'@'%';
GRANT UPDATE(calls, ok, failed, refused, cards, elapsed_ms_sum, projector_revision, updated_at)
  ON `agentic`.`agentic_tenant_item_usage_daily` TO 'agentic_admin'@'%';

FLUSH PRIVILEGES;
