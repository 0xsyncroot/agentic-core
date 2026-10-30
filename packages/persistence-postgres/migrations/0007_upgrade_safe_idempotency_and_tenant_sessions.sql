ALTER TABLE agentic.session_append_dedupe
  ADD COLUMN IF NOT EXISTS operation_fingerprint char(64);
ALTER TABLE agentic.session_stream
  ADD COLUMN IF NOT EXISTS agent_profile_id text;
UPDATE agentic.session_stream SET agent_profile_id = 'default' WHERE agent_profile_id IS NULL;

-- Remove the legacy global session namespace while preserving the tenant-scoped
-- unique key and tenant-aware foreign keys introduced by migration 0003.
ALTER TABLE agentic.session_append_dedupe
  DROP CONSTRAINT IF EXISTS session_append_dedupe_session_id_fkey;
ALTER TABLE agentic.session_event
  DROP CONSTRAINT IF EXISTS session_event_session_id_fkey;
ALTER TABLE agentic.session_stream
  DROP CONSTRAINT IF EXISTS session_stream_pkey;

ALTER TABLE agentic.session_append_dedupe
  DROP CONSTRAINT IF EXISTS session_append_dedupe_pkey;
ALTER TABLE agentic.session_append_dedupe
  ADD CONSTRAINT session_append_dedupe_pkey
  PRIMARY KEY (tenant_id, session_id, idempotency_key);

ALTER TABLE agentic.session_event
  DROP CONSTRAINT IF EXISTS session_event_session_id_seq_key;
ALTER TABLE agentic.session_event
  ADD CONSTRAINT session_event_tenant_session_seq_key
  UNIQUE (tenant_id, session_id, seq);
