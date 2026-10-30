import { createClient, createCluster, createSentinel } from "redis";
import type { RedisCommands, RedisSubscriber } from "./commands.js";
import { parseRedisUrl, type RedisMode, type RedisTarget } from "./parse-url.js";

export interface ConnectRedisOptions {
  /** Names the caller in errors, e.g. "Billing queue" gives "Billing queue Redis requires rediss://...". */
  readonly purpose: string;
  /** Allows plaintext (`redis…://`). The payloads are tenant data, so plaintext is a deployment decision. */
  readonly allowInsecureInternal: boolean;
  readonly connectTimeoutMs?: number;
  readonly onError?: (error: Error) => void;
}

export interface RedisConnection {
  readonly mode: RedisMode;
  readonly commands: RedisCommands;
  readonly isOpen: boolean;
  /** A second connection to the same topology, connected, for SUBSCRIBE (a subscribed connection takes no commands). */
  subscriber(): Promise<RedisSubscriber>;
  /** Drops the connection at once; commands still queued are rejected. */
  destroy(): void;
  /**
   * Waits up to `flushMs` for the commands already issued to get their replies, then drops the
   * connection. `destroy()` rejects what is still queued, and the command most likely to be queued
   * at shutdown is a turn's terminal write. Nothing issued after `close()` starts is waited for.
   */
  close(flushMs?: number): Promise<void>;
}

// node-redis types a client, a cluster and a sentinel differently; the surface in commands.ts is the common part.
interface Node {
  isOpen: boolean;
  connect(): Promise<unknown>;
  on(event: "error", listener: (error: unknown) => void): unknown;
  destroy(): unknown;
  duplicate(): Node;
}
type Anyway = Node & RedisCommands & RedisSubscriber;

/** Checks the URL and the TLS rule without connecting. */
export function checkRedisUrl(url: string, options: Pick<ConnectRedisOptions, "purpose" | "allowInsecureInternal">): RedisTarget {
  let target: RedisTarget;
  try { target = parseRedisUrl(url); } catch (error) {
    throw new Error(`${options.purpose} ${error instanceof Error ? error.message : "Redis URL is invalid"}`);
  }
  if (!target.tls && !options.allowInsecureInternal) {
    throw new Error(`${options.purpose} Redis requires rediss:// unless allowInsecureInternal is explicitly enabled (Cluster and Sentinel: rediss+cluster://, rediss+sentinel://)`);
  }
  return target;
}

function build(target: RedisTarget, connectTimeout: number): Node {
  const socket = { connectTimeout, ...(target.tls ? { tls: true as const } : {}) };
  const auth = {
    ...(target.username !== undefined ? { username: target.username } : {}),
    ...(target.password !== undefined ? { password: target.password } : {}),
  };
  if (target.mode === "standalone") return createClient({ url: target.url!, socket: { connectTimeout } }) as unknown as Node;
  if (target.mode === "cluster") {
    return createCluster({
      rootNodes: target.nodes.map((node) => ({ socket: { host: node.host, port: node.port, ...socket }, ...auth })),
      defaults: { ...auth, socket },
    }) as unknown as Node;
  }
  return createSentinel({
    name: target.masterName!,
    sentinelRootNodes: [...target.nodes],
    nodeClientOptions: { ...auth, ...(target.database !== undefined ? { database: target.database } : {}), socket },
    sentinelClientOptions: {
      ...(target.sentinelUsername !== undefined ? { username: target.sentinelUsername } : {}),
      ...(target.sentinelPassword !== undefined ? { password: target.sentinelPassword } : {}),
      socket,
    },
  }) as unknown as Node;
}

/**
 * node-redis `connect()` retries forever while the server is unreachable, so the wait is bounded
 * here and the half-open client is destroyed.
 */
async function open(node: Node, timeoutMs: number, purpose: string): Promise<void> {
  const connecting = node.connect();
  connecting.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([connecting, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${purpose} Redis did not connect within ${timeoutMs}ms`)), timeoutMs);
    })]);
  } catch (error) {
    try { node.destroy(); } catch { /* already closed */ }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const COMMAND_NAMES = [
  "eval", "evalSha", "get", "set", "getDel", "expire", "lRange", "hGet", "hGetAll", "hmGet", "zAdd", "zRange", "zRem", "publish", "ping",
] as const;

/**
 * Counts commands that were issued and not yet answered. In cluster and sentinel mode a command is
 * routed asynchronously and replies from different nodes are unordered, so a PING cannot stand in
 * for "everything before me has been answered" as it does on one connection.
 */
function tracked(node: Anyway, mode: RedisMode): { commands: RedisCommands; settled(): Promise<void> } {
  let inFlight = 0; let waiting: Array<() => void> = [];
  const done = () => { inFlight -= 1; if (inFlight === 0) { const wake = waiting; waiting = []; for (const resume of wake) resume(); } };
  const commands: Record<string, unknown> = {};
  for (const name of COMMAND_NAMES) {
    commands[name] = (...args: unknown[]) => {
      inFlight += 1;
      // A cluster publish goes through the channel's slot (sharded Pub/Sub, Redis 7+): its reply then
      // counts the subscribers that matter. A plain PUBLISH there reports only the node it reached.
      const method = mode === "cluster" && name === "publish" ? "sPublish" : name;
      const result = (node[method as keyof Anyway] as (...a: unknown[]) => Promise<unknown>)(...args);
      result.then(done, done);
      return result;
    };
  }
  Object.defineProperty(commands, "isOpen", { get: () => node.isOpen });
  return { commands: commands as unknown as RedisCommands, settled: () => inFlight === 0 ? Promise.resolve() : new Promise((resolve) => { waiting.push(resolve); }) };
}

/** One server's subscriber connection, which also says when it is between connections. */
function standaloneSubscriber(node: Anyway): RedisSubscriber {
  const events = node as unknown as {
    readonly isReady: boolean;
    on(event: "ready" | "reconnecting" | "end", listener: () => void): unknown;
    off(event: "ready" | "reconnecting" | "end", listener: () => void): unknown;
  };
  return {
    get isOpen() { return node.isOpen; },
    get isReady() { return events.isReady; },
    onStateChange(listener) {
      const states = ["ready", "reconnecting", "end"] as const;
      const handlers = states.map((state) => [state, () => listener(state)] as const);
      for (const [state, handler] of handlers) events.on(state, handler);
      return () => { for (const [state, handler] of handlers) events.off(state, handler); };
    },
    subscribe: (channel, listener) => node.subscribe(channel, listener),
    unsubscribe: (channel, listener) => node.unsubscribe(channel, listener),
    destroy: () => { void Promise.resolve(node.destroy()).catch(() => undefined); },
  };
}

/** Subscribes through the channel's slot, matching the sharded publish above. */
function shardedSubscriber(node: Anyway): RedisSubscriber {
  const sharded = node as unknown as {
    sSubscribe(channel: string, listener: (message: string) => void): Promise<void>;
    sUnsubscribe(channel: string, listener: (message: string) => void): Promise<void>;
  };
  return {
    get isOpen() { return node.isOpen; },
    subscribe: (channel, listener) => sharded.sSubscribe(channel, listener),
    unsubscribe: (channel, listener) => sharded.sUnsubscribe(channel, listener),
    destroy: () => { void Promise.resolve(node.destroy()).catch(() => undefined); },
  };
}

export async function connectRedis(url: string, options: ConnectRedisOptions): Promise<RedisConnection> {
  const timeout = options.connectTimeoutMs ?? 5_000;
  if (!Number.isInteger(timeout) || timeout < 250 || timeout > 30_000) throw new Error("connectTimeoutMs is invalid");
  const target = checkRedisUrl(url, options);
  const report = (error: unknown) => options.onError?.(error instanceof Error ? error : new Error(`${options.purpose} Redis failed`));
  const node = build(target, timeout);
  node.on("error", report);
  await open(node, timeout, options.purpose);
  const { commands, settled } = tracked(node as unknown as Anyway, target.mode);
  return {
    mode: target.mode,
    commands,
    get isOpen() { return node.isOpen; },
    async subscriber(): Promise<RedisSubscriber> {
      const second = node.duplicate();
      second.on("error", report);
      await open(second, timeout, options.purpose);
      return target.mode === "cluster" ? shardedSubscriber(second as unknown as Anyway) : standaloneSubscriber(second as unknown as Anyway);
    },
    destroy() { if (node.isOpen) void Promise.resolve(node.destroy()).catch(() => undefined); },
    async close(flushMs = 2_000) {
      if (!node.isOpen) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([settled(), new Promise((resolve) => { timer = setTimeout(resolve, flushMs); timer.unref(); })]);
      clearTimeout(timer);
      if (node.isOpen) await node.destroy();
    },
  };
}
