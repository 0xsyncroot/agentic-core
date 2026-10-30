import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { MAX_SKILL_CLOSING_CHARS, type SkillCatalog, type SkillDefinition } from "@0xsyncroot/contracts";
import { parse } from "yaml";

export interface MarkdownSkillLoaderOptions {
  readonly roots: readonly string[];
  readonly workspaceRoot?: string;
  readonly maxSkills?: number;
  readonly maxFileBytes?: number;
}

interface SkillMetadata {
  readonly id?: unknown;
  readonly version?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly requiredTools?: unknown;
  readonly done?: unknown;
  readonly preconditions?: unknown;
  readonly role?: unknown;
}

class ImmutableSkillCatalog implements SkillCatalog {
  readonly revision: string;
  readonly #skills: ReadonlyMap<string, SkillDefinition>;
  constructor(skills: readonly SkillDefinition[]) {
    const values = new Map<string, SkillDefinition>();
    for (const skill of skills) {
      if (values.has(skill.id)) throw new Error(`Duplicate skill id: ${skill.id}`);
      values.set(skill.id, Object.freeze({ ...skill, requiredTools: Object.freeze([...skill.requiredTools]), ...(skill.done ? { done: Object.freeze([...skill.done]) } : {}),
        ...(skill.preconditions ? { preconditions: Object.freeze(Object.fromEntries(Object.entries(skill.preconditions)
          .map(([toolId, { after }]) => [toolId, Object.freeze({ after: Object.freeze([...after]) })]))) } : {}) }));
    }
    this.#skills = values;
    this.revision = catalogRevision([...values.values()]);
  }
  list(): readonly Omit<SkillDefinition, "instructions">[] {
    return [...this.#skills.values()].sort((a, b) => a.id.localeCompare(b.id))
      .map(({ instructions: _instructions, closing: _closing, preconditions: _preconditions, ...summary }) => summary);
  }
  get(id: string): SkillDefinition | undefined { return this.#skills.get(id); }
}

function catalogRevision(skills: readonly SkillDefinition[]): string {
  const canonical = [...skills]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, version, name, description, role, requiredTools, instructions, done, closing, preconditions }) => ({
      id, version, name, description, ...(role ? { role } : {}), requiredTools: [...requiredTools], instructions, ...(done ? { done: [...done] } : {}), ...(closing ? { closing } : {}),
      ...(preconditions ? { preconditions: Object.keys(preconditions).sort().map((toolId) => [toolId, [...preconditions[toolId]!.after]]) } : {}),
    }));
  return `sha256-${createHash("sha256").update(JSON.stringify(canonical)).digest("base64url")}`;
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function requiredString(metadata: SkillMetadata, key: keyof SkillMetadata, file: string, maxLength: number): string {
  const value = metadata[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${file}: frontmatter ${key} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${file}: frontmatter ${key} exceeds ${maxLength} characters`);
  return normalized;
}

/**
 * `preconditions: { <write tool>: { after: [<tool>, …] } }`. Every id must be one of the skill's `requiredTools`, and a key
 * other than `after` is refused: a misspelt or not-yet-supported condition would otherwise switch the check off silently.
 */
function parsePreconditions(value: unknown, requiredTools: readonly string[], file: string): SkillDefinition["preconditions"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${file}: preconditions must map write tool ids to { after: [tool ids] }`);
  const known = new Set(requiredTools);
  const parsed: Record<string, { readonly after: readonly string[] }> = {};
  for (const [toolId, entry] of Object.entries(value)) {
    if (!known.has(toolId)) throw new Error(`${file}: preconditions key "${toolId}" is not one of requiredTools`);
    const keys = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? Object.keys(entry) : [];
    const after = (entry as { readonly after?: unknown } | null)?.after;
    if (keys.length !== 1 || keys[0] !== "after" || !Array.isArray(after) || after.length === 0 || after.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error(`${file}: preconditions.${toolId} must be { after: [tool ids] } with at least one tool id and no other key`);
    }
    const ids = [...new Set(after.map((id) => String(id).trim()))];
    const unknown = ids.find((id) => !known.has(id) || id === toolId);
    if (unknown !== undefined) throw new Error(`${file}: preconditions.${toolId}.after names "${unknown}", which is not another of requiredTools`);
    parsed[toolId] = { after: ids };
  }
  return Object.keys(parsed).length ? parsed : undefined;
}

function parseSkill(source: string, file: string): SkillDefinition {
  const normalized = source.replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(normalized);
  if (!match) throw new Error(`${file}: SKILL.md must contain YAML frontmatter and instructions`);
  const metadata = parse(match[1] ?? "") as SkillMetadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) throw new Error(`${file}: invalid skill frontmatter`);
  const id = requiredString(metadata, "id", file, 100);
  if (!/^[a-z0-9][a-z0-9.-]{1,99}$/.test(id)) throw new Error(`${file}: invalid skill id ${id}`);
  const version = requiredString(metadata, "version", file, 100);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`${file}: version must be SemVer`);
  // A role other than the two known ones is refused: a misspelt "supporting" would otherwise read as a procedure silently.
  const role = metadata.role;
  if (role !== undefined && role !== "procedure" && role !== "supporting") throw new Error(`${file}: role must be "procedure" or "supporting"`);
  const tools = metadata.requiredTools ?? [];
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || !tool.trim())) {
    throw new Error(`${file}: requiredTools must be an array of non-empty strings`);
  }
  const done = metadata.done ?? [];
  if (!Array.isArray(done) || done.length > 12 || done.some((line) => typeof line !== "string" || !line.trim() || line.length > 400)) {
    throw new Error(`${file}: done must be an array of at most 12 non-empty criteria of at most 400 characters`);
  }
  // "<condition> => <requirement>": one separator, both sides written — an arrow meant as text ("cũ => mới") would split a line silently.
  const malformed = done.find((line) => { const parts = String(line).split("=>"); return parts.length > 2 || (parts.length === 2 && parts.some((part) => !part.trim())); });
  if (malformed !== undefined) throw new Error(`${file}: done line "${String(malformed).slice(0, 80)}" must have at most one "=>" with text on both sides (write → for an arrow in the text)`);
  // One optional marker line, as in AGENT.md: what follows it is the skill's closing (`SkillDefinition.closing`), sent last
  // in the request while the skill is in effect — never part of the procedure `skill_load` returns.
  const [body = "", closingText, ...extra] = (match[2] ?? "").split(/^<!--\s*closing\s*-->\s*$/mu);
  if (extra.length > 0) throw new Error(`${file}: only one <!-- closing --> marker is allowed`);
  const instructions = body.trim();
  if (!instructions) throw new Error(`${file}: instructions must not be empty`);
  const closing = closingText?.trim();
  if (closing !== undefined && (!closing || closing.length > MAX_SKILL_CLOSING_CHARS)) {
    throw new Error(`${file}: closing must be non-empty and at most ${MAX_SKILL_CLOSING_CHARS} characters — it is paid on every request while the skill is in effect`);
  }
  const requiredTools = [...new Set(tools.map((tool) => String(tool).trim()))];
  const preconditions = parsePreconditions(metadata.preconditions, requiredTools, file);
  return {
    id, version, name: requiredString(metadata, "name", file, 120),
    description: requiredString(metadata, "description", file, 1_000),
    ...(role ? { role } : {}),
    requiredTools, instructions,
    ...(done.length ? { done: done.map((line) => String(line).trim()) } : {}),
    ...(closing ? { closing } : {}),
    ...(preconditions ? { preconditions } : {}),
  };
}

async function collectSkillFiles(root: string, trustedRoot: string, files: string[], maxSkills: number): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(root, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`Skill path must not be a symbolic link: ${path}`);
    const canonical = await realpath(path);
    if (!within(trustedRoot, canonical)) throw new Error(`Skill path escapes trusted root: ${path}`);
    if (entry.isDirectory()) await collectSkillFiles(canonical, trustedRoot, files, maxSkills);
    else if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(canonical);
      if (files.length > maxSkills) throw new Error(`Skill count exceeds ${maxSkills}`);
    }
  }
}

function skillLimits(options: { readonly maxSkills?: number; readonly maxFileBytes?: number }): { readonly maxSkills: number; readonly maxFileBytes: number } {
  const maxSkills = options.maxSkills ?? 100;
  const maxFileBytes = options.maxFileBytes ?? 128 * 1024;
  if (!Number.isInteger(maxSkills) || maxSkills <= 0) throw new Error("maxSkills must be positive");
  if (!Number.isInteger(maxFileBytes) || maxFileBytes <= 0) throw new Error("maxFileBytes must be positive");
  return { maxSkills, maxFileBytes };
}

export async function loadMarkdownSkillCatalog(options: MarkdownSkillLoaderOptions): Promise<SkillCatalog> {
  const workspace = await realpath(resolve(options.workspaceRoot ?? process.cwd()));
  const { maxSkills, maxFileBytes } = skillLimits(options);
  const files: string[] = [];
  for (const configured of options.roots) {
    const requested = resolve(workspace, configured);
    if (!within(workspace, requested)) throw new Error(`Skill root escapes workspace: ${configured}`);
    const root = await realpath(requested);
    if (!within(workspace, root)) throw new Error(`Skill root escapes workspace: ${configured}`);
    await collectSkillFiles(root, root, files, maxSkills);
  }
  const skills: SkillDefinition[] = [];
  for (const file of files) {
    const metadata = await lstat(file);
    if (metadata.size > maxFileBytes) throw new Error(`${file}: skill file exceeds ${maxFileBytes} bytes`);
    skills.push(parseSkill(await readFile(file, "utf8"), file));
  }
  return new ImmutableSkillCatalog(skills);
}

/**
 * The catalog of skills given as text, parsed and limited as `loadMarkdownSkillCatalog` parses and limits files, so the same
 * SKILL.md texts give the same catalog and revision whichever way they arrive. `name` labels errors only.
 */
export function markdownSkillCatalog(
  sources: readonly { readonly name: string; readonly text: string }[],
  options: { readonly maxSkills?: number; readonly maxFileBytes?: number } = {},
): SkillCatalog {
  const { maxSkills, maxFileBytes } = skillLimits(options);
  if (sources.length > maxSkills) throw new Error(`Skill count exceeds ${maxSkills}`);
  return new ImmutableSkillCatalog(sources.map(({ name, text }) => {
    if (Buffer.byteLength(text, "utf8") > maxFileBytes) throw new Error(`${name}: skill file exceeds ${maxFileBytes} bytes`);
    return parseSkill(text, name);
  }));
}
