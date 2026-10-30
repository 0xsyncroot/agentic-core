import type { LlmResponseStatus, LlmStreamEvent } from "@0xsyncroot/contracts";

type FinalLlmEvent = Extract<LlmStreamEvent, { type: "final" }>;
export type LlmTerminalDecision = "completed" | "tool_calls" | "partial" | "failed";

function inferredStatus(final: FinalLlmEvent): LlmResponseStatus {
  if (final.toolCalls.length > 0) return "tool_calls";
  const reason = final.finishReason.trim().toLowerCase().replaceAll("-", "_");
  if (["stop", "completed", "end_turn"].includes(reason)) return "completed";
  if (["length", "max_tokens", "incomplete"].includes(reason)) return "incomplete";
  if (["content_filter", "blocked", "refusal"].includes(reason)) return "blocked";
  if (["error", "failed"].includes(reason)) return "failed";
  return "unknown";
}

/** Maps provider finish strings into the small terminal vocabulary owned by core. */
export function classifyLlmTerminal(final: FinalLlmEvent): LlmTerminalDecision {
  const status = final.status ?? inferredStatus(final);
  if (status === "tool_calls") return final.toolCalls.length > 0 ? "tool_calls" : "partial";
  if (status === "failed") return "failed";
  if (status === "completed") return typeof final.content === "string" && final.content.trim() ? "completed" : "partial";
  return "partial";
}

/**
 * Internal note for the transcript when the budget cut a step short. Never shown to a user.
 *
 * The loop used to put this straight into the turn's answer. Two things were wrong with that:
 * it is English, in a product whose users are not, and it was written with `??`, so a model
 * that replied with tool calls and no prose — `content: ""`, the ordinary shape of such a
 * reply — slipped past it. The turn then ended with an empty answer and a trace claiming it
 * had finished, which is the silence a user cannot tell from a hang.
 */
const BUDGET_TRANSCRIPT_NOTE = "The turn reached its execution budget before a final answer could be produced.";

/**
 * Shapes the step the budget stopped, and says whether the model left anything to show.
 *
 * `silent` is the part the caller needs: the transcript keeps a note so the next turn can see
 * what happened, while the answer stays empty so the wording shown to a person is chosen by
 * the product, in its own language, rather than invented here.
 */
export function budgetFinal(final: FinalLlmEvent): { readonly final: FinalLlmEvent; readonly silent: boolean } {
  const silent = typeof final.content !== "string" || !final.content.trim();
  return {
    final: { ...final, content: silent ? BUDGET_TRANSCRIPT_NOTE : final.content, toolCalls: [], finishReason: "step-budget" },
    silent,
  };
}
