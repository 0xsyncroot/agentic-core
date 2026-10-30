import assert from "node:assert/strict";
import { test } from "node:test";
import {
  noticeRemovedSettings, readFlag, readIncludeErrorDetail, readRuntimeProfile, readSetting, readSettingSource, refuseUnreadSettings,
  SettingConflictError,
} from "../src/index.js";

function recorder(): { readonly log: (message: string) => void; readonly lines: string[] } {
  const lines: string[] = [];
  return { log: (message) => { lines.push(message); }, lines };
}

test("only the current name: its trimmed value, no warning", () => {
  const { log, lines } = recorder();
  assert.equal(readSetting({ REDIS_URL: "  rediss://r:6379  " }, "REDIS_URL", { legacy: ["OLD_REDIS_URL"], log }), "rediss://r:6379");
  assert.deepEqual(lines, []);
});

test("only a retired name: its value and exactly one warning naming the new name, however often it is read", () => {
  const { log, lines } = recorder();
  const env = { OLD_REDIS_URL: "rediss://old:6379" };
  for (let read = 0; read < 3; read += 1) {
    assert.equal(readSetting(env, "REDIS_URL", { legacy: ["OLD_REDIS_URL"], log }), "rediss://old:6379");
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /OLD_REDIS_URL is a retired setting name.*rename it to REDIS_URL/u);
  assert.doesNotMatch(lines[0]!, /rediss:\/\/old/u, "the warning never carries the value");
  assert.deepEqual(readSettingSource(env, "REDIS_URL", { legacy: ["OLD_REDIS_URL"], log }), { value: "rediss://old:6379", name: "OLD_REDIS_URL" });
});

test("both names with the same value: the current one, silently", () => {
  const { log, lines } = recorder();
  assert.equal(readSetting({ REDIS_URL: "a", OLD_REDIS_URL: " a " }, "REDIS_URL", { legacy: ["OLD_REDIS_URL"], log }), "a");
  assert.deepEqual(lines, []);
});

test("both names with different values: refusal that names both settings and neither value", () => {
  const env = { S3_SECRET_KEY: "new-secret", AGENTIC_S3_SECRET_KEY: "old-secret" };
  assert.throws(() => readSetting(env, "S3_SECRET_KEY", { legacy: ["AGENTIC_S3_SECRET_KEY"] }), (error: unknown) => {
    assert.ok(error instanceof SettingConflictError);
    assert.match(error.message, /S3_SECRET_KEY and its retired name AGENTIC_S3_SECRET_KEY are both set, to different values/u);
    assert.doesNotMatch(error.message, /secret"|new-secret|old-secret/u);
    return true;
  });
});

test("retired names are read in precedence order; a later one never overrides an earlier one", () => {
  const { log, lines } = recorder();
  const env = { CONCERN_OLD: "true", SHARED_OLD: "false" };
  assert.equal(readSetting(env, "NEW", { legacy: ["CONCERN_OLD", "SHARED_OLD"], log }), "true");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /CONCERN_OLD/u);
  assert.throws(() => readSetting({ ...env, NEW: "true" }, "NEW", { legacy: ["CONCERN_OLD", "SHARED_OLD"] }), SettingConflictError);
});

test("empty values count as unset, for the current and the retired names alike", () => {
  const { log, lines } = recorder();
  assert.equal(readSetting({ NEW: "  ", OLD: "" }, "NEW", { legacy: ["OLD"], log }), undefined);
  assert.equal(readSetting({ NEW: "", OLD: "x" }, "NEW", { legacy: ["OLD"], log }), "x");
  assert.equal(lines.length, 1);
});

test("flags accept true/false only and name the variable that holds the bad value", () => {
  assert.equal(readFlag({}, "NEW_FLAG", false), false);
  assert.equal(readFlag({ NEW_FLAG: "TRUE" }, "NEW_FLAG", false), true);
  assert.equal(readFlag({ OLD_FLAG: "false" }, "NEW_FLAG", true, { legacy: ["OLD_FLAG"], log: () => undefined }), false);
  assert.throws(() => readFlag({ OLD_FLAG: "yes" }, "NEW_FLAG", false, { legacy: ["OLD_FLAG"], log: () => undefined }), /^Error: OLD_FLAG must be true or false$/u);
});

test("the runtime profile is trimmed and an unknown value is refused, not read as development", () => {
  assert.equal(readRuntimeProfile({}), "development");
  assert.equal(readRuntimeProfile({ AGENTIC_RUNTIME_PROFILE: " production " }), "production");
  assert.throws(() => readRuntimeProfile({ AGENTIC_RUNTIME_PROFILE: "Production" }), /Unsupported AGENTIC_RUNTIME_PROFILE: Production/u);
  assert.throws(() => readRuntimeProfile({ AGENTIC_RUNTIME_PROFILE: "prod" }), /Unsupported AGENTIC_RUNTIME_PROFILE/u);
});

test("error detail: one shared name, each product's retired name, refused in production under whichever name is set", () => {
  const { log, lines } = recorder();
  const legacy = ["PRODUCT_DEBUG_ERRORS"];
  assert.equal(readIncludeErrorDetail({}, { legacy, log }), false);
  assert.equal(readIncludeErrorDetail({ AGENT_INCLUDE_ERROR_DETAIL: "true" }, { legacy, log }), true);
  assert.equal(readIncludeErrorDetail({ PRODUCT_DEBUG_ERRORS: "true" }, { legacy, log }), true);
  assert.equal(lines.length, 1);
  assert.throws(() => readIncludeErrorDetail({ AGENT_INCLUDE_ERROR_DETAIL: "true", AGENTIC_RUNTIME_PROFILE: "production" }, { legacy, log }),
    /AGENT_INCLUDE_ERROR_DETAIL must not be set when AGENTIC_RUNTIME_PROFILE=production/u);
  assert.throws(() => readIncludeErrorDetail({ PRODUCT_DEBUG_ERRORS: "true", AGENTIC_RUNTIME_PROFILE: "production" }, { legacy, log }),
    /PRODUCT_DEBUG_ERRORS must not be set when AGENTIC_RUNTIME_PROFILE=production/u);
  assert.equal(readIncludeErrorDetail({ AGENT_INCLUDE_ERROR_DETAIL: "false", AGENTIC_RUNTIME_PROFILE: "production" }, { legacy, log }), false);
});

test("settings a component does not read are refused by name instead of ignored", () => {
  refuseUnreadSettings({ OTHER: "x", SKILL_ROOTS: " " }, ["SKILL_ROOTS", "PROFILE_FILE"], "the product ships its own");
  assert.throws(() => refuseUnreadSettings({ SKILL_ROOTS: "/tmp/skills" }, ["SKILL_ROOTS", "PROFILE_FILE"], "the product ships its own"),
    /^Error: SKILL_ROOTS is set but not read here: the product ships its own\. Unset it$/u);
  assert.throws(() => refuseUnreadSettings({ SKILL_ROOTS: "a", PROFILE_FILE: "b" }, ["SKILL_ROOTS", "PROFILE_FILE"], "r"),
    /SKILL_ROOTS and PROFILE_FILE are set but not read here: r\. Unset them/u);
});

test("a removed setting still set is named once with what replaced it, never refused and never echoed", () => {
  const { log, lines } = recorder();
  noticeRemovedSettings({ OTHER: "x", GONE_BASE_URL: " " }, ["GONE_BASE_URL"], "the client sends it", log);
  assert.deepEqual(lines, [], "unset or empty: nothing to say");
  for (let start = 0; start < 3; start += 1) noticeRemovedSettings({ GONE_BASE_URL: "https://secret.example" }, ["GONE_BASE_URL"], "the client sends it", log);
  assert.deepEqual(lines, ["[settings] GONE_BASE_URL is a removed setting and is ignored: the client sends it. Unset it"]);
});
