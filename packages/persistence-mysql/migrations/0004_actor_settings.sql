-- One row per person and setting (ActorSettingStore). The value is text the product enumerates ("ask", "standing"),
-- never a flag: this driver hands flags back as "0"/"1" strings and Boolean("0") is true.
CREATE TABLE IF NOT EXISTS agentic_actor_setting (
  tenant_id varchar(191) NOT NULL, actor_id varchar(191) NOT NULL, setting_key varchar(64) NOT NULL,
  setting_value varchar(256) NOT NULL, revision varchar(64) NOT NULL, updated_at datetime(6) NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, setting_key)
) ENGINE=InnoDB;
