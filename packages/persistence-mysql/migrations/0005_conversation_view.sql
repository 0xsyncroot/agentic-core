-- Conversation review, shard side. Identifier and code columns are ascii_bin (one byte a character, compared exactly);
-- free text keeps utf8mb4_0900_ai_ci. JSON is canonical text in mediumtext, never the json type, which reprints doubles.
-- Flags are enumerated text. Every primary key starts with tenant_id except the per-shard worker tables.

-- The append path stamps this in the same UPDATE that moves current_seq, once its boot probe proves the column grant.
SET @migration_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns
         WHERE table_schema=DATABASE() AND table_name='agentic_session_stream' AND column_name='last_appended_at'),
  'SELECT 1',
  'ALTER TABLE agentic_session_stream ADD COLUMN last_appended_at datetime(6) NULL, ALGORITHM=INSTANT'
);
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

SET @migration_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.statistics
         WHERE table_schema=DATABASE() AND table_name='agentic_session_stream' AND index_name='stream_recent'),
  'SELECT 1',
  'CREATE INDEX stream_recent ON agentic_session_stream (last_appended_at)'
);
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

-- One holder per background worker kind in this shard; the token grows on every acquisition and fences the holder's writes.
CREATE TABLE IF NOT EXISTS agentic_worker_lease (
  worker_kind varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  lease_owner varchar(191) CHARACTER SET ascii COLLATE ascii_bin,
  fencing_token bigint unsigned NOT NULL DEFAULT 0, lease_expires_at datetime(6),
  PRIMARY KEY (worker_kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS agentic_projection_watermark (
  projector_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, watermark_at datetime(6) NOT NULL,
  projector_revision varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, updated_at datetime(6) NOT NULL,
  PRIMARY KEY (projector_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS agentic_projection_cursor (
  tenant_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  projector_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, projected_seq bigint unsigned NOT NULL,
  projector_revision varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, updated_at datetime(6) NOT NULL,
  PRIMARY KEY (tenant_id, session_id, projector_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS agentic_tenant_profile (
  tenant_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, display_name varchar(300), attributes mediumtext NOT NULL,
  source varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, source_at datetime(6) NOT NULL,
  version bigint unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The projected header of a conversation: who (as a pseudonym), when, how many answers. No conversation content.
CREATE TABLE IF NOT EXISTS agentic_review_session (
  tenant_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  agent_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  channel varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_key char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_key_version varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  started_at datetime(6) NOT NULL, last_turn_at datetime(6) NOT NULL, answers int unsigned NOT NULL,
  transcript_mask_version varchar(32) CHARACTER SET ascii COLLATE ascii_bin,
  version bigint unsigned NOT NULL DEFAULT 0, updated_at datetime(6) NOT NULL,
  PRIMARY KEY (tenant_id, session_id), KEY agent_started (agent_id, started_at), KEY session_lookup (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Masked entries, written once per mask version and never edited; created_at is when the entry happened in the conversation.
CREATE TABLE IF NOT EXISTS agentic_review_transcript (
  tenant_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mask_version varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, entry_seq bigint unsigned NOT NULL,
  turn_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, answer_index int unsigned,
  role varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  body_format varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  body mediumtext NOT NULL, tool_labels text, masked_values int unsigned NOT NULL,
  source_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, created_at datetime(6) NOT NULL,
  PRIMARY KEY (tenant_id, session_id, mask_version, entry_seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One row each time an operator opens a conversation; insert-only.
CREATE TABLE IF NOT EXISTS agentic_review_access (
  tenant_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  access_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin,
  action varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  purpose varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  detail text, at datetime(6) NOT NULL,
  PRIMARY KEY (tenant_id, access_id), KEY session_access (tenant_id, session_id, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
