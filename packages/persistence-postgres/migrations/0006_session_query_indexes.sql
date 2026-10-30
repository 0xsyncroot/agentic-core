CREATE INDEX IF NOT EXISTS session_stream_owner_created_idx
  ON agentic.session_stream (tenant_id, owner_actor_id, created_at, session_id);

CREATE INDEX IF NOT EXISTS session_event_checkpoint_idx
  ON agentic.session_event (tenant_id, session_id, type, seq DESC);
