import type { EventDraft, RuntimeSnapshot, SecurityContext, SessionStore, TurnLease } from "@0xsyncroot/contracts";

/**
 * The leased writer of one turn.
 *
 * It writes and nothing else: every read goes through the operation's `TurnJournalView`, which
 * follows this writer's `seq` and catches up with exactly the rows written since it last looked.
 * A `load()` here used to read the whole session on every step, and at turn end, and twice per
 * resume — the read amplification that made long sessions slow for no new information.
 */
export class TurnEventWriter {
  #seq: number;
  #lease: TurnLease;

  constructor(
    private readonly store: SessionStore,
    readonly sessionId: string,
    private readonly security: SecurityContext,
    private readonly runtime: RuntimeSnapshot,
    seq: number,
    lease: TurnLease,
  ) {
    this.#seq = seq;
    this.#lease = lease;
  }

  /** The journal's head as this writer last left it. */
  get seq(): number { return this.#seq; }

  /**
   * Appends in call order, one at a time. Each append is checked against the head the previous one left: two started together
   * (judgments asked in parallel, each journaled as it is answered) would pass the same head and the second would fail the
   * store's compare-and-set.
   */
  append(events: readonly EventDraft[], idempotencyKey: string): Promise<void> {
    return this.#queued(async () => {
      this.#seq = await this.store.appendLeased(this.#lease, this.#seq, events, idempotencyKey, { security: this.security, runtime: this.runtime });
    });
  }

  /** Queued with the appends: a store that fences on the lease must not see a renewal overtake an append in flight. */
  renew(ttlMs: number): Promise<void> {
    return this.#queued(async () => { this.#lease = await this.store.renewTurn(this.#lease, ttlMs, this.security); });
  }

  finish(terminal: EventDraft): Promise<void> {
    return this.#queued(async () => {
      this.#seq = await this.store.finishTurn(this.#lease, this.#seq, terminal, { security: this.security, runtime: this.runtime });
    });
  }

  #tail: Promise<unknown> = Promise.resolve();

  #queued(write: () => Promise<void>): Promise<void> {
    const run = this.#tail.then(write);
    this.#tail = run.catch(() => undefined);
    return run;
  }
}
