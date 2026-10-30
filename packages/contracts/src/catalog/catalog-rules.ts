import { AgenticError } from "../errors/agentic-error.js";
import { reviewCount, reviewHash, reviewIdentifier, reviewOneOf, reviewPageSize } from "../review/rules.js";
import { canonicalJson } from "../shared/json.js";
import {
  CATALOG_CHANNELS, CATALOG_ITEM_KINDS, type CatalogAgentSeed, type CatalogBuild, type CatalogChannelMove, type CatalogChannelName, type CatalogDraftUpdate,
  type CatalogGenerationReport, type CatalogItemKey, type CatalogReleaseCheckInput, type CatalogReleaseInput, type CatalogReleaseItem,
  type CatalogReleaseItemRef, type CatalogReleasePage, type CatalogRevisionInput,
} from "./catalog.js";

/**
 * The input rules every catalog engine applies before it stores anything, so each refuses a caller the same way, as
 * `validation` naming the field. Lengths are those of the stored columns; ids are printable ASCII; revision and release ids
 * are lowercase UUIDs; text holds no unpaired surrogate, so its UTF-8 bytes and therefore its hash are well defined.
 */

function invalid(field: string, rule: string): never { throw new AgenticError("validation", `${field} ${rule}`); }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
/** Characters of four-byte text that fit a MEDIUMTEXT column, rounded down. */
const MEDIUM_TEXT_CHARS = 4_000_000;
/** Characters of four-byte text that fit a TEXT column. */
const TEXT_CHARS = 16_383;

/** The largest page `listReleases` returns. */
export const CATALOG_RELEASE_PAGE_MAX = 100;

const code = (value: unknown, field: string) => reviewIdentifier(value, field, 100);
const principal = (value: unknown, field: string) => reviewIdentifier(value, field, 36);

/** A revision or release id: a lowercase UUID. */
export function catalogUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid(field, "must be a lowercase UUID");
  return value;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length > max || LONE_SURROGATE.test(value)) invalid(field, `must be well-formed text of at most ${max} characters`);
  return value;
}

function version(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(field, "must be null or an integer of at least 0");
  return value;
}

const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

export function checkedCatalogAgentId(agentId: unknown): string { return code(agentId, "agentId"); }

export function checkedCatalogChannel(channel: unknown): CatalogChannelName { return reviewOneOf(channel, "channel", CATALOG_CHANNELS); }

export function checkedCatalogItemKey(key: CatalogItemKey): CatalogItemKey {
  return { agentId: code(key.agentId, "agentId"), itemKind: reviewOneOf(key.itemKind, "itemKind", CATALOG_ITEM_KINDS), itemId: code(key.itemId, "itemId") };
}

export function checkedCatalogAgentSeed(seed: CatalogAgentSeed): CatalogAgentSeed {
  return { agentId: code(seed.agentId, "agentId"), productId: code(seed.productId, "productId"), createdBy: principal(seed.createdBy, "createdBy") };
}

export function checkedCatalogRevision(input: CatalogRevisionInput): CatalogRevisionInput {
  const count = reviewCount(input.requiredToolCount, "requiredToolCount");
  if (count > 65_535) invalid("requiredToolCount", "must be at most 65535");
  return {
    ...checkedCatalogItemKey(input),
    ...optional("parentRevisionId", input.parentRevisionId === undefined ? undefined : catalogUuid(input.parentRevisionId, "parentRevisionId")),
    bodyFormat: reviewOneOf(input.bodyFormat, "bodyFormat", ["markdown", "json"]), schemaVersion: reviewCount(input.schemaVersion, "schemaVersion", 1),
    displayName: text(input.displayName, "displayName", 200), summary: text(input.summary, "summary", 1_000), requiredToolCount: count,
    body: text(input.body, "body", MEDIUM_TEXT_CHARS), authorId: principal(input.authorId, "authorId"),
    authorScope: reviewIdentifier(input.authorScope, "authorScope", 16),
    ...optional("note", input.note === undefined ? undefined : text(input.note, "note", 500)),
  };
}

export function checkedCatalogDraftUpdate(update: CatalogDraftUpdate): Required<Omit<CatalogDraftUpdate, "expectedVersion">> & Pick<CatalogDraftUpdate, "expectedVersion"> {
  return {
    ...checkedCatalogItemKey(update), revisionId: catalogUuid(update.revisionId, "revisionId"),
    status: update.status === undefined ? "active" : reviewOneOf(update.status, "status", ["active", "retired"]),
    expectedVersion: version(update.expectedVersion, "expectedVersion"), updatedBy: principal(update.updatedBy, "updatedBy"),
  };
}

/** The release items as given, each (itemKind, itemId) once and at least one. */
export function checkedCatalogReleaseItems(items: readonly CatalogReleaseItemRef[]): CatalogReleaseItemRef[] {
  if (!Array.isArray(items) || items.length === 0) invalid("items", "must name at least one item, or be \"drafts\"");
  const seen = new Set<string>();
  return items.map((item, index) => {
    const checked = {
      itemKind: reviewOneOf(item.itemKind, `items[${index}].itemKind`, CATALOG_ITEM_KINDS), itemId: code(item.itemId, `items[${index}].itemId`),
      revisionId: catalogUuid(item.revisionId, `items[${index}].revisionId`),
    };
    const key = `${checked.itemKind}\u0000${checked.itemId}`;
    if (seen.has(key)) invalid("items", "must not name an item twice");
    seen.add(key);
    return checked;
  });
}

export function checkedCatalogReleaseInput(input: CatalogReleaseInput): Omit<CatalogReleaseInput, "items"> & { readonly items: CatalogReleaseItemRef[] | "drafts" } {
  return {
    agentId: code(input.agentId, "agentId"), ...optional("releaseId", input.releaseId === undefined ? undefined : catalogUuid(input.releaseId, "releaseId")),
    items: input.items === "drafts" ? "drafts" : checkedCatalogReleaseItems(input.items), createdBy: principal(input.createdBy, "createdBy"),
  };
}

export function checkedCatalogReleasePage(page: CatalogReleasePage): CatalogReleasePage {
  return {
    limit: reviewPageSize(page.limit, "limit", CATALOG_RELEASE_PAGE_MAX),
    ...optional("beforeNo", page.beforeNo === undefined ? undefined : reviewCount(page.beforeNo, "beforeNo", 1)),
  };
}

export function checkedCatalogChannelMove(move: CatalogChannelMove): CatalogChannelMove {
  return {
    agentId: code(move.agentId, "agentId"), channel: checkedCatalogChannel(move.channel), releaseId: catalogUuid(move.releaseId, "releaseId"),
    expectedVersion: version(move.expectedVersion, "expectedVersion"), updatedBy: principal(move.updatedBy, "updatedBy"),
  };
}

export function checkedCatalogReleaseCheck(input: CatalogReleaseCheckInput): CatalogReleaseCheckInput {
  return {
    agentId: code(input.agentId, "agentId"), releaseId: catalogUuid(input.releaseId, "releaseId"), checkKind: reviewIdentifier(input.checkKind, "checkKind", 32),
    buildDigest: reviewHash(input.buildDigest, "buildDigest"), status: reviewOneOf(input.status, "status", ["passed", "failed", "pending"]),
    ...optional("detail", input.detail === undefined ? undefined : text(input.detail, "detail", MEDIUM_TEXT_CHARS)),
    checkedBy: reviewIdentifier(input.checkedBy, "checkedBy", 191),
  };
}

/** The build with its components in stored order, each once. */
export function checkedCatalogBuild(build: CatalogBuild): CatalogBuild {
  const components = new Map<string, { componentKind: string; componentId: string }>();
  if (!Array.isArray(build.components)) invalid("components", "must be a list");
  build.components.forEach((component, index) => {
    const checked = {
      componentKind: reviewIdentifier(component.componentKind, `components[${index}].componentKind`, 32),
      componentId: reviewIdentifier(component.componentId, `components[${index}].componentId`, 191),
    };
    components.set(`${checked.componentKind}\u0000${checked.componentId}`, checked);
  });
  return {
    buildDigest: reviewHash(build.buildDigest, "buildDigest"), buildVersion: reviewIdentifier(build.buildVersion, "buildVersion", 64),
    components: [...components.values()].sort(byKindThenId((item) => [item.componentKind, item.componentId])),
  };
}

export function checkedCatalogGenerationReport(report: CatalogGenerationReport): CatalogGenerationReport {
  return {
    agentId: code(report.agentId, "agentId"), releaseId: catalogUuid(report.releaseId, "releaseId"), podId: reviewIdentifier(report.podId, "podId", 191),
    buildDigest: reviewHash(report.buildDigest, "buildDigest"), status: reviewOneOf(report.status, "status", ["building", "ready", "failed"]),
    ...optional("errorCode", report.errorCode === undefined ? undefined : reviewIdentifier(report.errorCode, "errorCode", 64)),
    ...optional("detail", report.detail === undefined ? undefined : text(report.detail, "detail", TEXT_CHARS)),
  };
}

/** A comparator on two ASCII keys by code unit, the order `ascii_bin` sorts in. */
export function byKindThenId<T>(keys: (item: T) => readonly [string, string]): (left: T, right: T) => number {
  return (left, right) => {
    const [a1, a2] = keys(left); const [b1, b2] = keys(right);
    return a1 < b1 ? -1 : a1 > b1 ? 1 : a2 < b2 ? -1 : a2 > b2 ? 1 : 0;
  };
}

/**
 * The canonical text a release's `manifestHash` is the sha256 hex of: its items' kind, id and body hash in (itemKind, itemId)
 * order. Revision ids are left out, so the same contents imported into another environment hash the same.
 */
export function catalogManifestText(items: readonly Pick<CatalogReleaseItem, "itemKind" | "itemId" | "bodyHash">[]): string {
  const sorted = [...items].sort(byKindThenId((item) => [item.itemKind, item.itemId]));
  return canonicalJson({ manifestFormat: 1, items: sorted.map(({ itemKind, itemId, bodyHash }) => ({ itemKind, itemId, bodyHash })) });
}
