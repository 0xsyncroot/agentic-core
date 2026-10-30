import type { IncomingMessage, ServerResponse } from "node:http";
import { AgenticError, type RunTurnResult, type TurnInterjections } from "@0xsyncroot/contracts";
import { publicApiError, type BusinessMessages } from "./error-mapping.js";
import { PublicAgentStreamWriter, type ToolTraceLabeller } from "./public-agent-stream.js";
import type { PublicReasoningMode, ReasoningSummarizer } from "./public-reasoning-stream.js";
import {
  pipeResumableAgentStream,
  requestedLastEventId,
  type ResumableAgentStreamKey,
  type ResumableAgentStreamRegistry,
} from "./resumable-agent-stream.js";
import { resultPayload } from "./result-payload.js";

export interface PublicAgentStreamOperationInput {
  readonly key: ResumableAgentStreamKey;
  readonly fingerprint: string;
  /** `interjections` is what the user has said since this turn began; hand it to the turn. */
  readonly run: (
    stream: PublicAgentStreamWriter,
    signal: AbortSignal,
    interjections: TurnInterjections,
  ) => Promise<RunTurnResult>;
}

export interface PublicAgentStreamErrorOptions {
  readonly businessMessages?: BusinessMessages;
  readonly includeErrorDetail?: boolean;
  /** Operator diagnostics only; observer failures never replace the original stream error. */
  readonly onStreamError?: (error: unknown, key: ResumableAgentStreamKey) => void;
  /**
   * Names each tool in the product's own words for the browser trace. Without one the stream
   * withholds tool activity entirely — the tool's id is not the product's to show, and a line that
   * names no work is noise. See PublicAgentStreamWriter.progress.
   */
  readonly toolTrace?: ToolTraceLabeller;
  /** How much of the model's reasoning crosses. Default `lifecycle`. See PublicReasoningMode. */
  readonly reasoning?: PublicReasoningMode;
  /** In `text` mode: the product's test for which sentences of the reasoning may cross. */
  readonly reasoningSentence?: (sentence: string) => boolean;
  /** In `text` mode: rewrites the reasoning for the user; with it the raw reasoning never crosses. */
  readonly reasoningSummary?: ReasoningSummarizer;
}

/** Shared HTTP delivery handler for both new turns and human-interaction continuation. */
export async function servePublicAgentStream(
  request: IncomingMessage,
  response: ServerResponse,
  registry: ResumableAgentStreamRegistry,
  prepareResponse: () => void,
  input: PublicAgentStreamOperationInput,
  errorOptions: PublicAgentStreamErrorOptions = {},
): Promise<void> {
  const requestedEventId = requestedLastEventId(request);
  const { operation, created } = await registry.acquire({
    key: input.key,
    fingerprint: input.fingerprint,
    run: async (publish, signal, interjections) => {
      const startedAt = performance.now();
      const stream = new PublicAgentStreamWriter(publish, {
        ...(errorOptions.toolTrace ? { toolTrace: errorOptions.toolTrace } : {}),
        ...(errorOptions.reasoning ? { reasoning: errorOptions.reasoning } : {}),
        ...(errorOptions.reasoningSentence ? { reasoningSentence: errorOptions.reasoningSentence } : {}),
        ...(errorOptions.reasoningSummary ? { reasoningSummary: errorOptions.reasoningSummary } : {}),
      });
      try {
        const result = await input.run(stream, signal, interjections);
        stream.discardOutputs();
        stream.discardNarrations();
        stream.discardReasonings();
        const unread = await interjections.close();
        stream.event("result", { ...resultPayload(result, startedAt, errorOptions.businessMessages),
          ...(unread.length > 0 ? { unreadInterjections: unread } : {}) });
      } catch (error) {
        try { errorOptions.onStreamError?.(error, input.key); } catch { /* Diagnostics must not break delivery. */ }
        stream.discardOutputs();
        stream.discardNarrations();
        stream.discardReasonings();
        const unread = await interjections.close();
        stream.event("error", { ...publicApiError(errorOptions.businessMessages, error, errorOptions.includeErrorDetail ?? false),
          ...(unread.length > 0 ? { unreadInterjections: unread } : {}) });
      }
    },
  });
  if (!created && requestedEventId > operation.lastEventId) {
    throw new AgenticError("validation", "Last-Event-ID is ahead of the retained stream journal");
  }
  const replayFrom = created && requestedEventId > 0 ? 0 : requestedEventId;
  prepareResponse();
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  response.setHeader("x-gateway-stream", created ? requestedEventId > 0 ? "reset" : "new" : "resumed");
  response.flushHeaders();
  try { await pipeResumableAgentStream(operation, response, replayFrom); }
  catch {
    // End an incomplete delivery so the client can reconnect with its last processed event ID.
    if (!response.writableEnded && !response.destroyed) response.end();
  }
}
