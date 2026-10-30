import {
  AgenticError, checkedAdminPrincipalSeed, checkedCatalogAudit, checkedMemberRole, reviewIdentifier, type AdminPrincipal, type AdminPrincipalSeed,
  type AdminPrincipalStore, type CatalogAuditRecord, type MemberRole,
} from "@0xsyncroot/contracts";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { mysqlTime } from "./mysql-time.js";
import { withTransaction } from "./transaction.js";
import { uuid7 } from "./uuid7.js";

const ER_DUP_ENTRY = 1062;
const PRINCIPAL_COLUMNS = "principal_id, issuer, subject, display_name, status";

interface PrincipalRow extends RowDataPacket { principal_id: string; issuer: string; subject: string; display_name: string; status: AdminPrincipal["status"] }
interface MemberRow extends RowDataPacket { scope_kind: MemberRole["scopeKind"]; scope_id: string; role: string; status: string }

const principalFromRow = (row: PrincipalRow): AdminPrincipal => ({
  principalId: row.principal_id, issuer: row.issuer, subject: row.subject, displayName: row.display_name, status: row.status,
});
const roleKey = (role: MemberRole) => JSON.stringify([role.scopeKind, role.scopeId, role.role]);

/** One seeding row of the audit: attributed to the seeded principal, in the capacity `seed`, stamped by the database clock. */
async function auditSeed(connection: PoolConnection, principalId: string, action: string, scope: Pick<MemberRole, "scopeKind" | "scopeId">, targetKind: string, detail: unknown): Promise<void> {
  await connection.execute(
    `INSERT INTO agentic_catalog_audit (scope_kind, scope_id, audit_id, principal_id, actor_scope, action, target_kind, target_id, detail, at)
     VALUES (?, ?, ?, ?, 'seed', ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
    [scope.scopeKind, scope.scopeId, uuid7(), principalId, action, targetKind, principalId, JSON.stringify(detail)]);
}

/**
 * Operators and their roles in the control plane. Removing a principal or a role is a status change made by an operator, so
 * seeding never revives what an operator disabled. Seeding reads, then inserts what is missing; a concurrent seeder's
 * duplicate key means the row now exists, so the seeding runs once more from the start and finds it.
 */
export class MySqlAdminPrincipalStore implements AdminPrincipalStore {
  constructor(private readonly pool: Pool) {}

  async ensureSeed(seed: AdminPrincipalSeed, roles: readonly MemberRole[]): Promise<AdminPrincipal> {
    const checked = checkedAdminPrincipalSeed(seed);
    const wanted = [...new Map(roles.map((role) => { const item = checkedMemberRole(role); return [roleKey(item), item] as const; })).values()];
    try {
      return await withTransaction(this.pool, (connection) => this.#seed(connection, checked, wanted));
    } catch (error) {
      if ((error as { errno?: unknown }).errno !== ER_DUP_ENTRY) throw error;
      return withTransaction(this.pool, (connection) => this.#seed(connection, checked, wanted));
    }
  }

  async get(principalId: string): Promise<AdminPrincipal | undefined> {
    const [rows] = await this.pool.execute<PrincipalRow[]>(`SELECT ${PRINCIPAL_COLUMNS} FROM agentic_platform_principal WHERE principal_id = ?`,
      [reviewIdentifier(principalId, "principalId", 36)]);
    return rows[0] ? principalFromRow(rows[0]) : undefined;
  }

  async roles(principalId: string): Promise<readonly MemberRole[]> {
    const [rows] = await this.pool.execute<MemberRow[]>(
      "SELECT scope_kind, scope_id, role, status FROM agentic_catalog_member WHERE principal_id = ? AND status = 'active' ORDER BY scope_kind, scope_id, role",
      [reviewIdentifier(principalId, "principalId", 36)]);
    return rows.map((row) => ({ scopeKind: row.scope_kind, scopeId: row.scope_id, role: row.role }));
  }

  async audit(record: CatalogAuditRecord): Promise<string> {
    const checked = checkedCatalogAudit(record);
    const auditId = uuid7();
    await this.pool.execute(
      `INSERT INTO agentic_catalog_audit (scope_kind, scope_id, audit_id, principal_id, actor_scope, action, target_kind, target_id,
         before_hash, after_hash, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [checked.scopeKind, checked.scopeId, auditId, checked.principalId, checked.actorScope, checked.action, checked.targetKind, checked.targetId,
        checked.beforeHash ?? null, checked.afterHash ?? null, checked.detail ?? null, mysqlTime(checked.at, "at")]);
    return auditId;
  }

  async #seed(connection: PoolConnection, seed: AdminPrincipalSeed, wanted: readonly MemberRole[]): Promise<AdminPrincipal> {
    const [byIdentity] = await connection.execute<PrincipalRow[]>(
      `SELECT ${PRINCIPAL_COLUMNS} FROM agentic_platform_principal WHERE issuer = ? AND subject = ?`, [seed.issuer, seed.subject]);
    if (byIdentity[0] && byIdentity[0].principal_id !== seed.principalId) throw new AgenticError("conflict", "Another principal already holds this issuer and subject");
    const [byId] = await connection.execute<PrincipalRow[]>(`SELECT ${PRINCIPAL_COLUMNS} FROM agentic_platform_principal WHERE principal_id = ?`, [seed.principalId]);
    const existing = byId[0];
    if (existing && (existing.issuer !== seed.issuer || existing.subject !== seed.subject)) throw new AgenticError("conflict", "The principal id belongs to another issuer and subject");
    const platform = { scopeKind: "platform", scopeId: "" } as const;
    if (!existing) {
      await connection.execute(
        `INSERT INTO agentic_platform_principal (principal_id, issuer, subject, display_name, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 0, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`, [seed.principalId, seed.issuer, seed.subject, seed.displayName]);
      await auditSeed(connection, seed.principalId, "principal.create", platform, "principal", { issuer: seed.issuer, subject: seed.subject, displayName: seed.displayName });
    } else if (existing.display_name !== seed.displayName) {
      await connection.execute("UPDATE agentic_platform_principal SET display_name = ?, version = version + 1, updated_at = UTC_TIMESTAMP(6) WHERE principal_id = ?",
        [seed.displayName, seed.principalId]);
      await auditSeed(connection, seed.principalId, "principal.update", platform, "principal", { displayName: seed.displayName });
    }
    const [members] = await connection.execute<MemberRow[]>("SELECT scope_kind, scope_id, role, status FROM agentic_catalog_member WHERE principal_id = ?", [seed.principalId]);
    const present = new Set(members.map((row) => roleKey({ scopeKind: row.scope_kind, scopeId: row.scope_id, role: row.role })));
    for (const role of wanted.filter((item) => !present.has(roleKey(item)))) {
      await connection.execute(
        `INSERT INTO agentic_catalog_member (scope_kind, scope_id, principal_id, role, status, version, granted_by, updated_at)
         VALUES (?, ?, ?, ?, 'active', 0, ?, UTC_TIMESTAMP(6))`, [role.scopeKind, role.scopeId, seed.principalId, role.role, seed.principalId]);
      await auditSeed(connection, seed.principalId, "member.grant", role, "member", { role: role.role });
    }
    const [after] = await connection.execute<PrincipalRow[]>(`SELECT ${PRINCIPAL_COLUMNS} FROM agentic_platform_principal WHERE principal_id = ?`, [seed.principalId]);
    return principalFromRow(after[0]!);
  }
}
