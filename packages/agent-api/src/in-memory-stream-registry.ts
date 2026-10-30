import { AgenticError } from "@0xsyncroot/contracts";
import { InterjectionQueue } from "./interjection-queue.js";
import type {
  ResumableAgentStreamEvent,
  ResumableAgentStreamKey,
  ResumableAgentStreamObserver,
  ResumableAgentStreamOperation,
  ResumableAgentStreamRegistry,
} from "./resumable-agent-stream.js";

const DEFAULT_MAX_OPERATIONS = 1_000;
const DEFAULT_MAX_EVENTS = 4_096;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_TERMINAL_TTL_MS = 5 * 60_000;
/** An aborted run only has to unwind and publish; one that takes longer is ignoring its signal. */
const DRAIN_ABORT_SETTLE_MS = 5_000;

interface StreamLimits {
  readonly maxEvents: number;
  readonly maxBytes: number;
}

function operationId(key: ResumableAgentStreamKey): string {
  return JSON.stringify([key.tenantId, key.actorId, key.sessionId, key.requestId]);
}

class InMemoryResumableAgentStreamOperation implements ResumableAgentStreamOperation {
  readonly #events: ResumableAgentStreamEvent[] = [];
  readonly #subscribers = new Set<ResumableAgentStreamObserver>();
  readonly #controller = new AbortController();
  readonly #run: Parameters<ResumableAgentStreamRegistry["acquire"]>[0]["run"];
  readonly #interjections = new InterjectionQueue();
  readonly #limits: StreamLimits;
  readonly #onTerminal: () => void;
  #state: "idle" | "running" | "terminal" = "idle";
  #bytes = 0;
  #finish!: () => void;
  /** Resolves once the terminal event has been published (including the never-started case, for a uniform drain). */
  readonly finished: Promise<void>;

  constructor(
    readonly key: ResumableAgentStreamKey,
    readonly fingerprint: string,
    run: Parameters<ResumableAgentStreamRegistry["acquire"]>[0]["run"],
    limits: StreamLimits,
    onTerminal: () => void,
  ) {
    this.#run = run;
    this.#limits = limits;
    this.#onTerminal = onTerminal;
    this.finished = new Promise((resolve) => { this.#finish = resolve; });
  }

  get lastEventId(): number { return this.#events.at(-1)?.id ?? 0; }
  get terminal(): boolean { return this.#state === "terminal"; }

  start(): void {
    if (this.#state !== "idle") return;
    this.#state = "running";
    void this.#run((event, payload) => this.#publish(event, payload), this.#controller.signal, this.#interjections)
      .catch((error: unknown) => this.#publish("error", {
        code: error instanceof AgenticError ? error.code : "internal",
        message: error instanceof AgenticError ? error.message : "Request failed",
      }))
      .finally(() => {
        if (!this.terminal) this.#publish("error", { code: "internal", message: "Stream ended without a terminal event" });
        this.#finish();
      });
  }

  cancel(): boolean {
    if (this.terminal || this.#controller.signal.aborted) return false;
    this.#controller.abort(new AgenticError("cancelled", "Turn cancelled by the client"));
    return true;
  }

  /** Refused once the turn is over or already cancelled: there is no step boundary left to read it at. */
  interject(content: string): boolean {
    if (this.terminal || this.#controller.signal.aborted) return false;
    return this.#interjections.offer(content);
  }

  async subscribe(afterEventId: number, observer: ResumableAgentStreamObserver): Promise<() => void> {
    if (!Number.isSafeInteger(afterEventId) || afterEventId < 0 || afterEventId > this.lastEventId) {
      throw new AgenticError("validation", "Last-Event-ID is outside the retained stream journal");
    }
    for (const event of this.#events) if (event.id > afterEventId) observer.event(event);
    if (this.terminal) {
      observer.end();
      return () => undefined;
    }
    this.#subscribers.add(observer);
    return () => { this.#subscribers.delete(observer); };
  }

  #publish(event: string, payload: unknown): void {
    if (this.terminal) return;
    let data: string;
    try { data = JSON.stringify(payload); }
    catch {
      this.#terminateWithError("invalid-stream-payload", "Stream payload is not JSON serializable");
      return;
    }
    const bytes = Buffer.byteLength(event) + Buffer.byteLength(data) + 32;
    if (this.#events.length >= this.#limits.maxEvents || this.#bytes + bytes > this.#limits.maxBytes) {
      this.#controller.abort(new AgenticError("budget-exceeded", "Public stream journal exceeded its budget"));
      this.#terminateWithError("stream-budget-exceeded", "Public stream exceeded its delivery budget");
      return;
    }
    this.#append(event, data, event === "result" || event === "error", bytes);
  }

  #terminateWithError(code: string, message: string): void {
    const data = JSON.stringify({ code, message });
    this.#append("error", data, true, Buffer.byteLength(data) + 37);
  }

  #append(event: string, data: string, terminal: boolean, bytes: number): void {
    const item = { id: this.lastEventId + 1, event, data };
    this.#events.push(item);
    this.#bytes += bytes;
    for (const subscriber of [...this.#subscribers]) {
      try { subscriber.event(item); } catch { this.#subscribers.delete(subscriber); }
    }
    if (!terminal) return;
    this.#state = "terminal";
    for (const subscriber of [...this.#subscribers]) {
      try { subscriber.end(); } catch { /* A broken delivery cannot affect the operation. */ }
    }
    this.#subscribers.clear();
    this.#onTerminal();
  }
}

/** Resolves once `work` settles or `ms` elapses, whichever comes first; never rejects. */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([work.then(() => undefined, () => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally { clearTimeout(timer); }
}

export class InMemoryResumableAgentStreamRegistry implements ResumableAgentStreamRegistry {
  /** Single-process only: not what "productionSafe" requires (shared across replicas). */
  readonly productionSafe = false;
  readonly #operations = new Map<string, InMemoryResumableAgentStreamOperation>();
  readonly #expiryTimers = new Set<NodeJS.Timeout>();
  readonly #maxOperations: number;
  readonly #limits: StreamLimits;
  readonly #terminalTtlMs: number;
  #draining: Promise<void> | undefined;
  #closed = false;

  constructor(options: { maxOperations?: number; maxEvents?: number; maxBytes?: number; terminalTtlMs?: number } = {}) {
    this.#maxOperations = options.maxOperations ?? DEFAULT_MAX_OPERATIONS;
    this.#limits = { maxEvents: options.maxEvents ?? DEFAULT_MAX_EVENTS, maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES };
    this.#terminalTtlMs = options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS;
  }

  async acquire(input: Parameters<ResumableAgentStreamRegistry["acquire"]>[0]): ReturnType<ResumableAgentStreamRegistry["acquire"]> {
    if (this.#closed) throw new AgenticError("transient", "Stream registry is closed");
    const id = operationId(input.key);
    const existing = this.#operations.get(id);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) throw new AgenticError("conflict", "requestId is already bound to different stream input");
      return { operation: existing, created: false };
    }
    // A draining node still replays the turns it ran, but a turn started now would outlive it.
    if (this.#draining) throw new AgenticError("transient", "Stream registry is draining", true);
    if (this.#operations.size >= this.#maxOperations) throw new AgenticError("budget-exceeded", "Too many retained public streams");
    let operation: InMemoryResumableAgentStreamOperation;
    operation = new InMemoryResumableAgentStreamOperation(input.key, input.fingerprint, input.run, this.#limits, () => {
      if (this.#closed) return;
      const timer = setTimeout(() => {
        this.#expiryTimers.delete(timer);
        if (this.#operations.get(id) === operation) this.#operations.delete(id);
      }, this.#terminalTtlMs);
      timer.unref();
      this.#expiryTimers.add(timer);
    });
    this.#operations.set(id, operation);
    return { operation, created: true };
  }

  async cancel(key: ResumableAgentStreamKey): Promise<boolean> {
    return this.#operations.get(operationId(key))?.cancel() ?? false;
  }

  async interject(key: ResumableAgentStreamKey, content: string): Promise<boolean> {
    return this.#operations.get(operationId(key))?.interject(content) ?? false;
  }

  drain(graceMs: number): Promise<void> {
    this.#draining ??= (async () => {
      const pending = [...this.#operations.values()].filter((operation) => !operation.terminal);
      if (pending.length === 0) return;
      const settled = Promise.all(pending.map((operation) => operation.finished));
      await settleWithin(settled, graceMs);
      for (const operation of pending) operation.cancel();
      await settleWithin(settled, DRAIN_ABORT_SETTLE_MS);
    })();
    return this.#draining;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const timer of this.#expiryTimers) clearTimeout(timer);
    this.#expiryTimers.clear();
    for (const operation of this.#operations.values()) operation.cancel();
    this.#operations.clear();
  }
}
