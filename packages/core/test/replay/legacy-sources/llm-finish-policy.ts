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

export function classifyLlmTerminal(final: FinalLlmEvent): LlmTerminalDecision {
  const status = final.status ?? inferredStatus(final);
  if (status === "tool_calls") return final.toolCalls.length > 0 ? "tool_calls" : "partial";
  if (status === "failed") return "failed";
  if (status === "completed") return typeof final.content === "string" && final.content.trim() ? "completed" : "partial";
  return "partial";
}

const BUDGET_TRANSCRIPT_NOTE = "The turn reached its execution budget before a final answer could be produced.";

export function budgetFinal(final: FinalLlmEvent): { readonly final: FinalLlmEvent; readonly silent: boolean } {
  const silent = typeof final.content !== "string" || !final.content.trim();
  return {
    final: { ...final, content: silent ? BUDGET_TRANSCRIPT_NOTE : final.content, toolCalls: [], finishReason: "step-budget" },
    silent,
  };
}
