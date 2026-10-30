import { AgenticError, type RuntimeSnapshot } from "@0xsyncroot/contracts";
import {
  type Disposable,
  type PluginActivationOptions,
  type PluginDescriptor,
} from "@0xsyncroot/plugin-sdk";
import { CapabilityRegistry } from "./capability-registry.js";
import { disposeReverse } from "./plugins/dispose-reverse.js";
import { PluginDependencyResolver } from "./plugins/plugin-dependency-resolver.js";
import { PluginManifestValidator } from "./plugins/plugin-manifest-validator.js";
import { PluginStager } from "./plugins/plugin-stager.js";
import {
  RuntimeSnapshotFactory,
  type RuntimePolicyRevisions,
} from "./plugins/runtime-snapshot-factory.js";
import type { RuntimeSnapshotLease, RuntimeSnapshotSource } from "./runtime-provider.js";

const CORE_API_VERSION = "1.0.0";
type HostState = "idle" | "staging" | "active" | "stopping" | "failed";

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freezeDeep(nested);
  }
  return value;
}

async function awaitWithSignal<T>(operation: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw new AgenticError("timeout", `${label} exceeded its shutdown deadline`);
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new AgenticError("timeout", `${label} exceeded its shutdown deadline`));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}

export interface PluginHostDependencies {
  readonly dependencyResolver?: PluginDependencyResolver;
  readonly manifestValidator?: PluginManifestValidator;
  readonly snapshotFactory?: RuntimeSnapshotFactory;
  readonly stager?: PluginStager;
  readonly policyRevisions?: RuntimePolicyRevisions;
}

export class PluginHost implements RuntimeSnapshotSource {
  #registry = new CapabilityRegistry();
  #snapshot: RuntimeSnapshot | undefined;
  #active: Array<{ descriptor: PluginDescriptor; disposable: Disposable }> = [];
  #state: HostState = "idle";
  #activeSnapshotLeases = 0;
  readonly #idleWaiters = new Set<() => void>();
  readonly #dependencyResolver: PluginDependencyResolver;
  readonly #manifestValidator: PluginManifestValidator;
  readonly #snapshotFactory: RuntimeSnapshotFactory;
  readonly #stager: PluginStager;

  constructor(dependencies: PluginHostDependencies = {}) {
    this.#dependencyResolver = dependencies.dependencyResolver ?? new PluginDependencyResolver();
    this.#manifestValidator = dependencies.manifestValidator ?? new PluginManifestValidator(CORE_API_VERSION);
    this.#stager = dependencies.stager ?? new PluginStager();
    this.#snapshotFactory =
      dependencies.snapshotFactory ??
      new RuntimeSnapshotFactory(
        CORE_API_VERSION,
        dependencies.policyRevisions ?? {
          policy: "unspecified",
          memoryPolicy: "disabled",
        },
      );
  }

  get state(): HostState {
    return this.#state;
  }

  get snapshot(): RuntimeSnapshot {
    if (!this.#snapshot) throw new AgenticError("conflict", "Plugin host is not active");
    return this.#snapshot;
  }

  /** Trusted core runtime view. Domain plugins only receive a scoped resolver during activation. */
  get capabilities() {
    if (this.#state !== "active") throw new AgenticError("conflict", `Capabilities unavailable while host is ${this.#state}`);
    return this.#registry.resolver();
  }

  acquireSnapshot(): RuntimeSnapshotLease {
    if (this.#state !== "active" || !this.#snapshot) {
      throw new AgenticError("conflict", `Cannot acquire runtime snapshot while host is ${this.#state}`);
    }
    const snapshot = this.#snapshot;
    const capabilities = this.#registry.resolver();
    this.#activeSnapshotLeases += 1;
    let released = false;
    return Object.freeze({
      snapshot,
      capabilities,
      release: () => {
        if (released) return;
        released = true;
        this.#activeSnapshotLeases -= 1;
        if (this.#activeSnapshotLeases === 0) {
          for (const resolve of this.#idleWaiters) resolve();
          this.#idleWaiters.clear();
        }
      },
    });
  }

  async #whenSnapshotsIdle(signal: AbortSignal): Promise<void> {
    if (this.#activeSnapshotLeases === 0) return;
    let resolveIdle!: () => void;
    const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
    this.#idleWaiters.add(resolveIdle);
    try { await awaitWithSignal(idle, signal, "Runtime drain"); }
    finally { this.#idleWaiters.delete(resolveIdle); }
  }

  async activate(descriptors: readonly PluginDescriptor[], options: PluginActivationOptions): Promise<RuntimeSnapshot> {
    if (this.#state !== "idle") throw new AgenticError("conflict", `Cannot activate plugin host from ${this.#state}`);
    this.#state = "staging";
    try {
      const frozen = descriptors.map((descriptor) =>
        Object.freeze({
          ...descriptor,
          manifest: freezeDeep({ ...descriptor.manifest }),
          ...(descriptor.config ? { config: freezeDeep({ ...descriptor.config }) } : {}),
        }),
      );
      for (const descriptor of frozen) {
        this.#manifestValidator.validate(descriptor.manifest);
        if (!(await options.verifyArtifact(descriptor))) {
          throw new AgenticError("denied", `Artifact verification failed: ${descriptor.manifest.id}`);
        }
      }

      const ordered = this.#dependencyResolver.resolve(frozen, this.#registry);
      const snapshot = this.#snapshotFactory.create(ordered);
      const shadow = new CapabilityRegistry(this.#registry);
      const staged: Array<{ descriptor: PluginDescriptor; disposable: Disposable }> = [];

      try {
        for (const descriptor of ordered) {
          const disposable = await this.#stager.stage(descriptor, shadow, snapshot);
          staged.push({ descriptor, disposable });
        }
      } catch (error) {
        try {
          await disposeReverse(staged.map((item) => item.disposable));
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Plugin activation and rollback both failed");
        }
        throw error;
      }

      this.#registry = shadow;
      this.#snapshot = snapshot;
      this.#active = staged;
      this.#state = "active";
      return snapshot;
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  async shutdown(signal = AbortSignal.timeout(5_000)): Promise<void> {
    if (this.#state === "idle") return;
    this.#state = "stopping";
    const errors: unknown[] = [];
    for (const item of [...this.#active].reverse()) {
      try {
        if (item.descriptor.plugin.quiesce) {
          await awaitWithSignal(Promise.resolve(item.descriptor.plugin.quiesce(signal)), signal, `Plugin quiesce ${item.descriptor.manifest.id}`);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    let drained = true;
    try {
      await this.#whenSnapshotsIdle(signal);
    } catch (error) {
      drained = false;
      errors.push(error);
    }
    if (drained) {
      for (const item of [...this.#active].reverse()) {
        try {
          await awaitWithSignal(Promise.resolve(item.disposable.dispose()), signal, `Plugin dispose ${item.descriptor.manifest.id}`);
        } catch (error) {
          errors.push(error);
        }
      }
      this.#active = [];
      this.#snapshot = undefined;
      this.#registry = new CapabilityRegistry();
    }
    this.#state = errors.length > 0 ? "failed" : "idle";
    if (errors.length > 0) throw new AggregateError(errors, "Plugin host shutdown completed with errors");
  }
}
