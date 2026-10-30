import {
  hasPermission,
  type SecurityContext,
  type ToolAuthorizationInput,
  type ToolDefinition,
  type ToolDiscoveryContext,
  type ToolExecutionPolicy,
  type ToolPolicyDecision,
} from "@0xsyncroot/contracts";
import { sha256 } from "../hash.js";

function permitted(tool: ToolDefinition, security: SecurityContext): boolean {
  return tool.requiredPermissions.every((permission) => hasPermission(security, permission));
}

/** Neutral fail-closed baseline. Deployments may inject a remote PDP through the same port. */
export class PermissionToolExecutionPolicy implements ToolExecutionPolicy {
  async discover(tools: readonly ToolDefinition[], context: ToolDiscoveryContext): Promise<readonly ToolDefinition[]> {
    return Object.freeze(tools.filter((tool) => permitted(tool, context.security)));
  }

  async authorize(input: ToolAuthorizationInput): Promise<ToolPolicyDecision> {
    const missing = input.tool.requiredPermissions.filter((permission) => !hasPermission(input.security, permission));
    const outcome = missing.length > 0
      ? "deny" as const
      : input.tool.sideEffect === "none"
        ? "allow" as const
        : "require_approval" as const;
    const reason = missing.length > 0
      ? `Missing permissions: ${missing.join(", ")}`
      : outcome === "allow"
        ? "Read-only action allowed"
        : `Approval required for ${input.tool.sideEffect} side effect`;
    const actionDigest = sha256({
      tenantId: input.security.tenantId,
      actorId: input.security.actorId,
      runtimeSnapshotId: input.runtime.id,
      toolId: input.tool.id,
      toolVersion: input.tool.version,
      toolOrigin: input.tool.origin ?? null,
      arguments: input.arguments,
      interaction: input.interaction ?? null,
    });
    return Object.freeze({
      decisionId: `policy-${sha256({ actionDigest, outcome, revision: input.runtime.policyRevision }).slice(0, 24)}`,
      outcome,
      policyRevision: input.runtime.policyRevision,
      reason,
      actionDigest,
    });
  }
}
