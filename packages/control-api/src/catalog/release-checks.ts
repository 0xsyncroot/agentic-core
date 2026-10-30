import { createHash } from "node:crypto";
import type { CatalogCheckStatus, CatalogItemKind } from "@0xsyncroot/contracts";
import { CONTEXTUAL_CONNECTOR_KINDS } from "./item-schemas.js";
import { MAX_SKILL_FILE_BYTES, MAX_SKILL_LOAD_CHARS } from "./markdown-items.js";
import { describeViolation, validateCatalogItem, type CatalogItemContent, type CatalogItemValidation } from "./validate-item.js";

/**
 * The checks a release gets before a channel may point at it, run on the release's bodies alone. Each check that needs the
 * build that will serve the release (a behaviour it registers, a tool it provides, the prompt it assembles) is recorded as
 * `pending` with what it still has to settle; the build settles it under its own digest.
 */

/** The digest checks that need no build are recorded under: sha256 of a fixed text, never a real build's digest. */
export const NO_BUILD_DIGEST = createHash("sha256").update("catalog:no-build", "utf8").digest("hex");

export const CATALOG_CHECK_KINDS = [
  "schema", "unique-ids", "references", "group-members", "required-tools", "skill-size", "build-behaviours", "build-tools", "prompt-budget",
] as const;
export type CatalogCheckKind = (typeof CATALOG_CHECK_KINDS)[number];

export interface CatalogCheckItem {
  readonly itemKind: CatalogItemKind;
  readonly itemId: string;
  readonly body: string;
}

export interface CatalogCheckResult {
  readonly checkKind: CatalogCheckKind;
  readonly status: CatalogCheckStatus;
  /** One finding per line; empty when the check passed. */
  readonly detail: string;
}

type Contents = { readonly [K in CatalogItemContent["kind"]]: ReadonlyMap<string, Extract<CatalogItemContent, { kind: K }>> };

const result = (checkKind: CatalogCheckKind, findings: readonly string[], whenFound: CatalogCheckStatus = "failed"): CatalogCheckResult =>
  ({ checkKind, status: findings.length === 0 ? "passed" : whenFound, detail: findings.join("\n") });

function contentsOf(validations: readonly CatalogItemValidation[]): Contents {
  const maps = { tool: new Map(), connector: new Map(), group: new Map(), skill: new Map(), profile: new Map() };
  for (const validation of validations) if (validation.content) maps[validation.content.kind].set(validation.itemId, validation.content);
  return maps as unknown as Contents;
}

/** Prefixes of the tools contextual connectors discover at runtime: `mcp_<connection>_`. */
function contextualPrefixes(contents: Contents): string[] {
  return [...contents.connector.values()].filter((item) => CONTEXTUAL_CONNECTOR_KINDS.includes(item.body.kind)).map((item) => `mcp_${item.body.connection}_`);
}

function uniqueIds(items: readonly CatalogCheckItem[], prefixes: readonly string[]): string[] {
  const findings: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.itemKind} ${item.itemId}`;
    if (seen.has(key)) findings.push(`${key} is in the release twice`);
    seen.add(key);
    const prefix = item.itemKind === "tool" ? prefixes.find((candidate) => item.itemId.startsWith(candidate)) : undefined;
    if (prefix !== undefined) findings.push(`${key} takes the name space ${prefix} of a contextual connector`);
  }
  return findings;
}

function references(ids: (kind: CatalogItemKind) => ReadonlySet<string>, contents: Contents): string[] {
  const findings: string[] = [];
  for (const [id, { body }] of contents.tool) {
    if (!ids("connector").has(body.connector)) findings.push(`tool ${id}: connector ${body.connector} is not in the release`);
    if (!ids("group").has(body.group)) findings.push(`tool ${id}: group ${body.group} is not in the release`);
  }
  for (const [id, { profile }] of contents.profile) {
    for (const skill of profile.frontmatter.preloadSkills ?? []) {
      if (!ids("skill").has(skill.trim())) findings.push(`profile ${id}: preloaded skill ${skill.trim()} is not in the release`);
    }
  }
  return findings;
}

function groupMembers(contents: Contents): string[] {
  const findings: string[] = [];
  const owner = new Map<string, string>();
  for (const [groupId, { body }] of contents.group) {
    for (const toolId of body.toolIds) {
      const earlier = owner.get(toolId);
      if (earlier !== undefined) findings.push(`tool ${toolId} is in two groups: ${earlier} and ${groupId}`);
      else owner.set(toolId, groupId);
      const tool = contents.tool.get(toolId);
      if (tool && tool.body.group !== groupId) findings.push(`group ${groupId} lists tool ${toolId}, which names group ${tool.body.group}`);
    }
  }
  for (const [toolId, { body }] of contents.tool) {
    const listed = contents.group.get(body.group);
    if (listed && !listed.body.toolIds.includes(toolId)) findings.push(`tool ${toolId} names group ${body.group}, whose toolIds leave it out`);
  }
  return findings;
}

/** A required tool is a release tool, a member of a release group (the build provides it; `build-tools` keeps it pending) or a contextual connector's tool. */
function requiredTools(contents: Contents, prefixes: readonly string[]): string[] {
  const findings: string[] = [];
  const grouped = new Set([...contents.group.values()].flatMap(({ body }) => body.toolIds));
  for (const [id, { skill }] of contents.skill) {
    for (const toolId of skill.requiredTools) {
      if (!contents.tool.has(toolId) && !grouped.has(toolId) && !prefixes.some((prefix) => toolId.startsWith(prefix))) {
        findings.push(`skill ${id}: required tool ${toolId} is not a release tool, a member of a release group, or a tool of a contextual connector in the release`);
      }
    }
  }
  return findings;
}

function skillSizes(contents: Contents): string[] {
  const findings: string[] = [];
  for (const [id, { skill }] of contents.skill) {
    if (skill.fileBytes > MAX_SKILL_FILE_BYTES) findings.push(`skill ${id}: file is ${skill.fileBytes} bytes, over ${MAX_SKILL_FILE_BYTES}`);
    if (skill.loadChars > MAX_SKILL_LOAD_CHARS) findings.push(`skill ${id}: skill_load returns ${skill.loadChars} characters, over ${MAX_SKILL_LOAD_CHARS}`);
  }
  return findings;
}

function buildTools(contents: Contents, prefixes: readonly string[]): string[] {
  const findings: string[] = [];
  for (const [groupId, { body }] of contents.group) {
    for (const toolId of body.toolIds) {
      if (!contents.tool.has(toolId) && !prefixes.some((prefix) => toolId.startsWith(prefix))) findings.push(`group ${groupId}: tool ${toolId} must be provided by the build`);
    }
  }
  return findings;
}

/** Every check of a release's items, in `CATALOG_CHECK_KINDS` order. */
export function runCatalogReleaseChecks(items: readonly CatalogCheckItem[]): CatalogCheckResult[] {
  const validations = items.map((item) => validateCatalogItem(item.itemKind, item.itemId, item.body));
  const contents = contentsOf(validations);
  const prefixes = contextualPrefixes(contents);
  const idSets = new Map<CatalogItemKind, Set<string>>();
  for (const item of items) idSets.set(item.itemKind, (idSets.get(item.itemKind) ?? new Set()).add(item.itemId));
  const ids = (kind: CatalogItemKind): ReadonlySet<string> => idSets.get(kind) ?? new Set();
  const behaviours = [...contents.tool].filter(([, tool]) => tool.body.behaviour !== undefined)
    .map(([id, tool]) => `tool ${id}: behaviour ${tool.body.behaviour} must be registered by the build`);
  return [
    result("schema", validations.flatMap((validation) => validation.violations.map((violation) => describeViolation(validation, violation)))),
    result("unique-ids", uniqueIds(items, prefixes)),
    result("references", references(ids, contents)),
    result("group-members", groupMembers(contents)),
    result("required-tools", requiredTools(contents, prefixes)),
    result("skill-size", skillSizes(contents)),
    result("build-behaviours", behaviours, "pending"),
    result("build-tools", buildTools(contents, prefixes), "pending"),
    { checkKind: "prompt-budget", status: "pending", detail: "the prompt the build assembles from this release must fit its budget" },
  ];
}

/** A release may be pointed at by a channel when no check failed; `pending` checks wait for the build that serves it. */
export function catalogChecksPass(results: readonly Pick<CatalogCheckResult, "status">[]): boolean {
  return results.every((check) => check.status !== "failed");
}
