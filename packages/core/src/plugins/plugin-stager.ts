import { AgenticError, type JsonValue, type RuntimeSnapshot } from "@0xsyncroot/contracts";
import {
  type CapabilityToken,
  type Disposable,
  type NamespacedStateStore,
  type PluginDescriptor,
  type RegistrationReceipt,
} from "@0xsyncroot/plugin-sdk";
import type { CapabilityRegistry } from "../capability-registry.js";
import { disposeReverse } from "./dispose-reverse.js";
import { isMajorCompatible, majorVersion } from "./version-policy.js";

/** Activates one already-resolved plugin against a shadow registry. */
export class PluginStager {
  readonly #pluginState = new Map<string, JsonValue>();

  async stage(
    descriptor: PluginDescriptor,
    shadow: CapabilityRegistry,
    snapshot: RuntimeSnapshot,
  ): Promise<Disposable> {
    const validation = await descriptor.plugin.validate({
      coreApiVersion: snapshot.coreVersion,
      config: descriptor.config ?? {},
    });
    if (!validation.valid) {
      throw new AgenticError(
        "validation",
        `Plugin ${descriptor.manifest.id} rejected config: ${validation.errors.join("; ")}`,
      );
    }
    this.#assertRequirementsAvailable(descriptor, shadow);

    const receipts: RegistrationReceipt[] = [];
    const allowed = new Set([
      ...Object.keys(descriptor.manifest.requires),
      ...Object.keys(descriptor.manifest.optional ?? {}),
      ...(descriptor.manifest.permissions.capabilities ?? []),
    ]);
    const registrar = {
      provide: <T>(token: CapabilityToken<T>, value: T): RegistrationReceipt => {
        const declared = descriptor.manifest.provides?.[token.id];
        if (!declared) {
          throw new AgenticError("validation", `Plugin ${descriptor.manifest.id} did not declare ${token.id}`);
        }
        if (declared.cardinality !== token.cardinality || !isMajorCompatible(declared.version, token.version)) {
          throw new AgenticError("validation", `Manifest/token mismatch for ${token.id}`);
        }
        const receipt = shadow.register(
          token,
          value,
          descriptor.manifest.id,
          descriptor.trustTier,
          declared.version,
        );
        receipts.push(receipt);
        return receipt;
      },
    };
    const resolver = shadow.resolver(allowed, descriptor.trustTier);
    let activated: Disposable | undefined;
    try {
      activated = await descriptor.plugin.activate({
        identity: {
          id: descriptor.manifest.id,
          version: descriptor.manifest.version,
          trustTier: descriptor.trustTier,
        },
        runtime: snapshot,
        config: descriptor.config ?? {},
        capabilities: resolver,
        registrations: registrar,
        state: this.#stateFor(descriptor),
        telemetry: { record: () => undefined },
      });
      this.#assertDeclaredCapabilitiesRegistered(descriptor, receipts);
      const health = await descriptor.plugin.health?.();
      if (health && !health.healthy) {
        throw new AgenticError(
          "permanent",
          `Plugin ${descriptor.manifest.id} unhealthy: ${health.detail ?? "unknown"}`,
        );
      }
    } catch (error) {
      await disposeReverse([...(activated ? [activated] : []), ...receipts]);
      throw error;
    }
    if (!activated) {
      throw new AgenticError("permanent", `Plugin ${descriptor.manifest.id} activation invariant failed`);
    }
    return {
      dispose: async () => disposeReverse([activated, ...receipts]),
    };
  }

  #assertRequirementsAvailable(descriptor: PluginDescriptor, registry: CapabilityRegistry): void {
    for (const [required, range] of Object.entries(descriptor.manifest.requires)) {
      if (!registry.providerVersions(required).some((version) => isMajorCompatible(version, range))) {
        throw new AgenticError("validation", `Plugin ${descriptor.manifest.id} requires ${required} ${range}`);
      }
    }
  }

  #assertDeclaredCapabilitiesRegistered(
    descriptor: PluginDescriptor,
    receipts: readonly RegistrationReceipt[],
  ): void {
    for (const capabilityId of Object.keys(descriptor.manifest.provides ?? {})) {
      if (!receipts.some((receipt) => receipt.capabilityId === capabilityId)) {
        throw new AgenticError(
          "validation",
          `Plugin ${descriptor.manifest.id} did not register declared ${capabilityId}`,
        );
      }
    }
  }

  #stateFor(descriptor: PluginDescriptor): NamespacedStateStore {
    const prefix = `deployment:${descriptor.manifest.id}:${majorVersion(descriptor.manifest.version) ?? 0}:`;
    return {
      get: async (key) => this.#pluginState.get(`${prefix}${key}`),
      set: async (key, value) => {
        this.#pluginState.set(`${prefix}${key}`, value);
      },
    };
  }
}
