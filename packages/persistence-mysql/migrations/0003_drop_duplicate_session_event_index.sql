-- `session_events (tenant_id,session_id,seq)` repeats the unique key `session_seq` column for column,
-- so every append maintained a second copy of the same B-tree and no read could prefer it.
-- The foreign key to agentic_session_stream stays on `session_seq`, which covers its prefix.
--
-- The drop is online (INPLACE, LOCK=NONE) but still takes an exclusive metadata lock at its start
-- and end. With MySQL's default lock_wait_timeout of a year, a pending DDL queued behind one long
-- read would queue every later statement on the table behind it; ten seconds fails the migration
-- instead, and the migrator records a file only after it succeeds, so running it again is safe.
SET SESSION lock_wait_timeout = 10;

SET @migration_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.statistics
         WHERE table_schema=DATABASE() AND table_name='agentic_session_event' AND index_name='session_events'),
  'ALTER TABLE agentic_session_event DROP INDEX session_events, ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;
