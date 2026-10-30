import type { RuntimeSnapshot } from "../runtime/runtime-snapshot.js";
import type { SecurityContext } from "../security/security-context.js";
import type { ToolDefinition } from "./tool.js";
import type { TurnApplicationContext } from "../agent/agent.js";

export interface ContextualToolDiscoveryContext {
  readonly security: SecurityContext;
  readonly runtime: RuntimeSnapshot;
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentProfileId?: string;
  /** Provenance-preserving host context. Sources must not authorize from untrusted data. */
  readonly applicationContext?: TurnApplicationContext;
}

/**
 * Request-scoped tool catalog provider. Implementations may consult an external
 * connector, policy service, or tenant registry, but must never expose secrets
 * through returned definitions or catalog metadata.
 */
export interface ContextualToolSource {
  readonly id: string;
  readonly version: string;
  /**
   * The source reads the files users attach (its deployment stores them where it reads them). When
   * no such source can be had this turn, the runtime knows attachments cannot be read — a fact, not
   * something a model or a judge has to work out from a refused call.
   */
  readonly readsAttachments?: boolean;
  discover(
    context: ContextualToolDiscoveryContext,
    signal: AbortSignal,
  ): Promise<ContextualToolCatalog>;
}

export interface ContextualToolCatalog {
  /** Opaque revision used to bind policy and approval decisions to a catalog. */
  readonly revision: string;
  readonly tools: readonly ToolDefinition[];
  /**
   * The source could not be reached this turn and offers nothing (a connector configured to be
   * omitted on failure). Said, not inferred from an empty list: a source may legitimately offer no tools.
   */
  readonly unavailable?: true;
}
