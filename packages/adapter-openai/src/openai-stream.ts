import { AgenticError, type JsonValue, type LlmUsage, type ToolCall } from "@0xsyncroot/contracts";

interface ResponseEnvelope {
  readonly id?: string;
  readonly status?: string;
  readonly output?: readonly OpenAIOutputItem[];
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number; readonly total_tokens?: number };
  readonly incomplete_details?: { readonly reason?: string } | null;
  /** Only a failed response carries this; `status` alone says "failed" and nothing about why. */
  readonly error?: { readonly code?: string; readonly message?: string } | null;
}

export interface OpenAIOutputItem extends Record<string, JsonValue | undefined> {
  readonly type: string;
  readonly id?: string;
  readonly call_id?: string;
  readonly name?: string;
  readonly arguments?: string;
}

interface OpenAIStreamChunk {
  readonly type?: string;
  readonly delta?: string;
  readonly item?: OpenAIOutputItem;
  readonly response?: ResponseEnvelope;
  /** The `error` event puts these at the top level of the event, not inside an `error` object. */
  readonly code?: string | null;
  readonly message?: string;
}

export interface OpenAIStreamComplete {
  readonly type: "complete";
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: string;
  /** No "failed": a failed response has no usable output, so it is raised rather than yielded. */
  readonly status: "completed" | "tool_calls" | "incomplete" | "blocked" | "unknown";
  readonly outputItems: readonly OpenAIOutputItem[];
  readonly providerRequestId?: string;
  readonly usage?: LlmUsage;
}

async function* sseData(response: Response): AsyncIterable<string> {
  if (!response.body) throw new AgenticError("transient", "OpenAI returned an empty stream", true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split("\n").filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      if (data) yield data;
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
}

function responseText(output: readonly OpenAIOutputItem[]): string {
  const chunks: string[] = [];
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (typeof part === "object" && part !== null && (part as { type?: string }).type === "output_text") {
        const value = (part as { text?: unknown }).text;
        if (typeof value === "string") chunks.push(value);
      }
    }
  }
  return chunks.join("");
}

export async function* parseOpenAIStream(response: Response): AsyncIterable<{ readonly type: "text-delta"; readonly delta: string } | OpenAIStreamComplete> {
  let streamedText = "";
  let terminal: ResponseEnvelope | undefined;
  const completedItems: OpenAIOutputItem[] = [];
  for await (const data of sseData(response)) {
    if (data === "[DONE]") break;
    let event: OpenAIStreamChunk;
    try { event = JSON.parse(data) as OpenAIStreamChunk; }
    catch { throw new AgenticError("permanent", "OpenAI returned an invalid SSE event"); }
    // The `error` event carries `message` and `code` at the top level of the event. Reading them
    // from a nested `error` object turned every mid-stream failure into the same blank
    // "OpenAI stream failed", which costs the operator the one line naming the key or quota.
    if (event.type === "error") {
      throw new AgenticError("permanent", `OpenAI stream failed${event.code ? ` (${event.code})` : ""}: ${event.message ?? "no message reported"}`);
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      streamedText += event.delta;
      yield { type: "text-delta", delta: event.delta };
    }
    if (event.type === "response.output_item.done" && event.item) completedItems.push(event.item);
    if (event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed") terminal = event.response;
  }
  if (!terminal) throw new AgenticError("permanent", "OpenAI stream ended without a terminal response");
  if (terminal.status === "failed") {
    // A failed response has no output to hand back, so the reason has to travel as the error.
    // `server_error` and `rate_limit_exceeded` are the provider's own transient codes: raising
    // them as permanent would end a turn on something the next attempt would have gotten through.
    const failure = terminal.error;
    const retryable = failure?.code === "server_error" || failure?.code === "rate_limit_exceeded";
    throw new AgenticError(retryable ? "transient" : "permanent",
      `OpenAI response failed${failure?.code ? ` (${failure.code})` : ""}: ${failure?.message ?? "no reason reported"}`, retryable);
  }
  const output = terminal.output?.length ? terminal.output : completedItems;
  // Only `call_id` is echoed back as the `function_call_output.call_id` of the next turn. The
  // item's own `id` is a different identifier, so accepting it here would send the model a
  // correlation key it never issued and the continuation would 400.
  const toolCalls = output.filter((item) => item.type === "function_call").map((item) => ({
    id: item.call_id ?? "", name: item.name ?? "", arguments: item.arguments ?? "{}",
  }));
  if (toolCalls.some((call) => !call.id || !call.name)) throw new AgenticError("permanent", "OpenAI returned an incomplete function call");
  const content = streamedText || responseText(output) || null;
  const rawStatus = terminal.status ?? "unknown";
  // A content filter is the one incomplete reason that is a refusal rather than a budget, and
  // the core finish policy routes those two differently.
  const incompleteReason = terminal.incomplete_details?.reason;
  const status = toolCalls.length > 0 ? "tool_calls" as const
    : rawStatus === "completed" ? "completed" as const
      : rawStatus !== "incomplete" ? "unknown" as const
        : incompleteReason === "content_filter" ? "blocked" as const : "incomplete" as const;
  const usage = terminal.usage ? {
    ...(terminal.usage.input_tokens !== undefined ? { inputTokens: terminal.usage.input_tokens } : {}),
    ...(terminal.usage.output_tokens !== undefined ? { outputTokens: terminal.usage.output_tokens } : {}),
    ...(terminal.usage.total_tokens !== undefined ? { totalTokens: terminal.usage.total_tokens } : {}),
  } : undefined;
  yield {
    type: "complete", content, toolCalls, status, outputItems: output,
    finishReason: incompleteReason ?? rawStatus,
    ...(terminal.id ? { providerRequestId: terminal.id } : {}),
    ...(usage ? { usage } : {}),
  };
}
