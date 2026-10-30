import { canonicalJson, type JsonValue } from "../shared/json.js";
import { CATALOG_ITEM_KINDS, type CatalogBodyFormat, type CatalogItemKind, type CatalogReleaseItem } from "./catalog.js";

/**
 * A release bundle: one release's manifest and the bodies of the revisions it holds, carried between environments as one JSON
 * file. `manifestHash` is the release's manifest hash (sha256 hex of `catalogManifestText` over `manifest`), and each
 * `bodyHash` is the sha256 hex of its body's UTF-8 bytes; the writer and the reader compute both. Revision ids are those of
 * the writing environment; an importer keeps each body, not its revision id, and keeps the release id.
 */

export const CATALOG_BUNDLE_FORMAT = 1;

/** The body schema version this platform writes and reads, for every item kind. */
export const CATALOG_SCHEMA_VERSION = 1;

/** Skills and profiles are Markdown files; the other kinds are JSON objects. */
export function catalogBodyFormat(kind: CatalogItemKind): CatalogBodyFormat {
  return kind === "skill" || kind === "profile" ? "markdown" : "json";
}

/**
 * The one text form each body is stored, hashed and exported in, so the same content gives the same `bodyHash` wherever it
 * is written. A JSON body is `canonicalJson` of its object (sorted keys, no whitespace); a Markdown body is the file's text
 * with CRLF line ends turned into LF and nothing else changed.
 */
export function canonicalBody(kind: CatalogItemKind, body: unknown): string {
  if (catalogBodyFormat(kind) === "markdown") {
    if (typeof body !== "string") throw new TypeError(`a ${kind} body is Markdown text`);
    return body.replaceAll("\r\n", "\n");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new TypeError(`a ${kind} body is a JSON object`);
  return canonicalJson(body);
}

export interface CatalogBundleSource {
  /** The writing environment's name. */
  readonly environment: string;
  readonly exportedBy: string;
  readonly exportedAt: string;
}

export interface CatalogBundleRevision {
  readonly itemKind: CatalogItemKind;
  readonly itemId: string;
  readonly revisionId: string;
  readonly bodyFormat: CatalogBodyFormat;
  readonly schemaVersion: number;
  readonly body: string;
}

export interface CatalogBundle {
  readonly bundleFormat: typeof CATALOG_BUNDLE_FORMAT;
  readonly agentId: string;
  readonly productId: string;
  readonly releaseId: string;
  readonly source: CatalogBundleSource;
  /** One entry per item, each with exactly one revision in `revisions`. */
  readonly manifest: readonly CatalogReleaseItem[];
  readonly revisions: readonly CatalogBundleRevision[];
  readonly manifestHash: string;
}

const HASH = { type: "string", pattern: "^[0-9a-f]{64}$" };
const UUID = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" };
const CODE = { type: "string", pattern: "^[\\x21-\\x7e]{1,100}$" };
const KIND = { enum: [...CATALOG_ITEM_KINDS] };
const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });

/** The published JSON Schema (draft 2020-12) of bundle format 1. */
export const CATALOG_BUNDLE_SCHEMA: { readonly [key: string]: JsonValue } = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $id: `catalog/bundle/${CATALOG_BUNDLE_FORMAT}`, title: "catalog release bundle",
  type: "object", additionalProperties: false,
  required: ["bundleFormat", "agentId", "productId", "releaseId", "source", "manifest", "revisions", "manifestHash"],
  properties: {
    bundleFormat: { const: CATALOG_BUNDLE_FORMAT }, agentId: CODE, productId: CODE, releaseId: UUID,
    source: {
      type: "object", additionalProperties: false, required: ["environment", "exportedBy", "exportedAt"],
      properties: { environment: text(100), exportedBy: text(191), exportedAt: text(40) },
    },
    manifest: {
      type: "array", minItems: 1,
      items: { type: "object", additionalProperties: false, required: ["itemKind", "itemId", "revisionId", "bodyHash"], properties: { itemKind: KIND, itemId: CODE, revisionId: UUID, bodyHash: HASH } },
    },
    revisions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["itemKind", "itemId", "revisionId", "bodyFormat", "schemaVersion", "body"],
        properties: { itemKind: KIND, itemId: CODE, revisionId: UUID, bodyFormat: { enum: ["markdown", "json"] }, schemaVersion: { type: "integer", minimum: 1 }, body: { type: "string" } },
      },
    },
    manifestHash: HASH,
  },
};
