import { AgenticError, type ContextualToolDiscoveryContext, type SecurityContext } from "@0xsyncroot/contracts";
import { digest, McpToolRefusal, principalBinding } from "./shared.js";
import type { McpClientPort, McpPrincipalAuthorization, McpPrincipalAuthorizationResolver } from "./types.js";
import { recoverMcpRead } from "./read-recovery.js";

interface PoolEntry {
  readonly client: Promise<McpClientPort>;
  references: number;
  lastUsedAt: number;
  retired: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class PrincipalClientPool {
  readonly #entries = new Map<string, PoolEntry>();
  #closed = false;

  constructor(
    private readonly serverId: string,
    private readonly endpoint: string,
    private readonly authorizationResolver: McpPrincipalAuthorizationResolver,
    private readonly clientFactory: (authorization: McpPrincipalAuthorization) => Promise<McpClientPort>,
    private readonly idleTtlMs: number,
    private readonly maxConnections: number,
  ) {}

  get size(): number { return this.#entries.size; }

  async use<T>(
    context: ContextualToolDiscoveryContext | { security: SecurityContext; agentProfileId?: string },
    signal: AbortSignal,
    operation: (client: McpClientPort) => Promise<T>,
    readOnly = false,
    retry = true,
  ): Promise<T> {
    return recoverMcpRead(() => this.#useOnce(context, signal, operation), signal, readOnly, retry);
  }

  async #useOnce<T>(
    context: ContextualToolDiscoveryContext | { security: SecurityContext; agentProfileId?: string },
    signal: AbortSignal,
    operation: (client: McpClientPort) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) throw new AgenticError("conflict", `MCP client pool ${this.serverId} is closed`);
    if (signal.aborted) throw signal.reason;
    const authorization = await this.authorizationResolver.resolve({
      serverId: this.serverId, endpoint: this.endpoint, security: context.security,
      agentProfileId: context.agentProfileId ?? "default",
    }, signal);
    const partition = authorization.partition.trim();
    if (!partition || partition.length > 256) throw new AgenticError("validation", "MCP authorization partition is invalid");
    const key = digest({
      serverId: this.serverId,
      principal: principalBinding(context.security),
      agentProfileId: context.agentProfileId ?? "default",
      partition,
    });
    let entry = this.#entries.get(key);
    if (!entry) {
      await this.#makeRoom();
      entry = { client: this.clientFactory(authorization), references: 0, lastUsedAt: Date.now(), retired: false };
      this.#entries.set(key, entry);
      void entry.client.catch(() => { if (this.#entries.get(key) === entry) this.#entries.delete(key); });
    }
    if (entry.timer) clearTimeout(entry.timer);
    delete entry.timer;
    entry.references += 1;
    try {
      const client = await entry.client;
      signal.throwIfAborted();
      return await operation(client);
    } catch (error) {
      // A refusal is the server answering: the client stays pooled. Anything else may have broken it.
      if (!(error instanceof McpToolRefusal)) {
        entry.retired = true;
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
      }
      throw error;
    } finally {
      entry.references -= 1;
      entry.lastUsedAt = Date.now();
      if (entry.references === 0 && entry.retired) {
        await entry.client.then((client) => client.close()).catch(() => undefined);
      } else if (this.#entries.get(key) === entry && entry.references === 0) {
        entry.timer = setTimeout(() => { void this.#evict(key, entry as PoolEntry); }, this.idleTtlMs);
        entry.timer.unref?.();
      }
    }
  }

  async #makeRoom(): Promise<void> {
    if (this.#entries.size < this.maxConnections) return;
    const idle = [...this.#entries.entries()]
      .filter(([, entry]) => entry.references === 0)
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
    if (!idle) throw new AgenticError("budget-exceeded", `MCP connection pool ${this.serverId} is full`);
    await this.#evict(idle[0], idle[1]);
  }

  async #evict(key: string, entry: PoolEntry): Promise<void> {
    if (this.#entries.get(key) !== entry) return;
    this.#entries.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    await entry.client.then((client) => client.close()).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map(async (entry) => {
      if (entry.timer) clearTimeout(entry.timer);
      await entry.client.then((client) => client.close()).catch(() => undefined);
    }));
  }
}
