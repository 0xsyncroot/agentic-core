import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { AgentProfileDefinition } from "@0xsyncroot/contracts";
import { parse } from "yaml";

export interface MarkdownAgentProfileLoaderOptions {
  readonly file: string;
  readonly maxFileBytes?: number;
}

interface ProfileMetadata {
  readonly id?: unknown;
  readonly version?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly supportedDomains?: unknown;
  readonly preloadSkills?: unknown;
  readonly conditionalSkills?: unknown;
}

function requiredString(
  metadata: ProfileMetadata,
  key: keyof ProfileMetadata,
  file: string,
  maxLength: number,
): string {
  const value = metadata[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${file}: frontmatter ${key} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${file}: frontmatter ${key} exceeds ${maxLength} characters`);
  return normalized;
}

function parseProfile(source: string, file: string): AgentProfileDefinition {
  const normalized = source.replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(normalized);
  if (!match) throw new Error(`${file}: AGENT.md must contain YAML frontmatter and instructions`);
  const metadata = parse(match[1] ?? "") as ProfileMetadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error(`${file}: invalid agent profile frontmatter`);
  }
  const id = requiredString(metadata, "id", file, 100);
  if (!/^[a-z0-9][a-z0-9.-]{1,99}$/.test(id)) throw new Error(`${file}: invalid agent profile id ${id}`);
  const version = requiredString(metadata, "version", file, 100);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`${file}: version must be SemVer`);
  const domains = metadata.supportedDomains ?? [];
  if (!Array.isArray(domains) || domains.length > 50 || domains.some((value) =>
    typeof value !== "string" || !value.trim() || value.trim().length > 160)) {
    throw new Error(`${file}: supportedDomains must contain at most 50 non-empty strings of 160 characters`);
  }
  const preloadSkills = metadata.preloadSkills ?? [];
  if (!Array.isArray(preloadSkills) || preloadSkills.length > 20 || preloadSkills.some((value) =>
    typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{1,99}$/.test(value.trim()))) {
    throw new Error(`${file}: preloadSkills must contain at most 20 skill ids`);
  }
  const conditionalSkills = metadata.conditionalSkills ?? [];
  if (!Array.isArray(conditionalSkills) || conditionalSkills.some((value) => typeof value !== "string" || !preloadSkills.includes(value.trim()))) {
    throw new Error(`${file}: conditionalSkills must list skill ids from preloadSkills`);
  }
  // One optional marker line splits the body: what follows it is sent as the last thing in the
  // system prompt rather than the first. A second marker is a mistake, not a third section.
  const [body = "", closing, ...extra] = (match[2] ?? "").split(/^<!--\s*closing\s*-->\s*$/mu);
  if (extra.length > 0) throw new Error(`${file}: only one <!-- closing --> marker is allowed`);
  const instructions = body.trim();
  const closingInstructions = closing?.trim();
  if (!instructions) throw new Error(`${file}: instructions must not be empty`);
  if (instructions.length + (closingInstructions?.length ?? 0) > 12_000) throw new Error(`${file}: instructions exceed 12000 characters`);
  if (closingInstructions !== undefined && (!closingInstructions || closingInstructions.length > 1_500)) {
    throw new Error(`${file}: closing instructions must be non-empty and at most 1500 characters — the end of the prompt only works while it is short`);
  }
  return Object.freeze({
    id,
    version,
    name: requiredString(metadata, "name", file, 120),
    description: requiredString(metadata, "description", file, 500),
    supportedDomains: Object.freeze([...new Set(domains.map((value) => String(value).trim()))]),
    ...(preloadSkills.length > 0
      ? { preloadSkills: Object.freeze([...new Set(preloadSkills.map((value) => String(value).trim()))]) }
      : {}),
    ...(conditionalSkills.length > 0
      ? { conditionalSkills: Object.freeze([...new Set(conditionalSkills.map((value) => String(value).trim()))]) }
      : {}),
    instructions,
    ...(closingInstructions ? { closingInstructions } : {}),
    contentDigest: `sha256-${createHash("sha256").update(normalized).digest("base64url")}`,
  });
}

function profileLimit(maxFileBytes = 16 * 1024): number {
  if (!Number.isInteger(maxFileBytes) || maxFileBytes <= 0) throw new Error("maxFileBytes must be positive");
  return maxFileBytes;
}

export async function loadMarkdownAgentProfile(
  options: MarkdownAgentProfileLoaderOptions,
): Promise<AgentProfileDefinition> {
  const requested = resolve(options.file);
  const metadata = await lstat(requested);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`Agent profile must be a regular file: ${requested}`);
  const canonical = await realpath(requested);
  if (canonical !== requested) throw new Error(`Agent profile path must be canonical and cannot traverse a symbolic link: ${requested}`);
  const maxFileBytes = profileLimit(options.maxFileBytes);
  if (metadata.size > maxFileBytes) throw new Error(`${requested}: agent profile exceeds ${maxFileBytes} bytes`);
  return parseProfile(await readFile(canonical, "utf8"), canonical);
}

/**
 * An agent profile given as text, parsed and limited as `loadMarkdownAgentProfile` parses and limits a file, so the same
 * AGENT.md text gives the same profile and content digest whichever way it arrives. `name` labels errors only.
 */
export function markdownAgentProfile(text: string, name: string, maxFileBytes?: number): AgentProfileDefinition {
  const limit = profileLimit(maxFileBytes);
  if (Buffer.byteLength(text, "utf8") > limit) throw new Error(`${name}: agent profile exceeds ${limit} bytes`);
  return parseProfile(text, name);
}
