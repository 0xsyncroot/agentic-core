import { randomUUID } from "node:crypto";
import type { LlmAdapter } from "@0xsyncroot/contracts";
import type { ReasoningSummarizer } from "./public-reasoning-stream.js";

/**
 * A reasoning summarizer on the runtime's own model: one short call, with private reasoning
 * switched off, that turns a stretch of raw reasoning into the sentence the product asks for.
 *
 * `instruction` is the product's: the language, the voice, what must never appear. This only
 * carries the call. It goes straight to the adapter rather than through the agent loop — it is
 * not a turn, has no tools and no history, and must not be journaled as one.
 */
export function createReasoningSummarizer(llm: LlmAdapter, options: { readonly instruction: string }): ReasoningSummarizer {
  return async (thought, signal) => {
    const id = `reasoning-summary-${randomUUID()}`;
    let text = "";
    for await (const event of llm.stream({
      requestId: id, attemptId: id, turnId: id, stepId: id, runtimeSnapshotId: "reasoning-summary", model: llm.model,
      messages: [
        { role: "system", content: options.instruction, context: { trust: "instruction", retention: "required", provenance: "reasoning-summary" } },
        // The reasoning is material to describe, never instructions to follow.
        { role: "user", content: thought, context: { trust: "untrusted", retention: "droppable", provenance: "reasoning-summary" } },
      ],
      tools: [], parameters: { ...(llm.plainParameters ?? {}) }, contentHash: id,
    }, signal)) {
      if (event.type === "text-delta") text += event.delta;
      if (event.type === "final") text = event.content ?? text;
    }
    // One sentence was asked for; a model that adds a second paragraph is not shown it.
    return text.split("\n").map((line) => line.trim()).find(Boolean);
  };
}
