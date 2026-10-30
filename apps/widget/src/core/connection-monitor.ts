/** @internal One connection state for the whole widget. */
type ConnectionState = "online" | "reconnecting" | "offline";

/** @internal Timing of the recovery loop; every figure is a host option with these defaults. */
interface ConnectionRecoveryOptions {
  /** After this long without a reachable backend, automatic resumption stops (state becomes "offline"). Default 120000. */
  readonly giveUpMs?: number;
  /** First wait between reachability probes; doubles up to `maxDelayMs`. Default 1000. */
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Probe spacing once resumption has been given up. Default 30000. */
  readonly slowDelayMs?: number;
  /** A probe that gets no answer within this time counts as failed. Default 8000. */
  readonly probeTimeoutMs?: number;
}

/**
 * @internal Decides whether the backend is reachable, and holds work until it is.
 *
 * With the backend down, every action the panel takes would fail on its own, one error bubble each,
 * with nothing to say they share a cause. The cause is one thing, so it is
 * one state: the first transport failure moves the widget to "reconnecting", a probe loop with
 * backoff looks for the backend, and everything that wants the network waits here instead of
 * failing. After `giveUpMs` the interrupted work is released as failed, but probing goes on slowly
 * so the widget still recovers by itself, and `retryNow` lets the user ask for it.
 */
class ConnectionMonitor {
  readonly #probe: (signal: AbortSignal) => Promise<boolean>;
  readonly #onChange: (state: ConnectionState) => void;
  readonly #giveUpMs: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #slowDelayMs: number;
  readonly #probeTimeoutMs: number;
  readonly #waiters = new Set<{ readonly done: (outcome: "online" | "gave-up") => void; readonly interrupted: boolean }>();
  #state: ConnectionState = "online";
  #since = 0;
  #attempt = 0;
  #running = false;
  #wake: (() => void) | undefined;
  #destroyed = false;

  constructor(probe: (signal: AbortSignal) => Promise<boolean>, onChange: (state: ConnectionState) => void, options: ConnectionRecoveryOptions = {}) {
    this.#probe = probe;
    this.#onChange = onChange;
    this.#giveUpMs = options.giveUpMs ?? 120_000;
    this.#baseDelayMs = options.baseDelayMs ?? 1_000;
    this.#maxDelayMs = Math.max(this.#baseDelayMs, options.maxDelayMs ?? 10_000);
    this.#slowDelayMs = options.slowDelayMs ?? 30_000;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? 8_000;
  }

  get state(): ConnectionState { return this.#state; }

  /** The first failure starts recovery; later ones, while it runs, change nothing. */
  reportFailure(): void {
    if (this.#destroyed || this.#state !== "online") return;
    this.#since = Date.now();
    this.#attempt = 0;
    this.#set("reconnecting");
    void this.#loop();
  }

  /**
   * Resolves when the backend answers again.
   *
   * `interrupted` work is released as "gave-up" when the window closes, so it can fail once and
   * say so. Work that has not started yet (`interrupted: false`) stays held for as long as it takes.
   */
  whenRestored(signal: AbortSignal, interrupted: boolean): Promise<"online" | "gave-up"> {
    if (this.#state === "online") return Promise.resolve("online");
    return new Promise((resolve, reject) => {
      const waiter = {
        interrupted,
        done: (outcome: "online" | "gave-up") => { signal.removeEventListener("abort", onAbort); this.#waiters.delete(waiter); resolve(outcome); },
      };
      const onAbort = () => { this.#waiters.delete(waiter); reject(signal.reason); };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiters.add(waiter);
    });
  }

  /** "Thử lại": probe now instead of waiting out the delay. */
  retryNow(): void {
    if (this.#state === "online") return;
    this.#wake?.();
  }

  destroy(): void {
    this.#destroyed = true;
    this.#wake?.();
    for (const waiter of [...this.#waiters]) waiter.done("gave-up");
  }

  async #loop(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (!this.#destroyed && this.#state !== "online") {
        if (await this.#reachable()) { this.#restore(); return; }
        if (this.#state === "reconnecting" && Date.now() - this.#since >= this.#giveUpMs) this.#giveUp();
        await this.#sleep(this.#state === "offline" ? this.#slowDelayMs : this.#backoff());
      }
    } finally { this.#running = false; }
  }

  #backoff(): number {
    const exponential = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** this.#attempt++);
    return Math.round(exponential * (0.75 + Math.random() * 0.5));
  }

  async #reachable(): Promise<boolean> {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), this.#probeTimeoutMs);
    try { return await this.#probe(controller.signal); }
    catch { return false; }
    finally { globalThis.clearTimeout(timer); }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = globalThis.setTimeout(done, ms);
      function done(): void { globalThis.clearTimeout(timer); resolve(); }
      this.#wake = () => { this.#wake = undefined; done(); };
    });
  }

  #restore(): void {
    this.#set("online");
    for (const waiter of [...this.#waiters]) waiter.done("online");
  }

  #giveUp(): void {
    this.#set("offline");
    for (const waiter of [...this.#waiters]) if (waiter.interrupted) waiter.done("gave-up");
  }

  #set(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    try { this.#onChange(state); } catch { /* The view cannot break recovery. */ }
  }
}

/**
 * @internal Whether a failure says the backend is unreachable (as opposed to refusing the request).
 *
 * Only what the transport diagnosed itself and marked retryable qualifies: a network error, a
 * timeout, a bare 5xx, a stream that ended without a result. A business sentence from the server
 * (a 4xx, a reasoned conflict) is an answer, so the link is evidently up.
 */
function isConnectivityFailure(cause: unknown): boolean {
  return cause instanceof AgentChatTransportError && cause.transportFailure === true && cause.retryable === true;
}
