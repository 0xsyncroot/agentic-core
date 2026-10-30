-- The database the service connects to, provisioned before it ever starts.
--
-- The service creates nothing and grants nothing: it expects a database that already exists.
-- This file is the local stand-in for whoever does that in a real deployment.
CREATE ROLE agentic_app
  LOGIN
  PASSWORD 'agentic_app_dev'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  -- Not negotiable: BYPASSRLS or superuser turns row-level security off, and row-level
  -- security is the only thing keeping one tenant's data out of another tenant's reads. The
  -- adapter refuses to start as either, so this keeps the local role honest too.
  NOBYPASSRLS;

GRANT CONNECT ON DATABASE agentic TO agentic_app;

-- The schema is owned by the admin role, so the application role cannot alter or drop it.
CREATE SCHEMA IF NOT EXISTS agentic AUTHORIZATION agentic_admin;
GRANT USAGE ON SCHEMA agentic TO agentic_app;

-- Rights for tables that do not exist yet.
--
-- Table-level grants need their table, and at first boot there is no schema to speak of. Default
-- privileges answer that: anything the admin role creates in this schema from now on carries
-- these rights. Coarser than `packages/persistence-postgres/grants/app-account.sql`, which a
-- real deployment applies once the tables exist — but it withholds DELETE and every DDL right,
-- which is what matters for local work.
ALTER DEFAULT PRIVILEGES FOR ROLE agentic_admin IN SCHEMA agentic
  GRANT SELECT, INSERT, UPDATE ON TABLES TO agentic_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agentic_admin IN SCHEMA agentic
  GRANT USAGE, SELECT ON SEQUENCES TO agentic_app;
