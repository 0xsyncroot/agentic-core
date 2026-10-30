import type { LlmUsage } from "@0xsyncroot/contracts";

export function normalizedUsage(usage: LlmUsage | undefined): Required<LlmUsage> {
  const inputTokens = Number.isInteger(usage?.inputTokens) && Number(usage?.inputTokens) >= 0 ? Number(usage?.inputTokens) : 0;
  const outputTokens = Number.isInteger(usage?.outputTokens) && Number(usage?.outputTokens) >= 0 ? Number(usage?.outputTokens) : 0;
  const suppliedTotal = Number.isInteger(usage?.totalTokens) && Number(usage?.totalTokens) >= 0 ? Number(usage?.totalTokens) : undefined;
  return { inputTokens, outputTokens, totalTokens: suppliedTotal ?? inputTokens + outputTokens };
}

export function addUsage(total: Required<LlmUsage>, next: Required<LlmUsage>): Required<LlmUsage> {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    totalTokens: total.totalTokens + next.totalTokens,
  };
}
