-- The local operator console account. Order: this init (first boot) -> `npm run db:migrate:mysql`
-- -> `packages/persistence-mysql/grants/admin-account.sql` as root.
--
-- Runs before the schema exists. MySQL refuses a table-level grant on a missing table unless it includes CREATE, and a
-- schema-wide grant would reach tables this account must never read, so the account is created here with no rights at
-- all. Every right it has comes from admin-account.sql, applied once the tables exist; until then every statement the
-- console runs is refused, never answered under a wider grant.
CREATE USER IF NOT EXISTS 'agentic_admin'@'%' IDENTIFIED BY 'agentic_admin_api_dev';
FLUSH PRIVILEGES;
