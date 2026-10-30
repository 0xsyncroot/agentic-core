import { AgenticError } from "@0xsyncroot/contracts";
import type { PluginManifest } from "@0xsyncroot/plugin-sdk";
import { isMajorCompatible, isSemanticVersion } from "./version-policy.js";

export class PluginManifestValidator {
  constructor(private readonly coreApiVersion: string) {}

  validate(manifest: PluginManifest): void {
    if (manifest.manifestVersion !== 1) {
      throw new AgenticError("validation", `Unsupported manifest version for ${manifest.id}`);
    }
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(manifest.id)) {
      throw new AgenticError("validation", `Plugin ID must be namespaced: ${manifest.id}`);
    }
    if (!isSemanticVersion(manifest.version)) throw new AgenticError("validation", `Plugin ${manifest.id} has an invalid semantic version`);
    if (!isMajorCompatible(this.coreApiVersion, manifest.coreApi)) {
      throw new AgenticError("validation", `Plugin ${manifest.id} is incompatible with core API ${this.coreApiVersion}`);
    }
  }
}
