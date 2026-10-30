/**
 * Display/reporting identity carried by trusted identity evidence — tenant and user facts a
 * monitor/telemetry event names, never a business or authorization decision.
 */
export interface SecurityDisplayIdentity {
  readonly tenantName?: string;
  readonly userId?: string;
  readonly fullName?: string;
}

const DISPLAY_IDENTITY_FIELDS = ["tenantName", "userId", "fullName"] as const satisfies readonly (keyof SecurityDisplayIdentity)[];

/**
 * The display identity found in `value`, copied field by field: only the known fields, only
 * non-blank strings of at most 256 characters, frozen. A malformed field is dropped rather than
 * refused, because a display label must never be the reason a request or a turn fails. Every
 * boundary that carries security data forward uses this, so no layer quietly loses the identity
 * another layer established.
 */
export function displayIdentityFrom(value: unknown): SecurityDisplayIdentity | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const source = value as Readonly<Record<string, unknown>>;
  const identity: { -readonly [Field in keyof SecurityDisplayIdentity]: string } = {};
  for (const field of DISPLAY_IDENTITY_FIELDS) {
    const entry = source[field];
    if (typeof entry === "string" && entry.trim() && entry.length <= 256) identity[field] = entry.trim();
  }
  return Object.keys(identity).length > 0 ? Object.freeze(identity) : undefined;
}

export interface SecurityContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly permissions: ReadonlySet<string>;
  readonly correlationId: string;
  readonly purpose: string;
  /** Immutable authentication facts produced by a delivery-layer identity adapter. */
  readonly authentication?: {
    readonly issuer: string;
    readonly subject: string;
    readonly assurance: "development" | "service" | "user" | "strong";
  };
  readonly roles?: readonly string[];
  readonly grantRevision?: string;
  /** Agent profiles explicitly authorized by trusted identity evidence. */
  readonly authorizedAgentProfiles?: readonly string[];
  /** Small, signed host facts. Browser-supplied live context never belongs here. */
  readonly trustedContext?: Readonly<Record<string, string>>;
  /**
   * Who to name in reporting, never who may do what. Distinct from `trustedContext`, which is a
   * product-defined, allow-listed bag of UI/business hints: mixing display identity into it would
   * blur what each field means and who may read it.
   */
  readonly identity?: SecurityDisplayIdentity;
}

/** Authoritative permission check shared by policies and direct service guards. */
export function hasPermission(security: SecurityContext, permission: string): boolean {
  return security.permissions.has("*") || security.permissions.has(permission);
}

/** Transport-neutral evidence. HTTP, CLI and queue adapters translate their credentials into this envelope. */
export interface IdentityEvidence {
  readonly bearerToken?: string;
  readonly correlationId: string;
  readonly purpose: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface IdentityResolver {
  resolve(evidence: IdentityEvidence, signal?: AbortSignal): Promise<SecurityContext>;
}
