import type { AgentNarrationEvent, RunTurnInput, ToolCall } from "@0xsyncroot/contracts";
import type { AgentOutputChannel } from "./agent-output-channel.js";
import type { WorkPlanLedger } from "./work-plan-ledger.js";

export interface NarrationDecision {
  readonly narrate: boolean;
  readonly narrationId?: string;
  readonly text?: string;
  /** The plan announcement, told beside nothing but a plan update: it opens the account and is never superseded (`NarrationChain`). */
  readonly announcement?: true;
}

/**
 * Whether a step's text is something the agent is telling the user while it works, rather than
 * its answer.
 *
 * Text beside a real tool call always is: the agent saying what it is about to do, as it does it.
 * It used to be withdrawn — the user watched a sentence appear in the answer's place and vanish
 * when the call ran, once per step, and was left with nothing to say what the agent had been
 * doing. It stays now, as chat, in the order it was said; the turn's account folds it away with
 * everything else once the real answer is in.
 *
 * Text beside nothing but a plan update keeps the rule of specs/agentic-core-architecture.md §3.3 and §10, because there it can also be the
 * answer (the model marking the step it is asking in, and asking): it is the plan announcement
 * only while the operation has dispatched none of the model's own other work, nothing has been
 * narrated yet, and the plan the preview produces still has something left to do. Any one of
 * those failing, planning-only text is the answer.
 */
export function decideNarration(input: {
  readonly planLedger: WorkPlanLedger;
  readonly toolCalls: readonly ToolCall[];
  readonly content: string | null;
  readonly modelDispatchedWork: boolean;
  readonly alreadyNarrated: boolean;
  readonly outputId: string | undefined;
  readonly attemptId: string;
}): NarrationDecision {
  const text = input.content?.trim();
  if (!text || input.toolCalls.length === 0) return { narrate: false };
  const narrated: NarrationDecision = { narrate: true, narrationId: input.outputId ?? input.attemptId, text };
  if (input.toolCalls.some((call) => !input.planLedger.isPlanningCall(call.name))) return narrated;
  if (input.modelDispatchedWork || input.alreadyNarrated) return { narrate: false };
  const preview = input.planLedger.previewProposals(input.toolCalls);
  if (!preview?.steps.some((step) => step.status === "pending" || step.status === "in_progress")) return { narrate: false };
  return { ...narrated, announcement: true };
}

/**
 * Frame order is locked (specs/agentic-core-architecture.md §10): narration start/delta/end, THEN the draft's own
 * `assistant-output-end{discarded}` — the client moves the draft text into the narration slot
 * rather than typing it twice, and must see the narration frames first to know to do that.
 */
export function emitNarration(
  input: RunTurnInput, turnId: string, decision: Required<Pick<NarrationDecision, "narrationId" | "text">>, answerDraft: AgentOutputChannel, kind?: "draft",
): void {
  const emit = (event: AgentNarrationEvent) => notifyNarration(input, event);
  emit({ type: "assistant-narration-start", turnId, narrationId: decision.narrationId, audience: "user", ...(kind ? { kind } : {}) });
  emit({ type: "assistant-narration-delta", turnId, narrationId: decision.narrationId, audience: "user", delta: decision.text });
  emit({ type: "assistant-narration-end", turnId, narrationId: decision.narrationId, audience: "user", status: "completed" });
  answerDraft.discardCommitted();
}

/** Tells the live stream that a narration left the chat, once the step that superseded it is journaled (`NarrationChain`). */
export function emitNarrationSuperseded(input: RunTurnInput, turnId: string, superseded: { readonly narrationId: string; readonly by: string }): void {
  notifyNarration(input, { type: "assistant-narration-superseded", turnId, narrationId: superseded.narrationId, audience: "user", by: superseded.by });
}

function notifyNarration(input: RunTurnInput, event: AgentNarrationEvent): void {
  try { input.onNarration?.(event); } catch { /* Observers cannot fail a durable turn. */ }
}
