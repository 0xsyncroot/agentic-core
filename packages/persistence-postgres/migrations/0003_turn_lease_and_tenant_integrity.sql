ALTER TABLE agentic.session_stream
  ADD COLUMN owner_actor_id text,
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_fencing_token bigint NOT NULL DEFAULT 0 CHECK (lease_fencing_token >= 0),
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN active_turn_id text,
  ADD COLUMN active_idempotency_key text;

UPDATE agentic.session_stream stream
SET owner_actor_id = (
  SELECT event.actor_id
  FROM agentic.session_event event
  WHERE event.session_id = stream.session_id AND event.tenant_id = stream.tenant_id
  ORDER BY event.seq
  LIMIT 1
)
WHERE stream.owner_actor_id IS NULL
  AND EXISTS (
    SELECT 1 FROM agentic.session_event event
    WHERE event.session_id = stream.session_id AND event.tenant_id = stream.tenant_id
  );

ALTER TABLE agentic.session_stream
  ADD CONSTRAINT session_stream_tenant_session_key UNIQUE (tenant_id, session_id);

ALTER TABLE agentic.session_event
  ADD CONSTRAINT session_event_tenant_stream_fk
  FOREIGN KEY (tenant_id, session_id)
  REFERENCES agentic.session_stream(tenant_id, session_id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE agentic.session_event VALIDATE CONSTRAINT session_event_tenant_stream_fk;

ALTER TABLE agentic.session_append_dedupe
  ADD CONSTRAINT session_append_dedupe_tenant_stream_fk
  FOREIGN KEY (tenant_id, session_id)
  REFERENCES agentic.session_stream(tenant_id, session_id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE agentic.session_append_dedupe VALIDATE CONSTRAINT session_append_dedupe_tenant_stream_fk;

CREATE TABLE agentic.session_turn_request (
  tenant_id text NOT NULL,
  session_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  turn_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  actor_id text NOT NULL,
  correlation_id text NOT NULL,
  runtime_snapshot_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  result_seq bigint,
  error_code text,
  PRIMARY KEY (tenant_id, session_id, idempotency_key),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES agentic.session_stream(tenant_id, session_id) ON DELETE CASCADE
);

CREATE INDEX session_turn_request_active_idx
  ON agentic.session_turn_request (tenant_id, session_id, status, started_at);

ALTER TABLE agentic.memory_record
  ADD CONSTRAINT memory_record_tenant_id_key UNIQUE (tenant_id, id);
ALTER TABLE agentic.memory_revision
  ADD CONSTRAINT memory_revision_tenant_record_fk
  FOREIGN KEY (tenant_id, memory_id)
  REFERENCES agentic.memory_record(tenant_id, id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE agentic.memory_revision VALIDATE CONSTRAINT memory_revision_tenant_record_fk;
ALTER TABLE agentic.memory_outbox
  ADD CONSTRAINT memory_outbox_tenant_record_fk
  FOREIGN KEY (tenant_id, memory_id)
  REFERENCES agentic.memory_record(tenant_id, id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE agentic.memory_outbox VALIDATE CONSTRAINT memory_outbox_tenant_record_fk;

ALTER TABLE agentic.session_turn_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentic.session_turn_request FORCE ROW LEVEL SECURITY;

DROP POLICY tenant_isolation ON agentic.session_stream;
CREATE POLICY tenant_isolation ON agentic.session_stream
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')
    AND (owner_actor_id IS NULL OR owner_actor_id = nullif(current_setting('app.actor_id', true), ''))
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')
    AND (owner_actor_id IS NULL OR owner_actor_id = nullif(current_setting('app.actor_id', true), ''))
  );

CREATE POLICY tenant_isolation ON agentic.session_turn_request
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')
    AND actor_id = nullif(current_setting('app.actor_id', true), '')
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')
    AND actor_id = nullif(current_setting('app.actor_id', true), '')
  );
