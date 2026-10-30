ALTER TABLE agentic.memory_revision
  ADD COLUMN IF NOT EXISTS protected_content jsonb,
  ADD COLUMN IF NOT EXISTS search_tokens text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS memory_revision_blind_search_idx
  ON agentic.memory_revision USING gin (search_tokens);
