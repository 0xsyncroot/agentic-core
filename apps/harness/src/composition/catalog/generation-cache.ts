import { AgenticError, type CatalogReleaseContent, type RuntimeSnapshot } from "@0xsyncroot/contracts";
import { PluginHost, type RuntimeSnapshotLease, type RuntimeSnapshotSource } from "@0xsyncroot/core";
import type { PluginDescriptor, ScopedCapabilityResolver } from "@0xsyncroot/plugin-sdk";
import { generationIdentityDescriptor, type GenerationIdentity } from "./generation-route.js";
import type { InfraExports } from "./infra-exports.js";

/** What a generation is built from. `infra` is the generation's own lease on the infra host, held until it shuts down. */
export interface GenerationRequest {
  readonly identity: GenerationIdentity;
  readonly content: CatalogReleaseContent;
  readonly infra: RuntimeSnapshotLease;
}

/** The plugins of one generation besides the identity and infra exports, and what runs around their host. */
export interface GenerationPlan {
  readonly descriptors: readonly PluginDescriptor[];
  readonly verifyArtifact: (descriptor: PluginDescriptor) => Promise<boolean>;
  /** Runs once the host is active; a throw fails the build and shuts the host down. */
  readonly activated?: (host: { readonly snapshot: RuntimeSnapshot; readonly capabilities: ScopedCapabilityResolver }) => Promise<void> | void;
  /** Runs after the host shut down, on eviction, on close and after a failed `activated`. */
  readonly dispose?: () => Promise<void>;
}

export type GenerationAssembler = (request: GenerationRequest) => Promise<GenerationPlan>;

/** What a build reads from the catalog: the release and the switches the generation serves. */
export interface GenerationSource {
  readonly content: CatalogReleaseContent;
  readonly switchesHash: string;
}

export type GenerationLoader = () => Promise<GenerationSource>;

export interface GenerationCacheOptions {
  readonly infra: RuntimeSnapshotSource;
  /** The infra host's plugins as each generation re-exports them, in the places the single-host composition gives them. */
  readonly infraExports: InfraExports;
  readonly assemble: GenerationAssembler;
  /** How many generations stay built. Pinned ones and ones with leases are kept above it until they become evictable. */
  readonly maxGenerations: number;
  /** Where a shutdown of an evicted generation reports its failure; nothing waits on it. */
  readonly onShutdownFailure: (error: unknown) => void;
}

interface Generation {
  readonly key: string;
  readonly identity: GenerationIdentity;
  readonly host: PluginHost;
  readonly plan: GenerationPlan;
  readonly infra: RuntimeSnapshotLease;
  leases: number;
  used: number;
}

/** A lease on one generation, released exactly once. */
export interface GenerationLease extends RuntimeSnapshotLease {
  readonly identity: GenerationIdentity;
}

export const generationKey = (agentId: string, releaseId: string, switchesHash: string): string =>
  JSON.stringify([agentId, releaseId, switchesHash]);

/**
 * The built generations of a pod: one `PluginHost` per (agent, release, switches), built once however many requests ask
 * for it at the same time, kept in least-recently-used order under `maxGenerations`. A pinned generation (what a channel
 * serves) and a generation with a live lease are never evicted; an evicted one is removed before it shuts down, so no new
 * lease reaches a host that is draining.
 */
export class GenerationCache {
  readonly #ready = new Map<string, Generation>();
  readonly #building = new Map<string, Promise<Generation>>();
  #pinned: ReadonlySet<string> = new Set();
  readonly #stopping = new Set<Promise<void>>();
  #clock = 0;
  #closed = false;

  constructor(private readonly options: GenerationCacheOptions) {
    if (!Number.isInteger(options.maxGenerations) || options.maxGenerations < 1) {
      throw new AgenticError("validation", "maxGenerations must be a positive integer");
    }
  }

  /** The keys that must stay built, for example the release each channel serves. */
  pin(keys: ReadonlySet<string>): void {
    this.#pinned = keys;
    this.#evict();
  }

  /** The snapshot id of a built generation, without leasing it. */
  snapshotId(key: string): string | undefined {
    return this.#ready.get(key)?.host.snapshot.id;
  }

  /**
   * Builds the generation when it is not built yet (one build per key at a time) and returns once it is ready. `load`
   * reads the release only when a build is needed. `timeoutMs` bounds the wait, not the build: a build that outlives it
   * still lands in the cache for the next request.
   */
  async ensure(key: string, load: GenerationLoader, timeoutMs?: number): Promise<void> {
    if (this.#ready.has(key)) return;
    await this.#withTimeout(this.#build(key, load), timeoutMs);
  }

  /** Leases a generation `ensure` made ready; building it again first when it was evicted in between. */
  async lease(key: string, load: GenerationLoader, timeoutMs?: number): Promise<GenerationLease> {
    for (;;) {
      const generation = this.#ready.get(key);
      if (generation) return this.#lease(generation);
      await this.#withTimeout(this.#build(key, load), timeoutMs);
    }
  }

  /** Waits for builds in flight, then shuts every generation down; later calls are refused. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#building.values()]);
    const generations = [...this.#ready.values()];
    this.#ready.clear();
    const results = await Promise.allSettled([...generations.map((generation) => this.#shutdown(generation)), ...this.#stopping]);
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length > 0) throw new AggregateError(errors, "Catalog generations shut down with errors");
  }

  #lease(generation: Generation): GenerationLease {
    const lease = generation.host.acquireSnapshot();
    generation.leases += 1;
    generation.used = ++this.#clock;
    let released = false;
    return Object.freeze({
      identity: generation.identity,
      snapshot: lease.snapshot,
      capabilities: lease.capabilities,
      release: () => {
        if (released) return;
        released = true;
        lease.release();
        generation.leases -= 1;
        this.#evict();
      },
    });
  }

  #build(key: string, load: GenerationLoader): Promise<Generation> {
    if (this.#closed) return Promise.reject(new AgenticError("transient", "Catalog generations are closed", true));
    const inFlight = this.#building.get(key);
    if (inFlight) return inFlight;
    const build = this.#assemble(key, load).then((generation) => {
      if (this.#closed) {
        void this.#shutdown(generation).catch(this.options.onShutdownFailure);
        throw new AgenticError("transient", "Catalog generations are closed", true);
      }
      generation.used = ++this.#clock;
      // Eviction waits for the next released lease or pin change, so the build is not evicted before its caller leases it.
      this.#ready.set(key, generation);
      return generation;
    }).finally(() => this.#building.delete(key));
    this.#building.set(key, build);
    return build;
  }

  async #assemble(key: string, load: GenerationLoader): Promise<Generation> {
    const infra = this.options.infra.acquireSnapshot();
    let host: PluginHost | undefined;
    let plan: GenerationPlan | undefined;
    try {
      const { content, switchesHash } = await load();
      const { agentId, releaseId, manifestHash } = content.release;
      const request: GenerationRequest = { identity: { agentId, releaseId, manifestHash, infraSnapshotId: infra.snapshot.id, switchesHash },
        content, infra };
      plan = await this.options.assemble(request);
      host = new PluginHost({ policyRevisions: { policy: infra.snapshot.policyRevision, memoryPolicy: infra.snapshot.memoryPolicyRevision } });
      // The exports carry the infra plugins' own manifests, so the plan's verifier checks them as the single host checks them.
      await host.activate([generationIdentityDescriptor(request.identity), ...this.options.infraExports.exports(), ...plan.descriptors], {
        security: { tenantId: "platform-bootstrap", actorId: "platform-bootstrap", permissions: new Set(),
          correlationId: crypto.randomUUID(), purpose: "platform-bootstrap" },
        verifyArtifact: plan.verifyArtifact,
      });
      await plan.activated?.({ snapshot: host.snapshot, capabilities: host.capabilities });
      return { key, identity: request.identity, host, plan, infra, leases: 0, used: 0 };
    } catch (error) {
      const errors: unknown[] = [error];
      try { await host?.shutdown(); } catch (cleanup) { errors.push(cleanup); }
      try { await plan?.dispose?.(); } catch (cleanup) { errors.push(cleanup); }
      infra.release();
      if (errors.length > 1) throw new AggregateError(errors, "Catalog generation build and cleanup both failed");
      throw error;
    }
  }

  #evict(): void {
    const evictable = () => [...this.#ready.values()]
      .filter((generation) => generation.leases === 0 && !this.#pinned.has(generation.key))
      .sort((left, right) => left.used - right.used);
    while (this.#ready.size > this.options.maxGenerations) {
      const oldest = evictable()[0];
      if (!oldest) return;
      this.#ready.delete(oldest.key);
      const stopping = this.#shutdown(oldest).catch(this.options.onShutdownFailure).finally(() => this.#stopping.delete(stopping));
      this.#stopping.add(stopping);
    }
  }

  async #shutdown(generation: Generation): Promise<void> {
    const errors: unknown[] = [];
    try { await generation.host.shutdown(); } catch (error) { errors.push(error); }
    try { await generation.plan.dispose?.(); } catch (error) { errors.push(error); }
    generation.infra.release();
    if (errors.length > 0) throw new AggregateError(errors, `Catalog generation ${generation.key} shut down with errors`);
  }

  async #withTimeout<T>(operation: Promise<T>, timeoutMs: number | undefined): Promise<T> {
    if (timeoutMs === undefined) return operation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AgenticError("transient",
        `The catalog generation was not built within ${timeoutMs} ms; try again`, true)), timeoutMs);
    });
    try { return await Promise.race([operation, expired]); }
    finally { clearTimeout(timer); }
  }
}
