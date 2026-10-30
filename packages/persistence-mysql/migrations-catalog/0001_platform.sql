-- Control plane: operators, their roles, the audit of what they did, and shard routing. Shared by every tenant, never
-- sharded, recorded in its own ledger. The configured operator is seeded at boot through AdminPrincipalStore.ensureSeed,
-- which audits what it creates; no principal is created here.

-- issuer and subject are compared exactly; display_name is free text.
CREATE TABLE IF NOT EXISTS agentic_platform_principal (
  principal_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  issuer varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subject varchar(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name varchar(200) NOT NULL, status varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version bigint unsigned NOT NULL DEFAULT 0, created_at datetime(6) NOT NULL, updated_at datetime(6) NOT NULL,
  PRIMARY KEY (principal_id), UNIQUE KEY issuer_subject (issuer, subject)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One role in one scope; a platform scope has the empty scope id. Removing a role sets its status, never deletes the row.
CREATE TABLE IF NOT EXISTS agentic_catalog_member (
  scope_kind varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version bigint unsigned NOT NULL DEFAULT 0, granted_by char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_at datetime(6) NOT NULL,
  PRIMARY KEY (scope_kind, scope_id, principal_id, role), KEY member_principal (principal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Insert-only.
CREATE TABLE IF NOT EXISTS agentic_catalog_audit (
  scope_kind varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope_id varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  audit_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_scope varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_kind varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  before_hash char(64) CHARACTER SET ascii COLLATE ascii_bin, after_hash char(64) CHARACTER SET ascii COLLATE ascii_bin,
  detail mediumtext, at datetime(6) NOT NULL,
  PRIMARY KEY (scope_kind, scope_id, audit_id), KEY audit_target (scope_kind, scope_id, target_kind, target_id, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- dsn_ref names the deployment secret that holds the shard's connection string; the string itself is never stored.
CREATE TABLE IF NOT EXISTS agentic_shard (
  shard_id varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  dsn_ref varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, weight smallint unsigned NOT NULL DEFAULT 100,
  version bigint unsigned NOT NULL DEFAULT 0, updated_at datetime(6) NOT NULL,
  PRIMARY KEY (shard_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A tenant without a row lives in the default shard.
CREATE TABLE IF NOT EXISTS agentic_shard_map (
  tenant_id varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  shard_id varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, map_version bigint unsigned NOT NULL,
  updated_by char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, updated_at datetime(6) NOT NULL,
  PRIMARY KEY (tenant_id), KEY shard_state (shard_id, state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One row, map_name 'routing', moved in the same transaction as every change to shard or shard_map.
CREATE TABLE IF NOT EXISTS agentic_shard_map_version (
  map_name varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, map_version bigint unsigned NOT NULL,
  updated_at datetime(6) NOT NULL,
  PRIMARY KEY (map_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
