import {
  AgenticError, checkedCatalogBuild, checkedCatalogGenerationReport, type CatalogBuild, type CatalogBuildRegistry, type CatalogGenerationReport,
  type CatalogGenerationStatus,
} from "@0xsyncroot/contracts";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { isDuplicate, readGeneration, readRelease } from "./catalog-rows.js";
import { withTransaction } from "./transaction.js";

/**
 * What a running service writes about itself, opened with the account that holds INSERT on the build table and INSERT and
 * UPDATE on the generation table. A build's stored components never change: registering adds the missing ones, and a digest
 * stored under another build version is a `conflict`, since the digest names one build.
 */
export class MySqlCatalogBuildRegistry implements CatalogBuildRegistry {
  constructor(private readonly pool: Pool) {}

  async registerBuild(build: CatalogBuild): Promise<number> {
    const checked = checkedCatalogBuild(build);
    const attempt = () => withTransaction(this.pool, async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        "SELECT component_kind, component_id, build_version FROM agentic_catalog_build WHERE build_digest = ?", [checked.buildDigest]);
      if (rows.some((row) => row.build_version !== checked.buildVersion)) {
        throw new AgenticError("conflict", "The build digest is registered under another build version");
      }
      const stored = new Set(rows.map((row) => `${row.component_kind}\u0000${row.component_id}`));
      const missing = checked.components.filter((item) => !stored.has(`${item.componentKind}\u0000${item.componentId}`));
      if (missing.length === 0) return 0;
      await connection.execute(
        `INSERT INTO agentic_catalog_build (build_digest, component_kind, component_id, build_version, registered_at)
         VALUES ${missing.map(() => "(?, ?, ?, ?, UTC_TIMESTAMP(6))").join(", ")}`,
        missing.flatMap((item) => [checked.buildDigest, item.componentKind, item.componentId, checked.buildVersion]));
      return missing.length;
    });
    try { return await attempt(); } catch (error) {
      if (!isDuplicate(error)) throw error;
      return attempt();
    }
  }

  /** Replaces the pod's row for the release; the release must exist. */
  async reportGeneration(report: CatalogGenerationReport): Promise<CatalogGenerationStatus> {
    const checked = checkedCatalogGenerationReport(report);
    if (!(await readRelease(this.pool, checked.agentId, checked.releaseId))) throw new AgenticError("validation", "No such release");
    await this.pool.execute(
      `INSERT INTO agentic_generation_status (agent_id, release_id, pod_id, build_digest, status, error_code, detail, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6)) AS incoming
       ON DUPLICATE KEY UPDATE build_digest = incoming.build_digest, status = incoming.status, error_code = incoming.error_code,
         detail = incoming.detail, updated_at = incoming.updated_at`,
      [checked.agentId, checked.releaseId, checked.podId, checked.buildDigest, checked.status, checked.errorCode ?? null, checked.detail ?? null]);
    return (await readGeneration(this.pool, checked.agentId, checked.releaseId, checked.podId))!;
  }
}
