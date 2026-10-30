import type { JsonValue, SecurityContext } from "@0xsyncroot/contracts";
import type { Disposable, ScopedPluginContext } from "./context.js";
import type { PluginManifest, TrustTier } from "./manifest.js";

export interface ValidationContext { readonly coreApiVersion: string; readonly config: Readonly<Record<string, JsonValue>> }
export type ValidationResult = { readonly valid: true } | { readonly valid: false; readonly errors: readonly string[] };
export interface AgentPlugin {
  validate(context: ValidationContext): Promise<ValidationResult>;
  activate(context: ScopedPluginContext): Promise<Disposable>;
  quiesce?(signal: AbortSignal): Promise<void>;
  health?(): Promise<{ readonly healthy: boolean; readonly detail?: string }>;
}
export interface PluginDescriptor {
  readonly manifest: PluginManifest;
  readonly plugin: AgentPlugin;
  readonly trustTier: TrustTier;
  readonly config?: Readonly<Record<string, JsonValue>>;
}
export interface PluginActivationOptions {
  readonly security: SecurityContext;
  readonly verifyArtifact: (descriptor: PluginDescriptor) => Promise<boolean>;
}
