CREATE TABLE IF NOT EXISTS agentic_session_stream (
  tenant_id varchar(191) NOT NULL, session_id varchar(191) NOT NULL, owner_actor_id varchar(191), agent_profile_id varchar(191),
  current_seq bigint unsigned NOT NULL DEFAULT 0, lease_owner varchar(191), lease_fencing_token bigint unsigned NOT NULL DEFAULT 0,
  lease_expires_at datetime(6), active_turn_id varchar(191), active_idempotency_key varchar(191), created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, session_id), KEY session_owner_created (tenant_id,owner_actor_id,created_at,session_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS agentic_session_append_dedupe (
  tenant_id varchar(191) NOT NULL, session_id varchar(191) NOT NULL, idempotency_key varchar(191) NOT NULL,
  operation_fingerprint char(64) NOT NULL, result_seq bigint unsigned NOT NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (tenant_id,session_id,idempotency_key),
  FOREIGN KEY (tenant_id,session_id) REFERENCES agentic_session_stream(tenant_id,session_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS agentic_session_event (
  event_id char(36) NOT NULL PRIMARY KEY, tenant_id varchar(191) NOT NULL, session_id varchar(191) NOT NULL, seq bigint unsigned NOT NULL,
  actor_id varchar(191) NOT NULL, correlation_id varchar(191) NOT NULL, runtime_snapshot_id varchar(191) NOT NULL, type varchar(191) NOT NULL,
  schema_version int unsigned NOT NULL, occurred_at datetime(6) NOT NULL, recorded_at datetime(6) NOT NULL,
  turn_id varchar(191), step_id varchar(191), request_id varchar(191), call_id varchar(191), attempt_id varchar(191),
  classification varchar(32) NOT NULL, payload json NOT NULL, integrity_hash char(64) NOT NULL,
  UNIQUE KEY session_seq (tenant_id,session_id,seq), KEY session_events (tenant_id,session_id,seq),
  KEY session_checkpoint (tenant_id,session_id,type,seq DESC),
  FOREIGN KEY (tenant_id,session_id) REFERENCES agentic_session_stream(tenant_id,session_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS agentic_session_turn_request (
  tenant_id varchar(191) NOT NULL, session_id varchar(191) NOT NULL, idempotency_key varchar(191) NOT NULL,
  request_fingerprint char(64) NOT NULL, turn_id varchar(191) NOT NULL, status varchar(32) NOT NULL, fencing_token bigint unsigned NOT NULL,
  actor_id varchar(191) NOT NULL, correlation_id varchar(191) NOT NULL, runtime_snapshot_id varchar(191) NOT NULL,
  started_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), finished_at datetime(6), result_seq bigint unsigned, error_code varchar(191),
  PRIMARY KEY (tenant_id,session_id,idempotency_key), KEY active_turns (tenant_id,session_id,status,started_at),
  FOREIGN KEY (tenant_id,session_id) REFERENCES agentic_session_stream(tenant_id,session_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS agentic_memory_record (
  id char(36) NOT NULL, tenant_id varchar(191) NOT NULL, scope_type varchar(191) NOT NULL, scope_id varchar(191) NOT NULL,
  kind varchar(32) NOT NULL, status varchar(32) NOT NULL, current_revision int unsigned NOT NULL, recorded_at datetime(6) NOT NULL,
  PRIMARY KEY (tenant_id,id), KEY memory_scope (tenant_id,scope_type,scope_id,status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS agentic_memory_revision (
  memory_id char(36) NOT NULL, revision int unsigned NOT NULL, tenant_id varchar(191) NOT NULL, content text NOT NULL,
  format varchar(32) NOT NULL, classification varchar(32) NOT NULL, source_ref text NOT NULL, authority varchar(32) NOT NULL,
  content_hash char(64) NOT NULL, recorded_at datetime(6) NOT NULL, protected_content json, search_tokens json NOT NULL,
  PRIMARY KEY (tenant_id,memory_id,revision), FULLTEXT KEY memory_content_search (content),
  FOREIGN KEY (tenant_id,memory_id) REFERENCES agentic_memory_record(tenant_id,id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS agentic_memory_outbox (
  id char(36) NOT NULL PRIMARY KEY, tenant_id varchar(191) NOT NULL, memory_id char(36) NOT NULL, revision int unsigned NOT NULL,
  operation varchar(16) NOT NULL, payload json NOT NULL, created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), processed_at datetime(6),
  KEY pending_outbox (processed_at,created_at), FOREIGN KEY (tenant_id,memory_id) REFERENCES agentic_memory_record(tenant_id,id) ON DELETE CASCADE
) ENGINE=InnoDB;
