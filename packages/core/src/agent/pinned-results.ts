import type { ChatMessage, SessionEvent } from "@0xsyncroot/contracts";
import { ToolCallPairing } from "./tool-call-pairing.js";
import { toolResultContent } from "./tool-result-bounds.js";

/**
 * How much of the context pinned results may take back after a checkpoint covered their calls.
 *
 * Claude Code re-attaches the newest invocation of each skill after compaction, within a total
 * budget. A skill left to the summary survives as a short excerpt of untrusted data while the turn
 * still counts it as loaded (docs/incidents/2026-10-11-core-skill-cut-by-checkpoint.md).
 */
export const PINNED_CONTEXT_CHARS = 48_000;

export interface PinnedResult {
  readonly toolId: string;
  /** The call's arguments as the model wrote them: one entry per distinct call (one per skill). */
  readonly arguments: string;
  readonly seq: number;
  readonly content: string;
  /** The runtime made the call (a skill the request matches), not the model. */
  readonly byRuntime?: true;
}

type ResultPayload = Parameters<typeof toolResultContent>[0];

/**
 * Succeeded results of pinned tools that the checkpoint covers, the newest per tool and arguments,
 * newest first, as many as fit the budget. A result the tail repeats is left out: the model reads
 * that one where it is.
 */
export function coveredPinnedResults(
  events: readonly SessionEvent[], coveredThroughSeq: number, pinned: ReadonlySet<string>, budgetChars = PINNED_CONTEXT_CHARS,
): readonly PinnedResult[] {
  if (pinned.size === 0 || coveredThroughSeq <= 0) return [];
  const pairing = new ToolCallPairing(events);
  const covered = new Map<string, PinnedResult>();
  const inTail = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool/result") continue;
    const payload = event.payload as Record<string, unknown>;
    if (typeof payload.toolId !== "string" || !pinned.has(payload.toolId) || payload.state !== "succeeded") continue;
    const intent = pairing.intentOfResult(event)?.payload as Record<string, unknown> | undefined;
    const args = typeof intent?.arguments === "string" ? intent.arguments : "{}";
    const key = `${payload.toolId}\u0000${args}`;
    if (event.seq > coveredThroughSeq) { inTail.add(key); continue; }
    covered.set(key, { toolId: payload.toolId, arguments: args, seq: event.seq, content: toolResultContent(payload as ResultPayload),
      ...(payload.initiator === "policy" ? { byRuntime: true as const } : {}) });
  }
  const kept: PinnedResult[] = [];
  let used = 0;
  for (const [key, result] of [...covered].sort((left, right) => right[1].seq - left[1].seq)) {
    if (inTail.has(key) || used + result.content.length > budgetChars) continue;
    kept.push(result);
    used += result.content.length;
  }
  return kept;
}

/**
 * The pinned results as system messages: what the tool declared them to be, instructions the turn
 * keeps whole. They cannot be tool messages (the calls that made them are summarized away). The
 * context window policy places them with the system prompt, where preloaded skills already sit,
 * and never drops them (retention "required").
 */
export function pinnedResultMessages(results: readonly PinnedResult[]): ChatMessage[] {
  return [...results].reverse().map((result) => ({
    role: "system",
    content: `Still in force — the result of ${result.toolId} with arguments ${result.arguments}, which ${result.byRuntime ? "the runtime loaded for this request" : "you called"} earlier in this conversation. `
      + `The conversation checkpoint summarizes that call; the result is kept here whole:\n${result.content}`,
    context: { trust: "instruction", retention: "required", provenance: "pinned-tool-result" },
  }));
}
