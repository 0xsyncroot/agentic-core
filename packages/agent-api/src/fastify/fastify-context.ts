import type { FastifyReply, FastifyRequest } from "fastify";
import type { SecurityContext } from "@0xsyncroot/contracts";
import { applyResponseHeaders, type AgentApiOptions, type AgentApiRuntime } from "../agent-api-handler.js";
import type { ResponsePolicy } from "../cors-policy.js";
import { publicApiError, publicStatus, type BusinessMessages } from "../error-mapping.js";
import { resolveIdentity as resolveRequestScopedIdentity, withRequestScope as withScope } from "../request-context.js";
import type { ToolTraceLabeller } from "../public-agent-stream.js";
import type { PublicReasoningMode, ReasoningSummarizer } from "../public-reasoning-stream.js";

/**
 * Everything a `/api/*` route handler in this Fastify binding shares: the same identity
 * resolution and request-scoping `createAgentApiHandler` uses (via `../request-context.js`, so
 * neither transport can drift from the other), plus the one Fastify-specific piece — sending a
 * response through `reply.raw` (the same `ServerResponse` `applyResponseHeaders`/`json` in
 * `agent-api-handler.ts` already write to) instead of through Fastify's own `reply.send()`, for
 * every route where this package does not hand Fastify a response schema (see
 * `fastify-response-schemas.ts` for which routes do and why).
 */
export interface FastifyRouteContext {
  readonly runtime: AgentApiRuntime;
  readonly options: AgentApiOptions;
  /**
   * `toolTrace` belongs here and not only on the handler path: this is the context the Fastify SSE
   * routes hand to the stream, and it used to be assembled without it, so a product that supplied a
   * labeller had it silently dropped and its users saw no tool activity at all. Two error-option
   * bags for two transports is the shape that made that possible.
   */
  readonly errorOptions: { readonly businessMessages?: BusinessMessages; readonly includeErrorDetail: boolean; readonly onStreamError?: NonNullable<AgentApiOptions["onStreamError"]>; readonly toolTrace?: ToolTraceLabeller; readonly reasoning?: PublicReasoningMode; readonly reasoningSentence?: (sentence: string) => boolean; readonly reasoningSummary?: ReasoningSummarizer };
  readonly chatInputOptions: { readonly attachmentOnlyContent?: string };
  readonly historyEventLimit: number;
  policyFor(request: FastifyRequest): ResponsePolicy;
}

export function resolveIdentity(context: FastifyRouteContext, request: FastifyRequest, purpose: string): Promise<SecurityContext> {
  return resolveRequestScopedIdentity(context.runtime.identityResolver, context.options, request.raw, purpose);
}

export function withRequestScope<T>(
  context: FastifyRouteContext, request: FastifyRequest, security: SecurityContext, task: () => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  return withScope(context.options, request.raw, security, task, signal);
}

/** Writes an error the same way `agent-api-handler.ts`'s `json()` does — same headers, same body shape, same status mapping. */
export function sendJsonError(context: FastifyRouteContext, reply: FastifyReply, policy: ResponsePolicy, error: unknown): void {
  applyResponseHeaders(reply.raw, policy);
  void reply.code(publicStatus(error)).send({ error: publicApiError(context.options.businessMessages, error, context.errorOptions.includeErrorDetail) });
}

/**
 * The same error body as `sendJsonError`, written directly to `reply.raw` instead of through
 * `reply.send()`. Required, not a style choice: once `reply.hijack()` has been called (every SSE
 * route in `fastify-sse-routes.ts`), Fastify's own reply pipeline is switched off, and `reply.send()`
 * writes nothing — the request found this by hanging forever instead of ending with an error body,
 * because the underlying socket was never told the response was complete.
 */
export function sendRawJsonError(context: FastifyRouteContext, reply: FastifyReply, policy: ResponsePolicy, error: unknown): void {
  applyResponseHeaders(reply.raw, policy);
  reply.raw.statusCode = publicStatus(error);
  reply.raw.setHeader("content-type", "application/json; charset=utf-8");
  reply.raw.end(JSON.stringify({ error: publicApiError(context.options.businessMessages, error, context.errorOptions.includeErrorDetail) }));
}

/**
 * Wraps a JSON route body: resolves the origin policy once, applies the standard response
 * headers on success, and maps any thrown error through `sendJsonError` — the one place every
 * JSON route in this binding shares that logic, so adding a route can never forget it.
 */
export function jsonRoute<T>(context: FastifyRouteContext, body: (request: FastifyRequest, reply: FastifyReply, policy: ResponsePolicy) => Promise<T>) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<T | undefined> => {
    const policy = context.policyFor(request);
    try {
      const result = await body(request, reply, policy);
      applyResponseHeaders(reply.raw, policy);
      return result;
    } catch (error) {
      sendJsonError(context, reply, policy, error);
      return undefined;
    }
  };
}
