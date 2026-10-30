import { readFlag, readSetting, readSettingSource, type ReadSettingOptions, type SettingsEnv } from "./read-setting.js";

export type RuntimeProfile = "development" | "production";

/**
 * `AGENTIC_RUNTIME_PROFILE`, read the same way by the harness and every product.
 *
 * The products used to treat any value other than `production` as development, so a typo such as
 * `Production` or `prod` started a production pod with every production gate open. An unknown
 * value is refused instead, as the harness always did.
 */
export function readRuntimeProfile(env: SettingsEnv): RuntimeProfile {
  const raw = readSetting(env, "AGENTIC_RUNTIME_PROFILE") ?? "development";
  if (raw !== "development" && raw !== "production") throw new Error(`Unsupported AGENTIC_RUNTIME_PROFILE: ${raw}`);
  return raw;
}

/**
 * `AGENT_INCLUDE_ERROR_DETAIL`: whether a failed request's technical message travels beside the
 * user's sentence, in a separate `detail` field (or the service log) where an operator reads it.
 *
 * Every product has this switch and every product named it differently; the caller passes its
 * own retired name. Production refuses it for all of them: the message can carry tenant data.
 */
export function readIncludeErrorDetail(env: SettingsEnv, options: ReadSettingOptions = {}): boolean {
  const enabled = readFlag(env, "AGENT_INCLUDE_ERROR_DETAIL", false, options);
  if (enabled && readRuntimeProfile(env) === "production") {
    const name = readSettingSource(env, "AGENT_INCLUDE_ERROR_DETAIL", options)?.name ?? "AGENT_INCLUDE_ERROR_DETAIL";
    throw new Error(`${name} must not be set when AGENTIC_RUNTIME_PROFILE=production`);
  }
  return enabled;
}
