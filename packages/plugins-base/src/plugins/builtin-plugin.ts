import type { PluginManifest, AgentPlugin } from "@0xsyncroot/plugin-sdk";

export function createBuiltinManifest(
  id: string,
  options: {
    readonly requires?: Readonly<Record<string, string>>;
    readonly provides: NonNullable<PluginManifest["provides"]>;
    readonly permissions?: PluginManifest["permissions"];
  },
): PluginManifest {
  return {
    manifestVersion: 1,
    id,
    version: "0.1.0",
    publisher: "Agentic Platform",
    coreApi: "^1.0.0",
    artifact: { digest: `builtin:${id}@0.1.0`, signature: "trusted-assembly" },
    requires: options.requires ?? {},
    provides: options.provides,
    permissions: options.permissions ?? {},
  };
}

export function createBuiltinPlugin(activate: AgentPlugin["activate"]): AgentPlugin {
  return { validate: async () => ({ valid: true }), activate, health: async () => ({ healthy: true }) };
}
