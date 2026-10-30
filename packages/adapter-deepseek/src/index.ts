import { apiMessages } from "./image-messages.js";
import type {
  AssistantModelState,
  ChatMessage,
  JsonValue,
  LlmAdapter,
  LlmStreamEvent,
  PreparedLlmRequest,
  ResolvedLlmModel,
} from "@0xsyncroot/contracts";
import { AgenticError, CAPABILITIES } from "@0xsyncroot/contracts";
import {
  LLM_CAPABILITY,
  type PluginDescriptor,
  type PluginManifest,
  type AgentPlugin,
} from "@0xsyncroot/plugin-sdk";
import { parseDeepSeekStream, type DeepSeekStreamComplete } from "./deepseek-stream.js";
import { DsmlDeltaGuard, dsmlToolCalls, looksLikeDsml } from "./deepseek-dsml.js";
export interface DeepSeekConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: "deepseek-v4-flash" | "deepseek-v4-pro" | (string & {});
  readonly thinking?: "enabled" | "disabled";
  readonly maxReasoningContentChars?: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Verified deployment metadata supplied by a trusted control plane for custom routes. */
  readonly modelContext?: {
    readonly contextWindowTokens: number;
    readonly maxOutputTokens?: number;
    readonly tokenizerId?: string;
    readonly revision: string;
  };
}
/**
 * A turn deadline aborts with `TimeoutError`. Calling that a cancellation is what the chat
 * shows as "stopped as requested" while the sheet is still being read.
 */
function abortedModelCall(signal: AbortSignal, cause: unknown, message: string): AgenticError {
  const reason = signal.reason;
  if (reason instanceof AgenticError) return reason;
  if (reason instanceof Error && reason.name === "TimeoutError") {
    return new AgenticError("timeout", reason.message || message, true, { cause });
  }
  return new AgenticError("cancelled", message, false, { cause });
}
const ADAPTER_ID = "deepseek";
const ADAPTER_VERSION = "0.1.0";
const PROVIDER_STATE_VERSION = 1;
const DEFAULT_MAX_REASONING_CONTENT_CHARS = 64_000;
interface DeepSeekResponse {
  readonly error?: { readonly message?: string };
}
function isContextOverflow(status: number, message: string): boolean {
  return (status === 400 || status === 413) && /context.{0,24}(length|window|limit)|too many tokens|maximum context/iu.test(message);
}
function reasoningContent(state: AssistantModelState | undefined): string | undefined {
  if (
    state?.providerId !== "deepseek" ||
    state.adapterId !== ADAPTER_ID ||
    state.adapterVersion !== ADAPTER_VERSION ||
    state.stateVersion !== PROVIDER_STATE_VERSION ||
    typeof state.payload !== "object" ||
    state.payload === null ||
    Array.isArray(state.payload)
  ) return undefined;
  const value = state.payload.reasoningContent;
  return typeof value === "string" ? value : undefined;
}
function apiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", content: message.content ?? "", tool_call_id: message.toolCallId };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    const privateReasoning = reasoningContent(message.providerState);
    return {
      role: "assistant",
      content: message.content,
      ...(privateReasoning !== undefined ? { reasoning_content: privateReasoning } : {}),
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content ?? "", ...(message.name ? { name: message.name } : {}) };
}

export class DeepSeekAdapter implements LlmAdapter {
  readonly id = ADAPTER_ID;
  readonly providerId = "deepseek";
  readonly model: string;
  readonly defaultParameters: Readonly<Record<string, JsonValue>>;
  readonly plainParameters: Readonly<Record<string, JsonValue>>;
  readonly features: { readonly textStreaming: true; readonly privateReasoning: boolean; readonly toolChoice: boolean };
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #thinkingEnabled: boolean;
  readonly #maxReasoningContentChars: number;
  readonly #modelContext: DeepSeekConfig["modelContext"];

  constructor(config: DeepSeekConfig) {
    if (!config.apiKey.trim()) throw new Error("DeepSeek API key is required");
    this.#apiKey = config.apiKey;
    this.#baseUrl = (config.baseUrl ?? "https://api.deepseek.com").replace(/\/$/, "");
    this.model = config.model ?? "deepseek-v4-flash";
    this.defaultParameters = { thinking: { type: config.thinking ?? "disabled" } };
    this.plainParameters = { thinking: { type: "disabled" } };
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#thinkingEnabled = config.thinking === "enabled";
    // Thinking mode rejects a named or required tool_choice outright (400), so the adapter must
    // not claim to enforce one there; the loop then enforces it in words instead.
    this.features = { textStreaming: true, privateReasoning: this.#thinkingEnabled, toolChoice: !this.#thinkingEnabled };
    this.#maxReasoningContentChars = config.maxReasoningContentChars ?? DEFAULT_MAX_REASONING_CONTENT_CHARS;
    this.#modelContext = config.modelContext;
    if (!Number.isInteger(this.#maxReasoningContentChars) || this.#maxReasoningContentChars <= 0) {
      throw new Error("maxReasoningContentChars must be a positive integer");
    }
    if (this.#modelContext && (!Number.isInteger(this.#modelContext.contextWindowTokens) ||
        this.#modelContext.contextWindowTokens <= 0 || !this.#modelContext.revision.trim())) {
      throw new Error("DeepSeek modelContext requires a positive contextWindowTokens and revision");
    }
  }

  async resolveModel(): Promise<ResolvedLlmModel> {
    const catalog = this.model === "deepseek-v4-flash" || this.model === "deepseek-v4-pro"
      ? { contextWindowTokens: 1_000_000, maxOutputTokens: 256_000, tokenizerId: "deepseek-v4", revision: "deepseek-v4-catalog-2026-07" }
      : undefined;
    const context = this.#modelContext ?? catalog;
    return {
      providerId: this.providerId, adapterId: this.id, modelId: this.model,
      routeRevision: context?.revision ?? `deepseek-unlisted:${this.model}`,
      metadataSource: this.#modelContext ? "deployment-override" : catalog ? "adapter-catalog" : "fallback",
      ...(context ? {
        contextWindowTokens: context.contextWindowTokens,
        ...(context.maxOutputTokens ? { maxOutputTokens: context.maxOutputTokens } : {}),
        ...(context.tokenizerId ? { tokenizerId: context.tokenizerId } : {}),
      } : {}),
      estimatedCharsPerToken: 3,
    };
  }

  async *stream(request: PreparedLlmRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: request.model,
          messages: apiMessages(request.messages, apiMessage),
          ...(request.tools.length > 0
            ? {
                tools: request.tools.map((tool) => ({
                  type: "function",
                  function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
                })),
              }
            : {}),
          ...request.parameters,
          ...(request.toolChoice === undefined || (this.#thinkingEnabled && request.toolChoice !== "auto" && request.toolChoice !== "none") ? {} : {
            tool_choice: typeof request.toolChoice === "string"
              ? request.toolChoice
              : { type: "function", function: { name: request.toolChoice.name } },
          }),
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
    } catch (error) {
      if (signal.aborted) throw abortedModelCall(signal, error, "DeepSeek request was cancelled");
      throw new AgenticError("transient", "DeepSeek transport failed", true, { cause: error });
    }

    if (!response.ok) {
      let payload: DeepSeekResponse = {};
      try { payload = (await response.json()) as DeepSeekResponse; } catch { /* Preserve status fallback. */ }
      const detail = payload.error?.message ?? response.statusText;
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
      const overflow = isContextOverflow(response.status, detail);
      throw new AgenticError(
        overflow ? "context-overflow" : retryable ? "transient" : "permanent",
        `DeepSeek request failed (${response.status}): ${detail}`,
        retryable,
      );
    }

    let completed: DeepSeekStreamComplete | undefined;
    const visible = new DsmlDeltaGuard();
    try {
      for await (const event of parseDeepSeekStream(response, this.#maxReasoningContentChars)) {
        if (event.type === "text-delta") {
          const delta = visible.push(event.delta);
          if (delta) yield { type: "text-delta", delta };
        } else {
          const rest = visible.flush();
          if (rest) yield { type: "text-delta", delta: rest };
          completed = event;
        }
      }
    } catch (error) {
      if (error instanceof AgenticError) throw error;
      if (signal.aborted) throw abortedModelCall(signal, error, "DeepSeek request was cancelled");
      throw new AgenticError("transient", "DeepSeek stream failed", true, { cause: error });
    }
    if (!completed) throw new AgenticError("permanent", "DeepSeek stream ended without a completion");
    const fallback = completed.toolCalls.length === 0
      ? dsmlToolCalls(completed.content, request.requestId)
      : { prose: null, calls: [] };
    const fallbackToolCalls = fallback.calls;
    const toolCalls = fallbackToolCalls.length > 0 ? fallbackToolCalls : completed.toolCalls;
    // Markup the parser could not turn into calls is not an answer, and neither is the sentence
    // in front of it: the model was reaching for a tool, not replying. Dropping the whole reply
    // leaves the step with nothing to say, which the loop handles; publishing it has no recovery.
    // A parsed envelope keeps its prose, exactly as text beside a native tool call is kept.
    const unparsedEnvelope = fallbackToolCalls.length === 0 && looksLikeDsml(completed.content);
    const content = fallbackToolCalls.length > 0 ? fallback.prose : unparsedEnvelope ? null : completed.content;
    const finishReason = fallbackToolCalls.length > 0 ? "tool_calls" : completed.finishReason;
    const status = toolCalls.length > 0
      ? "tool_calls" as const
      : finishReason === "stop" ? "completed" as const
      : finishReason === "length" ? "incomplete" as const
      : finishReason === "content_filter" ? "blocked" as const
      : "unknown" as const;
    // Plain recovery may return a tool call with no reasoning. Keep the explicit empty value
    // so the next thinking-mode continuation can replay that assistant turn faithfully.
    const providerState: AssistantModelState | undefined = this.#thinkingEnabled && (completed.reasoningContent || toolCalls.length > 0)
      ? {
          providerId: "deepseek",
          adapterId: ADAPTER_ID,
          adapterVersion: ADAPTER_VERSION,
          stateVersion: PROVIDER_STATE_VERSION,
          classification: "confidential",
          payload: { reasoningContent: completed.reasoningContent },
        }
      : undefined;
    yield {
      type: "final",
      content,
      toolCalls,
      finishReason,
      status,
      ...(providerState ? { providerState } : {}),
      ...(completed.providerRequestId ? { providerRequestId: completed.providerRequestId } : {}),
      ...(completed.usage
        ? {
            usage: {
              ...(completed.usage.prompt_tokens !== undefined ? { inputTokens: completed.usage.prompt_tokens } : {}),
              ...(completed.usage.completion_tokens !== undefined ? { outputTokens: completed.usage.completion_tokens } : {}),
              ...(completed.usage.total_tokens !== undefined ? { totalTokens: completed.usage.total_tokens } : {}),
            },
          }
        : {}),
    };
  }
}

export function createDeepSeekPlugin(config: DeepSeekConfig): PluginDescriptor {
  const id = "io.syncroot.adapter.deepseek";
  const adapter = new DeepSeekAdapter(config);
  const manifest: PluginManifest = {
    manifestVersion: 1,
    id,
    version: "0.1.0",
    publisher: "Agentic Platform",
    coreApi: "^1.0.0",
    artifact: { digest: `builtin:${id}@0.1.0`, signature: "trusted-assembly" },
    requires: {},
    provides: { [CAPABILITIES.llm]: { version: "1.0.0", cardinality: "single" } },
    permissions: { network: [new URL(config.baseUrl ?? "https://api.deepseek.com").origin], secrets: ["DEEPSEEK_API_KEY"] },
  };
  const plugin: AgentPlugin = {
    validate: async () => ({ valid: true }),
    activate: async (context) => {
      context.registrations.provide(LLM_CAPABILITY, adapter);
      return { dispose: () => undefined };
    },
    health: async () => ({ healthy: true }),
  };
  return {
    manifest,
    plugin,
    trustTier: "platform-core",
    config: {
      model: adapter.model,
      baseUrl: (config.baseUrl ?? "https://api.deepseek.com").replace(/\/$/, ""),
      thinking: config.thinking ?? "disabled",
      maxReasoningContentChars: config.maxReasoningContentChars ?? DEFAULT_MAX_REASONING_CONTENT_CHARS,
    },
  };
}
