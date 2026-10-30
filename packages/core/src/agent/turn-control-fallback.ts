import type { ChatMessage, EventDraft, FormInteractionRequest, JsonValue, LlmUsage, RunTurnInput, RunTurnResult, TurnControlPolicy } from "@0xsyncroot/contracts";
import { toJsonValue } from "./json-value.js";
import { report } from "./operation-observers.js";
import { normalizedContentHash, normalizedText, terminalCandidateHash, turnControlDecisionDraft } from "./turn-control.js";
import { turnControlFeedback } from "./turn-control-feedback.js";
import type { TurnEventWriter } from "./turn-event-writer.js";
import type { TurnTerminator } from "./turn-terminator.js";

/** What the loop hands over once a policy has sent the model's output back. */
export interface TurnControlReviewCommand {
  readonly policy: TurnControlPolicy;
  readonly input: RunTurnInput;
  readonly turnId: string;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly requestId: string;
  readonly attemptId: string;
  readonly phase: "tool-call" | "terminal" | "choice-violation";
  readonly feedback: string;
  /** The objection says the work is not finished: journaled with it, and the work-remains gate's rules apply to it. */
  readonly workRemains?: boolean;
  /** The work-remains gate decided on an answer the policy marked delivered (`TurnOutputReview`): journaled with the decision. */
  readonly delivered?: true;
  /** The policy's fallback, offered as guidance once an objection has already been sent back. */
  readonly guidance?: string;
  readonly candidate: { readonly content: string | null; readonly finishReason: string; readonly status?: string; readonly toolCalls: readonly unknown[] };
  /** Omitted when the step's usage was journaled already, with the assistant message the review followed. */
  readonly usageDraft?: { readonly type: string; readonly payload: Readonly<Record<string, JsonValue>> };
  readonly usage: Required<LlmUsage>;
  readonly writer: TurnEventWriter;
  /** Retracts the answer the user has been watching stream in: it was not accepted. */
  readonly discardDraftAnswer: () => void;
  /** The id the streamed draft would carry as narration: its own output id, so a client moves the text instead of retyping it. */
  readonly draftNarrationId: string;
  /** Hands the streamed draft over to the narration channel under that id, for a policy that keeps drafts. */
  readonly narrateDraftAnswer: (text: string) => void;
  /** The draft this turn last kept on screen; the same text is not kept a second time. */
  readonly lastKeptDraft?: string;
}

export interface TurnControlFallbackCommand extends TurnControlReviewCommand {
  /** The product's sentence; empty when it supplied none, and the turn still ends, as partial. */
  readonly fallback: string;
  readonly terminator: TurnTerminator;
  /** The runtime's question whether to go on, when its own bound ended work that `decide()` finds left. */
  readonly question?: FormInteractionRequest;
}

/**
 * Says that the answer on screen is about to go, and then retracts it.
 *
 * The draft streamed to the user as the model wrote it, so by the time a policy rejects it the
 * user has read most of it. Retracting it silently is what a glitch looks like — text appears,
 * vanishes, and something different arrives. The progress event goes first so the trace can
 * say the answer is under review before the bubble empties.
 */
function retractDraft(command: TurnControlReviewCommand): void {
  // Only an answer the user could have seen is announced as being reconsidered. A rejected
  // tool call showed nothing, and a row saying the answer is under review would then be about
  // an answer that never existed.
  if (command.phase === "terminal" && command.candidate.content?.trim()) {
    report(command.input, { type: "answer-revision-requested", turnId: command.turnId, step: command.stepIndex, phase: command.phase });
  }
  command.discardDraftAnswer();
}

/**
 * The streamed text a policy that keeps drafts leaves on screen, as the narration it becomes.
 *
 * Such a policy objects because the work is not finished, not because the text is wrong, and a
 * retraction then reads as the assistant taking back something true: the user watched a whole
 * report appear, collapse into "reviewing the answer", and come back. Kept, the text stays where
 * it was read, is journaled like any other narration, and folds away with the turn's account.
 * Every phase is kept alike — a terminal answer, text beside a refused call, a choice violation.
 */
function keptDraft(command: TurnControlReviewCommand): { readonly text: string; readonly draft: EventDraft } | undefined {
  const text = command.candidate.content?.trim();
  if (!command.policy.keepDraftsAsNarration || !text || repeatsKeptDraft(command)) return undefined;
  return { text, draft: {
    type: "assistant/narration", turnId: command.turnId, stepId: command.stepId,
    payload: { narrationId: command.draftNarrationId, audience: "user", content: text, draft: true },
  } };
}

/**
 * The draft is the one already on screen, word for word. Narrated again it would stand twice in the chat, the same
 * sentence under itself; it simply goes, without the "reviewing the answer" row a retraction shows — what it said is
 * still there to read.
 */
function repeatsKeptDraft(command: TurnControlReviewCommand): boolean {
  const text = command.candidate.content;
  return Boolean(command.policy.keepDraftsAsNarration && text?.trim() && command.lastKeptDraft !== undefined &&
    normalizedText(text) === normalizedText(command.lastKeptDraft));
}

/** The streamed draft leaves the screen: as narration, silently when it repeats what is shown, or retracted. */
function settleDraft(command: TurnControlReviewCommand, kept: { readonly text: string } | undefined): void {
  if (kept) command.narrateDraftAnswer(kept.text);
  else if (repeatsKeptDraft(command)) command.discardDraftAnswer();
  else retractDraft(command);
}

/**
 * Sends the model's output back with the policy's feedback, and returns what the next step
 * will read. The rejected answer is not journaled, so it does not reach the next step through
 * the conversation; it travels inside the objection — `turnControlFeedback` says why there.
 */
export async function continueAfterTurnControl(command: TurnControlReviewCommand): Promise<ChatMessage> {
  const { policy, input, turnId, stepId, stepIndex, writer } = command;
  const kept = keptDraft(command);
  // What the answer said, normalized: the turn's ledger keeps the same hash, and the same answer back ends the work.
  const contentHash = command.phase === "terminal" ? normalizedContentHash(command.candidate.content) : undefined;
  // A kept draft is journaled with the step that was sent back: that step's end is what tells a
  // reader of the journal this narration was a draft, not the turn's announcement.
  await writer.append([
    ...(command.usageDraft ? [command.usageDraft as never] : []),
    turnControlDecisionDraft(policy, turnId, stepId, command.phase, "continue", {
      candidateHash: terminalCandidateHash(command.candidate), reason: command.feedback, ...(command.workRemains ? { workRemains: true } : {}),
      ...(contentHash ? { contentHash } : {}), ...(command.delivered ? { delivered: true } : {}),
    }),
    ...(kept ? [kept.draft] : []),
    { type: "step/end", turnId, stepId, payload: { status: "completed", reason: "turn-control-continue" } },
  ], `turn-control:continue:${command.attemptId}`);
  settleDraft(command, kept);
  report(input, { type: "step-completed", turnId, step: stepIndex });
  // A repeat of the kept draft is on screen too, as that draft: quoted as shown, never as withheld.
  const shown = kept?.text ?? (repeatsKeptDraft(command) ? command.lastKeptDraft : undefined);
  return turnControlFeedback(policy, command.feedback, {
    ...(shown ? { withheldAnswer: shown, keptAsNarration: true } : command.phase === "terminal" ? { withheldAnswer: command.candidate.content } : {}),
    ...(command.guidance ? { guidance: command.guidance } : {}),
  });
}

/**
 * Journals the work-remains gate's decision to close: the stalled answer becomes narration (or is
 * retracted, by the policy's choice, exactly as a sent-back draft is) and the step ends, so the next
 * step can be the closing one. Recorded as `close`, not `continue`: it is no further objection, and
 * the turn does not count it as one (`decide()` counts objections sent back).
 */
export async function closeAfterTurnControl(command: TurnControlReviewCommand & { readonly reason: string }): Promise<void> {
  const { policy, input, turnId, stepId, stepIndex, writer } = command;
  const kept = keptDraft(command);
  await writer.append([
    ...(command.usageDraft ? [command.usageDraft as never] : []),
    turnControlDecisionDraft(policy, turnId, stepId, command.phase, "close", {
      candidateHash: terminalCandidateHash(command.candidate), reason: command.reason, workRemains: true,
      ...(command.delivered ? { delivered: true } : {}),
    }),
    ...(kept ? [kept.draft] : []),
    { type: "step/end", turnId, stepId, payload: { status: "completed", reason: "work-remains-closing" } },
  ], `turn-control:close:${command.attemptId}`);
  settleDraft(command, kept);
  report(input, { type: "step-completed", turnId, step: stepIndex });
}

/**
 * Ends a turn with the policy's own safe answer.
 *
 * A policy that re-raises the identical objection has established that the model will not
 * comply, so re-feeding it only burns the remaining budget and then truncates the user's
 * answer anyway. The policy supplies a `fallback` for exactly this case: an accurate,
 * conservative reply that states what could not be confirmed. The turn ends `partial`,
 * because the agent did not do what it set out to do — through the terminator, like any end.
 */
export async function finishWithTurnControlFallback(command: TurnControlFallbackCommand): Promise<RunTurnResult> {
  const { policy, turnId, stepId, stepIndex } = command;
  const kept = keptDraft(command);
  settleDraft(command, kept);
  return command.terminator.finishFallback({
    stepId, stepIndex, content: command.fallback, usage: command.usage, ...(command.question ? { question: command.question } : {}),
    drafts: [
      ...(command.usageDraft ? [command.usageDraft as never] : []),
      turnControlDecisionDraft(policy, turnId, stepId, command.phase, "fallback", {
        candidateHash: terminalCandidateHash(command.candidate), reason: command.feedback,
      }),
      ...(kept ? [kept.draft] : []),
      {
        type: "assistant/message", turnId, stepId, requestId: command.requestId, attemptId: command.attemptId,
        payload: toJsonValue({
          content: command.fallback, toolCalls: [], finishReason: "turn-control-fallback", usage: {},
        }),
      },
    ],
  });
}
