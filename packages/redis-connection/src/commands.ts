/**
 * The Redis commands this codebase needs, with node-redis argument shapes, and nothing else.
 *
 * Callers depend on this surface instead of `RedisClientType`, `RedisClusterType` or
 * `RedisSentinelType`, so one call site runs on a single node, a Redis Cluster or Sentinel.
 * In cluster mode a command with keys goes to the node owning the key's slot; the callers keep
 * every multi-key command inside one hash tag, so that is always one node.
 */
export interface RedisScriptArgs { readonly keys?: readonly string[]; readonly arguments?: readonly string[] }
export interface RedisSetOptions { readonly PX?: number; readonly EX?: number; readonly NX?: boolean }
export interface RedisZRangeOptions { readonly BY?: "LEX" | "SCORE"; readonly REV?: boolean; readonly LIMIT?: { readonly offset: number; readonly count: number } }

export interface RedisCommands {
  readonly isOpen: boolean;
  eval(script: string, options: RedisScriptArgs): Promise<unknown>;
  evalSha(sha: string, options: RedisScriptArgs): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<string | null>;
  getDel(key: string): Promise<string | null>;
  expire(key: string, seconds: number): Promise<unknown>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  hGet(key: string, field: string): Promise<string | undefined | null>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hmGet(key: string, fields: readonly string[]): Promise<(string | null)[]>;
  zAdd(key: string, member: { readonly score: number; readonly value: string }): Promise<unknown>;
  zRange(key: string, min: string | number, max: string | number, options?: RedisZRangeOptions): Promise<string[]>;
  zRem(key: string, member: string): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
  /** Resolves when the connection answers; in cluster mode every master answers. */
  ping(): Promise<unknown>;
}

export interface RedisSubscriber {
  readonly isOpen: boolean;
  /**
   * Whether the subscription socket can deliver messages now. `isOpen` stays true while node-redis
   * reconnects, and a message published meanwhile is lost (Pub/Sub is at-most-once), so a cache that
   * trusts invalidations must know this. Absent where it cannot be known (cluster, test doubles).
   */
  readonly isReady?: boolean;
  /** Every change of the subscription socket — ready after (re)connecting, reconnecting, end. Returns the remover. */
  onStateChange?(listener: (state: "ready" | "reconnecting" | "end") => void): () => void;
  subscribe(channel: string, listener: (message: string) => void): Promise<void>;
  unsubscribe(channel: string, listener: (message: string) => void): Promise<void>;
  destroy(): void;
}
