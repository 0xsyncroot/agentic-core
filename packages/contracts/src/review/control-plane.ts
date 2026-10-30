/**
 * Control-plane ports: operator identity, the audit of what operators did, shard routing, and the leases that keep one
 * background worker per shard. Control-plane rows are shared by every tenant and live outside the shards; worker leases
 * live in the shard their worker serves.
 */

/** A lease held by one worker process. `fencingToken` is opaque and only ever grows; never coerce it to a number. */
export interface WorkerLease {
  readonly workerKind: string;
  readonly owner: string;
  readonly fencingToken: string;
  readonly expiresAt: string;
}

/** At most one holder per `workerKind`. Expiry is judged by the database clock, not the caller's. */
export interface WorkerLeaseStore {
  /** Takes the lease when it is free, expired or already the caller's; each acquisition gets a larger token. */
  acquire(workerKind: string, owner: string, ttlMs: number): Promise<WorkerLease | undefined>;
  /** Extends a lease still held under the same token; `undefined` when it was lost. */
  renew(lease: WorkerLease, ttlMs: number): Promise<WorkerLease | undefined>;
  /** Frees a lease still held under the same token; a lost lease is left as it is. */
  release(lease: WorkerLease): Promise<void>;
}

export type AdminPrincipalStatus = "active" | "disabled";

/** An operator, identified by the issuer that vouches for them and their subject there. */
export interface AdminPrincipal {
  readonly principalId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly displayName: string;
  readonly status: AdminPrincipalStatus;
}

/** `platform` scopes have the empty scope id; `agent` scopes name the agent. */
export type MemberScopeKind = "platform" | "agent";

/** One role granted in one scope. The role names and what they allow are enumerated by the console's code, not stored. */
export interface MemberRole {
  readonly scopeKind: MemberScopeKind;
  readonly scopeId: string;
  readonly role: string;
}

/** One row of the control-plane audit. Hashes are sha256 hex of the target before and after, when it changed. */
export interface CatalogAuditRecord {
  readonly scopeKind: MemberScopeKind;
  readonly scopeId: string;
  readonly principalId: string;
  /** Who acted in which capacity, for example a principal through the console or the seeding at boot. */
  readonly actorScope: string;
  readonly action: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly beforeHash?: string;
  readonly afterHash?: string;
  readonly detail?: string;
  readonly at: string;
}

export interface AdminPrincipalSeed {
  readonly principalId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly displayName: string;
}

export interface AdminPrincipalStore {
  /**
   * Makes the configured principal exist with these roles, idempotently, in one transaction that audits what it created.
   * A missing principal or role is created active; a changed display name is updated; a principal or role an operator
   * disabled stays disabled. Another principal id already holding the issuer and subject is a `conflict`.
   */
  ensureSeed(seed: AdminPrincipalSeed, roles: readonly MemberRole[]): Promise<AdminPrincipal>;
  get(principalId: string): Promise<AdminPrincipal | undefined>;
  /** Active roles of the principal, in every scope. */
  roles(principalId: string): Promise<readonly MemberRole[]>;
  /** Appends one audit row and returns its id. */
  audit(record: CatalogAuditRecord): Promise<string>;
}

/** A shard the control plane knows. `dsnRef` names the deployment secret holding its connection string. */
export interface ShardEntry {
  readonly shardId: string;
  /** Absent for the default shard, which is the control plane's own connection. */
  readonly dsnRef?: string;
  readonly status: string;
  readonly weight: number;
}

/** The shard a tenant without a routing row lives in, and the only shard while none is registered. */
export const DEFAULT_SHARD_ID = "s0";

export interface ShardDirectory {
  /** Registered shards in shardId order; with none registered, the default shard alone. */
  shards(): Promise<readonly ShardEntry[]>;
  /** The tenant's shard; the default shard when the tenant has no routing row. */
  shardOf(tenantId: string): Promise<string>;
  /** Grows on every routing change, so a cache knows when to reload; 0 before any change. */
  mapVersion(): Promise<number>;
}
