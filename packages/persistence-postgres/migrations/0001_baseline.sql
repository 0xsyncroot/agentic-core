CREATE SCHEMA IF NOT EXISTS agentic;

CREATE TABLE IF NOT EXISTS agentic.schema_migration (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE agentic.session_stream (
  session_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  agent_profile_id text,
  current_seq bigint NOT NULL DEFAULT 0 CHECK (current_seq >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE agentic.session_append_dedupe (
  session_id text NOT NULL REFERENCES agentic.session_stream(session_id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL,
  operation_fingerprint char(64) NOT NULL,
  result_seq bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (session_id, idempotency_key)
);

CREATE TABLE agentic.session_event (
  event_id uuid PRIMARY KEY,
  session_id text NOT NULL REFERENCES agentic.session_stream(session_id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  tenant_id text NOT NULL,
  actor_id text NOT NULL,
  correlation_id text NOT NULL,
  runtime_snapshot_id text NOT NULL,
  type text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  turn_id text,
  step_id text,
  request_id text,
  call_id text,
  attempt_id text,
  classification text NOT NULL,
  payload jsonb NOT NULL,
  integrity_hash text NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE INDEX session_event_tenant_session_seq_idx
  ON agentic.session_event (tenant_id, session_id, seq);

CREATE TABLE agentic.memory_record (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope_type text NOT NULL CHECK (
    scope_type IN ('global', 'tenant', 'actor', 'agent', 'session')
    OR scope_type ~ '^[a-z0-9][a-z0-9.-]*:[a-z0-9][a-z0-9.-]*$'
  ),
  scope_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('episodic', 'semantic', 'relational')),
  status text NOT NULL CHECK (status IN ('active', 'superseded', 'deleted', 'quarantined')),
  current_revision integer NOT NULL CHECK (current_revision > 0),
  recorded_at timestamptz NOT NULL
);

CREATE INDEX memory_record_scope_idx
  ON agentic.memory_record (tenant_id, scope_type, scope_id, status);

CREATE TABLE agentic.memory_revision (
  memory_id uuid NOT NULL REFERENCES agentic.memory_record(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  tenant_id text NOT NULL,
  content text NOT NULL,
  format text NOT NULL CHECK (format IN ('text', 'markdown', 'json')),
  classification text NOT NULL,
  source_ref text NOT NULL,
  authority text NOT NULL CHECK (authority IN ('user-stated', 'domain-verified', 'document-derived', 'model-inferred')),
  content_hash text NOT NULL,
  recorded_at timestamptz NOT NULL,
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  PRIMARY KEY (memory_id, revision)
);

CREATE INDEX memory_revision_search_idx
  ON agentic.memory_revision USING gin (search_document);
CREATE INDEX memory_revision_tenant_idx
  ON agentic.memory_revision (tenant_id, memory_id, revision);

CREATE TABLE agentic.memory_outbox (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  memory_id uuid NOT NULL,
  revision integer NOT NULL,
  operation text NOT NULL CHECK (operation IN ('upsert', 'delete')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz
);

CREATE INDEX memory_outbox_pending_idx
  ON agentic.memory_outbox (created_at) WHERE processed_at IS NULL;

ALTER TABLE agentic.session_stream ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentic.session_stream FORCE ROW LEVEL SECURITY;
ALTER TABLE agentic.session_append_dedupe ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentic.session_append_dedupe FORCE ROW LEVEL SECURITY;
ALTER TABLE agentic.session_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentic.session_event FORCE ROW LEVEL SECURITY;
ALTER TABLE agentic.memory_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentic.memory_record FORCE ROW LEVEL SECURITY;
ALTER TABLE agentic.memory_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentic.memory_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE agentic.memory_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentic.memory_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON agentic.session_stream
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
CREATE POLICY tenant_isolation ON agentic.session_append_dedupe
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
CREATE POLICY tenant_isolation ON agentic.session_event
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
CREATE POLICY tenant_isolation ON agentic.memory_record
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
CREATE POLICY tenant_isolation ON agentic.memory_revision
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
CREATE POLICY tenant_isolation ON agentic.memory_outbox
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
