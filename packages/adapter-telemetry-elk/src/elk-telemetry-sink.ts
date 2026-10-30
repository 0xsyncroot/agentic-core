import type { AgentTelemetryEvent, AgentTelemetrySink } from "@0xsyncroot/contracts";
import type { ElkConfig } from "./elk-config.js";

export interface ElkTransport {
  /** Delivers one batch. Throws to request a retry; the sink decides whether to keep trying. */
  send(documents: readonly Readonly<Record<string, unknown>>[]): Promise<void>;
  close(): Promise<void>;
}

export interface ElkTelemetrySinkOptions {
  readonly config: ElkConfig;
  readonly transport: ElkTransport;
  /** Reported when a batch is abandoned, so an operator learns from the service, not from ELK. */
  readonly onError?: (error: Error, dropped: number) => void;
  readonly now?: () => Date;
}

/**
 * Ships agent telemetry to ELK without ever standing between a turn and its answer.
 *
 * Observability is best-effort by contract, and the failure this guards against is the obvious
 * one: a log shipper that blocks, retries or throws inside `record` turns an ELK outage into a
 * payroll outage. So `record` only enqueues, the queue is bounded, and everything that can go
 * wrong downstream is absorbed and counted.
 *
 * Loss is made visible rather than hidden. When the queue overflows, the oldest events are
 * dropped — the newest are the ones an operator is looking at — and the count is stamped on the
 * next document that does get through, so a gap in a dashboard has an explanation inside the
 * same index rather than only in a pod log nobody kept.
 */
export class ElkTelemetrySink implements AgentTelemetrySink {
  readonly #queue: Readonly<Record<string, unknown>>[] = [];
  readonly #config: ElkConfig;
  #timer: NodeJS.Timeout | undefined;
  #flushing: Promise<void> = Promise.resolve();
  #dropped = 0;
  #closed = false;

  constructor(private readonly options: ElkTelemetrySinkOptions) {
    this.#config = options.config;
  }

  record(event: AgentTelemetryEvent): void {
    if (this.#closed || !this.#config.enabled) return;
    this.#queue.push(this.#document(event));
    if (this.#queue.length > this.#config.queue.maxEvents) {
      this.#dropped += this.#queue.length - this.#config.queue.maxEvents;
      this.#queue.splice(0, this.#queue.length - this.#config.queue.maxEvents);
    }
    if (this.#queue.length >= this.#config.batch.maxEvents) { void this.flush(); return; }
    this.#schedule();
  }

  /** Sends whatever is queued. Safe to call at any time; never throws. */
  async flush(): Promise<void> {
    this.#clearTimer();
    const batch = this.#queue.splice(0, this.#config.batch.maxEvents);
    if (batch.length === 0) return;
    if (this.#dropped > 0) {
      batch[0] = { ...batch[0], "event.dropped": this.#dropped };
      this.#dropped = 0;
    }
    this.#flushing = this.#flushing.then(() => this.#deliver(batch));
    await this.#flushing;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimer();
    while (this.#queue.length > 0) await this.flush();
    await this.#flushing;
    await this.options.transport.close().catch(() => undefined);
  }

  /**
   * Retries a batch, then gives it up.
   *
   * An unbounded retry would grow the queue behind it until the process runs out of memory,
   * which converts a logging outage into a service outage — the exact coupling this class
   * exists to prevent.
   */
  async #deliver(batch: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
    for (let attempt = 1; attempt <= this.#config.retry.attempts; attempt += 1) {
      try { await this.options.transport.send(batch); return; }
      catch (error) {
        if (attempt === this.#config.retry.attempts || this.#closed) {
          this.#dropped += batch.length;
          this.#report(error, batch.length);
          return;
        }
        // Not unref'd: this wait is bounded by `retry.attempts`, and an unref'd timer lets the
        // event loop drain out from under an in-flight delivery, which leaves an awaited flush
        // pending forever instead of failing.
        await new Promise((resolve) => setTimeout(resolve, this.#config.retry.baseDelayMs * attempt));
      }
    }
  }

  #schedule(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.flush(); }, this.#config.batch.flushIntervalMs);
    this.#timer.unref();
  }

  #clearTimer(): void {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #report(error: unknown, dropped: number): void {
    try { this.options.onError?.(error instanceof Error ? error : new Error("ELK delivery failed"), dropped); }
    catch { /* An error reporter cannot be allowed to fail the sink. */ }
  }

  /**
   * Expands `event.action` into `{ event: { action } }`.
   *
   * ECS is defined as nested objects and written with dots as shorthand. Elasticsearch accepts
   * either, but a receiver in between does not: in Logstash a key with a literal dot is a field
   * whose name contains a dot, not a path, so `[event][action]` in a filter finds nothing and
   * teams reach for a `de_dot` filter to undo what the shipper did. Sending the nested form
   * means the same document works whether it lands in Elasticsearch directly or passes through
   * a pipeline first.
   */
  #nest(flat: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const document: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(flat)) {
      const segments = path.split(".");
      let target = document;
      for (const [index, segment] of segments.entries()) {
        if (index === segments.length - 1) { target[segment] = value; break; }
        const existing = target[segment];
        // A scalar already sitting where an object belongs would silently lose one of the two.
        // Keeping the deeper value and dropping the collision is not a choice worth making
        // quietly, so the flat key survives instead.
        if (existing !== undefined && (existing === null || typeof existing !== "object")) { document[path] = value; break; }
        target = (existing as Record<string, unknown>) ?? (target[segment] = {});
      }
    }
    return Object.freeze(document);
  }

  /**
   * One ECS-shaped document.
   *
   * Only identifiers and outcomes travel: these events carry no message content, no tool
   * arguments and no payroll values, so the index is safe to keep for a long time and to open
   * to an operations team that is not allowed to read payroll data.
   */
  #document(event: AgentTelemetryEvent): Readonly<Record<string, unknown>> {
    const finished = event.type === "agent.operation.finished" ? event : undefined;
    const truncated = event.type === "agent.tool.truncated" ? event : undefined;
    const ended = event.type === "agent.turn.ended" ? event : undefined;
    return this.#nest({
      "@timestamp": event.occurredAt,
      ...this.#config.fields,
      "event.kind": "event",
      "event.category": "process",
      "event.action": event.type,
      "event.outcome": finished?.outcome ?? ended?.outcome ?? "unknown",
      ...(finished ? { "event.duration": finished.durationMs * 1_000_000 } : {}),
      ...("operation" in event ? { "agent.operation": event.operation } : {}),
      "agent.tenant.id": event.tenantId,
      "agent.session.id": event.sessionId,
      "trace.id": event.correlationId,
      ...(truncated ? {
        "agent.turn.id": truncated.turnId, "agent.tool.id": truncated.toolId, "agent.tool.truncated.path": truncated.path,
        "agent.tool.truncated.shown": truncated.shown, "agent.tool.truncated.total": truncated.total,
        "agent.tool.truncated.limit_chars": truncated.limitChars,
      } : {}),
      ...(ended ? {
        "agent.turn.id": ended.turnId, "agent.turn.decision": ended.decision, "agent.turn.reason": ended.reason, "agent.turn.steps": ended.steps,
      } : {}),
      ...(finished?.usage ? {
        "agent.usage.input_tokens": finished.usage.inputTokens ?? null,
        "agent.usage.output_tokens": finished.usage.outputTokens ?? null,
        "agent.usage.total_tokens": finished.usage.totalTokens ?? null,
      } : {}),
    });
  }
}
