-- Database principal and rights for the account the service connects with.
--
-- Run as a principal that may GRANT, after the tables exist, and replace [agentic_app] with
-- your application principal. The login must already exist at server level. Keep this account
-- outside privileged roles and do not make it a schema or object owner.
--
-- Object DENYs protect append-only history and the migration ledger. Ownership and separately
-- granted column permissions have special precedence; audit those when changing account rights.

IF DATABASE_PRINCIPAL_ID('agentic_app') IS NULL
  CREATE USER [agentic_app] FOR LOGIN [agentic_app];
GO

GRANT SELECT, INSERT ON agentic.session_stream TO [agentic_app];
GRANT UPDATE (current_seq, owner_actor_id, agent_profile_id, lease_owner, lease_fencing_token, lease_expires_at, active_turn_id, active_idempotency_key)
  ON agentic.session_stream TO [agentic_app];
GRANT SELECT, INSERT ON agentic.session_append_dedupe TO [agentic_app];
GRANT SELECT, INSERT ON agentic.session_event TO [agentic_app];
GRANT SELECT, INSERT ON agentic.session_turn_request TO [agentic_app];
GRANT UPDATE (status, finished_at, result_seq, error_code) ON agentic.session_turn_request TO [agentic_app];
GRANT SELECT, INSERT ON agentic.memory_record TO [agentic_app];
GRANT UPDATE (status, current_revision) ON agentic.memory_record TO [agentic_app];
GRANT SELECT, INSERT ON agentic.memory_revision TO [agentic_app];
GRANT SELECT, INSERT ON agentic.memory_outbox TO [agentic_app];
GRANT UPDATE (processed_at) ON agentic.memory_outbox TO [agentic_app];
-- Per-person settings (migration 0003): a person's own row is written again on every change, never deleted.
GRANT SELECT, INSERT ON agentic.actor_setting TO [agentic_app];
GRANT UPDATE (setting_value, revision, updated_at) ON agentic.actor_setting TO [agentic_app];

DENY SELECT, INSERT, UPDATE, DELETE ON agentic.schema_migration TO [agentic_app];
DENY UPDATE, DELETE ON agentic.session_event TO [agentic_app];
DENY UPDATE, DELETE ON agentic.memory_revision TO [agentic_app];
DENY DELETE ON agentic.actor_setting TO [agentic_app];
-- CONTROL implies data permissions: denying it also blocks the explicit DML grants above.
-- REVOKE clears a directly applied CONTROL grant or denial when this script is reapplied.
REVOKE CONTROL ON SCHEMA::agentic FROM [agentic_app];
DENY ALTER, TAKE OWNERSHIP ON SCHEMA::agentic TO [agentic_app];
GO
