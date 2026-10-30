import { createHash } from "node:crypto";
import { catalogManifestText, type CatalogReleaseItem } from "@0xsyncroot/contracts";

/** sha256 hex of the UTF-8 bytes of a canonical body: the store's `bodyHash`. */
export function catalogBodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** sha256 hex of `catalogManifestText`: the store's `manifestHash` for a release holding these items. */
export function catalogManifestHash(items: readonly Pick<CatalogReleaseItem, "itemKind" | "itemId" | "bodyHash">[]): string {
  return createHash("sha256").update(catalogManifestText(items), "utf8").digest("hex");
}
