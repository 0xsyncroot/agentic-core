IF COL_LENGTH(N'agentic.session_append_dedupe', N'operation_fingerprint') IS NULL
  ALTER TABLE agentic.session_append_dedupe ADD operation_fingerprint char(64) NULL;

IF COL_LENGTH(N'agentic.session_stream', N'agent_profile_id') IS NULL
  ALTER TABLE agentic.session_stream ADD agent_profile_id nvarchar(191) NULL;

UPDATE agentic.session_stream SET agent_profile_id=N'default' WHERE agent_profile_id IS NULL;

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE object_id=OBJECT_ID(N'agentic.session_stream') AND name=N'ix_session_stream_owner_created'
)
  CREATE INDEX ix_session_stream_owner_created
    ON agentic.session_stream(tenant_id,owner_actor_id,created_at,session_id);

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE object_id=OBJECT_ID(N'agentic.session_event') AND name=N'ix_session_event_checkpoint'
)
  CREATE INDEX ix_session_event_checkpoint
    ON agentic.session_event(tenant_id,session_id,type,seq DESC);
