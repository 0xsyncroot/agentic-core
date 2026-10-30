import type { JsonValue, RuntimeSnapshot } from "@0xsyncroot/contracts";
import type { PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { sha256 } from "../hash.js";

export interface RuntimePolicyRevisions {
  readonly policy: string;
  readonly memoryPolicy: string;
}

export class RuntimeSnapshotFactory {
  constructor(
    private readonly coreVersion: string,
    private readonly revisions: RuntimePolicyRevisions,
  ) {}

  create(ordered: readonly PluginDescriptor[]): RuntimeSnapshot {
    const pluginSetId = sha256(
      ordered.map(({ manifest, trustTier, config }) => ({
        id: manifest.id,
        version: manifest.version,
        digest: manifest.artifact.digest,
        trustTier,
        config: (config ?? {}) as Readonly<Record<string, JsonValue>>,
      })),
    );
    const runtimeId = sha256({
      coreVersion: this.coreVersion,
      pluginSetId,
      policyRevision: this.revisions.policy,
      memoryPolicyRevision: this.revisions.memoryPolicy,
    });
    return Object.freeze({
      id: `runtime-${runtimeId.slice(0, 16)}`,
      coreVersion: this.coreVersion,
      pluginSetId,
      policyRevision: this.revisions.policy,
      memoryPolicyRevision: this.revisions.memoryPolicy,
      createdAt: new Date().toISOString(),
    });
  }
}
