import { randomUUID } from "node:crypto";
import {
  AgenticError, checkedAdminPrincipalSeed, checkedCatalogAudit, checkedMemberRole, reviewIdentifier, reviewTime, type AdminPrincipal, type AdminPrincipalSeed,
  type AdminPrincipalStore, type CatalogAuditRecord, type MemberRole, type MemberScopeKind,
} from "@0xsyncroot/contracts";
import { freezeDeep } from "./freeze.js";

interface MemberRow extends MemberRole { readonly principalId: string; status: "active" | "disabled" }

const roleKey = (role: MemberRole) => JSON.stringify([role.scopeKind, role.scopeId, role.role]);

/**
 * Operators and their roles in one process. It has no operator writer, so nothing here disables a principal or a role;
 * seeding creates what is missing, renames, and audits each of those with the capacity `seed`.
 */
export class InMemoryAdminPrincipalStore implements AdminPrincipalStore {
  readonly #principals = new Map<string, AdminPrincipal>();
  readonly #members: MemberRow[] = [];
  readonly #audit: CatalogAuditRecord[] = [];

  async ensureSeed(seed: AdminPrincipalSeed, roles: readonly MemberRole[]): Promise<AdminPrincipal> {
    const checked = checkedAdminPrincipalSeed(seed);
    const wanted = [...new Map(roles.map((role) => { const item = checkedMemberRole(role); return [roleKey(item), item] as const; })).values()];
    const holder = [...this.#principals.values()].find((item) => item.issuer === checked.issuer && item.subject === checked.subject);
    if (holder && holder.principalId !== checked.principalId) throw new AgenticError("conflict", "Another principal already holds this issuer and subject");
    const existing = this.#principals.get(checked.principalId);
    if (existing && (existing.issuer !== checked.issuer || existing.subject !== checked.subject)) throw new AgenticError("conflict", "The principal id belongs to another issuer and subject");
    const at = reviewTime(new Date().toISOString(), "at");
    const audit = (action: string, scopeKind: MemberScopeKind, scopeId: string, targetKind: string, detail: unknown) => {
      this.#audit.push(freezeDeep({ scopeKind, scopeId, principalId: checked.principalId, actorScope: "seed", action, targetKind, targetId: checked.principalId, detail: JSON.stringify(detail), at }));
    };
    if (!existing) {
      this.#principals.set(checked.principalId, freezeDeep({ ...checked, status: "active" }));
      audit("principal.create", "platform", "", "principal", { issuer: checked.issuer, subject: checked.subject, displayName: checked.displayName });
    } else if (existing.displayName !== checked.displayName) {
      this.#principals.set(checked.principalId, freezeDeep({ ...existing, displayName: checked.displayName }));
      audit("principal.update", "platform", "", "principal", { displayName: checked.displayName });
    }
    const present = new Set(this.#members.filter((row) => row.principalId === checked.principalId).map(roleKey));
    for (const role of wanted.filter((item) => !present.has(roleKey(item)))) {
      this.#members.push({ ...role, principalId: checked.principalId, status: "active" });
      audit("member.grant", role.scopeKind, role.scopeId, "member", { role: role.role });
    }
    return this.#principals.get(checked.principalId)!;
  }

  async get(principalId: string): Promise<AdminPrincipal | undefined> {
    return this.#principals.get(reviewIdentifier(principalId, "principalId", 36));
  }

  async roles(principalId: string): Promise<readonly MemberRole[]> {
    const id = reviewIdentifier(principalId, "principalId", 36);
    return this.#members.filter((row) => row.principalId === id && row.status === "active")
      .map((row) => freezeDeep({ scopeKind: row.scopeKind, scopeId: row.scopeId, role: row.role }));
  }

  async audit(record: CatalogAuditRecord): Promise<string> {
    this.#audit.push(freezeDeep(checkedCatalogAudit(record)));
    return randomUUID();
  }

  /** Every audit row, oldest first. */
  auditLog(): readonly CatalogAuditRecord[] {
    return [...this.#audit];
  }
}
