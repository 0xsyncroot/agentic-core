import { MAX_SKILL_CLOSING_CHARS } from "@0xsyncroot/contracts";
import { parse } from "yaml";
import { validateSchema, type SchemaViolation } from "./json-schema.js";
import { CATALOG_ITEM_SCHEMAS, type ProfileFrontmatter, type SkillFrontmatter } from "./item-schemas.js";

/**
 * Skill and profile bodies, read by the same rules the Markdown loaders apply when the runtime boots, so a release the
 * console accepts is one the runtime can load. Frontmatter is validated with the published schema; the body rules the
 * schema cannot state (one closing marker, instruction sizes, references inside the frontmatter) follow it.
 */

/** The largest `skill_load` result (plugins-base `MAX_SKILL_RESULT_CHARS`): a larger skill is refused whole at runtime. */
export const MAX_SKILL_LOAD_CHARS = 40_000;
/** The largest skill file the Markdown skill loader reads by default. */
export const MAX_SKILL_FILE_BYTES = 128 * 1024;
const MAX_PROFILE_INSTRUCTION_CHARS = 12_000;
const MAX_PROFILE_CLOSING_CHARS = 1_500;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/u;
const CLOSING_MARKER = /^<!--\s*closing\s*-->\s*$/mu;

export interface MarkdownSections<F> {
  readonly frontmatter: F;
  readonly instructions: string;
  readonly closing?: string;
}

export interface ParsedSkill extends MarkdownSections<SkillFrontmatter> {
  /** Characters of the JSON `skill_load` returns for this skill (everything but the closing). */
  readonly loadChars: number;
  readonly fileBytes: number;
  /** `requiredTools` trimmed and each once, as the loader keeps them. */
  readonly requiredTools: readonly string[];
}

export interface MarkdownParse<T> {
  readonly value?: T;
  readonly violations: readonly SchemaViolation[];
}

const trimmed = (values: readonly string[] | undefined): string[] => [...new Set((values ?? []).map((value) => value.trim()))];

/** Frontmatter and body of a Markdown item, or the violations that stop it being read. */
function sections<F>(kind: "skill" | "profile", itemId: string, body: string): MarkdownParse<MarkdownSections<F>> {
  const match = FRONTMATTER.exec(body);
  if (!match) return { violations: [{ path: "", message: "must start with YAML frontmatter between --- lines, followed by instructions" }] };
  let metadata: unknown;
  try { metadata = parse(match[1] ?? ""); } catch (error) {
    return { violations: [{ path: "frontmatter", message: `is not valid YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` }] };
  }
  const violations: SchemaViolation[] = validateSchema(CATALOG_ITEM_SCHEMAS[kind], metadata).map((failure) => ({
    path: failure.path === "" ? "frontmatter" : `frontmatter.${failure.path}`, message: failure.message,
  }));
  if (violations.length > 0) return { violations };
  const frontmatter = metadata as F & { readonly id: string };
  if (frontmatter.id.trim() !== itemId) violations.push({ path: "frontmatter.id", message: `must equal the item id ${itemId}` });
  const [text = "", closingText, ...extra] = (match[2] ?? "").split(CLOSING_MARKER);
  if (extra.length > 0) violations.push({ path: "instructions", message: "must hold at most one <!-- closing --> marker" });
  const instructions = text.trim();
  if (!instructions) violations.push({ path: "instructions", message: "must not be empty" });
  const closing = closingText?.trim();
  if (closing !== undefined && !closing) violations.push({ path: "closing", message: "must not be empty after its marker" });
  return { violations, value: { frontmatter, instructions, ...(closing ? { closing } : {}) } };
}

/** A skill body: the schema, then the loader's rules for `done`, `preconditions` and the closing. */
export function parseSkillBody(itemId: string, body: string): MarkdownParse<ParsedSkill> {
  const read = sections<SkillFrontmatter>("skill", itemId, body);
  if (!read.value) return read as MarkdownParse<never>;
  const violations = [...read.violations];
  const { frontmatter, instructions, closing } = read.value;
  (frontmatter.done ?? []).forEach((line, index) => {
    const parts = line.split("=>");
    if (parts.length > 2 || (parts.length === 2 && parts.some((part) => !part.trim()))) {
      violations.push({ path: `frontmatter.done[${index}]`, message: "must hold at most one \"=>\" with text on both sides" });
    }
  });
  const requiredTools = trimmed(frontmatter.requiredTools);
  for (const [toolId, entry] of Object.entries(frontmatter.preconditions ?? {})) {
    if (!requiredTools.includes(toolId)) violations.push({ path: `frontmatter.preconditions.${toolId}`, message: "must name one of requiredTools" });
    trimmed(entry.after).forEach((id, index) => {
      if (!requiredTools.includes(id) || id === toolId) {
        violations.push({ path: `frontmatter.preconditions.${toolId}.after[${index}]`, message: "must name another of requiredTools" });
      }
    });
  }
  if (closing !== undefined && closing.length > MAX_SKILL_CLOSING_CHARS) {
    violations.push({ path: "closing", message: `must hold at most ${MAX_SKILL_CLOSING_CHARS} characters` });
  }
  const done = trimmed(frontmatter.done);
  const preconditions = frontmatter.preconditions
    ? Object.fromEntries(Object.entries(frontmatter.preconditions).map(([toolId, entry]) => [toolId, { after: trimmed(entry.after) }]))
    : undefined;
  const loaded = {
    id: frontmatter.id.trim(), version: frontmatter.version.trim(), name: frontmatter.name.trim(), description: frontmatter.description.trim(),
    ...(frontmatter.role ? { role: frontmatter.role } : {}), requiredTools, instructions,
    ...(done.length > 0 ? { done } : {}), ...(preconditions && Object.keys(preconditions).length > 0 ? { preconditions } : {}),
  };
  return {
    violations,
    value: { ...read.value, requiredTools, loadChars: JSON.stringify(loaded).length, fileBytes: Buffer.byteLength(body, "utf8") },
  };
}

/** A profile body: the schema, then the loader's rules for `conditionalSkills` and the instruction sizes. */
export function parseProfileBody(itemId: string, body: string): MarkdownParse<MarkdownSections<ProfileFrontmatter>> {
  const read = sections<ProfileFrontmatter>("profile", itemId, body);
  if (!read.value) return read;
  const violations = [...read.violations];
  const { frontmatter, instructions, closing } = read.value;
  const preload = trimmed(frontmatter.preloadSkills);
  (frontmatter.conditionalSkills ?? []).forEach((id, index) => {
    if (!preload.includes(id.trim())) violations.push({ path: `frontmatter.conditionalSkills[${index}]`, message: "must name one of preloadSkills" });
  });
  if (instructions.length + (closing?.length ?? 0) > MAX_PROFILE_INSTRUCTION_CHARS) {
    violations.push({ path: "instructions", message: `must hold at most ${MAX_PROFILE_INSTRUCTION_CHARS} characters with the closing` });
  }
  if (closing !== undefined && closing.length > MAX_PROFILE_CLOSING_CHARS) {
    violations.push({ path: "closing", message: `must hold at most ${MAX_PROFILE_CLOSING_CHARS} characters` });
  }
  return { violations, value: read.value };
}
