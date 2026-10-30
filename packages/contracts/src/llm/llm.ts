import type { DataClassification, JsonValue } from "../shared/json.js";
import type { ModelImage } from "./image.js";

export interface ToolCall { readonly id: string; readonly name: string; readonly arguments: string }
/** Opaque state required by one adapter to reconstruct a provider request exactly. */
export interface AssistantModelState {
  readonly providerId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly stateVersion: number;
  readonly classification: DataClassification;
  readonly payload: JsonValue;
}
export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly images?: readonly ModelImage[];
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly providerState?: AssistantModelState;
  /** Provider-neutral trust and retention metadata; adapters must not serialize it as user-visible content. */
  readonly context?: {
    readonly trust: "instruction" | "untrusted";
    readonly retention: "required" | "compressible" | "droppable";
    readonly provenance: string;
  };
}
export interface ToolSchema { readonly name: string; readonly description: string; readonly inputSchema: JsonValue }
/** Provider-neutral model tool-selection control. Adapters own the wire-format mapping. */
export type LlmToolChoice = "auto" | "required" | "none" | { readonly name: string };
export type ModelMetadataSource = "provider-discovery" | "adapter-catalog" | "deployment-override" | "fallback";
/** Metadata for the exact provider/model route that will receive the request. */
export interface ResolvedLlmModel {
  readonly providerId: string;
  readonly adapterId: string;
  readonly modelId: string;
  readonly routeRevision: string;
  readonly metadataSource: ModelMetadataSource;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly tokenizerId?: string;
  /** Conservative conversion used only when no adapter token meter is available. */
  readonly estimatedCharsPerToken?: number;
}
export interface LlmContextMeasurement {
  readonly inputTokens: number;
  readonly method: "exact" | "provider" | "estimate";
  readonly revision: string;
}
export interface LlmContextMeasureInput {
  readonly model: ResolvedLlmModel;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolSchema[];
  readonly parameters: Readonly<Record<string, JsonValue>>;
}
export interface PreparedLlmRequest {
  readonly requestId: string; readonly attemptId: string; readonly turnId: string; readonly stepId: string;
  readonly runtimeSnapshotId: string; readonly model: string; readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolSchema[]; readonly toolChoice?: LlmToolChoice;
  readonly parameters: Readonly<Record<string, JsonValue>>; readonly contentHash: string;
}
export interface LlmUsage { readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number }
/**
 * What a provider counted for one call: the totals above plus, when it says so, how many input tokens it served from its
 * prompt cache. Absent means the provider did not say; it never stands for 0. Kept apart from `LlmUsage` because the turn's
 * running totals are `Required<LlmUsage>`, and a cache count is a fact about one call, not a sum.
 */
export interface LlmCallUsage extends LlmUsage {
  readonly cachedInputTokens?: number;
  /** Of `outputTokens`, those the provider counted as private reasoning; absent when it did not say. */
  readonly reasoningTokens?: number;
  /** Characters of private reasoning the call streamed (a length only, never the text); absent when none streamed. */
  readonly reasoningChars?: number;
}
export type LlmResponseStatus = "completed" | "tool_calls" | "incomplete" | "blocked" | "failed" | "unknown";
export type LlmStreamEvent =
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "reasoning-delta"; readonly delta: string }
  | { readonly type: "final"; readonly content: string | null; readonly toolCalls: readonly ToolCall[]; readonly finishReason: string; readonly status?: LlmResponseStatus; readonly usage?: LlmCallUsage; readonly providerRequestId?: string; readonly providerState?: AssistantModelState };
export interface LlmAdapter {
  readonly id: string; readonly providerId?: string; readonly model: string; readonly defaultParameters?: Readonly<Record<string, JsonValue>>;
  /**
   * Request parameters for a call that needs no private reasoning — a short rewrite, a label, a
   * summary — or a bounded recovery of a generation that exceeded its private reasoning limit.
   * Absent when the adapter has no such switch; the call is then made as any other.
   */
  readonly plainParameters?: Readonly<Record<string, JsonValue>>;
  /**
   * `progressStreaming`: the stream yields events while the model works, from its first token (reasoning or text deltas),
   * so a call silent for long has stalled rather than being busy. Without it a working call may be silent until its end:
   * hidden reasoning, tool calls sent whole. A request made with `plainParameters` is taken to have no such progress.
   */
  readonly features?: { readonly textStreaming?: boolean; readonly privateReasoning?: boolean; readonly toolChoice?: boolean; readonly progressStreaming?: boolean };
  /** Resolve the exact route at a clean execution boundary; implementations must not silently substitute a different model. */
  resolveModel?(signal: AbortSignal): Promise<ResolvedLlmModel>;
  /** Optional adapter-native token meter. Absence is explicit and activates a conservative fallback. */
  measureContext?(input: LlmContextMeasureInput, signal: AbortSignal): Promise<LlmContextMeasurement>;
  stream(request: PreparedLlmRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent>;
}
