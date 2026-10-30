-- Usage statistics, shard side. One fact per turn; daily groups are recomputed from the facts and never deleted.
-- A turn seen without its close is stored with status 'open' and ended_at = the time of its last event so far; usage
-- counts and daily groups leave it out until a later close replaces it or the sweep turns it 'abandoned' at that time.
-- `day` is the calendar day in Asia/Ho_Chi_Minh (UTC+7) of started_at. Identifier and code columns are ascii_bin.
-- release_id is never null because it is part of the daily keys: before releases exist every row carries
-- 00000000-0000-7000-8000-000000000000.

CREATE TABLE IF NOT EXISTS agentic_turn_fact (
  tenant_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  turn_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  agent_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  channel varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  release_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  runtime_snapshot_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  origin varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_key char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_key_version varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  day date NOT NULL, started_at datetime(6) NOT NULL, first_output_at datetime(6), ended_at datetime(6),
  status varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  response_ms int unsigned, first_output_ms int unsigned,
  steps int unsigned NOT NULL, tool_calls int unsigned NOT NULL, tool_failed int unsigned NOT NULL, tool_refused int unsigned NOT NULL,
  cards int unsigned NOT NULL, input_tokens bigint unsigned NOT NULL, output_tokens bigint unsigned NOT NULL,
  source_last_seq bigint unsigned NOT NULL,
  projector_revision varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (tenant_id, session_id, turn_id),
  KEY tenant_day (tenant_id, agent_id, day),
  KEY agent_day_actor (agent_id, day, tenant_id, actor_key),
  -- The abandoned-turn sweep reads open facts of every tenant in the shard by last event time, so the key starts with
  -- status, not tenant: a tenant-first key would need one scan per tenant. InnoDB appends the primary key, which covers
  -- the sweep's keyset order (ended_at, tenant_id, session_id, turn_id).
  KEY open_sweep (status, ended_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- resp_hist is a JSON array of counts, one per bound of the response-time histogram plus one for everything slower.
CREATE TABLE IF NOT EXISTS agentic_tenant_usage_daily (
  tenant_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  agent_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  day date NOT NULL,
  channel varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  release_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  origin varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  turns int unsigned NOT NULL, completed int unsigned NOT NULL, partial int unsigned NOT NULL, paused int unsigned NOT NULL,
  failed int unsigned NOT NULL, cards int unsigned NOT NULL, tool_calls int unsigned NOT NULL,
  resp_ms_sum bigint unsigned NOT NULL, resp_count int unsigned NOT NULL, resp_hist text NOT NULL,
  projector_revision varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, updated_at datetime(6) NOT NULL,
  PRIMARY KEY (tenant_id, agent_id, day, channel, release_id, origin),
  KEY agent_day (agent_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS agentic_tenant_item_usage_daily (
  tenant_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  agent_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  day date NOT NULL,
  channel varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  release_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_kind varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  calls int unsigned NOT NULL, ok int unsigned NOT NULL, failed int unsigned NOT NULL, refused int unsigned NOT NULL,
  cards int unsigned NOT NULL, elapsed_ms_sum bigint unsigned NOT NULL,
  projector_revision varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, updated_at datetime(6) NOT NULL,
  PRIMARY KEY (tenant_id, agent_id, day, channel, release_id, item_kind, item_id),
  KEY agent_item_day (agent_id, item_kind, item_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
