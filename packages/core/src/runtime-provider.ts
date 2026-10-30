import { AgenticError, type RuntimeSnapshot, type SecurityContext } from "@0xsyncroot/contracts";
import type { ScopedCapabilityResolver } from "@0xsyncroot/plugin-sdk";

/** Request-free lease over one immutable plugin-host generation. */
export interface RuntimeSnapshotLease {
  readonly snapshot: RuntimeSnapshot;
  readonly capabilities: ScopedCapabilityResolver;
  release(): void;
}

/** A host/source owns generations, but deliberately has no tenant-routing authority. */
export interface RuntimeSnapshotSource {
  acquireSnapshot(): RuntimeSnapshotLease;
}

/** Auditable proof of the exact route selected for one agent operation. */
export interface RuntimeBinding {
  readonly tenantId: string;
  readonly agentProfileId: string;
  readonly routeRevision: string;
  readonly runtimeSnapshotId: string;
}

/** Immutable, tenant-bound runtime view pinned for one agent operation. */
export interface RuntimeViewLease extends RuntimeSnapshotLease {
  readonly binding: RuntimeBinding;
}

export interface RuntimeResolutionRequest {
  readonly security: SecurityContext;
  readonly agentProfileId?: string;
  /**
   * The route revision a paused operation was bound to. Only core sets it, from the journal, when a resume acquires its
   * runtime; no request field reaches it. Opaque to core: a provider that can serve that revision again leases it, any
   * other provider leases its live route, and the resume's binding check refuses the difference as stale.
   */
  readonly pin?: string;
}

export interface RuntimeProvider {
  /** May settle later, for a provider that must build the generation it routes to before it can lease it. */
  acquireRuntime(request: RuntimeResolutionRequest): RuntimeViewLease | Promise<RuntimeViewLease>;
}

function exactIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new AgenticError("permanent", `Runtime provider returned an invalid ${label}`);
  }
  return value;
}

/** Validates every provider implementation at the application boundary. */
export async function acquireRuntimeView(provider: RuntimeProvider, request: RuntimeResolutionRequest): Promise<RuntimeViewLease> {
  const expectedTenantId = request.security.tenantId.trim();
  const expectedAgentProfileId = (request.agentProfileId ?? "default").trim();
  const lease = await provider.acquireRuntime(request);
  try {
    if (!lease || typeof lease.release !== "function" || !lease.snapshot || !lease.capabilities || !lease.binding) {
      throw new AgenticError("permanent", "Runtime provider returned an invalid lease");
    }
    const snapshotId = exactIdentifier(lease.snapshot.id, "snapshot ID");
    const tenantId = exactIdentifier(lease.binding.tenantId, "tenant binding");
    const agentProfileId = exactIdentifier(lease.binding.agentProfileId, "agent-profile binding");
    exactIdentifier(lease.binding.routeRevision, "route revision");
    const runtimeSnapshotId = exactIdentifier(lease.binding.runtimeSnapshotId, "snapshot binding");
    if (tenantId !== expectedTenantId || agentProfileId !== expectedAgentProfileId || runtimeSnapshotId !== snapshotId) {
      throw new AgenticError("denied", "Runtime provider returned a lease for a different request binding");
    }
    return lease;
  } catch (error) {
    try { lease?.release?.(); }
    catch (releaseError) { throw new AggregateError([error, releaseError], "Invalid runtime lease could not be released"); }
    throw error;
  }
}
