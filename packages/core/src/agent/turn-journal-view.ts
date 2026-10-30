import {
  MAX_SESSION_READ_EVENTS,
  type SecurityContext,
  type SessionContextView,
  type SessionEvent,
  type SessionReader,
} from "@0xsyncroot/contracts";
import { validatedContextView } from "./context-checkpoint-validator.js";

/** The journal's head as the operation's writer last left it. */
export interface JournalHead {
  readonly seq: number;
}

function frozenView(view: SessionContextView): SessionContextView {
  return Object.freeze({
    ...(view.checkpoint ? { checkpoint: view.checkpoint } : {}),
    events: Object.freeze([...view.events]),
    ...(view.truncatedBeforeSeq !== undefined ? { truncatedBeforeSeq: view.truncatedBeforeSeq } : {}),
  });
}

/**
 * One operation's bounded read of the journal.
 *
 * Seeded by a single `loadContext()` — before the claim, for a resume, so the pause can be checked
 * without writing anything — and afterwards extended only with the rows written since, read with
 * `loadSince(lastSeq)` just before something needs them. Every step used to read the whole session
 * again, and the turn end and each resume read it twice more: the same thousand rows, over and
 * over, to learn about the handful the operation had just written itself.
 *
 * Reads hand out frozen arrays that are replaced, never changed, when the view grows: a policy that
 * holds the state it was given keeps exactly that state across the awaits that follow.
 *
 * Two shapes are served. `events()` is the raw tail, not filtered by any checkpoint — what a turn's
 * result, a replay, a pause lookup or a plan restore needs, since a checkpoint may already cover the
 * turn that wrote them. `context()` is what the model is shown: the latest valid checkpoint and the
 * tail after it. A checkpoint written by this operation reaches the view like any other row and
 * narrows `context()` locally, without a second `loadContext()`.
 */
export class TurnJournalView {
  #events: readonly SessionEvent[] = Object.freeze([]);
  #checkpoint: SessionEvent | undefined;
  #truncatedBeforeSeq: number | undefined;
  #context: SessionContextView | undefined;
  #head: JournalHead | undefined;
  #catchingUp: Promise<void> | undefined;

  private constructor(
    private readonly store: SessionReader,
    readonly sessionId: string,
    private readonly security: SecurityContext,
    seed: SessionContextView,
  ) {
    this.#seed(seed);
  }

  /** The operation's one `loadContext()`. */
  static async open(store: SessionReader, sessionId: string, security: SecurityContext): Promise<TurnJournalView> {
    return new TurnJournalView(store, sessionId, security, await store.loadContext(sessionId, security));
  }

  /** Follows a writer from now on: a read first catches up with whatever it appended. */
  follow(head: JournalHead): void {
    this.#head = head;
  }

  /** Sequence of the newest event the view holds; 0 for an empty session. */
  get lastSeq(): number {
    return this.#events.at(-1)?.seq ?? 0;
  }

  /** What the view holds now, without reading: all a failing turn has left when the journal cannot be read. */
  get held(): readonly SessionEvent[] {
    return this.#events;
  }

  /** The raw bounded tail plus everything written since, oldest first. */
  async events(): Promise<readonly SessionEvent[]> {
    await this.#catchUp(false);
    return this.#events;
  }

  /** The model's view: the latest valid checkpoint and the tail it does not cover. */
  async context(): Promise<SessionContextView> {
    await this.#catchUp(false);
    this.#context ??= frozenView(this.#validated());
    return this.#context;
  }

  /** Policies inspect the journal, including evidence already summarized for the model. */
  async evidence(): Promise<SessionContextView> {
    await this.#catchUp(false);
    return frozenView({ ...this.#validated(), events: this.#events });
  }

  /**
   * Reads whatever was written since the view last looked, whether or not this operation wrote it.
   * For a view seeded before a claim that did not acquire: the turn it found may have finished since.
   */
  async refresh(): Promise<void> {
    await this.#catchUp(true);
  }

  #validated(): SessionContextView {
    const candidate: SessionContextView = {
      ...(this.#checkpoint ? { checkpoint: this.#checkpoint } : {}),
      events: this.#events,
      ...(this.#truncatedBeforeSeq !== undefined ? { truncatedBeforeSeq: this.#truncatedBeforeSeq } : {}),
    };
    // An invalid checkpoint is ignored rather than trusted: the bounded raw tail stands on its own.
    return validatedContextView(candidate) ?? {
      events: this.#events,
      ...(this.#truncatedBeforeSeq !== undefined ? { truncatedBeforeSeq: this.#truncatedBeforeSeq } : {}),
    };
  }

  async #catchUp(unconditional: boolean): Promise<void> {
    while (this.#catchingUp) await this.#catchingUp;
    const behind = unconditional || (this.#head !== undefined && this.#head.seq > this.lastSeq);
    if (!behind) return;
    this.#catchingUp = this.#readSince();
    try { await this.#catchingUp; }
    finally { this.#catchingUp = undefined; }
  }

  async #readSince(): Promise<void> {
    const since = await this.store.loadSince(this.sessionId, this.lastSeq, this.security, MAX_SESSION_READ_EVENTS);
    // A full page cannot say whether more rows follow it. Paging on through a long gap would be
    // the full read this view exists to avoid, so the view starts over from a fresh bounded tail.
    if (since.length >= MAX_SESSION_READ_EVENTS) {
      this.#seed(await this.store.loadContext(this.sessionId, this.security));
      return;
    }
    const fresh = since.filter((event) => event.seq > this.lastSeq);
    if (fresh.length === 0) return;
    for (const event of fresh) if (event.type === "context/checkpoint") this.#checkpoint = event;
    this.#events = Object.freeze([...this.#events, ...fresh]);
    this.#context = undefined;
  }

  #seed(view: SessionContextView): void {
    this.#events = Object.freeze([...view.events]);
    this.#checkpoint = view.checkpoint;
    this.#truncatedBeforeSeq = view.truncatedBeforeSeq;
    this.#context = undefined;
  }
}
