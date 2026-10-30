IF OBJECT_ID(N'agentic.session_stream',N'U') IS NULL
CREATE TABLE agentic.session_stream (
  tenant_id nvarchar(191) NOT NULL, session_id nvarchar(191) NOT NULL, owner_actor_id nvarchar(191) NULL,
  agent_profile_id nvarchar(191) NULL,
  current_seq bigint NOT NULL CONSTRAINT df_session_stream_seq DEFAULT 0,
  lease_owner nvarchar(191) NULL, lease_fencing_token bigint NOT NULL CONSTRAINT df_session_stream_fence DEFAULT 0,
  lease_expires_at datetime2(6) NULL, active_turn_id nvarchar(191) NULL, active_idempotency_key nvarchar(191) NULL,
  created_at datetime2(6) NOT NULL CONSTRAINT df_session_stream_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_session_stream PRIMARY KEY (tenant_id,session_id)
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'agentic.session_stream') AND name=N'ix_session_stream_owner_created')
CREATE INDEX ix_session_stream_owner_created ON agentic.session_stream(tenant_id,owner_actor_id,created_at,session_id);

IF OBJECT_ID(N'agentic.session_append_dedupe',N'U') IS NULL
CREATE TABLE agentic.session_append_dedupe (
  tenant_id nvarchar(191) NOT NULL, session_id nvarchar(191) NOT NULL, idempotency_key nvarchar(191) NOT NULL,
  operation_fingerprint char(64) NOT NULL, result_seq bigint NOT NULL,
  created_at datetime2(6) NOT NULL CONSTRAINT df_append_dedupe_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_session_append_dedupe PRIMARY KEY (tenant_id,session_id,idempotency_key),
  CONSTRAINT fk_append_dedupe_stream FOREIGN KEY (tenant_id,session_id)
    REFERENCES agentic.session_stream(tenant_id,session_id) ON DELETE CASCADE
);

IF OBJECT_ID(N'agentic.session_event',N'U') IS NULL
CREATE TABLE agentic.session_event (
  event_id nvarchar(191) NOT NULL, tenant_id nvarchar(191) NOT NULL, session_id nvarchar(191) NOT NULL, seq bigint NOT NULL,
  actor_id nvarchar(191) NOT NULL, correlation_id nvarchar(191) NOT NULL, runtime_snapshot_id nvarchar(191) NOT NULL,
  type nvarchar(191) NOT NULL, schema_version int NOT NULL, occurred_at datetime2(6) NOT NULL, recorded_at datetime2(6) NOT NULL,
  turn_id nvarchar(191) NULL, step_id nvarchar(191) NULL, request_id nvarchar(191) NULL,
  call_id nvarchar(191) NULL, attempt_id nvarchar(191) NULL, classification nvarchar(32) NOT NULL,
  payload nvarchar(max) NOT NULL, integrity_hash char(64) NOT NULL,
  CONSTRAINT pk_session_event PRIMARY KEY (event_id),
  CONSTRAINT uq_session_event_seq UNIQUE (tenant_id,session_id,seq),
  CONSTRAINT ck_session_event_payload_json CHECK (ISJSON(payload)=1),
  CONSTRAINT fk_session_event_stream FOREIGN KEY (tenant_id,session_id)
    REFERENCES agentic.session_stream(tenant_id,session_id) ON DELETE CASCADE
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'agentic.session_event') AND name=N'ix_session_event_stream')
CREATE INDEX ix_session_event_stream ON agentic.session_event(tenant_id,session_id,seq);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'agentic.session_event') AND name=N'ix_session_event_checkpoint')
CREATE INDEX ix_session_event_checkpoint ON agentic.session_event(tenant_id,session_id,type,seq DESC);

IF OBJECT_ID(N'agentic.session_turn_request',N'U') IS NULL
CREATE TABLE agentic.session_turn_request (
  tenant_id nvarchar(191) NOT NULL, session_id nvarchar(191) NOT NULL, idempotency_key nvarchar(191) NOT NULL,
  request_fingerprint char(64) NOT NULL, turn_id nvarchar(191) NOT NULL, status nvarchar(32) NOT NULL,
  fencing_token bigint NOT NULL, actor_id nvarchar(191) NOT NULL, correlation_id nvarchar(191) NOT NULL,
  runtime_snapshot_id nvarchar(191) NOT NULL, started_at datetime2(6) NOT NULL CONSTRAINT df_turn_request_started DEFAULT SYSUTCDATETIME(),
  finished_at datetime2(6) NULL, result_seq bigint NULL, error_code nvarchar(191) NULL,
  CONSTRAINT pk_session_turn_request PRIMARY KEY (tenant_id,session_id,idempotency_key),
  CONSTRAINT fk_turn_request_stream FOREIGN KEY (tenant_id,session_id)
    REFERENCES agentic.session_stream(tenant_id,session_id) ON DELETE CASCADE
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'agentic.session_turn_request') AND name=N'ix_active_turns')
CREATE INDEX ix_active_turns ON agentic.session_turn_request(tenant_id,session_id,status,started_at);

IF OBJECT_ID(N'agentic.memory_record',N'U') IS NULL
CREATE TABLE agentic.memory_record (
  id nvarchar(191) NOT NULL, tenant_id nvarchar(191) NOT NULL, scope_type nvarchar(191) NOT NULL, scope_id nvarchar(191) NOT NULL,
  kind nvarchar(32) NOT NULL, status nvarchar(32) NOT NULL, current_revision int NOT NULL, recorded_at datetime2(6) NOT NULL,
  CONSTRAINT pk_memory_record PRIMARY KEY (tenant_id,id)
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'agentic.memory_record') AND name=N'ix_memory_scope')
CREATE INDEX ix_memory_scope ON agentic.memory_record(tenant_id,scope_type,scope_id,status);

IF OBJECT_ID(N'agentic.memory_revision',N'U') IS NULL
CREATE TABLE agentic.memory_revision (
  memory_id nvarchar(191) NOT NULL, revision int NOT NULL, tenant_id nvarchar(191) NOT NULL,
  content nvarchar(max) NOT NULL, format nvarchar(32) NOT NULL, classification nvarchar(32) NOT NULL,
  source_ref nvarchar(max) NOT NULL, authority nvarchar(32) NOT NULL, content_hash char(64) NOT NULL,
  recorded_at datetime2(6) NOT NULL, protected_content nvarchar(max) NULL, search_tokens nvarchar(max) NOT NULL,
  CONSTRAINT pk_memory_revision PRIMARY KEY (tenant_id,memory_id,revision),
  CONSTRAINT ck_memory_revision_protected_json CHECK (protected_content IS NULL OR ISJSON(protected_content)=1),
  CONSTRAINT ck_memory_revision_search_json CHECK (ISJSON(search_tokens)=1),
  CONSTRAINT fk_memory_revision_record FOREIGN KEY (tenant_id,memory_id)
    REFERENCES agentic.memory_record(tenant_id,id) ON DELETE CASCADE
);

IF OBJECT_ID(N'agentic.memory_outbox',N'U') IS NULL
CREATE TABLE agentic.memory_outbox (
  id nvarchar(191) NOT NULL, tenant_id nvarchar(191) NOT NULL, memory_id nvarchar(191) NOT NULL,
  revision int NOT NULL, operation nvarchar(16) NOT NULL, payload nvarchar(max) NOT NULL,
  created_at datetime2(6) NOT NULL CONSTRAINT df_memory_outbox_created DEFAULT SYSUTCDATETIME(), processed_at datetime2(6) NULL,
  CONSTRAINT pk_memory_outbox PRIMARY KEY (id),
  CONSTRAINT ck_memory_outbox_payload_json CHECK (ISJSON(payload)=1),
  CONSTRAINT fk_memory_outbox_record FOREIGN KEY (tenant_id,memory_id)
    REFERENCES agentic.memory_record(tenant_id,id) ON DELETE CASCADE
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'agentic.memory_outbox') AND name=N'ix_memory_outbox_pending')
CREATE INDEX ix_memory_outbox_pending ON agentic.memory_outbox(processed_at,created_at);
GO

CREATE OR ALTER FUNCTION agentic.tenant_access(@tenant_id nvarchar(191))
RETURNS TABLE WITH SCHEMABINDING
AS RETURN SELECT 1 AS allowed
WHERE @tenant_id=CONVERT(nvarchar(191),SESSION_CONTEXT(N'tenant_id'));
GO

IF NOT EXISTS (SELECT 1 FROM sys.security_policies WHERE name=N'tenant_policy' AND schema_id=SCHEMA_ID(N'agentic'))
EXEC(N'CREATE SECURITY POLICY agentic.tenant_policy
  ADD FILTER PREDICATE agentic.tenant_access(tenant_id) ON agentic.session_stream,
  ADD BLOCK PREDICATE agentic.tenant_access(tenant_id) ON agentic.session_stream AFTER INSERT,
  ADD BLOCK PREDICATE agentic.tenant_access(tenant_id) ON agentic.session_stream AFTER UPDATE,
  ADD FILTER PREDICATE agentic.tenant_access(tenant_id) ON agentic.session_append_dedupe,
  ADD BLOCK PREDICATE agentic.tenant_access(tenant_id) ON agentic.session_append_dedupe AFTER INSERT,
  ADD FILTER PREDICATE agentic.tenant_access(tenant_id) ON agentic.session_event,
  ADD BLOCK PREDICATE agentic.tenant_access(tenant_id) ON agentic.session_event AFTER INSERT,
  ADD FILTER PREDICATE agentic.tenant_access(tenant_id) ON agentic.session_turn_request,
  ADD BLOCK PREDICATE agentic.tenant_access(tenant_id) ON agentic.session_turn_request AFTER INSERT,
  ADD BLOCK PREDICATE agentic.tenant_access(tenant_id) ON agentic.session_turn_request AFTER UPDATE,
  ADD FILTER PREDICATE agentic.tenant_access(tenant_id) ON agentic.memory_record,
  ADD BLOCK PREDICATE agentic.tenant_access(tenant_id) ON agentic.memory_record AFTER INSERT,
  ADD BLOCK PREDICATE agentic.tenant_access(tenant_id) ON agentic.memory_record AFTER UPDATE,
  ADD FILTER PREDICATE agentic.tenant_access(tenant_id) ON agentic.memory_revision,
  ADD BLOCK PREDICATE agentic.tenant_access(tenant_id) ON agentic.memory_revision AFTER INSERT,
  ADD FILTER PREDICATE agentic.tenant_access(tenant_id) ON agentic.memory_outbox,
  ADD BLOCK PREDICATE agentic.tenant_access(tenant_id) ON agentic.memory_outbox AFTER INSERT,
  ADD BLOCK PREDICATE agentic.tenant_access(tenant_id) ON agentic.memory_outbox AFTER UPDATE
  WITH (STATE=ON);');
