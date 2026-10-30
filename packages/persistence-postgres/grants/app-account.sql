-- Narrow privileges for the role the service connects with.
--
-- The migration tool used to apply these itself, which is why migrating needed a second,
-- administrative connection. Owning roles belongs to whoever owns the database, so this is a
-- script to run rather than something the application does — run it as the schema owner, after
-- the tables exist, and replace `agentic_app` with your role.
--
-- Two things this does NOT do, on purpose:
--   * It does not create the role. That is your identity management, not ours.
--   * It does not grant BYPASSRLS or superuser, and the service refuses to start as either —
--     both of those turn row-level security off, and row-level security is the only thing
--     keeping one tenant's payroll data out of another tenant's reads.

GRANT USAGE ON SCHEMA agentic TO agentic_app;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA agentic FROM agentic_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA agentic REVOKE ALL ON TABLES FROM agentic_app;

GRANT SELECT, INSERT ON agentic.session_stream TO agentic_app;
GRANT UPDATE(current_seq, owner_actor_id, agent_profile_id, lease_owner, lease_fencing_token, lease_expires_at, active_turn_id, active_idempotency_key)
  ON agentic.session_stream TO agentic_app;

GRANT SELECT, INSERT ON agentic.session_append_dedupe TO agentic_app;
GRANT SELECT, INSERT ON agentic.session_event TO agentic_app;
GRANT SELECT, INSERT, UPDATE ON agentic.session_turn_request TO agentic_app;

GRANT SELECT, INSERT ON agentic.memory_record TO agentic_app;
GRANT UPDATE(status, current_revision) ON agentic.memory_record TO agentic_app;
GRANT SELECT, INSERT ON agentic.memory_revision TO agentic_app;
GRANT SELECT, INSERT ON agentic.memory_outbox TO agentic_app;
GRANT UPDATE(processed_at) ON agentic.memory_outbox TO agentic_app;

-- Per-person settings (migration 0008): a person's own row is written again on every change, never deleted.
GRANT SELECT, INSERT ON agentic.actor_setting TO agentic_app;
GRANT UPDATE(setting_value, revision, updated_at) ON agentic.actor_setting TO agentic_app;
