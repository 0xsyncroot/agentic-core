import { randomUUID } from "node:crypto";
import { langfuseAuthorizationHeader, type LangfuseConfig } from "./langfuse-config.js";

export interface LangfuseEvent {
  readonly type: "trace-create" | "generation-create" | "generation-update" | "event-create";
  readonly body: Readonly<Record<string, unknown>>;
}

export interface LangfuseIngestion {
  enqueue(event: LangfuseEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface LangfuseClientOptions {
  readonly config: LangfuseConfig;
  /** Supplied by the composition root: an adapter never reads the process environment itself. */
  readonly env: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly onError?: (error: Error, dropped: number) => void;
  readonly now?: () => Date;
}

/**
 * Batched, bounded, best-effort delivery to Langfuse's ingestion endpoint.
 *
 * A tracer sits on the hot path of every model call, so the only acceptable behaviour under
 * failure is to lose traces quietly and keep the turn running: it never blocks, never retries
 * without limit, and never throws into the caller. The queue is bounded for the same reason —
 * an unreachable Langfuse must not become this service's memory leak.
 */
export class LangfuseClient implements LangfuseIngestion {
  readonly #queue: Array<Readonly<Record<string, unknown>>> = [];
  readonly #config: LangfuseConfig;
  readonly #fetch: typeof globalThis.fetch;
  readonly #authorization: string;
  #timer: NodeJS.Timeout | undefined;
  #sending: Promise<void> = Promise.resolve();
  #dropped = 0;
  #closed = false;

  constructor(private readonly options: LangfuseClientOptions) {
    this.#config = options.config;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#authorization = langfuseAuthorizationHeader(options.config, options.env);
  }

  enqueue(event: LangfuseEvent): void {
    if (this.#closed || !this.#config.enabled) return;
    this.#queue.push({
      id: randomUUID(),
      type: event.type,
      timestamp: (this.options.now?.() ?? new Date()).toISOString(),
      body: event.body,
    });
    if (this.#queue.length > this.#config.queue.maxEvents) {
      this.#dropped += this.#queue.length - this.#config.queue.maxEvents;
      this.#queue.splice(0, this.#queue.length - this.#config.queue.maxEvents);
    }
    if (this.#queue.length >= this.#config.batch.maxEvents) { void this.flush(); return; }
    if (this.#timer) return;
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.flush(); }, this.#config.batch.flushIntervalMs);
    this.#timer.unref();
  }

  async flush(): Promise<void> {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    const batch = this.#queue.splice(0, this.#config.batch.maxEvents);
    if (batch.length === 0) return;
    this.#sending = this.#sending.then(() => this.#deliver(batch));
    await this.#sending;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    while (this.#queue.length > 0) await this.flush();
    await this.#sending;
  }

  async #deliver(batch: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
    for (let attempt = 1; attempt <= this.#config.retry.attempts; attempt += 1) {
      try {
        const response = await this.#fetch(`${this.#config.baseUrl}/api/public/ingestion`, {
          method: "POST",
          signal: AbortSignal.timeout(this.#config.timeoutMs),
          redirect: "error",
          headers: { "content-type": "application/json", accept: "application/json", authorization: this.#authorization },
          body: JSON.stringify({ batch }),
        });
        // 207 is Langfuse's partial success: some events were rejected, the rest were stored.
        // Retrying the whole batch would duplicate the stored ones, so it is reported, not retried.
        if (response.status === 207) { this.#report(new Error("Langfuse rejected part of a trace batch"), 0); return; }
        if (!response.ok) throw new Error(`Langfuse ingestion returned HTTP ${response.status}`);
        void response.body?.cancel();
        return;
      } catch (error) {
        if (attempt === this.#config.retry.attempts || this.#closed) {
          this.#dropped += batch.length;
          this.#report(error, this.#dropped);
          this.#dropped = 0;
          return;
        }
        // Not unref'd: this wait is bounded by `retry.attempts`, and an unref'd timer lets the
        // event loop drain out from under an in-flight delivery, which leaves an awaited flush
        // pending forever instead of failing.
        await new Promise((resolve) => setTimeout(resolve, this.#config.retry.baseDelayMs * attempt));
      }
    }
  }

  #report(error: unknown, dropped: number): void {
    try { this.options.onError?.(error instanceof Error ? error : new Error("Langfuse delivery failed"), dropped); }
    catch { /* An error reporter cannot be allowed to fail the tracer. */ }
  }
}
