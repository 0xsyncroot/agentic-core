-- The local application account.
--
-- Runs at first boot, before the schema exists, so the grants here can only be schema-wide:
-- MySQL refuses a table-level GRANT for a table it cannot find. That is enough for local work
-- and still withholds DELETE and every DDL right from the account the service connects with.
--
-- A deployment that wants the tighter, per-column posture applies
-- `packages/persistence-mysql/grants/app-account.sql` after migrating, when the tables exist.
CREATE USER IF NOT EXISTS 'agentic_app'@'%' IDENTIFIED BY 'agentic_app_dev';
GRANT SELECT, INSERT, UPDATE ON agentic.* TO 'agentic_app'@'%';
FLUSH PRIVILEGES;
