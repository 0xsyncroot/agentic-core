import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMarkdownSkillCatalog } from "@0xsyncroot/adapter-skills-markdown";
import { canonicalBody, canonicalJson } from "@0xsyncroot/contracts";
import { MAX_SKILL_RESULT_CHARS } from "@0xsyncroot/plugins-base";
import {
  CATALOG_ITEM_SCHEMAS, catalogBodyHash, catalogRevisionFields, MAX_SKILL_LOAD_CHARS, parseSkillBody, validateCatalogItem, validateSchema,
} from "../src/index.js";
import { CONNECTOR, GROUP, PROFILE, SKILL, TOOL } from "./catalog-fixture.js";

const paths = (kind: Parameters<typeof validateCatalogItem>[0], id: string, body: string) =>
  validateCatalogItem(kind, id, body).violations.map((violation) => `${violation.path}: ${violation.message}`);

test("every kind's schema is published with its id and accepts the fixture", () => {
  assert.deepEqual(Object.keys(CATALOG_ITEM_SCHEMAS).sort(), ["connector", "group", "profile", "skill", "tool"]);
  assert.equal(CATALOG_ITEM_SCHEMAS.tool.$id, "catalog/tool/1");
  assert.equal(CATALOG_ITEM_SCHEMAS.skill.title, "skill frontmatter");
  assert.deepEqual(paths("tool", "ledger_read", canonicalJson(TOOL)), []);
  assert.deepEqual(paths("connector", "ledger", canonicalJson(CONNECTOR)), []);
  assert.deepEqual(paths("group", "ledger-read", canonicalJson(GROUP)), []);
  assert.deepEqual(paths("skill", "ledger.review", SKILL), []);
  assert.deepEqual(paths("profile", "ledger-agent", PROFILE), []);
});

test("a failing field is named by its path", () => {
  const tool = { ...TOOL, permission: [], inputSchema: { type: "array" }, timeoutMs: 0, extra: 1 };
  const found = paths("tool", "ledger_read", canonicalJson(tool));
  for (const path of ["permission", "inputSchema.type", "timeoutMs", "extra"]) assert.ok(found.some((line) => line.startsWith(`${path}: `)), `${path} in ${found.join(" | ")}`);
  const missing = paths("tool", "ledger_read", canonicalJson({ ...TOOL, description: undefined }));
  assert.deepEqual(missing, ["description: is required"]);
  const connector = paths("connector", "ledger", canonicalJson({ ...CONNECTOR, riskOverrides: { "x.y": "none" } }));
  assert.ok(connector.some((line) => line.startsWith("riskOverrides.x.y: ")), connector.join(" | "));
});

test("rules between tool fields are refused by field", () => {
  const write = { ...TOOL, kind: "action", access: "write", sideEffect: "none", readback: true, repeatableRows: {} };
  assert.deepEqual(paths("tool", "ledger_read", canonicalJson(write)), [
    "sideEffect: must not be none for a write", "readback: is allowed only on a read tool",
  ]);
  const report = { ...TOOL, repeatableRows: { rows: "whole" } };
  assert.deepEqual(paths("tool", "ledger_read", canonicalJson(report)), ["repeatableRows: is allowed only on a write tool"]);
  const action = { ...TOOL, kind: "action", access: "write", sideEffect: "idempotent", repeatableRows: {} };
  assert.deepEqual(paths("tool", "ledger_read", canonicalJson(action)), []);
});

test("a JSON body must be its canonical text; a Markdown body must use LF line ends", () => {
  assert.deepEqual(paths("tool", "ledger_read", JSON.stringify(TOOL, null, 2)), [": is not in canonical form (sorted keys, no whitespace)"]);
  assert.deepEqual(paths("tool", "ledger_read", "{"), [": is not valid JSON"]);
  assert.deepEqual(paths("skill", "ledger.review", SKILL.replaceAll("\n", "\r\n")), [": is not in canonical form (LF line ends)"]);
  assert.equal(canonicalBody("skill", SKILL.replaceAll("\n", "\r\n")), SKILL);
  assert.equal(canonicalBody("tool", JSON.parse(JSON.stringify(TOOL, null, 2))), canonicalJson(TOOL));
  assert.equal(catalogBodyHash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("skill frontmatter faults are named under frontmatter", () => {
  const version = paths("skill", "ledger.review", SKILL.replace("version: 1.0.0", "version: one"));
  assert.equal(version.length, 1);
  assert.match(version[0] ?? "", /^frontmatter\.version: /u);
  const named = paths("skill", "ledger.review", SKILL.replace("id: ledger.review", "id: ledger.other"));
  assert.deepEqual(named, ["frontmatter.id: must equal the item id ledger.review"]);
  const arrows = paths("skill", "ledger.review", SKILL.replace("rows read => every row is reported", "a => b => c"));
  assert.deepEqual(arrows, ["frontmatter.done[0]: must hold at most one \"=>\" with text on both sides"]);
  const markers = paths("skill", "ledger.review", `${SKILL}<!-- closing -->\nagain\n`);
  assert.deepEqual(markers, ["instructions: must hold at most one <!-- closing --> marker"]);
  const conditional = paths("profile", "ledger-agent", PROFILE.replace("preloadSkills:", "conditionalSkills:\n  - other.skill\npreloadSkills:"));
  assert.deepEqual(conditional, ["frontmatter.conditionalSkills[0]: must name one of preloadSkills"]);
});

test("revision list fields come from the body", () => {
  assert.deepEqual(catalogRevisionFields("skill", "ledger.review", SKILL), {
    bodyFormat: "markdown", schemaVersion: 1, displayName: "Ledger review", summary: "Reviews a ledger period.", requiredToolCount: 1,
  });
  assert.deepEqual(catalogRevisionFields("connector", "ledger", canonicalJson(CONNECTOR)), {
    bodyFormat: "json", schemaVersion: 1, displayName: "ledger", summary: "intent-adapter ledger-api", requiredToolCount: 0,
  });
  const long = catalogRevisionFields("tool", "ledger_read", canonicalJson({ ...TOOL, description: `${"a".repeat(999)}\u{1F600}` }));
  assert.equal(long.summary, "a".repeat(999));
  assert.deepEqual(catalogRevisionFields("tool", "ledger_read", "{"), { bodyFormat: "json", schemaVersion: 1, displayName: "ledger_read", summary: "", requiredToolCount: 0 });
});

test("a skill reads as the Markdown skill loader reads it, and skill_load size is the size of the loaded skill", async (t) => {
  assert.equal(MAX_SKILL_LOAD_CHARS, MAX_SKILL_RESULT_CHARS);
  const root = await mkdtemp(join(tmpdir(), "catalog-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = SKILL.replace("requiredTools:\n  - ledger_read", "requiredTools:\n  - ledger_read\n  - ' ledger_write '\n  - ledger_read\npreconditions:\n  ledger_write:\n    after: [ledger_read]");
  await mkdir(join(root, "ledger"));
  await writeFile(join(root, "ledger", "SKILL.md"), body);
  const loaded = (await loadMarkdownSkillCatalog({ roots: [root], workspaceRoot: root })).get("ledger.review");
  const parsed = parseSkillBody("ledger.review", body);
  assert.deepEqual(parsed.violations, []);
  assert.ok(loaded && parsed.value);
  const { closing, ...withoutClosing } = loaded;
  assert.equal(parsed.value.closing, closing);
  assert.deepEqual(parsed.value.requiredTools, loaded.requiredTools);
  assert.equal(parsed.value.loadChars, JSON.stringify(withoutClosing).length);
});

test("validateSchema reports every failing path of a nested value", () => {
  const schema = CATALOG_ITEM_SCHEMAS.group;
  const found = validateSchema(schema, { purpose: " ", order: -1, toolIds: ["a", "a"] }).map((violation) => violation.path);
  assert.deepEqual(found.sort(), ["order", "purpose", "toolIds[1]"]);
});
