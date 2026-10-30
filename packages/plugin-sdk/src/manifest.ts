import type { CapabilityCardinality } from "./capability.js";

export type TrustTier = "platform-core" | "first-party-domain" | "third-party";

export interface PluginManifest {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly publisher: string;
  readonly coreApi: string;
  readonly artifact: { readonly digest: string; readonly signature: string };
  readonly requires: Readonly<Record<string, string>>;
  readonly optional?: Readonly<Record<string, string>>;
  readonly provides?: Readonly<Record<string, { readonly version: string; readonly cardinality: CapabilityCardinality }>>;
  readonly permissions: {
    readonly capabilities?: readonly string[];
    readonly capabilityOperations?: Readonly<Record<string, readonly string[]>>;
    readonly network?: readonly string[];
    readonly secrets?: readonly string[];
  };
}
