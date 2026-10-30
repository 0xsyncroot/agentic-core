import type { CatalogReader } from "@0xsyncroot/contracts";
import { createMySqlControlPlane, type MySqlPersistenceEvent } from "@0xsyncroot/persistence-mysql";

/** The catalog a deployment routes releases from, over its own pool. */
export interface CatalogReaderConnection {
  readonly reader: CatalogReader;
  close(): Promise<void>;
}

export interface CatalogReaderOptions {
  /** Connections the pool may open; the MySQL adapter's default when unset. */
  readonly poolSize?: number;
  readonly log?: (event: MySqlPersistenceEvent) => void;
}

/**
 * Where the catalog lives: the control-plane schema at `CATALOG_DATABASE_URL`, else `DATABASE_URL`, the database the
 * migration CLI applies that schema to. Releases are kept by the MySQL catalog store only, so any other URL fails here.
 */
export function catalogDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env.CATALOG_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (!url) throw new Error("Catalog routing reads releases from MySQL: set CATALOG_DATABASE_URL or DATABASE_URL");
  if (new URL(url).protocol !== "mysql:") throw new Error("Catalog routing reads releases from MySQL: the catalog database URL must use mysql://");
  return url;
}

/** Opens the catalog reader at the catalog database URL; the agent only reads it, the admin API writes it. */
export async function openCatalogReader(env: NodeJS.ProcessEnv, options: CatalogReaderOptions = {}): Promise<CatalogReaderConnection> {
  const controlPlane = await createMySqlControlPlane(catalogDatabaseUrl(env), options);
  return Object.freeze({ reader: controlPlane.catalog, close: () => controlPlane.close() });
}
