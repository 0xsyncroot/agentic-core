import {
  AgenticError, catalogUuid, checkedCatalogAgentId, checkedCatalogAgentSeed, checkedCatalogDraftUpdate, checkedCatalogItemKey, checkedCatalogRevision,
  type CatalogAgent, type CatalogAgentSeed, type CatalogChannel, type CatalogChannelMove, type CatalogDraftUpdate, type CatalogEditor, type CatalogItem,
  type CatalogItemKey, type CatalogRelease, type CatalogReleaseCheckInput, type CatalogReleaseCheckRecorded, type CatalogReleaseCreated,
  type CatalogReleaseInput, type CatalogReleasePage, type CatalogRevision, type CatalogRevisionInput, type CatalogRevisionSaved,
} from "@0xsyncroot/contracts";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { createRelease, listReleases, moveChannel, recordCheck, revokeRelease } from "./catalog-releases.js";
import {
  isDuplicate, ITEM_COLUMNS, itemFromRow, MySqlCatalogReader, readAgent, REVISION_COLUMNS, revisionFromRow, type CatalogDb,
} from "./catalog-rows.js";
import { sha256 } from "./hash.js";
import { withTransaction } from "./transaction.js";
import { uuid7 } from "./uuid7.js";

const REVISION_KEY = "r.agent_id = ? AND r.item_kind = ? AND r.item_id = ?";

async function readItem(db: CatalogDb, key: CatalogItemKey): Promise<CatalogItem | undefined> {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT ${ITEM_COLUMNS} FROM agentic_catalog_item WHERE agent_id = ? AND item_kind = ? AND item_id = ?`,
    [key.agentId, key.itemKind, key.itemId]);
  return rows[0] ? itemFromRow(rows[0]) : undefined;
}

async function readRevision(db: CatalogDb, key: CatalogItemKey, column: "revision_id" | "body_hash", value: string): Promise<CatalogRevision | undefined> {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT ${REVISION_COLUMNS} FROM agentic_catalog_item_revision r WHERE ${REVISION_KEY} AND r.${column} = ?`,
    [key.agentId, key.itemKind, key.itemId, value]);
  return rows[0] ? revisionFromRow(rows[0]) : undefined;
}

/**
 * The console's catalog over the control plane, opened with the console's account. Rows are inserted or have a granted
 * column updated, never replaced or deleted; a duplicate key from a concurrent writer means the row now exists, and the call
 * answers from it as the earlier writer stored it.
 */
export class MySqlCatalogStore extends MySqlCatalogReader implements CatalogEditor {
  async ensureAgent(seed: CatalogAgentSeed): Promise<{ readonly agent: CatalogAgent; readonly created: boolean }> {
    const checked = checkedCatalogAgentSeed(seed);
    const stored = async () => {
      const agent = (await readAgent(this.pool, checked.agentId))!;
      if (agent.productId !== checked.productId) throw new AgenticError("conflict", "The agent id belongs to another product");
      return { agent, created: false };
    };
    if (await readAgent(this.pool, checked.agentId)) return stored();
    try {
      await this.pool.execute(
        `INSERT INTO agentic_catalog_agent (agent_id, product_id, status, release_counter, taxonomy_version, version, created_by, created_at, updated_at)
         VALUES (?, ?, 'active', 0, 0, 0, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`, [checked.agentId, checked.productId, checked.createdBy]);
    } catch (error) {
      if (isDuplicate(error)) return stored();
      throw error;
    }
    return { agent: (await readAgent(this.pool, checked.agentId))!, created: true };
  }

  /** The body hash is over the body's own characters; a parent is looked up under the same item, so another item's is refused. */
  async putRevision(input: CatalogRevisionInput): Promise<CatalogRevisionSaved> {
    const checked = checkedCatalogRevision(input);
    const bodyHash = sha256(checked.body);
    const same = await readRevision(this.pool, checked, "body_hash", bodyHash);
    if (same) return { revision: same, created: false };
    if (!(await readAgent(this.pool, checked.agentId))) throw new AgenticError("validation", "No such agent");
    if (checked.parentRevisionId !== undefined && !(await readRevision(this.pool, checked, "revision_id", checked.parentRevisionId))) {
      throw new AgenticError("validation", "parentRevisionId must be a revision of the same item");
    }
    const revisionId = uuid7();
    try {
      await this.pool.execute(
        `INSERT INTO agentic_catalog_item_revision (agent_id, item_kind, item_id, revision_id, parent_revision_id, body_format, schema_version,
           display_name, summary, required_tool_count, body, body_hash, author_id, author_scope, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
        [checked.agentId, checked.itemKind, checked.itemId, revisionId, checked.parentRevisionId ?? null, checked.bodyFormat, checked.schemaVersion,
          checked.displayName, checked.summary, checked.requiredToolCount, checked.body, bodyHash, checked.authorId, checked.authorScope, checked.note ?? null]);
    } catch (error) {
      if (isDuplicate(error)) return { revision: (await readRevision(this.pool, checked, "body_hash", bodyHash))!, created: false };
      throw error;
    }
    return { revision: (await readRevision(this.pool, checked, "revision_id", revisionId))!, created: true };
  }

  async getRevision(key: CatalogItemKey, revisionId: string): Promise<CatalogRevision | undefined> {
    return readRevision(this.pool, checkedCatalogItemKey(key), "revision_id", catalogUuid(revisionId, "revisionId"));
  }

  /** Oldest first by the database clock; revisions stamped in the same microsecond follow their UUIDv7 ids. */
  async revisions(key: CatalogItemKey): Promise<readonly CatalogRevision[]> {
    const checked = checkedCatalogItemKey(key);
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT ${REVISION_COLUMNS} FROM agentic_catalog_item_revision r WHERE ${REVISION_KEY} ORDER BY r.created_at, r.revision_id`,
      [checked.agentId, checked.itemKind, checked.itemId]);
    return rows.map(revisionFromRow);
  }

  /** Creates the item or moves its draft by compare-and-set on version, in one transaction with the read-back. */
  async setDraft(update: CatalogDraftUpdate): Promise<CatalogItem> {
    const checked = checkedCatalogDraftUpdate(update);
    if (!(await readRevision(this.pool, checked, "revision_id", checked.revisionId))) throw new AgenticError("validation", "revisionId must be a revision of the item");
    const changed = () => new AgenticError("conflict", "The item changed since it was read");
    return withTransaction(this.pool, async (connection) => {
      if (checked.expectedVersion === null) {
        try {
          await connection.execute(
            `INSERT INTO agentic_catalog_item (agent_id, item_kind, item_id, draft_revision_id, status, version, updated_by, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, UTC_TIMESTAMP(6))`,
            [checked.agentId, checked.itemKind, checked.itemId, checked.revisionId, checked.status, checked.updatedBy]);
        } catch (error) {
          if (isDuplicate(error)) throw changed();
          throw error;
        }
      } else {
        const [moved] = await connection.execute<ResultSetHeader>(
          `UPDATE agentic_catalog_item SET draft_revision_id = ?, status = ?, version = version + 1, updated_by = ?, updated_at = UTC_TIMESTAMP(6)
            WHERE agent_id = ? AND item_kind = ? AND item_id = ? AND version = ?`,
          [checked.revisionId, checked.status, checked.updatedBy, checked.agentId, checked.itemKind, checked.itemId, checked.expectedVersion]);
        if (moved.affectedRows === 0) throw changed();
      }
      return (await readItem(connection, checked))!;
    });
  }

  async getItem(key: CatalogItemKey): Promise<CatalogItem | undefined> { return readItem(this.pool, checkedCatalogItemKey(key)); }

  async listItems(agentId: string): Promise<readonly CatalogItem[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT ${ITEM_COLUMNS} FROM agentic_catalog_item WHERE agent_id = ? ORDER BY item_kind, item_id`,
      [checkedCatalogAgentId(agentId)]);
    return rows.map(itemFromRow);
  }

  async createRelease(input: CatalogReleaseInput): Promise<CatalogReleaseCreated> { return createRelease(this.pool, input); }

  async listReleases(agentId: string, page: CatalogReleasePage): Promise<readonly CatalogRelease[]> { return listReleases(this.pool, agentId, page); }

  async revokeRelease(agentId: string, releaseId: string, revokedBy: string): Promise<CatalogRelease> { return revokeRelease(this.pool, agentId, releaseId, revokedBy); }

  async moveChannel(move: CatalogChannelMove): Promise<CatalogChannel> { return moveChannel(this.pool, move); }

  async recordCheck(input: CatalogReleaseCheckInput): Promise<CatalogReleaseCheckRecorded> { return recordCheck(this.pool, input); }
}
