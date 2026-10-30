import {
  catalogUuid, checkedCatalogAgentId, checkedCatalogChannel, reviewHash, type CatalogAgent, type CatalogBuild, type CatalogChannel, type CatalogChannelName,
  type CatalogGenerationStatus, type CatalogItem, type CatalogReader, type CatalogRelease, type CatalogReleaseCheck, type CatalogReleaseContent,
  type CatalogRevision,
} from "@0xsyncroot/contracts";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { isoColumn } from "./mysql-time.js";

/** What a catalog statement runs on: the pool for a single read, the transaction's connection inside one. */
export type CatalogDb = Pick<Pool | PoolConnection, "execute">;

export const ER_DUP_ENTRY = 1062;
export const isDuplicate = (error: unknown) => (error as { errno?: unknown } | undefined)?.errno === ER_DUP_ENTRY;

export const AGENT_COLUMNS = `agent_id, product_id, status, release_counter, taxonomy_version, version, created_by,
  ${isoColumn("created_at")} AS created_at, ${isoColumn("updated_at")} AS updated_at`;
export const REVISION_COLUMNS = `r.agent_id, r.item_kind, r.item_id, r.revision_id, r.parent_revision_id, r.body_format, r.schema_version, r.display_name,
  r.summary, r.required_tool_count, r.body, r.body_hash, r.author_id, r.author_scope, r.note, ${isoColumn("r.created_at")} AS created_at`;
export const ITEM_COLUMNS = `agent_id, item_kind, item_id, draft_revision_id, status, version, updated_by, ${isoColumn("updated_at")} AS updated_at`;
export const RELEASE_COLUMNS = `agent_id, release_id, release_no, manifest_hash, status, revoked_by, ${isoColumn("revoked_at")} AS revoked_at, created_by,
  ${isoColumn("created_at")} AS created_at`;
const CHANNEL_COLUMNS = `agent_id, channel, release_id, version, updated_by, ${isoColumn("updated_at")} AS updated_at`;
const CHECK_COLUMNS = `agent_id, release_id, check_kind, build_digest, status, detail, checked_by, ${isoColumn("checked_at")} AS checked_at`;
const GENERATION_COLUMNS = `agent_id, release_id, pod_id, build_digest, status, error_code, detail, ${isoColumn("updated_at")} AS updated_at`;

/** A nullable column read as an absent field, the way the ports return optional values. */
const optional = <K extends string>(key: K, value: unknown): { [P in K]?: string } => (value === null || value === undefined ? {} : { [key]: String(value) }) as { [P in K]?: string };

export const agentFromRow = (row: RowDataPacket): CatalogAgent => ({
  agentId: row.agent_id, productId: row.product_id, createdBy: row.created_by, status: row.status, releaseCounter: Number(row.release_counter),
  taxonomyVersion: Number(row.taxonomy_version), version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at,
});

export const revisionFromRow = (row: RowDataPacket): CatalogRevision => ({
  agentId: row.agent_id, itemKind: row.item_kind, itemId: row.item_id, ...optional("parentRevisionId", row.parent_revision_id), bodyFormat: row.body_format,
  schemaVersion: Number(row.schema_version), displayName: row.display_name, summary: row.summary, requiredToolCount: Number(row.required_tool_count),
  body: row.body, authorId: row.author_id, authorScope: row.author_scope, ...optional("note", row.note), revisionId: row.revision_id, bodyHash: row.body_hash,
  createdAt: row.created_at,
});

export const itemFromRow = (row: RowDataPacket): CatalogItem => ({
  agentId: row.agent_id, itemKind: row.item_kind, itemId: row.item_id, draftRevisionId: row.draft_revision_id, status: row.status,
  version: Number(row.version), updatedBy: row.updated_by, updatedAt: row.updated_at,
});

export const releaseFromRow = (row: RowDataPacket): CatalogRelease => ({
  agentId: row.agent_id, releaseId: row.release_id, releaseNo: Number(row.release_no), manifestHash: row.manifest_hash, status: row.status,
  ...optional("revokedBy", row.revoked_by), ...optional("revokedAt", row.revoked_at), createdBy: row.created_by, createdAt: row.created_at,
});

export const channelFromRow = (row: RowDataPacket): CatalogChannel => ({
  agentId: row.agent_id, channel: row.channel, releaseId: row.release_id, version: Number(row.version), updatedBy: row.updated_by, updatedAt: row.updated_at,
});

export const checkFromRow = (row: RowDataPacket): CatalogReleaseCheck => ({
  agentId: row.agent_id, releaseId: row.release_id, checkKind: row.check_kind, buildDigest: row.build_digest, status: row.status,
  ...optional("detail", row.detail), checkedBy: row.checked_by, checkedAt: row.checked_at,
});

export const generationFromRow = (row: RowDataPacket): CatalogGenerationStatus => ({
  agentId: row.agent_id, releaseId: row.release_id, podId: row.pod_id, buildDigest: row.build_digest, status: row.status,
  ...optional("errorCode", row.error_code), ...optional("detail", row.detail), updatedAt: row.updated_at,
});

export async function readAgent(db: CatalogDb, agentId: string): Promise<CatalogAgent | undefined> {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT ${AGENT_COLUMNS} FROM agentic_catalog_agent WHERE agent_id = ?`, [agentId]);
  return rows[0] ? agentFromRow(rows[0]) : undefined;
}

export async function readRelease(db: CatalogDb, agentId: string, releaseId: string): Promise<CatalogRelease | undefined> {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT ${RELEASE_COLUMNS} FROM agentic_catalog_release WHERE agent_id = ? AND release_id = ?`,
    [agentId, releaseId]);
  return rows[0] ? releaseFromRow(rows[0]) : undefined;
}

export async function readChannel(db: CatalogDb, agentId: string, channel: string): Promise<CatalogChannel | undefined> {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT ${CHANNEL_COLUMNS} FROM agentic_catalog_channel WHERE agent_id = ? AND channel = ?`, [agentId, channel]);
  return rows[0] ? channelFromRow(rows[0]) : undefined;
}

export async function readGeneration(db: CatalogDb, agentId: string, releaseId: string, podId: string): Promise<CatalogGenerationStatus | undefined> {
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT ${GENERATION_COLUMNS} FROM agentic_generation_status WHERE agent_id = ? AND release_id = ? AND pod_id = ?`, [agentId, releaseId, podId]);
  return rows[0] ? generationFromRow(rows[0]) : undefined;
}

export async function readCheck(db: CatalogDb, agentId: string, releaseId: string, checkKind: string, buildDigest: string): Promise<CatalogReleaseCheck | undefined> {
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT ${CHECK_COLUMNS} FROM agentic_catalog_release_check WHERE agent_id = ? AND release_id = ? AND check_kind = ? AND build_digest = ?`,
    [agentId, releaseId, checkKind, buildDigest]);
  return rows[0] ? checkFromRow(rows[0]) : undefined;
}

/**
 * What a runtime reads, over one pool. Every statement reads only the tables the agent's account may select, so the same
 * class serves the console's account and the agent's; the draft table is not among them.
 */
export class MySqlCatalogReader implements CatalogReader {
  constructor(protected readonly pool: Pool) {}

  async getAgent(agentId: string): Promise<CatalogAgent | undefined> { return readAgent(this.pool, checkedCatalogAgentId(agentId)); }

  async getRelease(agentId: string, releaseId: string): Promise<CatalogRelease | undefined> {
    return readRelease(this.pool, checkedCatalogAgentId(agentId), catalogUuid(releaseId, "releaseId"));
  }

  /** Two reads without a transaction: a release and its items are insert-only, so the second read cannot disagree with the first. */
  async releaseContent(agentId: string, releaseId: string): Promise<CatalogReleaseContent | undefined> {
    const release = await this.getRelease(agentId, releaseId);
    if (!release) return undefined;
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT ${REVISION_COLUMNS} FROM agentic_catalog_release_item i
         JOIN agentic_catalog_item_revision r
           ON r.agent_id = i.agent_id AND r.item_kind = i.item_kind AND r.item_id = i.item_id AND r.revision_id = i.revision_id
        WHERE i.agent_id = ? AND i.release_id = ? ORDER BY i.item_kind, i.item_id`, [release.agentId, release.releaseId]);
    return { release, items: rows.map(revisionFromRow) };
  }

  async getChannel(agentId: string, channel: CatalogChannelName): Promise<CatalogChannel | undefined> {
    return readChannel(this.pool, checkedCatalogAgentId(agentId), checkedCatalogChannel(channel));
  }

  async channels(agentId: string): Promise<readonly CatalogChannel[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT ${CHANNEL_COLUMNS} FROM agentic_catalog_channel WHERE agent_id = ? ORDER BY channel`,
      [checkedCatalogAgentId(agentId)]);
    return rows.map(channelFromRow);
  }

  async checks(agentId: string, releaseId: string): Promise<readonly CatalogReleaseCheck[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT ${CHECK_COLUMNS} FROM agentic_catalog_release_check WHERE agent_id = ? AND release_id = ? ORDER BY check_kind, build_digest`,
      [checkedCatalogAgentId(agentId), catalogUuid(releaseId, "releaseId")]);
    return rows.map(checkFromRow);
  }

  async build(buildDigest: string): Promise<CatalogBuild | undefined> {
    const digest = reviewHash(buildDigest, "buildDigest");
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT component_kind, component_id, build_version FROM agentic_catalog_build WHERE build_digest = ? ORDER BY component_kind, component_id", [digest]);
    if (rows.length === 0) return undefined;
    return { buildDigest: digest, buildVersion: rows[0]!.build_version, components: rows.map((row) => ({ componentKind: row.component_kind, componentId: row.component_id })) };
  }

  async generations(agentId: string, releaseId: string): Promise<readonly CatalogGenerationStatus[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT ${GENERATION_COLUMNS} FROM agentic_generation_status WHERE agent_id = ? AND release_id = ? ORDER BY pod_id`,
      [checkedCatalogAgentId(agentId), catalogUuid(releaseId, "releaseId")]);
    return rows.map(generationFromRow);
  }
}
