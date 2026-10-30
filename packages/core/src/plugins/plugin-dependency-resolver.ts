import { AgenticError } from "@0xsyncroot/contracts";
import type { PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import type { CapabilityRegistry } from "../capability-registry.js";
import { isMajorCompatible } from "./version-policy.js";

function key(descriptor: PluginDescriptor): string {
  return `${descriptor.manifest.id}@${descriptor.manifest.version}`;
}

export class PluginDependencyResolver {
  resolve(descriptors: readonly PluginDescriptor[], registry: CapabilityRegistry): PluginDescriptor[] {
    const byId = new Map<string, PluginDescriptor>();
    const providers = new Map<string, PluginDescriptor[]>();
    for (const descriptor of descriptors) {
      if (byId.has(descriptor.manifest.id)) {
        throw new AgenticError("conflict", `Duplicate plugin ID in activation set: ${descriptor.manifest.id}`);
      }
      byId.set(descriptor.manifest.id, descriptor);
      for (const [capabilityId, declaration] of Object.entries(descriptor.manifest.provides ?? {})) {
        const current = providers.get(capabilityId) ?? [];
        if (declaration.cardinality === "single" && (current.length > 0 || registry.has(capabilityId))) {
          throw new AgenticError("conflict", `Single-provider capability conflict: ${capabilityId}`);
        }
        providers.set(capabilityId, [...current, descriptor]);
      }
    }

    const dependencies = new Map<PluginDescriptor, Set<PluginDescriptor>>();
    for (const descriptor of descriptors) {
      const requiredProviders = new Set<PluginDescriptor>();
      for (const [capabilityId, range] of Object.entries(descriptor.manifest.requires)) {
        if (registry.providerVersions(capabilityId).some((version) => isMajorCompatible(version, range))) continue;
        const candidates = (providers.get(capabilityId) ?? []).filter((candidate) => {
          const version = candidate.manifest.provides?.[capabilityId]?.version;
          return version !== undefined && isMajorCompatible(version, range);
        });
        if (candidates.length === 0) {
          throw new AgenticError("validation", `Plugin ${descriptor.manifest.id} requires missing ${capabilityId} ${range}`);
        }
        for (const candidate of candidates) requiredProviders.add(candidate);
      }
      for (const [capabilityId, range] of Object.entries(descriptor.manifest.optional ?? {})) {
        for (const candidate of providers.get(capabilityId) ?? []) {
          const version = candidate.manifest.provides?.[capabilityId]?.version;
          if (version && isMajorCompatible(version, range)) requiredProviders.add(candidate);
        }
      }
      dependencies.set(descriptor, requiredProviders);
    }

    const ordered: PluginDescriptor[] = [];
    const remaining = new Set(descriptors);
    while (remaining.size > 0) {
      const ready = [...remaining]
        .filter((descriptor) => [...(dependencies.get(descriptor) ?? [])].every((dependency) => !remaining.has(dependency)))
        .sort((left, right) => key(left).localeCompare(key(right)));
      if (ready.length === 0) {
        throw new AgenticError(
          "conflict",
          `Plugin dependency cycle: ${[...remaining].map((descriptor) => descriptor.manifest.id).sort().join(", ")}`,
        );
      }
      for (const descriptor of ready) {
        ordered.push(descriptor);
        remaining.delete(descriptor);
      }
    }
    return ordered;
  }
}
