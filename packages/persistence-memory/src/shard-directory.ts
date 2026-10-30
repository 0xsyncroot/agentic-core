import { DEFAULT_SHARD_ID, reviewIdentifier, type ShardDirectory, type ShardEntry } from "@0xsyncroot/contracts";
import { freezeDeep } from "./freeze.js";

export interface InMemoryShardDirectoryOptions {
  readonly shards?: readonly ShardEntry[];
  /** Tenant id to shard id. */
  readonly routes?: ReadonlyMap<string, string>;
  readonly mapVersion?: number;
}

/** Fixed shard routing given at construction; with no shard registered, the default shard alone serves every tenant. */
export class InMemoryShardDirectory implements ShardDirectory {
  readonly #shards: readonly ShardEntry[];
  constructor(private readonly options: InMemoryShardDirectoryOptions = {}) {
    this.#shards = freezeDeep([...(options.shards ?? [])].sort((left, right) => (left.shardId < right.shardId ? -1 : left.shardId > right.shardId ? 1 : 0)));
  }

  async shards(): Promise<readonly ShardEntry[]> {
    return this.#shards.length > 0 ? this.#shards : [{ shardId: DEFAULT_SHARD_ID, status: "active", weight: 100 }];
  }

  async shardOf(tenantId: string): Promise<string> {
    return this.options.routes?.get(reviewIdentifier(tenantId, "tenantId", 191)) ?? DEFAULT_SHARD_ID;
  }

  async mapVersion(): Promise<number> {
    return this.options.mapVersion ?? 0;
  }
}
