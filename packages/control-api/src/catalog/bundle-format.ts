import { AgenticError, CATALOG_BUNDLE_SCHEMA, CATALOG_SCHEMA_VERSION, catalogBodyFormat, type CatalogBundle, type CatalogReleaseItem } from "@0xsyncroot/contracts";
import { catalogBodyHash, catalogManifestHash } from "./canonical.js";
import { assertSupportedSchema, validateSchema, type JsonSchema } from "./json-schema.js";

/** The published bundle schema, refused at load when it uses a keyword this validator does not read. */
const BUNDLE_SCHEMA = assertSupportedSchema(CATALOG_BUNDLE_SCHEMA as JsonSchema);

function refuse(field: string, rule: string): never { throw new AgenticError("validation", `${field} ${rule}`); }

const keyOf = (item: { readonly itemKind: string; readonly itemId: string }): string => `${item.itemKind} ${item.itemId}`;

/**
 * Reads a bundle and proves it whole: the schema, each item once, one revision per manifest entry and no other, each body's
 * format and schema version, each body's hash, and the manifest hash. Any mismatch refuses the bundle as `validation`
 * naming the field, before anything is written.
 */
export function readCatalogBundle(value: unknown): CatalogBundle {
  const violation = validateSchema(BUNDLE_SCHEMA, value)[0];
  if (violation) refuse(violation.path === "" ? "bundle" : violation.path, violation.message);
  const bundle = value as CatalogBundle;
  const entries = new Map<string, { readonly entry: CatalogReleaseItem; readonly index: number }>();
  bundle.manifest.forEach((entry, index) => {
    if (entries.has(keyOf(entry))) refuse(`manifest[${index}]`, `names ${keyOf(entry)} twice`);
    entries.set(keyOf(entry), { entry, index });
  });
  const covered = new Set<string>();
  bundle.revisions.forEach((revision, index) => {
    const at = `revisions[${index}]`;
    const listed = entries.get(keyOf(revision));
    if (!listed || listed.entry.revisionId !== revision.revisionId) refuse(at, `is not the manifest's revision of ${keyOf(revision)}`);
    if (covered.has(keyOf(revision))) refuse(at, `repeats ${keyOf(revision)}`);
    covered.add(keyOf(revision));
    if (revision.bodyFormat !== catalogBodyFormat(revision.itemKind)) refuse(`${at}.bodyFormat`, `must be ${catalogBodyFormat(revision.itemKind)} for a ${revision.itemKind}`);
    if (revision.schemaVersion !== CATALOG_SCHEMA_VERSION) refuse(`${at}.schemaVersion`, `must be ${CATALOG_SCHEMA_VERSION}, the version this console reads`);
    if (catalogBodyHash(revision.body) !== listed.entry.bodyHash) refuse(`${at}.body`, `does not hash to manifest[${listed.index}].bodyHash`);
  });
  for (const [key, { index }] of entries) if (!covered.has(key)) refuse(`manifest[${index}]`, `has no revision for ${key}`);
  if (catalogManifestHash(bundle.manifest) !== bundle.manifestHash) refuse("manifestHash", "does not match the manifest");
  return bundle;
}

/** A bundle as file text: indented JSON with a final line end, so two exports of one release differ only in their source. */
export function catalogBundleText(bundle: CatalogBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** Parses a bundle file's text; text that is not JSON is refused as `validation`. */
export function parseCatalogBundle(text: string): CatalogBundle {
  let value: unknown;
  try { value = JSON.parse(text); } catch { refuse("bundle", "is not valid JSON"); }
  return readCatalogBundle(value);
}
