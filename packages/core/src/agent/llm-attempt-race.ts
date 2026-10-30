import { AgenticError, type EventDraft, type LlmAdapter, type LlmAttemptHedge, type LlmStreamEvent, type PreparedLlmRequest } from "@0xsyncroot/contracts";
import { classifyError } from "./error-classifier.js";

/** One adapter call of a model attempt: its own attempt id, its own abort and its own stream. */
export interface AttemptCall {
  readonly attemptId: string;
  readonly controller: AbortController;
  readonly iterator: AsyncIterator<LlmStreamEvent>;
  /** Unlinks the call from the turn's signal once the attempt is over with it. */
  readonly release: () => void;
}

export interface AttemptRaceOptions {
  readonly adapter: LlmAdapter;
  /** The turn's signal: aborting it aborts every call of the attempt. */
  readonly signal: AbortSignal;
  /** How long the attempt may wait for its first event, counted from its first call. */
  readonly firstEventMs: number;
  /**
   * Silence after which a second, identical call is made. 0, or a value not below `firstEventMs`, makes none; so does a stream
   * that may be silent while it works (no `progressStreaming`), where silence says nothing.
   */
  readonly hedgeAfterMs: number;
  /** Journals the second call's request (a new attempt id, the same body) and returns it. Called at most once. */
  readonly prepareHedge: () => Promise<PreparedLlmRequest>;
}

const EMPTY_STREAM: AsyncIterator<LlmStreamEvent> = { next: async () => ({ done: true, value: undefined }) };

function stop(call: AttemptCall, reason: unknown): void {
  call.controller.abort(reason);
  call.release();
  try { void Promise.resolve(call.iterator.return?.()).catch(() => undefined); } catch { /* Its abort signal still ends it. */ }
}

/**
 * The first event of a model attempt: from its call or, when that call stays silent, from the first of two.
 *
 * A provider gateway can leave a call open with no response header until it cuts the call itself, minutes later, while
 * calls that work speak within seconds (docs/incidents/2026-10-12-core-silent-model-calls.md). Waiting the whole
 * first-event bound for a call that will never speak, then retrying, costs every such hang most of a minute.
 * After `hedgeAfterMs` of silence the same request goes once more; whichever call yields an event
 * first is the attempt's, the other is aborted and never feeds the stream. Both calls share one first-event bound,
 * counted from the first, so a hedge never makes an attempt wait longer than it did without one.
 *
 * An error is not an event, nor is a stream that ends before its first one: such a call leaves the race to the other.
 * When every call has failed, the attempt fails with the first call's error, as it would have without a second call. A
 * second call that cannot be journaled is not made, and the first goes on alone. A model call has no side effect, and
 * tools run only from the stream that won.
 */
export class AttemptRace {
  readonly #calls: AttemptCall[] = [];
  readonly #failures = new Map<string, unknown>();
  #primaryAttemptId: string | undefined;
  #hedgeAttemptId: string | undefined;
  #winner: AttemptCall | undefined;
  #startedAt = 0;
  #firstEventMs: number | undefined;
  #preparing: Promise<unknown> | undefined;

  constructor(private readonly options: AttemptRaceOptions) {}

  get adapterId(): string { return this.options.adapter.id; }
  /** The call whose stream the attempt uses; undefined until one has yielded. */
  get winner(): AttemptCall | undefined { return this.#winner; }
  /** From the first call to the first event of the call that won. */
  get firstEventMs(): number | undefined { return this.#firstEventMs; }
  /** Present once a second call was journaled, whether or not it was sent before the first call spoke. */
  get hedge(): LlmAttemptHedge | undefined {
    if (this.#primaryAttemptId === undefined || this.#hedgeAttemptId === undefined) return undefined;
    const winner = !this.#winner ? "none" : this.#winner.attemptId === this.#primaryAttemptId ? "primary" : "hedge";
    return { primaryAttemptId: this.#primaryAttemptId, hedgeAttemptId: this.#hedgeAttemptId, afterMs: this.options.hedgeAfterMs, winner };
  }

  /** The error a call failed with before the race was decided, if it did. */
  failureOf(attemptId: string): unknown { return this.#failures.get(attemptId); }
  /** Resolves once a second call being journaled is written, so the rows that close the attempt come after its request. */
  async quiet(): Promise<void> { await this.#preparing?.catch(() => undefined); }

  first(request: PreparedLlmRequest): Promise<{ readonly call: AttemptCall; readonly first: IteratorResult<LlmStreamEvent> }> {
    const { signal, firstEventMs, hedgeAfterMs } = this.options;
    this.#primaryAttemptId = request.attemptId;
    this.#startedAt = performance.now();
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      let settled = false, preparing = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        finish();
      };
      const fail = (reason: unknown): void => settle(() => { for (const call of this.#calls) stop(call, reason); reject(reason); });
      const onAbort = (): void => fail(signal.reason);
      const lose = (call: AttemptCall, error: unknown): void => {
        if (settled) return;
        this.#failures.set(call.attemptId, error);
        if (!preparing && this.#failures.size === this.#calls.length) fail(this.#failures.get(this.#calls[0]!.attemptId));
      };
      const enter = (call: AttemptCall, next: Promise<IteratorResult<LlmStreamEvent>>): void => {
        next.then((first) => {
          if (first.done) { lose(call, new AgenticError("permanent", `LLM adapter ${this.adapterId} ended without a final event`)); return; }
          settle(() => {
            this.#winner = call;
            this.#firstEventMs = Math.round(performance.now() - this.#startedAt);
            const lost = new AgenticError("cancelled", "Another call of the same model attempt answered first");
            for (const other of this.#calls) if (other !== call) stop(other, lost);
            resolve({ call, first });
          });
        }, (error: unknown) => lose(call, error));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      timers.push(setTimeout(() => fail(new AgenticError("timeout", `LLM attempt timed out after ${firstEventMs}ms`, true)), firstEventMs));
      if (hedgeAfterMs > 0 && hedgeAfterMs < firstEventMs) {
        timers.push(setTimeout(() => {
          preparing = true;
          this.#preparing = this.options.prepareHedge().then((hedge) => {
            this.#hedgeAttemptId = hedge.attemptId;
            preparing = false;
            if (settled) return;
            const opened = this.#open(hedge);
            enter(opened.call, opened.next);
          }, () => {
            preparing = false;
            if (!settled && this.#failures.size === this.#calls.length) fail(this.#failures.get(this.#calls[0]!.attemptId));
          });
        }, hedgeAfterMs));
      }
      const opened = this.#open(request);
      enter(opened.call, opened.next);
    });
  }

  #open(request: PreparedLlmRequest): { readonly call: AttemptCall; readonly next: Promise<IteratorResult<LlmStreamEvent>> } {
    const { adapter, signal } = this.options;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    let iterator = EMPTY_STREAM, next: Promise<IteratorResult<LlmStreamEvent>>;
    try {
      iterator = adapter.stream(request, controller.signal)[Symbol.asyncIterator]();
      next = Promise.resolve(iterator.next());
    } catch (error) { next = Promise.reject(error); }
    const call = { attemptId: request.attemptId, controller, iterator, release: () => signal.removeEventListener("abort", onAbort) };
    this.#calls.push(call);
    return { call, next };
  }
}

/**
 * The row that closes the call an attempt did not use: it failed on its own (its error's code), lost the race
 * ("hedge-lost"), or neither call spoke and the attempt failed (`failure`). None when the attempt made a single call. Only
 * the used call's usage is recorded as the step's.
 */
export function unusedCallDiscard(
  race: AttemptRace, usedAttemptId: string, at: { readonly turnId: string; readonly stepId: string; readonly requestId: string },
  failure?: { readonly code: string; readonly willRetry: boolean },
): EventDraft[] {
  const hedge = race.hedge;
  if (!hedge) return [];
  const attemptId = usedAttemptId === hedge.primaryAttemptId ? hedge.hedgeAttemptId : hedge.primaryAttemptId;
  const lost = hedge.winner !== "none" || !failure;
  // Its own error when it had one: a 400 to the second call is not the first call's timeout, nor a lost race.
  const own = race.failureOf(attemptId);
  const code = own !== undefined ? classifyError(own).code : lost ? "hedge-lost" : failure.code;
  return [{ type: "llm/attempt-discarded", ...at, attemptId, payload: {
    itemId: null, hadPublicOutput: false, code, willRetry: lost ? false : failure.willRetry, hedge,
  } }];
}
