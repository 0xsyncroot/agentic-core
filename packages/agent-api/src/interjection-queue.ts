import type { TurnInterjections } from "@0xsyncroot/contracts";

export const MAX_PENDING_INTERJECTIONS = 8;

/** Atomic remote hand-off; input that does not fit must stay at the remote end. */
export interface RemoteInterjections {
  drain(room: number): Promise<readonly string[]>;
  close(): Promise<readonly string[]>;
}

/** The delivery edge closes the queue before publishing a terminal response. */
export interface ClosableInterjections extends TurnInterjections {
  close(): Promise<readonly string[]>;
}

/** Shared, bounded queue for local and cross-replica input. */
export class InterjectionQueue implements ClosableInterjections {
  readonly #pending: string[] = [];
  #collecting: Promise<void> = Promise.resolve();
  #closing: Promise<readonly string[]> | undefined;
  #closed = false;
  #reserved = 0;
  readonly #listeners = new Set<() => void>();

  constructor(private readonly maxPending = MAX_PENDING_INTERJECTIONS, private readonly remote?: RemoteInterjections) {}

  offer(content: string): boolean {
    if (this.#closed || this.#pending.length + this.#reserved >= this.maxPending) return false;
    this.#pending.push(content);
    this.#arrived();
    return true;
  }

  take(): readonly string[] { return this.#pending.splice(0); }

  get pending(): number { return this.#pending.length; }

  collect(): Promise<void> {
    const remote = this.remote;
    if (!remote || this.#closed) return Promise.resolve();
    const step = this.#collecting.then(async () => {
      const room = this.maxPending - this.#pending.length;
      if (room <= 0 || this.#closed) return;
      this.#reserved = room;
      let drained: readonly string[] = [];
      try { drained = await remote.drain(room); this.#pending.push(...drained); }
      finally { this.#reserved = 0; }
      if (drained.length > 0) this.#arrived();
    });
    this.#collecting = step.catch(() => undefined);
    return step;
  }

  /** Calls `listener` whenever input arrives, until unsubscribed or the queue closes. */
  subscribe(listener: () => void): () => void {
    if (this.#closed) return () => undefined;
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #arrived(): void {
    if (this.#closed) return;
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { /* A listener's failure is its own; the input stays queued. */ }
    }
  }

  /** Idempotent and race-safe: rejects later offers and returns every unread sentence. */
  close(): Promise<readonly string[]> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#listeners.clear();
    this.#closing = (async () => {
      await this.#collecting;
      const remote = this.remote ? await this.remote.close() : [];
      return [...this.take(), ...remote];
    })();
    return this.#closing;
  }
}
