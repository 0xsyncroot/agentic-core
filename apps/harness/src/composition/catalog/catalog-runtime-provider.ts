import { AgenticError, type CatalogChannelName, type CatalogReader } from "@0xsyncroot/contracts";
import type { RuntimeProvider, RuntimeResolutionRequest, RuntimeViewLease } from "@0xsyncroot/core";
import { GenerationCache, generationKey, type GenerationCacheOptions, type GenerationLease, type GenerationLoader } from "./generation-cache.js";
import { generationRouteRevision, NO_TOOL_SWITCHES_HASH, parseGenerationRoute } from "./generation-route.js";

export interface CatalogRuntimeProviderOptions extends Omit<GenerationCacheOptions, "onShutdownFailure"> {
  readonly reader: CatalogReader;
  /** The agents this deployment serves; an agent profile id outside the list is denied before the catalog is read. */
  readonly agentIds: readonly string[];
  /** The deploy part of every route revision (infra, policy and model revisions); a pin from another deploy leases live. */
  readonly routeRevision: string;
  /** How often the channels are read again; a hint reads them at once. */
  readonly pollIntervalMs: number;
  /** How long a turn waits for a generation it has to build; longer is a retryable error and the build carries on. */
  readonly buildTimeoutMs: number;
  /** Calls `onHint` when a channel may have moved; returns how to stop. */
  readonly subscribeHints?: (onHint: () => void) => () => void;
  /** Where a failed channel read, generation build or eviction shutdown is reported; the provider keeps serving what it has. */
  readonly onBackgroundFailure: (error: unknown) => void;
}

interface ChannelPointer {
  readonly releaseId: string;
  readonly version: number;
}

const CHANNELS: readonly CatalogChannelName[] = ["staging", "live"];

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new AgenticError("validation", `${label} cannot be empty`);
  return normalized;
}

function staleBinding(message: string): AgenticError {
  return new AgenticError("conflict", message, false, { reason: "stale-binding" });
}

/**
 * Routes each authenticated tenant of a listed agent to the generation built from the release its channel serves. A tenant
 * with no binding of its own gets the live channel with no tool switches. A resumed turn names the route its pause was
 * bound to: when that route is one of this deploy's, the release is read again by key and served, rebuilt when needed, unless
 * it was revoked (stale binding); any other pin gets live, which the resume's snapshot check then refuses as stale.
 */
export class CatalogRuntimeProvider implements RuntimeProvider {
  readonly #options: CatalogRuntimeProviderOptions;
  readonly #agents: ReadonlySet<string>;
  readonly #routeRevision: string;
  readonly #cache: GenerationCache;
  readonly #channels = new Map<string, Map<CatalogChannelName, ChannelPointer>>();
  readonly #pending = new Set<string>();
  #refreshing: Promise<void> | undefined;
  #again = false;
  #interval: ReturnType<typeof setInterval> | undefined;
  #unsubscribe: (() => void) | undefined;
  #closed = false;

  constructor(options: CatalogRuntimeProviderOptions) {
    this.#options = options;
    this.#routeRevision = required(options.routeRevision, "routeRevision");
    if (options.agentIds.length === 0) throw new AgenticError("validation", "A catalog runtime serves at least one agent");
    this.#agents = new Set(options.agentIds.map((agentId) => required(agentId, "agentId")));
    for (const [label, value] of [["pollIntervalMs", options.pollIntervalMs], ["buildTimeoutMs", options.buildTimeoutMs]] as const) {
      if (!Number.isInteger(value) || value < 1) throw new AgenticError("validation", `${label} must be a positive integer`);
    }
    this.#cache = new GenerationCache({ infra: options.infra, infraExports: options.infraExports, assemble: options.assemble,
      maxGenerations: options.maxGenerations, onShutdownFailure: options.onBackgroundFailure });
  }

  /** Builds what every channel of every listed agent serves, then follows the channels; an agent without a live release fails. */
  async start(): Promise<void> {
    await this.refresh();
    const missing = [...this.#agents].filter((agentId) => !this.#channels.get(agentId)?.has("live"));
    if (missing.length > 0) throw new AgenticError("permanent", `No live release could be served for agent ${missing.join(", ")}`);
    this.#interval = setInterval(() => void this.refresh(), this.#options.pollIntervalMs);
    this.#interval.unref?.();
    this.#unsubscribe = this.#options.subscribeHints?.(() => void this.refresh());
  }

  /** Reads every channel again; calls during a read coalesce into one more read after it. */
  refresh(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#refreshing) {
      this.#again = true;
      return this.#refreshing;
    }
    const run = async () => {
      do {
        this.#again = false;
        await Promise.all([...this.#agents].map((agentId) => this.#refreshAgent(agentId)));
      } while (this.#again && !this.#closed);
    };
    this.#refreshing = run().finally(() => { this.#refreshing = undefined; });
    return this.#refreshing;
  }

  async acquireRuntime(request: RuntimeResolutionRequest): Promise<RuntimeViewLease> {
    const tenantId = required(request.security.tenantId, "tenantId");
    if (!request.security.authentication) {
      throw new AgenticError("denied", "Catalog runtime routing requires authenticated identity evidence");
    }
    const agentId = required(request.agentProfileId ?? "default", "agentProfileId");
    if (!this.#agents.has(agentId)) throw new AgenticError("denied", `No catalog runtime is assigned to agent profile ${agentId}`);
    const switchesHash = NO_TOOL_SWITCHES_HASH;
    const releaseId = await this.#pinnedRelease(agentId, switchesHash, request.pin) ?? this.#live(agentId);
    const lease = await this.#cache.lease(generationKey(agentId, releaseId, switchesHash),
      this.#loader(agentId, releaseId, switchesHash), this.#options.buildTimeoutMs);
    return this.#view(lease, tenantId);
  }

  /** The snapshot id of the generation an agent's live channel serves, when it is built. */
  liveSnapshotId(agentId: string): string | undefined {
    const live = this.#channels.get(agentId)?.get("live");
    return live ? this.#cache.snapshotId(generationKey(agentId, live.releaseId, NO_TOOL_SWITCHES_HASH)) : undefined;
  }

  /** Stops following the channels and shuts every generation down. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#interval) clearInterval(this.#interval);
    this.#unsubscribe?.();
    await this.#refreshing;
    await this.#cache.close();
  }

  /** The release a pin names when this deploy can serve it again; a revoked one is refused, anything else falls to live. */
  async #pinnedRelease(agentId: string, switchesHash: string, pin: string | undefined): Promise<string | undefined> {
    if (pin === undefined) return undefined;
    const route = parseGenerationRoute(this.#routeRevision, pin);
    if (!route || route.switchesHash !== switchesHash) return undefined;
    const release = await this.#options.reader.getRelease(agentId, route.releaseId);
    if (!release) return undefined;
    if (release.status === "revoked") throw staleBinding(`Release ${route.releaseId} was revoked after the operation paused`);
    return release.releaseId;
  }

  #live(agentId: string): string {
    const live = this.#channels.get(agentId)?.get("live");
    if (!live) throw new AgenticError("transient", `No live release is served for agent ${agentId} yet`, true);
    return live.releaseId;
  }

  #loader(agentId: string, releaseId: string, switchesHash: string): GenerationLoader {
    return async () => {
      const content = await this.#options.reader.releaseContent(agentId, releaseId);
      if (!content) throw new AgenticError("permanent", `Release ${releaseId} of agent ${agentId} does not exist`);
      if (content.release.status === "revoked") throw staleBinding(`Release ${releaseId} of agent ${agentId} is revoked`);
      return { content, switchesHash };
    };
  }

  async #refreshAgent(agentId: string): Promise<void> {
    let channels;
    try { channels = await this.#options.reader.channels(agentId); }
    catch (error) { this.#options.onBackgroundFailure(error); return; }
    const pointers = this.#channels.get(agentId) ?? new Map<CatalogChannelName, ChannelPointer>();
    this.#channels.set(agentId, pointers);
    await Promise.all(channels.filter((channel) => CHANNELS.includes(channel.channel)).map(async (channel) => {
      const known = pointers.get(channel.channel);
      if (known && known.version >= channel.version) return;
      const key = generationKey(agentId, channel.releaseId, NO_TOOL_SWITCHES_HASH);
      this.#pending.add(key);
      this.#pin();
      try {
        await this.#cache.ensure(key, this.#loader(agentId, channel.releaseId, NO_TOOL_SWITCHES_HASH));
        const current = pointers.get(channel.channel);
        if (!current || current.version < channel.version) {
          pointers.set(channel.channel, { releaseId: channel.releaseId, version: channel.version });
        }
      } catch (error) {
        this.#options.onBackgroundFailure(error);
      } finally {
        this.#pending.delete(key);
        this.#pin();
      }
    }));
  }

  /** Keeps every release a channel serves, and every one being built for a channel, out of eviction. */
  #pin(): void {
    const keys = new Set(this.#pending);
    for (const [agentId, pointers] of this.#channels) {
      for (const pointer of pointers.values()) keys.add(generationKey(agentId, pointer.releaseId, NO_TOOL_SWITCHES_HASH));
    }
    this.#cache.pin(keys);
  }

  #view(lease: GenerationLease, tenantId: string): RuntimeViewLease {
    const { agentId, releaseId, switchesHash } = lease.identity;
    return Object.freeze({
      snapshot: lease.snapshot,
      capabilities: lease.capabilities,
      binding: Object.freeze({
        tenantId,
        agentProfileId: agentId,
        routeRevision: generationRouteRevision(this.#routeRevision, { releaseId, switchesHash }),
        runtimeSnapshotId: lease.snapshot.id,
      }),
      release: lease.release,
    });
  }
}
