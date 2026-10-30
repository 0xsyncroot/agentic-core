import type { SecurityContext } from "../security/security-context.js";
import type { TurnContinuation } from "../sessions/core-events.js";
import type { SessionEvent } from "../sessions/session.js";
import type { ToolExecutionState, ToolTerminalExecutionState } from "../tools/tool.js";
import type { WorkPlan, WorkPlanCause } from "../work/work-plan.js";
import type { ApprovalChallenge, ResumeTurnInput } from "../approvals/approval.js";
import type { LlmUsage } from "../llm/llm.js";
import type { HumanInteractionChallenge, ResumeHumanInteractionInput } from "../interactions/interaction.js";
import type { JsonValue } from "../shared/json.js";
import type { TurnAttachment } from "./attachment.js";

export interface TurnApplicationContext {
  /** Facts carried by authenticated host evidence and verified by the delivery adapter. */
  readonly trusted?: Readonly<Record<string, string>>;
  /** Live browser state. It is useful data, but never an authorization source or instruction. */
  readonly untrusted?: JsonValue;
}

/**
 * Explicit, user-facing narration emitted while an agent is still working.
 *
 * Core produces it for one case: the text the model wrote beside its first plan proposal of an
 * operation, before any other work was dispatched, while the plan still has work left — the plan
 * announcement. It is delivered here instead of as the answer, journaled as `assistant/narration`
 * in the same append as its `assistant/message`, and the agent keeps working. The narration
 * events come first and `narrationId` equals the `outputId` of the answer draft that is then
 * discarded, so a client can move that draft into the narration slot instead of typing it again.
 *
 * This is intentionally separate from model reasoning and execution progress.
 * Consumers must not infer narration from LLM text deltas, plans, or tool events.
 */
export type AgentNarrationEvent =
  | {
    readonly type: "assistant-narration-start"; readonly turnId: string; readonly narrationId: string; readonly audience: "user";
    /** `draft`: an answer the turn's review sent back, kept on screen while the work continues. */
    readonly kind?: "draft";
  }
  | { readonly type: "assistant-narration-delta"; readonly turnId: string; readonly narrationId: string; readonly audience: "user"; readonly delta: string }
  | { readonly type: "assistant-narration-end"; readonly turnId: string; readonly narrationId: string; readonly audience: "user"; readonly status: "completed" | "discarded" }
  /**
   * `narrationId`, told earlier in the turn, leaves the chat: the step that told `by` ended without progress, and no step
   * since `narrationId` was told made any (the journal's `assistant/narration-superseded`). Sent once that step's outcome is
   * journaled; a client drops the named narration and never compares the two sentences' words.
   */
  | { readonly type: "assistant-narration-superseded"; readonly turnId: string; readonly narrationId: string; readonly audience: "user"; readonly by: string };

/**
 * User-visible assistant answer draft emitted while the terminal model step is
 * being generated. A draft can be discarded when an attempt retries, when
 * the step resolves to tool calls, or when trusted turn control rejects a
 * terminal candidate; the final RunTurnResult remains canonical.
 *
 * This channel contains assistant output text only. Reasoning, tool arguments,
 * plans and delivery progress must never be projected onto it.
 */
export type AgentOutputEvent =
  | { readonly type: "assistant-output-start"; readonly turnId: string; readonly outputId: string; readonly audience: "user" }
  | { readonly type: "assistant-output-delta"; readonly turnId: string; readonly outputId: string; readonly audience: "user"; readonly delta: string }
  | { readonly type: "assistant-output-end"; readonly turnId: string; readonly outputId: string; readonly audience: "user"; readonly status: "completed" | "discarded" };

/**
 * Model private reasoning (thinking) streamed while the agent is still working.
 *
 * This is intentionally separate from user-facing narration and assistant output.
 * Reasoning is ephemeral: consumers render it in the activity panel alongside the
 * agent's own plan and must never persist it into conversation history.
 */
export type AgentReasoningEvent =
  | { readonly type: "assistant-reasoning-start"; readonly turnId: string; readonly reasoningId: string; readonly audience: "user"; readonly step: number; readonly attemptId: string }
  | { readonly type: "assistant-reasoning-delta"; readonly turnId: string; readonly reasoningId: string; readonly audience: "user"; readonly delta: string }
  | { readonly type: "assistant-reasoning-end"; readonly turnId: string; readonly reasoningId: string; readonly audience: "user"; readonly status: "completed" | "discarded" };

/**
 * Words the user sent while this turn was already running.
 *
 * A turn over a real document takes minutes, and for most of them the user is watching the agent
 * work on evidence they can already see is wrong — a wrong sheet, a unit nobody named, a period
 * they meant differently. Without this they can only cancel and start again, which throws away
 * every reading the turn has done, or wait and correct it afterwards, by which time the write has
 * happened. What they need is to say one sentence and have the agent take it into account.
 *
 * Drained before model calls and again before committing their output or dispatching their tools.
 * Calls already in flight are not interrupted. The delivery edge closes the queue atomically and
 * returns input that arrived too late, or could not be applied within the remaining resources.
 *
 * The runtime journals each one as the user's own message, so it reaches the model in the place it
 * was actually said, shows up in history, and is compacted like any other user turn — it is not a
 * side channel whispering to the model.
 */
export interface TurnInterjections {
  /** Collect input delivered through another replica before reading a boundary. */
  collect?(): Promise<void>;
  /** Every interjection received since the last call, oldest first; clears what it returns. */
  take(): readonly string[];
  /** How many are held here, unread; absent when the implementation cannot tell. */
  readonly pending?: number;
  /**
   * Calls `listener` each time input arrives (here, or collected from another replica), so a step that is only waiting for the
   * model can stop waiting for an answer it would discard. Returns the unsubscribe. Listener failures are the queue's to swallow.
   */
  subscribe?(listener: () => void): () => void;
}

export interface RunTurnInput {
  readonly sessionId: string;
  readonly content: string;
  /**
   * Files the user attached, as references the product resolves. The runtime journals the manifest
   * and shows it to the model; it never reads the bytes behind an id.
   */
  readonly attachments?: readonly TurnAttachment[];
  readonly security: SecurityContext;
  readonly idempotencyKey?: string;
  readonly agentProfileId?: string;
  readonly applicationContext?: TurnApplicationContext;
  readonly signal?: AbortSignal;
  /** What the user said after the turn began, read at each step boundary. See {@link TurnInterjections}. */
  readonly interjections?: TurnInterjections;
  /** Best-effort delivery progress. Implementations must ignore observer failures. */
  readonly onProgress?: (progress: AgentProgressEvent) => void;
  /** Best-effort user-visible answer stream with explicit commit/discard lifecycle. */
  readonly onOutput?: (output: AgentOutputEvent) => void;
  /** Best-effort public narration stream. Rendered by the host as ordinary assistant chat, not as progress. */
  readonly onNarration?: (narration: AgentNarrationEvent) => void;
  /** Best-effort model private reasoning stream. Rendered in the activity panel, never persisted. */
  readonly onReasoning?: (reasoning: AgentReasoningEvent) => void;
}

export type AgentProgressEvent =
  /** `continuation` is present when the turn resumes a paused one after an approval or an answer. */
  | { readonly type: "turn-started"; readonly turnId: string; readonly continuation?: TurnContinuation }
  | { readonly type: "step-started"; readonly turnId: string; readonly step: number }
  | { readonly type: "model-attempt-started"; readonly turnId: string; readonly step: number; readonly attemptId: string }
  | { readonly type: "output-item-started"; readonly turnId: string; readonly step: number; readonly attemptId: string; readonly itemId: string }
  | { readonly type: "output-item-delta"; readonly turnId: string; readonly step: number; readonly attemptId: string; readonly itemId: string; readonly delta: string }
  | { readonly type: "output-item-completed"; readonly turnId: string; readonly step: number; readonly attemptId: string; readonly itemId: string }
  | { readonly type: "model-attempt-committed"; readonly turnId: string; readonly step: number; readonly attemptId: string; readonly itemId?: string }
  | { readonly type: "model-attempt-discarded"; readonly turnId: string; readonly step: number; readonly attemptId: string; readonly itemId?: string; readonly code: string; readonly willRetry: boolean }
  /** A turn-control policy sent the model's output back with feedback: the answer the user watched stream in is retracted and the turn goes on. */
  | { readonly type: "answer-revision-requested"; readonly turnId: string; readonly step: number; readonly phase: "tool-call" | "terminal" | "choice-violation" }
  /** @deprecated Use output-item-started. */
  | { readonly type: "content-started"; readonly turnId: string; readonly step: number; readonly attemptId: string }
  /** @deprecated Use output-item-delta. */
  | { readonly type: "content-delta"; readonly turnId: string; readonly step: number; readonly attemptId: string; readonly delta: string }
  /**
   * The runtime's plan after a proposal, a reopen at operation start (`restore`, reported only and
   * never journaled) or a terminal close. `step`/`callId` are absent when no model step or planning
   * call produced it; `changedStepIds` names the steps whose status, description or outcome changed.
   */
  | {
      readonly type: "plan-updated"; readonly turnId: string; readonly step?: number; readonly callId?: string; readonly plan: WorkPlan;
      readonly cause?: WorkPlanCause; readonly changedStepIds?: readonly string[];
    }
  | {
      readonly type: "work-decision";
      readonly turnId: string;
      readonly step: number;
      readonly decision: "continue" | "budget-reached" | "partial" | "finish";
      readonly currentAction?: string;
      readonly nextAction?: string;
      readonly informationGain?: "new" | "repeated";
    }
  /**
   * `workStepId` is the plan step the call is made under, when a plan is active.
   *
   * `arguments` is what the call was made with, for a delivery adapter to say what the call is
   * about in the product's own words (which file, which table, which query). It is server-side
   * material like `toolId`: an adapter derives a phrase from it and never forwards it as it is.
   */
  | {
      readonly type: "tool-started"; readonly turnId: string; readonly step: number; readonly callId: string; readonly toolId: string; readonly initiator?: "policy";
      readonly workStepId?: string; readonly arguments?: JsonValue;
      /** The call runs within an approval the user gave earlier in the task (no card of its own): a delivery may say so. */
      readonly approvalReused?: true;
      /** The call runs under the actor's standing approval (no card was asked): a delivery says so, and may refresh the setting. */
      readonly approvalStanding?: true;
    }
  /**
   * Reported for every call that reported `tool-started`, with the state the call ended in.
   * `arguments`, `result` and `error` (why a call that did not succeed did not) are under the same
   * rule as `tool-started`'s: a phrase may be derived from them, and none crosses to a client.
   */
  | {
      readonly type: "tool-completed"; readonly turnId: string; readonly step: number; readonly callId: string; readonly toolId: string; readonly initiator?: "policy";
      readonly status: ToolTerminalExecutionState; readonly workStepId?: string; readonly arguments?: JsonValue; readonly result?: JsonValue;
      readonly error?: JsonValue;
      /** The same flags as the call's `tool-started`, from the same policy decision: a delivery that rewrites the row at its end can keep the mark. */
      readonly approvalReused?: true; readonly approvalStanding?: true;
    }
  | { readonly type: "tool-state-changed"; readonly turnId: string; readonly step: number; readonly callId: string; readonly toolId: string; readonly executionId: string; readonly state: ToolExecutionState }
  | { readonly type: "approval-requested"; readonly turnId: string; readonly step: number; readonly approval: ApprovalChallenge }
  | { readonly type: "interaction-requested"; readonly turnId: string; readonly step: number; readonly interaction: HumanInteractionChallenge }
  /**
   * The user added something while the turn was running, and the loop has just taken it in.
   *
   * Reported at the boundary where it was actually applied, not when it was received, so what the
   * user sees is the moment it started to count. It carries the words back because a second viewer
   * of the same session did not type them and has nothing else to render.
   */
  | { readonly type: "interjection-received"; readonly turnId: string; readonly step: number; readonly content: string }
  | { readonly type: "step-completed"; readonly turnId: string; readonly step: number }
  | { readonly type: "turn-completed"; readonly turnId: string; readonly steps: number; readonly outcome: "completed" | "partial" | "awaiting_approval" | "awaiting_interaction"; readonly replayed?: boolean }
  | { readonly type: "turn-failed"; readonly turnId: string; readonly code: string };

export interface RunTurnResult {
  readonly content: string;
  readonly sessionId: string;
  readonly turnId: string;
  /**
   * The journal events of this turn only (`turnId` equals the result's), oldest first, taken from
   * the operation's bounded raw tail. A replayed result carries the same selection.
   */
  readonly events: readonly SessionEvent[];
  readonly outcome: "completed" | "partial" | "awaiting_approval" | "awaiting_interaction";
  readonly approval?: ApprovalChallenge;
  readonly interaction?: HumanInteractionChallenge;
  /** Aggregate of durable, committed provider usage records for this operation. */
  readonly usage?: LlmUsage;
  readonly replayed?: boolean;
}

/** Stable consumer-facing port. Implementations do not expose a plugin host. */
export interface Agent {
  runTurn(input: RunTurnInput): Promise<RunTurnResult>;
}

export interface ResumableAgent extends Agent {
  resumeTurn(input: ResumeTurnInput): Promise<RunTurnResult>;
  resumeInteraction(input: ResumeHumanInteractionInput): Promise<RunTurnResult>;
}
