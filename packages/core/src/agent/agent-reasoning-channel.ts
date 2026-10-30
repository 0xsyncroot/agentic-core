import type { AgentReasoningEvent, RunTurnInput } from "@0xsyncroot/contracts";

/**
 * Best-effort lifecycle for ephemeral model reasoning.
 *
 * Reasoning is never appended to the durable session journal: a discarded attempt or a
 * rejected terminal candidate must leave no trace behind, and the delivery client renders
 * it in the ephemeral activity panel only. The channel therefore mirrors the output channel
 * lifecycle without any writer involvement.
 */
export class AgentReasoningChannel {
  readonly #open = new Set<string>();

  constructor(private readonly input: RunTurnInput, private readonly turnId: string) {}

  start(reasoningId: string, step: number, attemptId: string): void {
    if (this.#open.has(reasoningId)) return;
    this.#open.add(reasoningId);
    this.#emit({ type: "assistant-reasoning-start", turnId: this.turnId, reasoningId, audience: "user", step, attemptId });
  }

  delta(reasoningId: string, delta: string): void {
    if (!this.#open.has(reasoningId) || !delta) return;
    this.#emit({ type: "assistant-reasoning-delta", turnId: this.turnId, reasoningId, audience: "user", delta });
  }

  end(reasoningId: string, status: "completed" | "discarded"): void {
    if (!this.#open.delete(reasoningId)) return;
    this.#emit({ type: "assistant-reasoning-end", turnId: this.turnId, reasoningId, audience: "user", status });
  }

  endAll(status: "completed" | "discarded"): void {
    for (const reasoningId of [...this.#open]) this.end(reasoningId, status);
  }

  #emit(event: AgentReasoningEvent): void {
    try { this.input.onReasoning?.(event); } catch { /* Observers cannot fail a durable turn. */ }
  }
}
