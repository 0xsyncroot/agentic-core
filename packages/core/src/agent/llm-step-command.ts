import type { ChatMessage, LlmAdapter, LlmStreamEvent, LlmToolChoice, ResolvedLlmModel, ToolDefinition } from "@0xsyncroot/contracts";
import type { TurnEventWriter } from "./turn-event-writer.js";

/** The `llm/attempt-discarded` code of a call cut for input the user added while it ran (`watchInterjections`). */
export const INTERJECTION_DISCARD = "interjection";

export interface LlmStepCommand {
  readonly turnId: string;
  readonly stepId: string;
  readonly runtimeSnapshotId: string;
  readonly messages: readonly ChatMessage[];
  readonly llm: LlmAdapter;
  readonly resolvedModel: ResolvedLlmModel;
  readonly tools: readonly ToolDefinition[];
  readonly toolChoice?: LlmToolChoice;
  readonly writer: TurnEventWriter;
  readonly signal: AbortSignal;
  /** Cuts the call when the user adds input: discarded as INTERJECTION_DISCARD, never retried. */
  readonly interrupt?: AbortSignal;
  readonly maxContextChars?: number;
  readonly onAttemptStarted?: (attemptId: string) => void;
  readonly onOutputStarted?: (attemptId: string, itemId: string) => void;
  readonly onTextDelta?: (delta: string, attemptId: string, itemId: string) => void;
  readonly onOutputCompleted?: (attemptId: string, itemId: string) => void;
  /** Ephemeral private reasoning. It is never persisted, so it has no event-journal counterpart. */
  readonly onReasoningStarted?: (attemptId: string, reasoningId: string) => void;
  readonly onReasoningDelta?: (delta: string, attemptId: string, reasoningId: string) => void;
  readonly onReasoningEnded?: (attemptId: string, reasoningId: string, status: "completed" | "discarded") => void;
  readonly onAttemptCommitted?: (attemptId: string, itemId?: string) => void;
  readonly onAttemptDiscarded?: (attemptId: string, code: string, willRetry: boolean, itemId?: string) => void;
  /** The serialized size of what is about to be sent, after trimming: set against the tokens a refusal counts. */
  readonly onRequestSized?: (chars: number) => void;
  /** The closing lines of the skills in effect (`skillClosingLines`): after the closing instruction, in the request's last message. */
  readonly closingLines?: readonly string[];
  /** The turn's last model step: the request's last message invites no further calls. */
  readonly finalStep?: boolean;
  /** Asked without private reasoning (`plainParameters`) from the first attempt, as a reasoning-limit recovery is; ignored without them. */
  readonly plain?: boolean;
}

export interface LlmStepResult {
  readonly final: Extract<LlmStreamEvent, { type: "final" }>;
  readonly requestId: string;
  readonly attemptId: string;
  /** Serialized characters of what was sent (messages and tool schemas, images not counted), to set against the tokens the provider counted. */
  readonly requestChars: number;
  /** Input tokens the provider served from its prompt cache for the used call, and those it read afresh; absent when it did not say. */
  readonly cachedInputTokens?: number;
  readonly uncachedInputTokens?: number;
}
