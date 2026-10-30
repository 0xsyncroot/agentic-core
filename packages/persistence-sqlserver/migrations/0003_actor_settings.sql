-- One row per person and setting (ActorSettingStore). The value is text the product enumerates ("ask", "standing"),
-- never a flag. The tenant security policy filters and blocks its rows like every other table's.
IF OBJECT_ID(N'agentic.actor_setting',N'U') IS NULL
CREATE TABLE agentic.actor_setting (
  tenant_id nvarchar(191) NOT NULL, actor_id nvarchar(191) NOT NULL, setting_key nvarchar(64) NOT NULL,
  setting_value nvarchar(256) NOT NULL, revision nvarchar(64) NOT NULL, updated_at datetime2(6) NOT NULL,
  CONSTRAINT pk_actor_setting PRIMARY KEY (tenant_id,actor_id,setting_key)
);
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.security_predicates
  WHERE target_object_id=OBJECT_ID(N'agentic.actor_setting')
)
EXEC(N'ALTER SECURITY POLICY agentic.tenant_policy
  ADD FILTER PREDICATE agentic.tenant_access(tenant_id) ON agentic.actor_setting,
  ADD BLOCK PREDICATE agentic.tenant_access(tenant_id) ON agentic.actor_setting AFTER INSERT,
  ADD BLOCK PREDICATE agentic.tenant_access(tenant_id) ON agentic.actor_setting AFTER UPDATE');
