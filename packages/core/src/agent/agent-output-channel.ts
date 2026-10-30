import type { AgentOutputEvent, RunTurnInput } from "@0xsyncroot/contracts";

/** Best-effort lifecycle for transient, user-visible answer drafts. */
export class AgentOutputChannel {
  readonly #open = new Set<string>();
  #committedOutputId: string | undefined;

  constructor(private readonly input: RunTurnInput, private readonly turnId: string) {}

  start(outputId: string): void {
    this.#open.add(outputId);
    this.#emit({ type: "assistant-output-start", turnId: this.turnId, outputId, audience: "user" });
  }

  delta(outputId: string, delta: string): void {
    if (this.#open.has(outputId)) {
      this.#emit({ type: "assistant-output-delta", turnId: this.turnId, outputId, audience: "user", delta });
    }
  }

  commit(outputId: string | undefined): void { this.#committedOutputId = outputId; }

  /** The draft's own output id, once committed — narration's `narrationId` falls back to the attempt id without one. */
  get committedOutputId(): string | undefined { return this.#committedOutputId; }

  end(outputId: string | undefined, status: "completed" | "discarded"): void {
    if (!outputId || !this.#open.delete(outputId)) return;
    this.#emit({ type: "assistant-output-end", turnId: this.turnId, outputId, audience: "user", status });
  }

  /** Runtime-authored text after the committed answer, in the same output. With none open, the final content carries it. */
  appendCommitted(text: string): void {
    if (this.#committedOutputId) this.delta(this.#committedOutputId, text);
  }

  completeCommitted(content: string | null): void {
    this.end(this.#committedOutputId, typeof content === "string" && content.length > 0 ? "completed" : "discarded");
  }

  discardCommitted(): void { this.end(this.#committedOutputId, "discarded"); }

  discardAll(): void {
    for (const outputId of [...this.#open]) this.end(outputId, "discarded");
  }

  #emit(event: AgentOutputEvent): void {
    try { this.input.onOutput?.(event); } catch { /* Observers cannot fail a durable turn. */ }
  }
}
