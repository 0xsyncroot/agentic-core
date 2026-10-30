-- One row per person and setting (ActorSettingStore). The value is text the product enumerates ("ask", "standing"),
-- never a flag. Rows are the person's own: row-level security binds them to the tenant and the actor of the transaction.
CREATE TABLE IF NOT EXISTS agentic.actor_setting (
  tenant_id text NOT NULL,
  actor_id text NOT NULL,
  setting_key text NOT NULL CHECK (length(setting_key) BETWEEN 1 AND 64),
  setting_value text NOT NULL CHECK (length(setting_value) <= 256),
  revision text NOT NULL CHECK (length(revision) BETWEEN 1 AND 64),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, setting_key)
);

ALTER TABLE agentic.actor_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentic.actor_setting FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS actor_isolation ON agentic.actor_setting;
CREATE POLICY actor_isolation ON agentic.actor_setting
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')
    AND actor_id = nullif(current_setting('app.actor_id', true), '')
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')
    AND actor_id = nullif(current_setting('app.actor_id', true), '')
  );
