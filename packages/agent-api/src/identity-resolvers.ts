import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { AgenticError, type IdentityEvidence, type IdentityResolver, type SecurityContext } from "@0xsyncroot/contracts";

interface SignedIdentityClaims {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly sub: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly permissions: readonly string[];
  readonly roles?: readonly string[];
  readonly grantRevision: string;
  readonly agentProfileIds: readonly string[];
  readonly context?: Readonly<Record<string, string>>;
  readonly assurance?: SecurityContext["authentication"] extends infer T
    ? T extends { assurance: infer A } ? A : never
    : never;
  readonly exp: number;
  readonly iat: number;
  readonly nbf?: number;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new AgenticError("denied", `Invalid identity claim: ${name}`);
  }
  return value;
}

function stringList(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) throw new AgenticError("denied", `Invalid identity claim: ${name}`);
  return Object.freeze(value.map((entry) => requiredString(entry, name)));
}

function stringRecord(value: unknown, name: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgenticError("denied", `Invalid identity claim: ${name}`);
  const entries = Object.entries(value);
  if (entries.length > 64) throw new AgenticError("denied", `Invalid identity claim: ${name}`);
  const result: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!key.trim() || key.length > 128 || typeof entry !== "string" || entry.length > 2_048) {
      throw new AgenticError("denied", `Invalid identity claim: ${name}`);
    }
    result[key] = entry;
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 16_384) throw new AgenticError("denied", `Invalid identity claim: ${name}`);
  return Object.freeze(result);
}

function decodeJson(value: string): Record<string, unknown> {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
    return decoded as Record<string, unknown>;
  } catch {
    throw new AgenticError("denied", "Invalid bearer token");
  }
}

export class HmacIdentityResolver implements IdentityResolver {
  readonly #secret: Buffer;

  constructor(
    secret: string,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly maxLifetimeSeconds = 300,
  ) {
    this.#secret = Buffer.from(secret, "utf8");
    if (this.#secret.length < 32) throw new Error("AGENTIC_WEB_AUTH_SECRET must contain at least 32 bytes");
    if (!issuer.trim() || !audience.trim()) throw new Error("Identity issuer and audience are required");
    if (!Number.isInteger(maxLifetimeSeconds) || maxLifetimeSeconds < 30 || maxLifetimeSeconds > 3_600) {
      throw new Error("Identity token maximum lifetime must be an integer from 30 to 3600 seconds");
    }
  }

  async resolve(evidence: IdentityEvidence, signal?: AbortSignal): Promise<SecurityContext> {
    if (signal?.aborted) throw signal.reason;
    const token = evidence.bearerToken;
    if (!token || token.length > 16_384) throw new AgenticError("denied", "Bearer authentication is required");
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new AgenticError("denied", "Invalid bearer token");
    const header = decodeJson(parts[0]);
    if (header.alg !== "HS256" || header.typ !== "JWT") throw new AgenticError("denied", "Unsupported bearer token header");
    const expected = createHmac("sha256", this.#secret).update(`${parts[0]}.${parts[1]}`).digest();
    let supplied: Buffer;
    try { supplied = Buffer.from(parts[2], "base64url"); }
    catch { throw new AgenticError("denied", "Invalid bearer token"); }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new AgenticError("denied", "Invalid bearer token signature");
    }
    const raw = decodeJson(parts[1]);
    const claims = raw as unknown as SignedIdentityClaims;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(claims.iat) || claims.iat > now + 30) throw new AgenticError("denied", "Bearer token issue time is invalid");
    if (!Number.isInteger(claims.exp) || claims.exp <= now) throw new AgenticError("denied", "Bearer token expired");
    if (claims.exp <= claims.iat || claims.exp - claims.iat > this.maxLifetimeSeconds) {
      throw new AgenticError("denied", "Bearer token lifetime is invalid");
    }
    if (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > now)) throw new AgenticError("denied", "Bearer token is not active");
    if (requiredString(claims.iss, "iss") !== this.issuer) throw new AgenticError("denied", "Bearer token issuer is not allowed");
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(this.audience)) throw new AgenticError("denied", "Bearer token audience is not allowed");
    const assurance = claims.assurance ?? "user";
    if (!["development", "service", "user", "strong"].includes(assurance)) throw new AgenticError("denied", "Invalid identity claim: assurance");
    const subject = requiredString(claims.sub, "sub");
    const authorizedAgentProfiles = stringList(claims.agentProfileIds, "agentProfileIds");
    if (authorizedAgentProfiles.length === 0 || new Set(authorizedAgentProfiles).size !== authorizedAgentProfiles.length) {
      throw new AgenticError("denied", "Invalid identity claim: agentProfileIds");
    }
    const trustedContext = stringRecord(claims.context, "context");
    return Object.freeze({
      tenantId: requiredString(claims.tenantId, "tenantId"),
      actorId: requiredString(claims.actorId, "actorId"),
      permissions: Object.freeze(new Set(stringList(claims.permissions, "permissions"))),
      correlationId: evidence.correlationId,
      purpose: evidence.purpose,
      authentication: Object.freeze({ issuer: claims.iss, subject, assurance }),
      ...(claims.roles ? { roles: stringList(claims.roles, "roles") } : {}),
      grantRevision: requiredString(claims.grantRevision, "grantRevision"),
      authorizedAgentProfiles,
      ...(trustedContext ? { trustedContext } : {}),
    });
  }
}

/** Explicit local-development identity. Never compose this adapter for a remote or production listener. */
export class StaticDevelopmentIdentityResolver implements IdentityResolver {
  constructor(
    private readonly tenantId: string,
    private readonly actorId: string,
    private readonly agentProfileIds: readonly string[] = ["default"],
  ) {
    if (agentProfileIds.length === 0 || agentProfileIds.some((profile) => !profile.trim())) {
      throw new Error("Static development identity requires at least one agent profile");
    }
  }

  async resolve(evidence: IdentityEvidence): Promise<SecurityContext> {
    return Object.freeze({
      tenantId: this.tenantId,
      actorId: this.actorId,
      permissions: Object.freeze(new Set(["*"])),
      correlationId: evidence.correlationId,
      purpose: evidence.purpose,
      authentication: Object.freeze({ issuer: "local-development", subject: this.actorId, assurance: "development" }),
      grantRevision: "local-development-v1",
      authorizedAgentProfiles: Object.freeze([...new Set(this.agentProfileIds)]),
    });
  }
}

export async function resolveRequestIdentity(
  request: IncomingMessage, resolver: IdentityResolver, purpose: string, signal?: AbortSignal,
  attributes?: Readonly<Record<string, string>>,
): Promise<SecurityContext> {
  const authorization = request.headers.authorization;
  const match = typeof authorization === "string" ? /^Bearer\s+(.+)$/i.exec(authorization.trim()) : undefined;
  if (authorization !== undefined && !match) throw new AgenticError("denied", "Authorization must use the Bearer scheme");
  return resolver.resolve({
    ...(match?.[1] ? { bearerToken: match[1] } : {}), correlationId: crypto.randomUUID(), purpose,
    ...(attributes && Object.keys(attributes).length > 0 ? { attributes } : {}),
  }, signal);
}
