SET @migration_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns
         WHERE table_schema=DATABASE() AND table_name='agentic_session_append_dedupe' AND column_name='operation_fingerprint'),
  'SELECT 1',
  'ALTER TABLE agentic_session_append_dedupe ADD COLUMN operation_fingerprint char(64) NULL AFTER idempotency_key'
);
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

SET @migration_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns
         WHERE table_schema=DATABASE() AND table_name='agentic_session_stream' AND column_name='agent_profile_id'),
  'SELECT 1',
  'ALTER TABLE agentic_session_stream ADD COLUMN agent_profile_id varchar(191) NULL AFTER owner_actor_id'
);
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

UPDATE agentic_session_stream SET agent_profile_id='default' WHERE agent_profile_id IS NULL;

SET @migration_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.statistics
         WHERE table_schema=DATABASE() AND table_name='agentic_session_stream' AND index_name='session_owner_created'),
  'SELECT 1',
  'CREATE INDEX session_owner_created ON agentic_session_stream(tenant_id,owner_actor_id,created_at,session_id)'
);
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

SET @migration_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.statistics
         WHERE table_schema=DATABASE() AND table_name='agentic_session_event' AND index_name='session_checkpoint'),
  'SELECT 1',
  'CREATE INDEX session_checkpoint ON agentic_session_event(tenant_id,session_id,type,seq DESC)'
);
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;
