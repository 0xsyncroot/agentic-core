import type { JsonValue, RuntimeSnapshot } from "@0xsyncroot/contracts";
import type { CapabilityToken } from "./capability.js";
import type { TrustTier } from "./manifest.js";

export interface Disposable { dispose(): Promise<void> | void }
export interface RegistrationReceipt extends Disposable { readonly owner: string; readonly capabilityId: string }
export interface OwnedRegistrar { provide<T>(token: CapabilityToken<T>, value: T): RegistrationReceipt }
export interface ScopedCapabilityResolver {
  optional<T>(token: CapabilityToken<T>): T | undefined;
  require<T>(token: CapabilityToken<T>): T;
  all<T>(token: CapabilityToken<T>): readonly T[];
}
export interface NamespacedStateStore { get(key: string): Promise<JsonValue | undefined>; set(key: string, value: JsonValue): Promise<void> }
export interface PluginTelemetry { record(name: string, attributes?: Readonly<Record<string, JsonValue>>): void }
export interface ScopedPluginContext {
  readonly identity: { readonly id: string; readonly version: string; readonly trustTier: TrustTier };
  readonly runtime: RuntimeSnapshot;
  readonly config: Readonly<Record<string, JsonValue>>;
  readonly capabilities: ScopedCapabilityResolver;
  readonly registrations: OwnedRegistrar;
  readonly state: NamespacedStateStore;
  readonly telemetry: PluginTelemetry;
}
