import { CATALOG_SCHEMA_VERSION, canonicalJson, catalogBodyFormat, type CatalogBodyFormat, type CatalogItemKind } from "@0xsyncroot/contracts";
import { validateSchema, type SchemaViolation } from "./json-schema.js";
import {
  CATALOG_ITEM_SCHEMAS, MAX_GROUP_ID_CHARS, type ConnectorItemBody, type GroupItemBody, type ProfileFrontmatter,
  type ToolItemBody,
} from "./item-schemas.js";
import { parseProfileBody, parseSkillBody, type MarkdownSections, type ParsedSkill } from "./markdown-items.js";

/** An item's body once read: the JSON object of a tool, connector or group, or the sections of a skill or profile. */
export type CatalogItemContent =
  | { readonly kind: "tool"; readonly body: ToolItemBody }
  | { readonly kind: "connector"; readonly body: ConnectorItemBody }
  | { readonly kind: "group"; readonly body: GroupItemBody }
  | { readonly kind: "skill"; readonly skill: ParsedSkill }
  | { readonly kind: "profile"; readonly profile: MarkdownSections<ProfileFrontmatter> };

/** The result of validating one stored body; `content` is present only when `violations` is empty. */
export interface CatalogItemValidation {
  readonly itemKind: CatalogItemKind;
  readonly itemId: string;
  readonly violations: readonly SchemaViolation[];
  readonly content?: CatalogItemContent;
}

const SUMMARY_CHARS = 1_000;

/** The rules between tool fields that a per-field schema cannot state. */
function toolRules(body: ToolItemBody): SchemaViolation[] {
  const failures: SchemaViolation[] = [];
  if (body.kind === "report" && body.access !== "read") failures.push({ path: "access", message: "must be read for a report" });
  if (body.kind === "action" && body.access !== "write") failures.push({ path: "access", message: "must be write for an action" });
  if (body.access === "read" && body.sideEffect !== "none") failures.push({ path: "sideEffect", message: "must be none for a read" });
  if (body.access === "write" && body.sideEffect === "none") failures.push({ path: "sideEffect", message: "must not be none for a write" });
  if (body.readback === true && body.access !== "read") failures.push({ path: "readback", message: "is allowed only on a read tool" });
  if (body.repeatableRows !== undefined && body.access !== "write") failures.push({ path: "repeatableRows", message: "is allowed only on a write tool" });
  return failures;
}

/** A JSON body: well-formed, in canonical form (the text the hash is taken over), valid by its schema. */
function jsonItem(kind: "tool" | "connector" | "group", itemId: string, body: string): CatalogItemValidation {
  const result = (violations: readonly SchemaViolation[], content?: CatalogItemContent): CatalogItemValidation =>
    ({ itemKind: kind, itemId, violations, ...(violations.length === 0 && content ? { content } : {}) });
  let value: unknown;
  try { value = JSON.parse(body); } catch { return result([{ path: "", message: "is not valid JSON" }]); }
  const violations = validateSchema(CATALOG_ITEM_SCHEMAS[kind], value);
  if (violations.length > 0) return result(violations);
  if (canonicalJson(value) !== body) return result([{ path: "", message: "is not in canonical form (sorted keys, no whitespace)" }]);
  if (kind === "tool") return result(toolRules(value as ToolItemBody), { kind, body: value as ToolItemBody });
  if (kind === "group") {
    const idRule = itemId.length > MAX_GROUP_ID_CHARS ? [{ path: "", message: `belongs to a group id longer than ${MAX_GROUP_ID_CHARS} characters` }] : [];
    return result(idRule, { kind, body: value as GroupItemBody });
  }
  return result([], { kind, body: value as ConnectorItemBody });
}

/** Validates one item's canonical body against its kind's schema and rules, naming each failing field by its path. */
export function validateCatalogItem(itemKind: CatalogItemKind, itemId: string, body: string): CatalogItemValidation {
  if (catalogBodyFormat(itemKind) === "markdown" && body.includes("\r\n")) {
    return { itemKind, itemId, violations: [{ path: "", message: "is not in canonical form (LF line ends)" }] };
  }
  if (itemKind === "skill") {
    const parsed = parseSkillBody(itemId, body);
    return { itemKind, itemId, violations: parsed.violations, ...(parsed.violations.length === 0 && parsed.value ? { content: { kind: itemKind, skill: parsed.value } } : {}) };
  }
  if (itemKind === "profile") {
    const parsed = parseProfileBody(itemId, body);
    return { itemKind, itemId, violations: parsed.violations, ...(parsed.violations.length === 0 && parsed.value ? { content: { kind: itemKind, profile: parsed.value } } : {}) };
  }
  return jsonItem(itemKind, itemId, body);
}

/** One violation as one line, for check details and command output. */
export function describeViolation(validation: Pick<CatalogItemValidation, "itemKind" | "itemId">, violation: SchemaViolation): string {
  return `${validation.itemKind} ${validation.itemId}: ${violation.path === "" ? "body" : violation.path} ${violation.message}`;
}

/** What a revision stores beside its body, derived from it so lists never parse bodies. */
export interface CatalogRevisionFields {
  readonly bodyFormat: CatalogBodyFormat;
  readonly schemaVersion: number;
  readonly displayName: string;
  readonly summary: string;
  readonly requiredToolCount: number;
}

/** The text's start, at most `SUMMARY_CHARS` UTF-16 units and never cut inside a surrogate pair. */
function firstChars(text: string): string {
  let kept = "";
  for (const point of text.trim()) {
    if (kept.length + point.length > SUMMARY_CHARS) break;
    kept += point;
  }
  return kept;
}

/** The list fields of a revision; a body that does not validate is listed under its item id with an empty summary. */
export function catalogRevisionFields(itemKind: CatalogItemKind, itemId: string, body: string): CatalogRevisionFields {
  const base = { bodyFormat: catalogBodyFormat(itemKind), schemaVersion: CATALOG_SCHEMA_VERSION };
  const content = validateCatalogItem(itemKind, itemId, body).content;
  if (!content) return { ...base, displayName: itemId, summary: "", requiredToolCount: 0 };
  switch (content.kind) {
    case "tool": return { ...base, displayName: itemId, summary: firstChars(content.body.description), requiredToolCount: 0 };
    case "connector": return { ...base, displayName: itemId, summary: `${content.body.kind} ${content.body.connection}`, requiredToolCount: 0 };
    case "group": return { ...base, displayName: itemId, summary: firstChars(content.body.purpose), requiredToolCount: 0 };
    case "skill": {
      const { frontmatter } = content.skill;
      return { ...base, displayName: frontmatter.name.trim(), summary: firstChars(frontmatter.description), requiredToolCount: content.skill.requiredTools.length };
    }
    case "profile": {
      const { frontmatter } = content.profile;
      return { ...base, displayName: frontmatter.name.trim(), summary: firstChars(frontmatter.description), requiredToolCount: 0 };
    }
  }
}
