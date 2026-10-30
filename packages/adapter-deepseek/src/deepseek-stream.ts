import { AgenticError, MODEL_LIMIT_REASON, type ToolCall } from "@0xsyncroot/contracts";

export interface DeepSeekUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
}

interface DeepSeekStreamChunk {
  readonly id?: string;
  readonly choices?: readonly {
    readonly finish_reason?: string | null;
    readonly delta?: {
      readonly content?: string | null;
      readonly reasoning_content?: string | null;
      readonly tool_calls?: readonly {
        readonly index: number;
        readonly id?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }[];
    };
  }[];
  readonly usage?: DeepSeekUsage | null;
  readonly error?: { readonly message?: string };
}

export interface DeepSeekStreamComplete {
      readonly type: "complete";
      readonly content: string | null;
      readonly reasoningContent: string;
      readonly toolCalls: readonly ToolCall[];
      readonly finishReason: string;
      readonly providerRequestId?: string;
      readonly usage?: DeepSeekUsage;
}

export type ParsedDeepSeekStreamEvent =
  | { readonly type: "text-delta"; readonly delta: string }
  | DeepSeekStreamComplete;

async function* sseData(response: Response): AsyncIterable<string> {
  if (!response.body) throw new AgenticError("transient", "DeepSeek returned an empty stream", true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }).replaceAll("\r\n", "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
      }
      if (done) { ended = true; break; }
    }
    const data = buffer.trim().startsWith("data:") ? buffer.trim().slice(5).trimStart() : "";
    if (data) yield data;
  } finally {
    // A limit or a caller closing the iterator must stop the upstream generation too.
    if (!ended) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function* parseDeepSeekStream(
  response: Response,
  maxReasoningContentChars: number,
): AsyncIterable<ParsedDeepSeekStreamEvent> {
  let content = "";
  let reasoningContent = "";
  let finishReason = "unknown";
  let providerRequestId: string | undefined;
  let usage: DeepSeekUsage | undefined;
  const streamedTools = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const data of sseData(response)) {
    if (data === "[DONE]") break;
    let chunk: DeepSeekStreamChunk;
    try { chunk = JSON.parse(data) as DeepSeekStreamChunk; }
    catch { throw new AgenticError("permanent", "DeepSeek returned an invalid SSE chunk"); }
    if (chunk.error) throw new AgenticError("permanent", chunk.error.message ?? "DeepSeek stream failed");
    if (chunk.id) providerRequestId = chunk.id;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;
    if (typeof delta?.reasoning_content === "string") {
      reasoningContent += delta.reasoning_content;
      if (reasoningContent.length > maxReasoningContentChars) {
        throw new AgenticError("budget-exceeded", `DeepSeek reasoning state exceeds ${maxReasoningContentChars} characters`, false,
          { reason: MODEL_LIMIT_REASON.REASONING });
      }
    }
    if (typeof delta?.content === "string" && delta.content) {
      content += delta.content;
      yield { type: "text-delta", delta: delta.content };
    }
    for (const toolDelta of delta?.tool_calls ?? []) {
      const current = streamedTools.get(toolDelta.index) ?? { id: "", name: "", arguments: "" };
      if (toolDelta.id) current.id += toolDelta.id;
      if (toolDelta.function?.name) current.name += toolDelta.function.name;
      if (toolDelta.function?.arguments) current.arguments += toolDelta.function.arguments;
      streamedTools.set(toolDelta.index, current);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const toolCalls = [...streamedTools.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => ({ id: call.id, name: call.name, arguments: call.arguments }));
  if (toolCalls.some((call) => !call.id || !call.name)) {
    throw new AgenticError("permanent", "DeepSeek returned an incomplete streamed tool call");
  }
  yield {
    type: "complete",
    content: content || null,
    reasoningContent,
    toolCalls,
    finishReason,
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(usage ? { usage } : {}),
  };
}
