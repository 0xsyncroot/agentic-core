-- Catalog: the configuration each agent runs with. Revisions, releases, release items, checks and build rows are
-- insert-only; an item's draft pointer, a channel's release, a release's revocation and a generation's status are the only
-- columns that change, each table that changes has a version for compare-and-set, and nothing is deleted.

-- release_counter numbers the agent's releases; it grows in the same transaction that inserts a release.
CREATE TABLE IF NOT EXISTS agentic_catalog_agent (
  agent_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  product_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  release_counter int unsigned NOT NULL DEFAULT 0, taxonomy_version int unsigned NOT NULL DEFAULT 0,
  version bigint unsigned NOT NULL DEFAULT 0, created_by char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at datetime(6) NOT NULL, updated_at datetime(6) NOT NULL,
  PRIMARY KEY (agent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- An item and the revision its draft points at; retiring an item is a status change.
CREATE TABLE IF NOT EXISTS agentic_catalog_item (
  agent_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_kind varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  draft_revision_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version bigint unsigned NOT NULL DEFAULT 0, updated_by char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_at datetime(6) NOT NULL,
  PRIMARY KEY (agent_id, item_kind, item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Insert-only. One row per distinct body of an item (item_body), so saving the same body again finds the stored revision.
-- display_name, summary and required_tool_count are derived from the body when inserted, so lists never parse bodies;
-- display_name is not unique and keeps the accent-insensitive collation for search.
CREATE TABLE IF NOT EXISTS agentic_catalog_item_revision (
  agent_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_kind varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parent_revision_id char(36) CHARACTER SET ascii COLLATE ascii_bin,
  body_format varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, schema_version int unsigned NOT NULL,
  display_name varchar(200) NOT NULL, summary varchar(1000) NOT NULL, required_tool_count smallint unsigned NOT NULL,
  body mediumtext NOT NULL, body_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  author_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  author_scope varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  note varchar(500), created_at datetime(6) NOT NULL,
  PRIMARY KEY (agent_id, item_kind, item_id, revision_id), UNIQUE KEY item_body (agent_id, item_kind, item_id, body_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A release is its release_item rows; manifest_hash is the sha256 of their sorted list. status is active or revoked only:
-- which release is live is read from catalog_channel.
CREATE TABLE IF NOT EXISTS agentic_catalog_release (
  agent_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  release_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  release_no int unsigned NOT NULL, manifest_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revoked_by char(36) CHARACTER SET ascii COLLATE ascii_bin, revoked_at datetime(6),
  created_by char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, created_at datetime(6) NOT NULL,
  PRIMARY KEY (agent_id, release_id), UNIQUE KEY release_no (agent_id, release_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Insert-only.
CREATE TABLE IF NOT EXISTS agentic_catalog_release_item (
  agent_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  release_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_kind varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  body_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (agent_id, release_id, item_kind, item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Insert-only: the first result of a check against one build stands.
CREATE TABLE IF NOT EXISTS agentic_catalog_release_check (
  agent_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  release_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  check_kind varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  build_digest char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, detail mediumtext,
  checked_by varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, checked_at datetime(6) NOT NULL,
  PRIMARY KEY (agent_id, release_id, check_kind, build_digest)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Moved only by compare-and-set on version.
CREATE TABLE IF NOT EXISTS agentic_catalog_channel (
  agent_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  channel varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  release_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version bigint unsigned NOT NULL DEFAULT 0, updated_by char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_at datetime(6) NOT NULL,
  PRIMARY KEY (agent_id, channel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Insert-only: what each build of a service provides (behaviours, connector kinds, permission names).
CREATE TABLE IF NOT EXISTS agentic_catalog_build (
  build_digest char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  component_kind varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  component_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  build_version varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, registered_at datetime(6) NOT NULL,
  PRIMARY KEY (build_digest, component_kind, component_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One row per pod and release, replaced as the pod builds the release's generation.
CREATE TABLE IF NOT EXISTS agentic_generation_status (
  agent_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  release_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  pod_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  build_digest char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  error_code varchar(64) CHARACTER SET ascii COLLATE ascii_bin, detail text, updated_at datetime(6) NOT NULL,
  PRIMARY KEY (agent_id, release_id, pod_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
