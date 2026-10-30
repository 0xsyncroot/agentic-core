ALTER TABLE agentic.memory_record
  DROP CONSTRAINT IF EXISTS memory_record_scope_type_check;

UPDATE agentic.memory_record
   SET scope_type = CASE scope_type
     WHEN 'public' THEN 'global'
     WHEN 'user' THEN 'actor'
     WHEN 'unit' THEN 'legacy:unit'
     WHEN 'case' THEN 'legacy:case'
     ELSE scope_type
   END
 WHERE scope_type IN ('public', 'user', 'unit', 'case');

ALTER TABLE agentic.memory_record
  ADD CONSTRAINT memory_record_scope_type_check CHECK (
    scope_type IN ('global', 'tenant', 'actor', 'agent', 'session')
    OR scope_type ~ '^[a-z0-9][a-z0-9.-]*:[a-z0-9][a-z0-9.-]*$'
  );
