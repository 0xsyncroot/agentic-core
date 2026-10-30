import { AgenticError, type ChatMessage, type JsonValue, type LlmAdapter, type LlmStreamEvent, type PreparedLlmRequest, type ResolvedLlmModel } from "@0xsyncroot/contracts";
import { CAPABILITIES } from "@0xsyncroot/contracts";
import { LLM_CAPABILITY, type AgentPlugin, type PluginDescriptor, type PluginManifest } from "@0xsyncroot/plugin-sdk";
import { parseOpenAIStream, type OpenAIOutputItem } from "./openai-stream.js";

const ADAPTER_ID = "openai-responses";
const ADAPTER_VERSION = "0.1.0";
const STATE_VERSION = 1;
const DEFAULT_MAX_STATE_CHARS = 200_000;

function isContextOverflow(status: number, message: string, code: string | undefined): boolean {
  // `code` is the machine-readable half of the documented error envelope and the only part that
  // survives a reworded or localized message, so it decides first; the wording is the fallback.
  if (code === "context_length_exceeded") return true;
  return (status === 400 || status === 413) && /context.{0,24}(length|window|limit)|too many tokens|maximum context/iu.test(message);
}

export interface OpenAIConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly organization?: string;
  readonly project?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly allowInsecureInternal?: boolean;
  readonly maxProviderStateChars?: number;
  /** Verified deployment metadata supplied by a trusted control plane for custom routes. */
  readonly modelContext?: {
    readonly contextWindowTokens: number;
    readonly maxOutputTokens?: number;
    readonly tokenizerId?: string;
    readonly revision: string;
  };
}

function storedOutput(message: ChatMessage): readonly OpenAIOutputItem[] | undefined {
  const state = message.providerState;
  if (!state || state.providerId !== "openai" || state.adapterId !== ADAPTER_ID ||
      state.adapterVersion !== ADAPTER_VERSION || state.stateVersion !== STATE_VERSION) return undefined;
  if (typeof state.payload !== "object" || state.payload === null || Array.isArray(state.payload)) return undefined;
  const output = (state.payload as { outputItems?: unknown }).outputItems;
  return Array.isArray(output) ? output as OpenAIOutputItem[] : undefined;
}

function inputItems(messages: readonly ChatMessage[]): JsonValue[] {
  const items: JsonValue[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      items.push({ type: "function_call_output", call_id: message.toolCallId ?? "", output: message.images?.length
        ? [{ type: "input_text", text: message.content ?? "" }, ...message.images.map((image) => ({ type: "input_image", image_url: `data:${image.mediaType};base64,${image.data}`, detail: "auto" }))]
        : message.content ?? "" });
      continue;
    }
    const replay = message.role === "assistant" ? storedOutput(message) : undefined;
    if (replay) { items.push(...replay as unknown as JsonValue[]); continue; }
    if (message.images?.length) items.push({ role: message.role, content: [
      { type: "input_text", text: message.content ?? "" },
      ...message.images.map((image) => ({ type: "input_image", image_url: `data:${image.mediaType};base64,${image.data}`, detail: "auto" })),
    ] });
    else if (message.content) items.push({ role: message.role, content: message.content });
    for (const call of message.toolCalls ?? []) {
      items.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
    }
  }
  return items;
}

export class OpenAIAdapter implements LlmAdapter {
  readonly id = ADAPTER_ID;
  readonly providerId = "openai";
  readonly model: string;
  readonly defaultParameters: Readonly<Record<string, JsonValue>> = { store: false };
  readonly features = { textStreaming: true, privateReasoning: false, toolChoice: true } as const;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #organization: string | undefined;
  readonly #project: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #maxProviderStateChars: number;
  readonly #modelContext: OpenAIConfig["modelContext"];

  constructor(config: OpenAIConfig) {
    if (!config.apiKey.trim()) throw new Error("OpenAI API key is required");
    const endpoint = new URL(config.baseUrl ?? "https://api.openai.com/v1");
    if (endpoint.username || endpoint.password) throw new Error("OpenAI base URL must not contain credentials");
    if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost" && endpoint.hostname !== "::1") {
      if (!config.allowInsecureInternal) throw new Error("Remote OpenAI base URL must use HTTPS");
    }
    this.#apiKey = config.apiKey;
    this.#baseUrl = endpoint.toString().replace(/\/$/, "");
    this.model = config.model ?? "gpt-5";
    this.#organization = config.organization;
    this.#project = config.project;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#maxProviderStateChars = config.maxProviderStateChars ?? DEFAULT_MAX_STATE_CHARS;
    this.#modelContext = config.modelContext;
    if (!Number.isInteger(this.#maxProviderStateChars) || this.#maxProviderStateChars <= 0) throw new Error("maxProviderStateChars must be positive");
    if (this.#modelContext && (!Number.isInteger(this.#modelContext.contextWindowTokens) ||
        this.#modelContext.contextWindowTokens <= 0 || !this.#modelContext.revision.trim())) {
      throw new Error("OpenAI modelContext requires a positive contextWindowTokens and revision");
    }
  }

  async resolveModel(): Promise<ResolvedLlmModel> {
    const catalog = this.model === "gpt-5"
      ? { contextWindowTokens: 400_000, maxOutputTokens: 128_000, tokenizerId: "o200k_base", revision: "openai-gpt5-catalog-2026-08" }
      : undefined;
    const context = this.#modelContext ?? catalog;
    return {
      providerId: this.providerId, adapterId: this.id, modelId: this.model,
      routeRevision: context?.revision ?? `openai-unlisted:${this.model}`,
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
      response = await this.#fetch(`${this.#baseUrl}/responses`, {
        method: "POST", signal,
        headers: {
          authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json",
          ...(this.#organization ? { "openai-organization": this.#organization } : {}),
          ...(this.#project ? { "openai-project": this.#project } : {}),
        },
        body: JSON.stringify({
          model: request.model, input: inputItems(request.messages),
          tools: request.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })),
          // A reasoning model returns its reasoning items as bare ids, and this adapter replays
          // those items on the next turn. With the default `store: false` the API never kept them,
          // so a replayed id comes back as "Item with id 'rs_...' not found" and the turn dies in
          // the middle of a tool loop. The encrypted content is what makes a stateless replay
          // legal. It sits before the caller's parameters so an explicit `include` still wins.
          include: ["reasoning.encrypted_content"],
          ...request.parameters,
          ...(request.toolChoice === undefined ? {} : {
            tool_choice: typeof request.toolChoice === "string"
              ? request.toolChoice
              : { type: "function", name: request.toolChoice.name },
          }),
          stream: true,
        }),
      });
    } catch (error) {
      if (signal.aborted) throw new AgenticError("cancelled", "OpenAI request was cancelled", false, { cause: error });
      throw new AgenticError("transient", "OpenAI transport failed", true, { cause: error });
    }
    if (!response.ok) {
      let detail = response.statusText;
      let code: string | undefined;
      try {
        const envelope = (await response.json()) as { error?: { message?: string; code?: string } };
        detail = envelope.error?.message ?? detail;
        if (typeof envelope.error?.code === "string") code = envelope.error.code;
      } catch { /* a proxy or a load balancer can answer a failure with a non-JSON body */ }
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
      const overflow = isContextOverflow(response.status, detail, code);
      throw new AgenticError(overflow ? "context-overflow" : retryable ? "transient" : "permanent", `OpenAI request failed (${response.status}): ${detail}`, retryable);
    }
    for await (const event of parseOpenAIStream(response)) {
      if (event.type === "text-delta") { yield event; continue; }
      const serialized = JSON.stringify(event.outputItems);
      if (serialized.length > this.#maxProviderStateChars) throw new AgenticError("permanent", `OpenAI provider state exceeds ${this.#maxProviderStateChars} characters`);
      yield {
        type: "final", content: event.content, toolCalls: event.toolCalls, finishReason: event.finishReason,
        status: event.status, ...(event.providerRequestId ? { providerRequestId: event.providerRequestId } : {}),
        ...(event.usage ? { usage: event.usage } : {}),
        providerState: {
          providerId: "openai", adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION,
          stateVersion: STATE_VERSION, classification: "confidential",
          payload: { outputItems: JSON.parse(serialized) as JsonValue },
        },
      };
    }
  }
}

export function createOpenAIPlugin(config: OpenAIConfig): PluginDescriptor {
  const id = "io.syncroot.adapter.openai";
  const adapter = new OpenAIAdapter(config);
  const manifest: PluginManifest = {
    manifestVersion: 1, id, version: ADAPTER_VERSION, publisher: "Agentic Platform", coreApi: "^1.0.0",
    artifact: { digest: `builtin:${id}@${ADAPTER_VERSION}`, signature: "trusted-assembly" }, requires: {},
    provides: { [CAPABILITIES.llm]: { version: "1.0.0", cardinality: "single" } },
    permissions: { network: [new URL(config.baseUrl ?? "https://api.openai.com/v1").origin], secrets: ["OPENAI_API_KEY"] },
  };
  const plugin: AgentPlugin = {
    validate: async () => ({ valid: true }),
    activate: async (context) => { context.registrations.provide(LLM_CAPABILITY, adapter); return { dispose: () => undefined }; },
    health: async () => ({ healthy: true }),
  };
  return { manifest, plugin, trustTier: "platform-core", config: { model: adapter.model, baseUrl: config.baseUrl ?? "https://api.openai.com/v1" } };
}
