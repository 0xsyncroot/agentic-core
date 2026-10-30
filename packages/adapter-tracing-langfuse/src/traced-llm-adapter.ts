import { randomUUID } from "node:crypto";
import type { LlmAdapter, LlmStreamEvent, PreparedLlmRequest } from "@0xsyncroot/contracts";
import type { LangfuseCapture, LangfuseConfig } from "./langfuse-config.js";
import type { LangfuseIngestion } from "./langfuse-client.js";

export interface TracedLlmAdapterOptions {
  readonly ingestion: LangfuseIngestion;
  readonly config: LangfuseConfig;
  readonly now?: () => Date;
}

/** What a trace says about a message when the content itself is not allowed to leave. */
function shape(request: PreparedLlmRequest, capture: LangfuseCapture): Readonly<Record<string, unknown>> {
  const roles: Record<string, number> = {};
  let characters = 0;
  for (const message of request.messages) {
    roles[message.role] = (roles[message.role] ?? 0) + 1;
    characters += typeof message.content === "string" ? message.content.length : 0;
  }
  return {
    messages: request.messages.length,
    roles,
    characters,
    tools: request.tools.map((tool) => tool.name).slice(0, 64),
    toolChoice: request.toolChoice ?? "auto",
    // The runtime already hashes exactly what it sent. Two turns with the same hash saw the
    // same input, which is the question a trace is usually being opened to answer.
    contentHash: request.contentHash,
    capture,
  };
}

/**
 * Wraps a model adapter so every call appears in Langfuse as a generation under its turn.
 *
 * A decorator rather than a change to the adapters: each provider stays unaware of tracing,
 * and a deployment that does not configure Langfuse runs the undecorated adapter with no
 * branch left behind in the hot path. The trace is keyed by `turnId`, so the steps of one turn
 * — including retries of the same step — group the way an engineer reads them.
 *
 * Nothing here can fail a model call. Every emission is enqueued into a bounded buffer, and a
 * tracer that cannot reach Langfuse loses traces rather than turns.
 */
export function traceLlmAdapter(adapter: LlmAdapter, options: TracedLlmAdapterOptions): LlmAdapter {
  const seenTurns = new Set<string>();
  const clock = options.now ?? (() => new Date());
  const full = options.config.capture === "full";

  return Object.freeze({
    ...adapter,
    ...(adapter.resolveModel ? { resolveModel: adapter.resolveModel.bind(adapter) } : {}),
    ...(adapter.measureContext ? { measureContext: adapter.measureContext.bind(adapter) } : {}),
    stream(request: PreparedLlmRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent> {
      const observationId = randomUUID();
      const startedAt = clock();
      if (!seenTurns.has(request.turnId)) {
        seenTurns.add(request.turnId);
        // Bounded: a long-lived process would otherwise remember every turn it ever traced.
        if (seenTurns.size > 4_096) seenTurns.clear();
        options.ingestion.enqueue({ type: "trace-create", body: {
          id: request.turnId, name: "agent-turn", environment: options.config.environment,
          ...(options.config.release ? { release: options.config.release } : {}),
          ...(options.config.tags.length > 0 ? { tags: [...options.config.tags] } : {}),
          metadata: { runtimeSnapshotId: request.runtimeSnapshotId, requestId: request.requestId },
        } });
      }
      options.ingestion.enqueue({ type: "generation-create", body: {
        id: observationId, traceId: request.turnId, name: `step:${request.stepId}`,
        startTime: startedAt.toISOString(), model: request.model,
        modelParameters: request.parameters,
        input: full ? request.messages : shape(request, options.config.capture),
        metadata: { attemptId: request.attemptId, stepId: request.stepId, ...(full ? shape(request, "full") : {}) },
      } });

      return (async function* stream(): AsyncIterable<LlmStreamEvent> {
        let output = "";
        let reasoningCharacters = 0;
        let closed = false;
        const finish = (body: Readonly<Record<string, unknown>>): void => {
          if (closed) return;
          closed = true;
          options.ingestion.enqueue({ type: "generation-update", body: {
            id: observationId, traceId: request.turnId, endTime: clock().toISOString(), ...body,
          } });
        };
        try {
          for await (const event of adapter.stream(request, signal)) {
            if (event.type === "text-delta") output += event.delta;
            else if (event.type === "reasoning-delta") reasoningCharacters += event.delta.length;
            else if (event.type === "final") {
              finish({
                output: full
                  ? { content: event.content, toolCalls: event.toolCalls }
                  : { characters: (event.content ?? output).length, toolCalls: event.toolCalls.map((call) => call.name),
                      reasoningCharacters },
                ...(event.usage ? { usage: {
                  input: event.usage.inputTokens ?? null,
                  output: event.usage.outputTokens ?? null,
                  total: event.usage.totalTokens ?? null,
                } } : {}),
                level: event.status === "failed" || event.status === "blocked" ? "ERROR" : "DEFAULT",
                metadata: { finishReason: event.finishReason, status: event.status ?? "unknown",
                  ...(event.providerRequestId ? { providerRequestId: event.providerRequestId } : {}) },
              });
            }
            yield event;
          }
          // A stream that ends without a final event is a real condition worth seeing in a
          // trace, not something to paper over with a synthetic success.
          finish({ level: "WARNING", statusMessage: "stream ended without a final event" });
        } catch (error) {
          finish({
            level: "ERROR",
            statusMessage: error instanceof Error ? error.message.slice(0, 512) : "model call failed",
          });
          throw error;
        }
      })();
    },
  });
}
