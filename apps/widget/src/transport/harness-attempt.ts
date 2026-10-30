/**
 * One HTTP attempt at a stream, with two clocks of its own.
 *
 * A backend that dies mid-turn would leave the panel retrying for good, because a connection that
 * opens and then says nothing never fails — `fetch` waits and the
 * reader waits. The server sends a heartbeat on a fixed cadence, so silence longer than that is
 * itself the failure: the attempt is aborted here and the caller resumes it like any dropped link.
 * @internal
 */
class HarnessAttemptGuard {
  readonly #controller = new AbortController();
  readonly #parent: AbortSignal;
  readonly #onParentAbort: () => void;
  #timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #expired: "headers" | "idle" | undefined;

  constructor(parent: AbortSignal) {
    this.#parent = parent;
    this.#onParentAbort = () => this.#controller.abort(parent.reason);
    if (parent.aborted) this.#controller.abort(parent.reason);
    else parent.addEventListener("abort", this.#onParentAbort, { once: true });
  }

  /** Aborts when the caller aborts, or when one of the two clocks runs out. */
  get signal(): AbortSignal { return this.#controller.signal; }
  /** Which clock ended the attempt; undefined when it ended some other way. */
  get expired(): "headers" | "idle" | undefined { return this.#expired; }

  /** Starts the clock for response headers. `0` means no limit. */
  waitForHeaders(ms: number): void { this.#arm(ms, "headers"); }
  /** Every received byte, heartbeat comments included, restarts the idle clock. */
  touch(ms: number): void { this.#arm(ms, "idle"); }

  dispose(): void {
    this.#disarm();
    this.#parent.removeEventListener("abort", this.#onParentAbort);
  }

  #arm(ms: number, kind: "headers" | "idle"): void {
    this.#disarm();
    if (ms <= 0 || this.#controller.signal.aborted) return;
    this.#timer = globalThis.setTimeout(() => {
      this.#expired = kind;
      this.#controller.abort(new DOMException(`No ${kind === "headers" ? "response" : "data"} for ${ms} ms.`, "TimeoutError"));
    }, ms);
  }

  #disarm(): void {
    if (this.#timer !== undefined) globalThis.clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
