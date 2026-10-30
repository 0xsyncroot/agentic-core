DROP POLICY tenant_isolation ON agentic.session_event;
CREATE POLICY tenant_isolation ON agentic.session_event
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')
    AND EXISTS (
      SELECT 1 FROM agentic.session_stream parent
      WHERE parent.tenant_id = session_event.tenant_id
        AND parent.session_id = session_event.session_id
    )
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')
    AND actor_id = nullif(current_setting('app.actor_id', true), '')
    AND EXISTS (
      SELECT 1 FROM agentic.session_stream parent
      WHERE parent.tenant_id = session_event.tenant_id
        AND parent.session_id = session_event.session_id
    )
  );

DROP POLICY tenant_isolation ON agentic.session_append_dedupe;
CREATE POLICY tenant_isolation ON agentic.session_append_dedupe
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')
    AND EXISTS (
      SELECT 1 FROM agentic.session_stream parent
      WHERE parent.tenant_id = session_append_dedupe.tenant_id
        AND parent.session_id = session_append_dedupe.session_id
    )
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')
    AND EXISTS (
      SELECT 1 FROM agentic.session_stream parent
      WHERE parent.tenant_id = session_append_dedupe.tenant_id
        AND parent.session_id = session_append_dedupe.session_id
    )
  );
