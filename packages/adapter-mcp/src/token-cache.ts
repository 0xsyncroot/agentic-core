/**
 * A tiny LRU cache of exchanged MCP access tokens, one entry per cache key (a principal/server/
 * profile digest). Coalesces concurrent lookups for the same key into a single in-flight exchange,
 * so a burst of parallel tool calls from one principal never triggers a burst of exchanges.
 */

export interface CachedMcpToken {
  readonly accessToken: string;
  readonly partition: string;
}

export interface ExchangedMcpToken extends CachedMcpToken {
  /** Absolute time, already skew-adjusted, past which the entry is treated as unusable. */
  readonly expiresAt: number;
}

interface Entry {
  accessToken: string;
  partition: string;
  expiresAt: number;
  inFlight?: Promise<CachedMcpToken>;
}

export class McpTokenCache {
  readonly #entries = new Map<string, Entry>();
  readonly #maxEntries: number;

  constructor(maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new Error("MCP token cache size must be a positive integer");
    this.#maxEntries = maxEntries;
  }

  /** Returns the live token for `key`, exchanging (or joining an in-flight exchange) only when needed. */
  get(key: string, exchange: () => Promise<ExchangedMcpToken>): Promise<CachedMcpToken> {
    const existing = this.#entries.get(key);
    if (existing?.inFlight) return existing.inFlight;
    if (existing && existing.expiresAt > Date.now()) {
      this.#touch(key);
      return Promise.resolve({ accessToken: existing.accessToken, partition: existing.partition });
    }
    return this.#refresh(key, exchange);
  }

  /** Forces one fresh exchange, joining any exchange already in flight for `key` instead of starting a second one. */
  forceRefresh(key: string, exchange: () => Promise<ExchangedMcpToken>): Promise<CachedMcpToken> {
    const existing = this.#entries.get(key);
    if (existing?.inFlight) return existing.inFlight;
    return this.#refresh(key, exchange);
  }

  #refresh(key: string, exchange: () => Promise<ExchangedMcpToken>): Promise<CachedMcpToken> {
    const placeholder: Entry = this.#entries.get(key) ?? { accessToken: "", partition: "", expiresAt: 0 };
    const inFlight: Promise<CachedMcpToken> = exchange().then(
      (token) => {
        placeholder.accessToken = token.accessToken;
        placeholder.partition = token.partition;
        placeholder.expiresAt = token.expiresAt;
        delete placeholder.inFlight;
        this.#touch(key);
        this.#evictOverflow();
        return { accessToken: token.accessToken, partition: token.partition };
      },
      (error) => {
        // A broken exchange must not stick around as a poisoned cache entry: drop it so the next
        // attempt exchanges again instead of forever returning the same failure.
        if (this.#entries.get(key) === placeholder) this.#entries.delete(key);
        throw error;
      },
    );
    placeholder.inFlight = inFlight;
    this.#entries.set(key, placeholder);
    return inFlight;
  }

  #touch(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    this.#entries.set(key, entry); // Map insertion order doubles as LRU order.
  }

  #evictOverflow(): void {
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
