import { AgenticError } from "@0xsyncroot/contracts";
import type {
  RuntimeProvider,
  RuntimeResolutionRequest,
  RuntimeSnapshotSource,
  RuntimeViewLease,
} from "./runtime-provider.js";

export interface TenantRuntimeRoute {
  readonly tenantId: string;
  readonly agentProfileId: string;
  /** Request-free source; only this router may bind it to a tenant/profile request. */
  readonly provider: RuntimeSnapshotSource;
  /** Opaque control-plane revision required for auditable runtime binding. */
  readonly routeRevision: string;
}

interface ResolvedTenantRuntimeRoute {
  readonly provider: RuntimeSnapshotSource;
  readonly routeRevision: string;
}

function normalized(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw new AgenticError("validation", `${label} cannot be empty`);
  return result;
}

function routeKey(tenantId: string, agentProfileId: string): string {
  return JSON.stringify([tenantId, agentProfileId]);
}

/**
 * Fail-closed multi-tenant runtime router. There is deliberately no global or
 * cross-tenant fallback: every tenant/profile binding is explicit.
 */
export class TenantRuntimeRouter implements RuntimeProvider {
  #routes: ReadonlyMap<string, ResolvedTenantRuntimeRoute> = new Map();

  constructor(routes: readonly TenantRuntimeRoute[] = []) {
    this.replaceRoutes(routes);
  }

  /** Atomically replaces routing state; already acquired runtime leases stay pinned. */
  replaceRoutes(routes: readonly TenantRuntimeRoute[]): void {
    const next = new Map<string, ResolvedTenantRuntimeRoute>();
    for (const route of routes) {
      const tenantId = normalized(route.tenantId, "tenantId");
      const agentProfileId = normalized(route.agentProfileId, "agentProfileId");
      if (!route.provider || typeof route.provider.acquireSnapshot !== "function") {
        throw new AgenticError("validation", `Runtime route ${tenantId}/${agentProfileId} requires a snapshot source`);
      }
      const routeRevision = normalized(route.routeRevision, "routeRevision");
      const key = routeKey(tenantId, agentProfileId);
      if (next.has(key)) throw new AgenticError("conflict", `Duplicate runtime route for ${tenantId}/${agentProfileId}`);
      next.set(key, Object.freeze({ provider: route.provider, routeRevision }));
    }
    this.#routes = next;
  }

  acquireRuntime(request: RuntimeResolutionRequest): RuntimeViewLease {
    const tenantId = normalized(request.security.tenantId, "tenantId");
    const agentProfileId = normalized(request.agentProfileId ?? "default", "agentProfileId");
    const route = this.#routes.get(routeKey(tenantId, agentProfileId));
    if (!route) throw new AgenticError("denied", `No runtime is assigned to tenant/profile ${tenantId}/${agentProfileId}`);
    const sourceLease = route.provider.acquireSnapshot();
    if (!sourceLease || typeof sourceLease.release !== "function") {
      throw new AgenticError("permanent", "Runtime snapshot source returned an invalid lease");
    }
    const snapshotId = sourceLease.snapshot?.id;
    if (typeof snapshotId !== "string" || !snapshotId.trim() || snapshotId !== snapshotId.trim()) {
      sourceLease.release();
      throw new AgenticError("permanent", "Runtime snapshot source returned an invalid snapshot ID");
    }
    const runtimeSnapshotId = snapshotId;
    let released = false;
    return Object.freeze({
      snapshot: sourceLease.snapshot,
      capabilities: sourceLease.capabilities,
      binding: Object.freeze({
        tenantId,
        agentProfileId,
        routeRevision: route.routeRevision,
        runtimeSnapshotId,
      }),
      release: () => {
        if (released) return;
        released = true;
        sourceLease.release();
      },
    });
  }
}
