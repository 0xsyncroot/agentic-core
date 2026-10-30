import { AgenticError } from "@0xsyncroot/contracts";
import type { McpClientPort } from "./types.js";

const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_RESTART_WINDOW_MS = 60_000;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;

export interface StdioProcessManagerHooks {
  onStderr(chunk: Buffer): void;
  onUnexpectedClose(): void;
}

export interface StdioProcessManagerConfig {
  readonly serverId: string;
  /**
   * Takes the manager's own hooks rather than closing over the manager: the manager does not exist
   * yet at the point a caller builds this function (it is what `new StdioProcessManager(...)` is
   * about to construct), so hooks are threaded through the call instead of captured up front.
   */
  readonly spawn: (hooks: StdioProcessManagerHooks) => Promise<McpClientPort>;
  readonly maxRestarts?: number;
  readonly restartWindowMs?: number;
  readonly maxStderrBytes?: number;
}

export interface StdioHealth {
  readonly healthy: boolean;
  readonly detail?: string;
}

/** Bounded FIFO byte buffer: keeps only the most recently captured bytes, never the full stream. */
class StderrRingBuffer {
  #chunks: string[] = [];
  #bytes = 0;
  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    this.#chunks.push(text);
    this.#bytes += Buffer.byteLength(text, "utf8");
    while (this.#bytes > this.maxBytes && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift();
      if (dropped) this.#bytes -= Buffer.byteLength(dropped, "utf8");
    }
    if (this.#bytes > this.maxBytes) {
      const kept = this.#chunks.join("").slice(-this.maxBytes);
      this.#chunks = [kept];
      this.#bytes = Buffer.byteLength(kept, "utf8");
    }
  }

  tail(): string {
    return this.#chunks.join("");
  }
}

type Status = "idle" | "starting" | "ready";

/**
 * Owns exactly one child process for a stdio MCP connector, shared by every principal: lazily
 * spawned on first use, restarted (bounded by a rolling budget) after a crash.
 *
 * A call whose signal aborts (a tool timeout, a cancelled turn) only abandons that call — it never
 * tears down the process. JSON-RPC over stdio correlates by request id, so one abandoned call does
 * not desynchronise the stream for the others sharing it; the only trustworthy signal that the
 * process itself is unusable is the transport's own close/error detection, which already reaches
 * `onUnexpectedClose` below. Killing the shared child on every timeout would take down every other
 * principal's concurrent call over one slow response — worse than the problem it would "fix".
 *
 * Captured stderr is a diagnostic channel only — it reaches `health()` and nowhere else. A thrown
 * error carries the spawn failure's own short message, never a stderr dump.
 */
export class StdioProcessManager {
  readonly #serverId: string;
  readonly #spawn: (hooks: StdioProcessManagerHooks) => Promise<McpClientPort>;
  readonly #maxRestarts: number;
  readonly #restartWindowMs: number;
  readonly #stderr: StderrRingBuffer;
  #client: Promise<McpClientPort> | undefined;
  #status: Status = "idle";
  /** Bumped on every spawn attempt; a spawn's hooks no-op once they are no longer the current one. */
  #generation = 0;
  #restartTimestamps: number[] = [];
  #lastError: string | undefined;
  #disposed = false;

  constructor(config: StdioProcessManagerConfig) {
    this.#serverId = config.serverId;
    this.#spawn = config.spawn;
    this.#maxRestarts = config.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.#restartWindowMs = config.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
    this.#stderr = new StderrRingBuffer(config.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES);
  }

  /**
   * A never-yet-spawned process ("not started") is healthy, not merely absent-and-forgiven: lazy
   * spawn on first use is the point (see the class doc), and `PluginStager` requires `health()` to
   * report healthy immediately after `activate()`, before any discovery has run. A spawn in flight
   * reports "starting" rather than looking indistinguishable from a settled, working connector.
   * Only a genuine failure — a spawn error, a crash, or disposal — is unhealthy.
   */
  health(): StdioHealth {
    if (this.#disposed) return { healthy: false, detail: "disposed" };
    if (this.#lastError) {
      const tail = this.#stderr.tail();
      return { healthy: false, detail: tail ? `${this.#lastError}; recent stderr: ${tail}` : this.#lastError };
    }
    if (this.#status === "starting") return { healthy: true, detail: "starting" };
    return { healthy: true, ...(this.#status === "idle" ? { detail: "not started" } : {}) };
  }

  /** Runs `operation` against the shared process, spawning it on first use. */
  async use<T>(operation: (client: McpClientPort) => Promise<T>, signal: AbortSignal): Promise<T> {
    const client = await this.#ensureClient(signal);
    return operation(client);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#generation += 1; // any in-flight spawn's hooks stop applying to this manager's state
    const current = this.#client;
    this.#client = undefined;
    if (!current) return;
    const client = await current.catch(() => undefined);
    await client?.close().catch(() => undefined);
  }

  /**
   * Spawns on first use (or after the current client was invalidated), bounded by the restart
   * budget. Honors `signal` while waiting for a slow handshake: the caller unblocks promptly on
   * abort rather than parking behind however long the connect attempt takes (up to the SDK's own
   * discovery timeout) — the spawn itself keeps running in the background and still resolves into
   * `#client` for the next caller, the same trade-off core's own tool-call timeout already makes.
   */
  async #ensureClient(signal: AbortSignal): Promise<McpClientPort> {
    if (this.#disposed) throw new AgenticError("conflict", `MCP stdio connector ${this.#serverId} is disposed`);
    if (this.#client) return this.#client;
    if (!this.#withinRestartBudget()) {
      throw new AgenticError("budget-exceeded", `MCP stdio connector ${this.#serverId} exceeded ${this.#maxRestarts} restarts within ${this.#restartWindowMs}ms`);
    }
    this.#restartTimestamps.push(Date.now());
    this.#status = "starting";
    const generation = ++this.#generation;
    const hooks: StdioProcessManagerHooks = {
      onStderr: (chunk) => { if (generation === this.#generation) this.#stderr.append(chunk); },
      onUnexpectedClose: () => {
        if (generation !== this.#generation) return; // a stale spawn's late close; the current one is unaffected
        this.#lastError = "process exited unexpectedly";
        this.#client = undefined;
        this.#status = "idle";
      },
    };
    const spawned: Promise<McpClientPort> = this.#spawn(hooks).then(
      (client) => {
        if (generation === this.#generation) { this.#lastError = undefined; this.#status = "ready"; }
        return client;
      },
      (error) => {
        if (this.#client === spawned) this.#client = undefined;
        if (generation === this.#generation) {
          this.#lastError = error instanceof Error ? error.message : String(error);
          this.#status = "idle";
        }
        throw error;
      },
    );
    this.#client = spawned;
    if (signal.aborted) throw signal.reason;
    return new Promise<McpClientPort>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      spawned.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  #withinRestartBudget(): boolean {
    const cutoff = Date.now() - this.#restartWindowMs;
    this.#restartTimestamps = this.#restartTimestamps.filter((timestamp) => timestamp > cutoff);
    return this.#restartTimestamps.length < this.#maxRestarts;
  }
}
