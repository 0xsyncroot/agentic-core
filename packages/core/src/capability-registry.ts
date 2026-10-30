import type {
  CapabilityToken,
  RegistrationReceipt,
  ScopedCapabilityResolver,
  TrustTier,
} from "@0xsyncroot/plugin-sdk";
import { AgenticError } from "@0xsyncroot/contracts";

interface ProviderRecord<T = unknown> {
  readonly owner: string;
  readonly value: T;
  readonly version: string;
}

export class CapabilityRegistry {
  readonly #providers: Map<string, ProviderRecord[]>;

  constructor(source?: CapabilityRegistry) {
    this.#providers = source
      ? new Map([...source.#providers].map(([id, providers]) => [id, [...providers]]))
      : new Map();
  }

  register<T>(
    token: CapabilityToken<T>,
    value: T,
    owner: string,
    trustTier: TrustTier,
    providerVersion: string,
  ): RegistrationReceipt {
    if (token.protected && trustTier !== "platform-core") {
      throw new AgenticError("denied", `Plugin ${owner} cannot provide protected capability ${token.id}`);
    }

    const existing = this.#providers.get(token.id) ?? [];
    if (token.cardinality === "single" && existing.length > 0) {
      throw new AgenticError("conflict", `Single-provider capability conflict: ${token.id}`);
    }

    const record: ProviderRecord<T> = { owner, value, version: providerVersion };
    this.#providers.set(token.id, [...existing, record]);

    let disposed = false;
    return {
      owner,
      capabilityId: token.id,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const current = this.#providers.get(token.id) ?? [];
        this.#providers.set(
          token.id,
          current.filter((candidate) => candidate !== record),
        );
      },
    };
  }

  resolver(allowed?: ReadonlySet<string>, trustTier?: TrustTier): ScopedCapabilityResolver {
    const assertAllowed = <T>(token: CapabilityToken<T>): void => {
      const id = token.id;
      if (allowed && !allowed.has(id)) {
        throw new AgenticError("denied", `Capability ${id} was not declared in the plugin manifest`);
      }
      if (trustTier && trustTier !== "platform-core" && token.protected) {
        throw new AgenticError("denied", `Plugin trust tier ${trustTier} cannot resolve protected capability ${id} directly`);
      }
    };

    return {
      optional: <T>(token: CapabilityToken<T>): T | undefined => {
        assertAllowed(token);
        return this.#providers.get(token.id)?.[0]?.value as T | undefined;
      },
      require: <T>(token: CapabilityToken<T>): T => {
        assertAllowed(token);
        const value = this.#providers.get(token.id)?.[0]?.value as T | undefined;
        if (value === undefined) throw new AgenticError("validation", `Missing capability ${token.id}`);
        return value;
      },
      all: <T>(token: CapabilityToken<T>): readonly T[] => {
        assertAllowed(token);
        return (this.#providers.get(token.id) ?? []).map((provider) => provider.value as T);
      },
    };
  }

  has(id: string): boolean {
    return (this.#providers.get(id)?.length ?? 0) > 0;
  }

  providerVersions(id: string): readonly string[] {
    return (this.#providers.get(id) ?? []).map((provider) => provider.version);
  }
}
