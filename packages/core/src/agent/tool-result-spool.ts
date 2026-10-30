import type { JsonValue, ToolResultScope, ToolResultSpool } from "@0xsyncroot/contracts";

interface Stored { readonly toolId: string; readonly value: JsonValue; readonly scope: string; readonly chars: number; readonly storedAt: number }

export interface InMemoryToolResultSpoolOptions {
  readonly maxEntries?: number;
  readonly maxChars?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/**
 * Keeps cut results in this process's memory, bounded by count, total size and age.
 *
 * Not durable: a restart, or a request landing on another replica, finds nothing, and `read_result`
 * then says so and tells the model to call the original tool again. That is the pilot's trade; a
 * shared store is the same two methods behind {@link ToolResultSpool}.
 */
export class InMemoryToolResultSpool implements ToolResultSpool {
  readonly #entries = new Map<string, Stored>();
  readonly #maxEntries: number;
  readonly #maxChars: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #chars = 0;

  constructor(options: InMemoryToolResultSpoolOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 64;
    this.#maxChars = options.maxChars ?? 24_000_000;
    this.#ttlMs = options.ttlMs ?? 60 * 60_000;
    this.#now = options.now ?? Date.now;
  }

  put(scope: ToolResultScope, entry: { readonly toolId: string; readonly value: JsonValue }): string {
    const id = `res_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const chars = JSON.stringify(entry.value).length;
    this.#entries.set(id, { toolId: entry.toolId, value: entry.value, scope: key(scope), chars, storedAt: this.#now() });
    this.#chars += chars;
    this.#evict();
    return id;
  }

  get(scope: ToolResultScope, id: string): { readonly toolId: string; readonly value: JsonValue } | undefined {
    this.#evict();
    const stored = this.#entries.get(id);
    return stored && stored.scope === key(scope) ? { toolId: stored.toolId, value: stored.value } : undefined;
  }

  list(scope: ToolResultScope): readonly { readonly id: string; readonly toolId: string }[] {
    this.#evict();
    return [...this.#entries].filter(([, stored]) => stored.scope === key(scope)).map(([id, stored]) => ({ id, toolId: stored.toolId }));
  }

  /** Oldest first: expired entries, then whatever keeps the spool over its count or size bound. */
  #evict(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [id, stored] of this.#entries) {
      if (stored.storedAt >= cutoff && this.#entries.size <= this.#maxEntries && this.#chars <= this.#maxChars) break;
      this.#entries.delete(id);
      this.#chars -= stored.chars;
    }
  }
}

function key(scope: ToolResultScope): string {
  return `${scope.tenantId}\u0000${scope.sessionId}`;
}
