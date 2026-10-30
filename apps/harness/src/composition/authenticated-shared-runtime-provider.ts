import { AgenticError } from "@0xsyncroot/contracts";
import type {
  RuntimeProvider,
  RuntimeResolutionRequest,
  RuntimeSnapshotSource,
  RuntimeViewLease,
} from "@0xsyncroot/core";

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new AgenticError("validation", `${label} cannot be empty`);
  return normalized;
}

/**
 * Reference SaaS route policy for one product-wide agent profile. Identity remains
 * delivery-owned; this provider only accepts a SecurityContext carrying authentication
 * evidence and binds its tenant to the shared immutable runtime snapshot.
 */
export class AuthenticatedSharedRuntimeProvider implements RuntimeProvider {
  readonly #agentProfileId: string;
  readonly #routeRevision: string;

  constructor(
    private readonly source: RuntimeSnapshotSource,
    routeRevision: string,
    agentProfileId = "default",
  ) {
    if (!source || typeof source.acquireSnapshot !== "function") {
      throw new AgenticError("validation", "Authenticated runtime route requires a snapshot source");
    }
    this.#agentProfileId = required(agentProfileId, "agentProfileId");
    this.#routeRevision = required(routeRevision, "routeRevision");
  }

  acquireRuntime(request: RuntimeResolutionRequest): RuntimeViewLease {
    const tenantId = required(request.security.tenantId, "tenantId");
    if (!request.security.authentication) {
      throw new AgenticError("denied", "Shared runtime routing requires authenticated identity evidence");
    }
    const agentProfileId = required(request.agentProfileId ?? "default", "agentProfileId");
    if (agentProfileId !== this.#agentProfileId) {
      throw new AgenticError("denied", `No shared runtime is assigned to agent profile ${agentProfileId}`);
    }
    const sourceLease = this.source.acquireSnapshot();
    const snapshotId = sourceLease.snapshot?.id;
    if (typeof snapshotId !== "string" || !snapshotId.trim() || snapshotId !== snapshotId.trim()) {
      sourceLease.release();
      throw new AgenticError("permanent", "Runtime snapshot source returned an invalid snapshot ID");
    }
    let released = false;
    return Object.freeze({
      snapshot: sourceLease.snapshot,
      capabilities: sourceLease.capabilities,
      binding: Object.freeze({
        tenantId,
        agentProfileId,
        routeRevision: this.#routeRevision,
        runtimeSnapshotId: snapshotId,
      }),
      release: () => {
        if (released) return;
        released = true;
        sourceLease.release();
      },
    });
  }
}
