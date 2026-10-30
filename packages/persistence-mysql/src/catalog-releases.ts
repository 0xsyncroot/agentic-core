import {
  AgenticError, catalogManifestText, catalogUuid, checkedCatalogAgentId, checkedCatalogChannelMove, checkedCatalogReleaseCheck, checkedCatalogReleaseInput,
  checkedCatalogReleasePage, reviewIdentifier, type CatalogChannel, type CatalogChannelMove, type CatalogRelease, type CatalogReleaseCheckInput,
  type CatalogReleaseCheckRecorded, type CatalogReleaseCreated, type CatalogReleaseInput, type CatalogReleaseItem, type CatalogReleaseItemRef,
  type CatalogReleasePage,
} from "@0xsyncroot/contracts";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { isDuplicate, readChannel, readCheck, readRelease, RELEASE_COLUMNS, releaseFromRow, type CatalogDb } from "./catalog-rows.js";
import { sha256 } from "./hash.js";
import { withTransaction } from "./transaction.js";
import { uuid7 } from "./uuid7.js";

/**
 * Releases and channels. Each transaction takes its row lock with its first statement, before any plain read, so the
 * snapshot its reads see begins after the lock was granted: a release number is taken under the agent row's lock, and a
 * channel move and a revocation of the same release lock that release's row, so neither can see the other half done.
 * The console's account may update only the columns these locking statements name.
 */

const affected = (result: ResultSetHeader) => result.affectedRows;

async function resolveItems(db: CatalogDb, agentId: string, refs: readonly CatalogReleaseItemRef[] | "drafts"): Promise<CatalogReleaseItem[]> {
  if (refs === "drafts") {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT i.item_kind, i.item_id, i.draft_revision_id AS revision_id, r.body_hash FROM agentic_catalog_item i
         JOIN agentic_catalog_item_revision r
           ON r.agent_id = i.agent_id AND r.item_kind = i.item_kind AND r.item_id = i.item_id AND r.revision_id = i.draft_revision_id
        WHERE i.agent_id = ? AND i.status = 'active' ORDER BY i.item_kind, i.item_id`, [agentId]);
    if (rows.length === 0) throw new AgenticError("validation", "The agent has no active item to release");
    return rows.map((row) => ({ itemKind: row.item_kind, itemId: row.item_id, revisionId: row.revision_id, bodyHash: row.body_hash }));
  }
  const items: CatalogReleaseItem[] = [];
  for (const ref of refs) {
    const [rows] = await db.execute<RowDataPacket[]>(
      "SELECT body_hash FROM agentic_catalog_item_revision WHERE agent_id = ? AND item_kind = ? AND item_id = ? AND revision_id = ?",
      [agentId, ref.itemKind, ref.itemId, ref.revisionId]);
    if (!rows[0]) throw new AgenticError("validation", `No revision ${ref.revisionId} of ${ref.itemKind} ${ref.itemId}`);
    items.push({ ...ref, bodyHash: rows[0].body_hash });
  }
  return items;
}

const sameRelease = (existing: CatalogRelease, manifestHash: string): CatalogReleaseCreated => {
  if (existing.manifestHash !== manifestHash) throw new AgenticError("conflict", "The release id holds other items");
  return { release: existing, created: false };
};

async function insertRelease(pool: Pool, input: ReturnType<typeof checkedCatalogReleaseInput>): Promise<CatalogReleaseCreated> {
  return withTransaction(pool, async (connection) => {
    const [counted] = await connection.execute<ResultSetHeader>(
      `UPDATE agentic_catalog_agent SET release_counter = release_counter + 1, version = version + 1, updated_at = UTC_TIMESTAMP(6)
        WHERE agent_id = ?`, [input.agentId]);
    if (affected(counted) === 0) throw new AgenticError("validation", "No such agent");
    const items = await resolveItems(connection, input.agentId, input.items);
    const manifestHash = sha256(catalogManifestText(items));
    const [agent] = await connection.execute<RowDataPacket[]>("SELECT release_counter FROM agentic_catalog_agent WHERE agent_id = ?", [input.agentId]);
    const releaseId = input.releaseId ?? uuid7();
    await connection.execute(
      `INSERT INTO agentic_catalog_release (agent_id, release_id, release_no, manifest_hash, status, created_by, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, UTC_TIMESTAMP(6))`, [input.agentId, releaseId, Number(agent[0]!.release_counter), manifestHash, input.createdBy]);
    await connection.query(
      "INSERT INTO agentic_catalog_release_item (agent_id, release_id, item_kind, item_id, revision_id, body_hash) VALUES ?",
      [items.map((item) => [input.agentId, releaseId, item.itemKind, item.itemId, item.revisionId, item.bodyHash])]);
    return { release: (await readRelease(connection, input.agentId, releaseId))!, created: true };
  });
}

/**
 * Creates a release, numbered under the agent row's lock. A given release id that is already stored is answered from its row
 * before any lock is taken, so the counter does not move; a concurrent insert of the same id is a duplicate key, after which
 * one more attempt finds the stored row.
 */
export async function createRelease(pool: Pool, input: CatalogReleaseInput): Promise<CatalogReleaseCreated> {
  const checked = checkedCatalogReleaseInput(input);
  const attempt = async () => {
    const existing = checked.releaseId === undefined ? undefined : await readRelease(pool, checked.agentId, checked.releaseId);
    if (existing) return sameRelease(existing, sha256(catalogManifestText(await resolveItems(pool, checked.agentId, checked.items))));
    return insertRelease(pool, checked);
  };
  try { return await attempt(); } catch (error) {
    if (!isDuplicate(error) || checked.releaseId === undefined) throw error;
    return attempt();
  }
}

export async function listReleases(pool: Pool, agentId: string, page: CatalogReleasePage): Promise<readonly CatalogRelease[]> {
  const id = checkedCatalogAgentId(agentId); const checked = checkedCatalogReleasePage(page);
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT ${RELEASE_COLUMNS} FROM agentic_catalog_release WHERE agent_id = ?${checked.beforeNo === undefined ? "" : " AND release_no < ?"}
      ORDER BY release_no DESC LIMIT ${checked.limit}`, checked.beforeNo === undefined ? [id] : [id, checked.beforeNo]);
  return rows.map(releaseFromRow);
}

/** Revokes under the release row's lock; a channel that still serves the release rolls the revocation back. */
export async function revokeRelease(pool: Pool, agentId: string, releaseId: string, revokedBy: string): Promise<CatalogRelease> {
  const id = checkedCatalogAgentId(agentId); const release = catalogUuid(releaseId, "releaseId"); const by = reviewIdentifier(revokedBy, "revokedBy", 36);
  return withTransaction(pool, async (connection) => {
    const [revoked] = await connection.execute<ResultSetHeader>(
      `UPDATE agentic_catalog_release SET status = 'revoked', revoked_by = ?, revoked_at = UTC_TIMESTAMP(6)
        WHERE agent_id = ? AND release_id = ? AND status = 'active'`, [by, id, release]);
    if (affected(revoked) === 1) {
      const [serving] = await connection.execute<RowDataPacket[]>(
        "SELECT channel FROM agentic_catalog_channel WHERE agent_id = ? AND release_id = ? LIMIT 1", [id, release]);
      if (serving[0]) throw new AgenticError("conflict", "A channel serves this release; move it first");
    }
    const stored = await readRelease(connection, id, release);
    if (!stored) throw new AgenticError("validation", "No such release");
    return stored;
  });
}

/** Moves a channel by compare-and-set, holding the target release's row so it cannot be revoked in between. */
export async function moveChannel(pool: Pool, move: CatalogChannelMove): Promise<CatalogChannel> {
  const checked = checkedCatalogChannelMove(move);
  return withTransaction(pool, async (connection) => {
    await connection.execute("UPDATE agentic_catalog_release SET revoked_at = revoked_at WHERE agent_id = ? AND release_id = ?",
      [checked.agentId, checked.releaseId]);
    const release = await readRelease(connection, checked.agentId, checked.releaseId);
    if (!release) throw new AgenticError("validation", "No such release");
    if (release.status === "revoked") throw new AgenticError("conflict", "A revoked release cannot be served");
    if (checked.expectedVersion === null) {
      try {
        await connection.execute(
          `INSERT INTO agentic_catalog_channel (agent_id, channel, release_id, version, updated_by, updated_at)
           VALUES (?, ?, ?, 0, ?, UTC_TIMESTAMP(6))`, [checked.agentId, checked.channel, checked.releaseId, checked.updatedBy]);
      } catch (error) {
        if (isDuplicate(error)) throw new AgenticError("conflict", "The channel changed since it was read");
        throw error;
      }
    } else {
      const [moved] = await connection.execute<ResultSetHeader>(
        `UPDATE agentic_catalog_channel SET release_id = ?, version = version + 1, updated_by = ?, updated_at = UTC_TIMESTAMP(6)
          WHERE agent_id = ? AND channel = ? AND version = ?`, [checked.releaseId, checked.updatedBy, checked.agentId, checked.channel, checked.expectedVersion]);
      if (affected(moved) === 0) throw new AgenticError("conflict", "The channel changed since it was read");
    }
    return (await readChannel(connection, checked.agentId, checked.channel))!;
  });
}

/** Inserts the check's first result; a stored one, or a concurrent insert's, is returned with `created: false`. */
export async function recordCheck(pool: Pool, input: CatalogReleaseCheckInput): Promise<CatalogReleaseCheckRecorded> {
  const checked = checkedCatalogReleaseCheck(input);
  const stored = () => readCheck(pool, checked.agentId, checked.releaseId, checked.checkKind, checked.buildDigest);
  if (!(await readRelease(pool, checked.agentId, checked.releaseId))) throw new AgenticError("validation", "No such release");
  const existing = await stored();
  if (existing) return { check: existing, created: false };
  try {
    await pool.execute(
      `INSERT INTO agentic_catalog_release_check (agent_id, release_id, check_kind, build_digest, status, detail, checked_by, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
      [checked.agentId, checked.releaseId, checked.checkKind, checked.buildDigest, checked.status, checked.detail ?? null, checked.checkedBy]);
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    return { check: (await stored())!, created: false };
  }
  return { check: (await stored())!, created: true };
}
