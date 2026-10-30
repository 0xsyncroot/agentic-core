import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AgenticError,
  type IdentityResolver,
  type ResumableAgent,
  type SecurityContext,
  type SessionReader,
} from "@0xsyncroot/contracts";
import { resumeApproval } from "./approval-api.js";
import { cancelInput, interjectInput, SESSION_PATTERN } from "./chat-input.js";
import { acceptChatTurn, type AttachmentStore } from "./inline-attachments.js";
import { runtimeAnswer } from "./runtime-answer.js";
import {
  applyCorsHeaders, createOriginPolicyResolver, rejectsApiOrigin, respondToPreflight,
  type ResponsePolicy, type WebApplicationOptions as CorsOptions,
} from "./cors-policy.js";
import { publicApiError, publicStatus, type BusinessMessages } from "./error-mapping.js";
import { sessionHistoryEvents } from "./session-history.js";
import { sessionDirectory } from "./session-directory.js";
import { visibleMessages } from "./history-view.js";
import { readInteractionInput, resolveInteraction } from "./interaction-api.js";
import { servePublicAgentStream } from "./public-agent-stream-handler.js";
import { applicationContext, resolveIdentity as resolveRequestScopedIdentity, withRequestScope as withScope, type RequestScopeOptions } from "./request-context.js";
import { resultPayload } from "./result-payload.js";
import type { ToolTraceLabeller } from "./public-agent-stream.js";
import type { PublicReasoningMode, ReasoningSummarizer } from "./public-reasoning-stream.js";
import { InMemoryResumableAgentStreamRegistry } from "./in-memory-stream-registry.js";
import {
  resumableAgentOperationFingerprint,
  resumableAgentStreamFingerprint,
  resumableAgentStreamKey,
  type ResumableAgentStreamRegistry,
  type ResumableAgentStreamKey,
} from "./resumable-agent-stream.js";

export interface AgentApiRuntime {
  readonly agent: ResumableAgent;
  readonly identityResolver: IdentityResolver;
  readonly sessions: Pick<SessionReader, "loadRecent"> & Partial<Pick<SessionReader, "loadSince" | "listSessions">>;
}

export interface AgentApiOptions extends CorsOptions, RequestScopeOptions {
  /** Replace the single-process replay journal with a shared production implementation. */
  readonly streamRegistry?: ResumableAgentStreamRegistry;
  /**
   * How much one turn may publish to the built-in single-process journal before it is cut off
   * (default 4,096 events / 1 MiB). A product whose turns run long — dozens of steps, each with its
   * own narration and tool lines — sizes this for them: a turn that outgrows its journal is ended
   * as over budget, mid-work. Ignored when `streamRegistry` is supplied; that registry has its own.
   */
  readonly streamLimits?: { readonly maxEvents?: number; readonly maxBytes?: number };
  readonly deploymentProfile?: "development" | "production";
  /** A product's own sentences for classified failures. Omitted: generic English fallbacks. */
  readonly businessMessages?: BusinessMessages;
  /**
   * Whether the runtime's own technical message reaches the response as `detail`. Off by
   * default — a business deployment shows it nowhere a user reads; a dev/demo consumer may turn
   * it on for its own debugging.
   */
  readonly includeErrorDetail?: boolean;
  /**
   * Names each tool in the product's own words for the browser trace. Omit it and tool activity is
   * withheld entirely: a tool id is not the product's to publish, and a trace line naming no work
   * is noise. See `PublicAgentStreamWriter.progress`.
   */
  readonly toolTrace?: ToolTraceLabeller;
  /**
   * How much of the model's private reasoning the stream publishes. Default `lifecycle`: that it is
   * thinking, never what. `text` publishes the reasoning itself — see `PublicReasoningMode`.
   */
  readonly reasoning?: PublicReasoningMode;
  /** In `text` mode: the product's test for which sentences of the reasoning may cross. */
  readonly reasoningSentence?: (sentence: string) => boolean;
  /** In `text` mode: rewrites the reasoning for the user; with it the raw reasoning never crosses. */
  readonly reasoningSummary?: ReasoningSummarizer;
  /** Server-side observer for the original exception that ends a stream. */
  readonly onStreamError?: (error: unknown, key: ResumableAgentStreamKey) => void;
  /**
   * Where a file sent with a turn is kept, and the handle a tool opens it by. With one, a client
   * sends the file in the same request as the message and this service stores it before the turn
   * runs: the browser is never told where files go or what they are called once stored. Without
   * one, a file's bytes are dropped and the turn carries its name and size only.
   */
  readonly attachmentStore?: AttachmentStore;
  /**
   * The product's words for the lines a chat client writes itself, by the client's own label name
   * (`thinking`, `awaitingUser`, `transportError`, …). Answered by `GET /api/runtime`, so a page
   * that embeds the client need not be told them. See runtime-answer.ts.
   */
  readonly clientLabels?: Readonly<Record<string, string>>;
  /** Events per storage read when reconstructing complete session history. Default 500. */
  readonly historyEventLimit?: number;
  /** A product delivery pins its directory to its own routed profile. */
  readonly sessionAgentProfileId?: string;
  /** A product's own sentence for an attachments-only turn. Omitted: the package's English default. */
  readonly attachmentOnlyContent?: string;
}

/** Security + CORS headers every response from this handler carries, success or failure. */
export function applyResponseHeaders(response: ServerResponse, policy?: ResponsePolicy): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  applyCorsHeaders(response, policy);
}

function json(response: ServerResponse, status: number, payload: unknown, policy?: ResponsePolicy): void {
  applyResponseHeaders(response, policy);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

/**
 * The neutral HTTP/SSE delivery for the durable agent loop: routes, streaming, resumable stream
 * registry, history projection, identity resolution and error mapping — everything a product
 * backend needs on top of `@0xsyncroot/harness`'s `createBlankRuntime`, shared between `apps/web` (the
 * dev/demo delivery app) and a real product backend such as EXAMPLE's. It owns exactly the `/api/*`
 * surface: `handle` returns `false`, untouched, for any other path so a consumer can still serve
 * its own static assets or answer its own 404 for them.
 */
export function createAgentApiHandler(runtime: AgentApiRuntime, options: AgentApiOptions = {}) {
  if (options.deploymentProfile === "production" && options.streamRegistry?.productionSafe !== true) {
    throw new Error("Production agent-api delivery requires a production-safe shared ResumableAgentStreamRegistry");
  }
  const resolveOriginPolicy = createOriginPolicyResolver(options);
  const ownsRegistry = options.streamRegistry === undefined;
  const streamRegistry = options.streamRegistry ?? new InMemoryResumableAgentStreamRegistry(options.streamLimits ?? {});
  const historyEventLimit = options.historyEventLimit ?? 500;

  const errorOptions = {
    ...(options.businessMessages ? { businessMessages: options.businessMessages } : {}),
    includeErrorDetail: options.includeErrorDetail ?? false,
    ...(options.toolTrace ? { toolTrace: options.toolTrace } : {}),
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(options.reasoningSentence ? { reasoningSentence: options.reasoningSentence } : {}),
    ...(options.reasoningSummary ? { reasoningSummary: options.reasoningSummary } : {}),
    ...(options.onStreamError ? { onStreamError: options.onStreamError } : {}),
  };
  const chatInputOptions = {
    ...(options.attachmentOnlyContent ? { attachmentOnlyContent: options.attachmentOnlyContent } : {}),
  };

  function resolveIdentity(request: IncomingMessage, purpose: string): Promise<SecurityContext> {
    return resolveRequestScopedIdentity(runtime.identityResolver, options, request, purpose);
  }

  function withRequestScope<T>(request: IncomingMessage, security: SecurityContext, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withScope(options, request, security, task, signal);
  }

  async function sessionHistory(request: IncomingMessage, sessionId: string, response: ServerResponse, policy: ResponsePolicy): Promise<void> {
    if (!SESSION_PATTERN.test(sessionId)) throw new AgenticError("validation", "sessionId is invalid");
    const events = await sessionHistoryEvents(runtime.sessions, sessionId, await resolveIdentity(request, "agent-api-session-history"), historyEventLimit);
    json(response, 200, { sessionId, messages: visibleMessages(events, options) }, policy);
  }

  async function chat(request: IncomingMessage, response: ServerResponse, policy: ResponsePolicy): Promise<void> {
    const { input, security: requestSecurity } = await acceptChatTurn(request, chatInputOptions, options.attachmentStore, () => resolveIdentity(request, "agent-api-chat"));
    const startedAt = performance.now();
    const result = await withRequestScope(request, requestSecurity, () => runtime.agent.runTurn({
      sessionId: input.sessionId, content: input.content, idempotencyKey: input.requestId, security: requestSecurity,
      ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}),
      ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
      ...applicationContext(requestSecurity, input.agentContext),
    }));
    json(response, 200, resultPayload(result, startedAt, options.businessMessages), policy);
  }

  async function chatStream(request: IncomingMessage, response: ServerResponse, policy: ResponsePolicy): Promise<void> {
    const { input, security: requestSecurity } = await acceptChatTurn(request, chatInputOptions, options.attachmentStore, () => resolveIdentity(request, "agent-api-chat-stream"));
    await servePublicAgentStream(request, response, streamRegistry, () => applyResponseHeaders(response, policy), {
      key: resumableAgentStreamKey(requestSecurity, input),
      fingerprint: resumableAgentStreamFingerprint(requestSecurity, input),
      run: (stream, signal, interjections) => withRequestScope(request, requestSecurity, () => runtime.agent.runTurn({
        sessionId: input.sessionId, content: input.content, idempotencyKey: input.requestId, security: requestSecurity, signal, interjections,
        ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}),
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
        ...applicationContext(requestSecurity, input.agentContext),
        onProgress: (progress) => stream.progress(progress), onOutput: (output) => stream.output(output),
        onNarration: (narration) => stream.narration(narration), onReasoning: (reasoning) => stream.reasoning(reasoning),
      }), signal),
    }, errorOptions);
  }

  async function interactionStream(request: IncomingMessage, response: ServerResponse, policy: ResponsePolicy, interactionId: string): Promise<void> {
    const input = await readInteractionInput(request);
    const security = await resolveIdentity(request, "agent-api-interaction-stream");
    await servePublicAgentStream(request, response, streamRegistry, () => applyResponseHeaders(response, policy), {
      key: resumableAgentStreamKey(security, input),
      fingerprint: resumableAgentOperationFingerprint(security, input, "interaction", {
        kind: input.kind, interactionId,
        ...(input.kind === "approval" ? { decision: input.decision } : { action: input.action, content: input.content ?? null }),
        agentProfileId: input.agentProfileId ?? null,
      }),
      run: (stream, signal, interjections) => withRequestScope(request, security, () => resolveInteraction(runtime.agent, security, interactionId, input, {
        signal, interjections, onProgress: (progress) => stream.progress(progress), onOutput: (output) => stream.output(output),
        onNarration: (narration) => stream.narration(narration), onReasoning: (reasoning) => stream.reasoning(reasoning),
      }), signal),
    }, errorOptions);
  }

  /**
   * Hands a running turn something the user just typed, without ending it.
   *
   * 202 when the turn took it, 200 with `accepted: false` when there was nothing running to take
   * it or the turn is already holding all it will read at once. The difference matters to whoever
   * typed the sentence, so it is answered rather than absorbed — the same shape `/api/chat/cancel`
   * uses for the same reason.
   */
  async function interjectChatStream(request: IncomingMessage, response: ServerResponse, policy: ResponsePolicy): Promise<void> {
    const input = await interjectInput(request);
    const security = await resolveIdentity(request, "agent-api-chat-interject");
    const accepted = await streamRegistry.interject(resumableAgentStreamKey(security, input), input.content);
    json(response, accepted ? 202 : 200, { accepted }, policy);
  }

  async function cancelChatStream(request: IncomingMessage, response: ServerResponse, policy: ResponsePolicy): Promise<void> {
    const input = await cancelInput(request);
    const security = await resolveIdentity(request, "agent-api-chat-cancel");
    const cancelled = await streamRegistry.cancel(resumableAgentStreamKey(security, input));
    json(response, cancelled ? 202 : 200, { cancelled }, policy);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const policy = resolveOriginPolicy(request);
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://localhost"); }
    catch { json(response, 400, { error: publicApiError(options.businessMessages, new AgenticError("validation", "Request URL is invalid"), errorOptions.includeErrorDetail) }, policy); return true; }
    if (!url.pathname.startsWith("/api/")) return false;
    try {
      if (rejectsApiOrigin(request, url.pathname, policy)) { json(response, 403, { error: { code: "denied", message: "Browser origin is not allowed" } }); return true; }
      if (request.method === "OPTIONS") { respondToPreflight(request, response, policy); return true; }
      if (request.method === "GET" && url.pathname === "/api/health") { json(response, 200, { status: "ok" }, policy); return true; }
      if (request.method === "GET" && url.pathname === "/api/runtime") {
        await resolveIdentity(request, "agent-api-runtime-metadata");
        // A connectivity probe only; tenant/profile-specific capabilities are discovered inside the authenticated turn boundary.
        json(response, 200, runtimeAnswer(options), policy);
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/sessions") {
        json(response, 200, await sessionDirectory(runtime.sessions, url.searchParams, await resolveIdentity(request, "agent-api-session-directory"), options.sessionAgentProfileId), policy);
        return true;
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
        await sessionHistory(request, decodeURIComponent(url.pathname.slice("/api/sessions/".length)), response, policy);
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/chat") { await chat(request, response, policy); return true; }
      if (request.method === "POST" && url.pathname === "/api/chat/stream") { await chatStream(request, response, policy); return true; }
      if (request.method === "POST" && url.pathname === "/api/chat/cancel") { await cancelChatStream(request, response, policy); return true; }
      if (request.method === "POST" && url.pathname === "/api/chat/interject") { await interjectChatStream(request, response, policy); return true; }
      const interactionMatch = /^\/api\/interactions\/([^/]+)\/stream$/.exec(url.pathname);
      if (request.method === "POST" && interactionMatch) { await interactionStream(request, response, policy, decodeURIComponent(interactionMatch[1]!)); return true; }
      if (request.method === "POST" && url.pathname.startsWith("/api/approvals/")) {
        const resumed = await resumeApproval(request, runtime.agent, runtime.identityResolver, decodeURIComponent(url.pathname.slice("/api/approvals/".length)), options.identityAttributes?.(request), options.runWithRequestScope);
        json(response, 200, resultPayload(resumed.result, resumed.startedAt, options.businessMessages), policy);
        return true;
      }
      json(response, 404, { error: { code: "not-found", message: "Route not found" } }, policy);
      return true;
    } catch (error) {
      json(response, publicStatus(error), { error: publicApiError(options.businessMessages, error, errorOptions.includeErrorDetail) }, policy);
      return true;
    }
  }

  return {
    handle,
    close: (): Promise<void> => ownsRegistry ? streamRegistry.close() : Promise.resolve(),
  };
}

export type AgentApiHandler = ReturnType<typeof createAgentApiHandler>;
