import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG_CHECK_KINDS, catalogChecksPass, runCatalogReleaseChecks, type CatalogCheckItem } from "../src/index.js";
import { CONNECTOR, GROUP, jsonItem, releaseItems, SKILL, TOOL } from "./catalog-fixture.js";

const statuses = (items: readonly CatalogCheckItem[]) => Object.fromEntries(runCatalogReleaseChecks(items).map((check) => [check.checkKind, check.status]));
const detail = (items: readonly CatalogCheckItem[], kind: string) => runCatalogReleaseChecks(items).find((check) => check.checkKind === kind)?.detail ?? "";

test("a complete release passes every check that needs no build; prompt-budget waits for the build", () => {
  const checks = runCatalogReleaseChecks(releaseItems());
  assert.deepEqual(checks.map((check) => check.checkKind), [...CATALOG_CHECK_KINDS]);
  assert.deepEqual(statuses(releaseItems()), {
    schema: "passed", "unique-ids": "passed", references: "passed", "group-members": "passed", "required-tools": "passed", "skill-size": "passed",
    "build-behaviours": "passed", "build-tools": "passed", "prompt-budget": "pending",
  });
  assert.equal(catalogChecksPass(checks), true);
});

test("a schema fault fails the schema check with the item and field", () => {
  const items = releaseItems({ tool: { ...TOOL, timeoutMs: 0 } });
  assert.equal(statuses(items).schema, "failed");
  assert.equal(detail(items, "schema"), "tool ledger_read: timeoutMs must be at least 1");
  assert.equal(catalogChecksPass(runCatalogReleaseChecks(items)), false);
});

test("an item twice, or a tool in a contextual connector's name space, fails unique-ids", () => {
  assert.equal(statuses([...releaseItems(), jsonItem("connector", "ledger", CONNECTOR)])["unique-ids"], "failed");
  const mcp = [...releaseItems(), jsonItem("connector", "docs", { kind: "mcp-stdio", connection: "office" }), jsonItem("tool", "mcp_office_read", { ...TOOL, group: "ledger-read" })];
  assert.match(detail(mcp, "unique-ids"), /tool mcp_office_read takes the name space mcp_office_/u);
});

test("a missing connector, group or preloaded skill fails references", () => {
  const items = releaseItems({ tool: { ...TOOL, connector: "nowhere" } }).filter((item) => item.itemKind !== "skill");
  assert.equal(statuses(items).references, "failed");
  assert.equal(detail(items, "references"), "tool ledger_read: connector nowhere is not in the release\nprofile ledger-agent: preloaded skill ledger.review is not in the release");
});

test("group membership must agree both ways, and a tool sits in one group", () => {
  const other = jsonItem("group", "ledger-other", { purpose: "Other.", order: 1, toolIds: ["ledger_read"] });
  assert.match(detail([...releaseItems(), other], "group-members"), /tool ledger_read is in two groups: ledger-read and ledger-other/u);
  const left = releaseItems().map((item) => (item.itemKind === "group" ? jsonItem("group", "ledger-read", { ...GROUP, toolIds: ["ledger_sum"] }) : item));
  assert.match(detail(left, "group-members"), /tool ledger_read names group ledger-read, whose toolIds leave it out/u);
});

test("required tools: a release tool, a group member or a contextual connector tool passes; anything else fails", () => {
  const needs = (tools: string) => SKILL.replace("requiredTools:\n  - ledger_read", `requiredTools:\n${tools}`);
  const grouped = releaseItems({ skill: needs("  - ledger_read\n  - ledger_sum") })
    .map((item) => (item.itemKind === "group" ? jsonItem("group", "ledger-read", { ...GROUP, toolIds: ["ledger_read", "ledger_sum"] }) : item));
  assert.equal(statuses(grouped)["required-tools"], "passed");
  assert.equal(statuses(grouped)["build-tools"], "pending");
  assert.equal(detail(grouped, "build-tools"), "group ledger-read: tool ledger_sum must be provided by the build");
  assert.equal(catalogChecksPass(runCatalogReleaseChecks(grouped)), true);
  const contextual = [...releaseItems({ skill: needs("  - ledger_read\n  - mcp_office_read") }), jsonItem("connector", "docs", { kind: "mcp-http", connection: "office" })];
  assert.equal(statuses(contextual)["required-tools"], "passed");
  const avaOnly = [...releaseItems({ skill: needs("  - ledger_read\n  - mcp_office_read") }), jsonItem("connector", "docs", { kind: "intent-adapter", connection: "office" })];
  assert.equal(statuses(avaOnly)["required-tools"], "failed");
  const unknown = releaseItems({ skill: needs("  - ledger_read\n  - ledger_sum") });
  assert.equal(detail(unknown, "required-tools"), "skill ledger.review: required tool ledger_sum is not a release tool, a member of a release group, or a tool of a contextual connector in the release");
});

test("skill size: skill_load over 40,000 characters or a file over 128 KiB fails", () => {
  const large = (chars: number) => SKILL.replace("Read the ledger with ledger_read, then report each row.", "x".repeat(chars));
  assert.equal(statuses(releaseItems({ skill: large(39_000) }))["skill-size"], "passed");
  assert.match(detail(releaseItems({ skill: large(40_000) }), "skill-size"), /skill_load returns \d+ characters, over 40000/u);
  const bytes = detail(releaseItems({ skill: SKILL.replace("Read the ledger with ledger_read, then report each row.", "\u4e2d".repeat(45_000)) }), "skill-size");
  assert.match(bytes, /^skill ledger\.review: file is \d+ bytes, over 131072\nskill ledger\.review: skill_load returns \d+ characters, over 40000$/u);
});

test("a behaviour is pending until a build registers it", () => {
  const items = releaseItems({ tool: { ...TOOL, behaviour: "ledger.card" } });
  assert.equal(statuses(items)["build-behaviours"], "pending");
  assert.equal(detail(items, "build-behaviours"), "tool ledger_read: behaviour ledger.card must be registered by the build");
  assert.equal(catalogChecksPass(runCatalogReleaseChecks(items)), true);
});
