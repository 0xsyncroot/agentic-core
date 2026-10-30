import {
  hasPermission,
  type MemoryContextPolicy,
  type MemoryQuery,
  type MemoryScope,
  type SecurityContext,
} from "@0xsyncroot/contracts";

/** Conservative generic scopes. Domain scopes must be contributed by a product policy. */
export function baseMemoryScopes(
  security: SecurityContext,
  sessionId: string,
): readonly MemoryScope[] {
  return [
    { tenantId: security.tenantId, type: "tenant", id: security.tenantId },
    { tenantId: security.tenantId, type: "actor", id: security.actorId },
    { tenantId: security.tenantId, type: "session", id: sessionId },
  ];
}

export class BaseMemoryContextPolicy implements MemoryContextPolicy {
  constructor(private readonly limit = 8) {}

  createQuery(input: {
    readonly text: string;
    readonly sessionId: string;
    readonly security: SecurityContext;
  }): MemoryQuery | undefined {
    // An identity that may not read memory asks no store: the engines refuse it before reading, which only fails the lookup.
    if (!hasPermission(input.security, "memory.read")) return undefined;
    return {
      text: input.text,
      scopes: baseMemoryScopes(input.security, input.sessionId),
      limit: this.limit,
    };
  }
}
