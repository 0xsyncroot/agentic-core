import Fastify, { type FastifyInstance } from "fastify";
import { applyResponseHeaders, type AgentApiOptions, type AgentApiRuntime } from "../agent-api-handler.js";
import { createOriginPolicyResolver, rejectsApiOrigin, respondToPreflight } from "../cors-policy.js";
import { InMemoryResumableAgentStreamRegistry } from "../in-memory-stream-registry.js";
import { createFastifyClientErrorHandler } from "./fastify-client-error.js";
import type { FastifyRouteContext } from "./fastify-context.js";
import { registerJsonRoutes } from "./fastify-json-routes.js";
import { registerSseRoutes } from "./fastify-sse-routes.js";

/**
 * A deployment behind an ingress whose upstream keep-alive is shorter than this server's own
 * closes a socket the proxy is still holding open, which the proxy then tries to reuse and the
 * backend answers with nothing — the client sees an intermittent 502 with no error on this side to
 * explain it. 72s matches a 60s ingress-nginx upstream keep-alive with margin, which is this
 * deployment's own known value (a product composition states its own reasoning for it explicitly
 * rather than relying on this default silently, so that reasoning travels with wherever the number
 * is actually pinned, not just here).
 */
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 72_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_BODY_LIMIT = 256 * 1024;
const DEFAULT_MAX_PARAM_LENGTH = 128;

export interface AgentApiFastifyOptions extends AgentApiOptions {
  /** Default 72 000ms — see this file's own doc comment for why that exact number and not Fastify's own default. */
  readonly keepAliveTimeoutMs?: number;
  /** Default 120 000ms. A model call is the dominant cost on this API; bound generously, not tightly. */
  readonly requestTimeoutMs?: number;
  /** Default 256 KiB. `agentContext` alone is capped at 32 KiB (see chat-input.ts); this bounds the whole request body one layer earlier, before any parsing. */
  readonly bodyLimit?: number;
  /** Default 128. No path parameter this binding reads (`sessionId`/`approvalId`/`interactionId`) is validated past 128 chars anyway; this refuses a longer one before routing does any work on it. */
  readonly maxParamLength?: number;
  /** Off by default, matching `createAgentApiHandler`'s own silence; a consumer wires Fastify's own logger when it wants request logging. */
  readonly logger?: boolean;
}

function notFoundBody() {
  return { error: { code: "not-found", message: "Route not found" } };
}

/**
 * The Fastify binding for the same neutral `/api/*` delivery `createAgentApiHandler` (raw
 * `node:http`) implements — reusing its exact identity resolution, request scoping, input
 * validation, error mapping and SSE framing (all already shared via `../request-context.js` and
 * the rest of this package's exported building blocks), with Fastify's own router, hooks and
 * (where the payload shape is safe to fully specify — see `fastify-response-schemas.ts`) response
 * schemas in place of the raw handler's hand-rolled if-chain and manual `JSON.stringify`.
 *
 * `apps/web` and any other consumer of the raw `createAgentApiHandler` are entirely unaffected by
 * this file — nothing here is imported by `agent-api-handler.ts`, only the reverse.
 */
export function createAgentApiFastify(runtime: AgentApiRuntime, options: AgentApiFastifyOptions = {}): FastifyInstance {
  if (options.deploymentProfile === "production" && options.streamRegistry?.productionSafe !== true) {
    throw new Error("Production agent-api delivery requires a production-safe shared ResumableAgentStreamRegistry");
  }
  const clientError = createFastifyClientErrorHandler("[agent-api-fastify]");
  const app = Fastify({
    keepAliveTimeout: options.keepAliveTimeoutMs ?? DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
    requestTimeout: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
    // routerOptions.maxParamLength, not the deprecated top-level maxParamLength (removed in fastify@6).
    routerOptions: { maxParamLength: options.maxParamLength ?? DEFAULT_MAX_PARAM_LENGTH },
    clientErrorHandler: clientError.handle,
    logger: options.logger ?? false,
    // Fastify's own built-in for the problem the raw-http path solves by calling
    // `server.closeIdleConnections()` itself before `.close()`: without it, `.close()` waits for
    // every keep-alive socket to end on its own, which — now that keepAliveTimeout is pinned to
    // 72s — could stall an otherwise-fast graceful shutdown for up to 72s on connections doing
    // nothing. "idle" (not `true`) still lets an in-flight request finish; only idle sockets are
    // force-closed.
    forceCloseConnections: "idle",
  });

  // `chatInput`/`cancelInput`/`readInteractionInput` (shared with the raw-http handler) read the
  // body themselves, directly off `request.raw` as a stream — the same thing every one of this
  // package's own tests exercises. Fastify's own content-type parsers would otherwise consume
  // that stream first (to populate `request.body`), leaving nothing for those functions to read
  // and turning every POST into "Request body must be valid JSON". A `'*'` parser alone does not
  // stop this: Fastify's two *native* default parsers (`application/json`, `text/plain`) are
  // exact-match and take precedence over a wildcard, so both are overridden explicitly, in
  // addition to the wildcard for anything else. Registering a parser that reads nothing is what
  // keeps `request.raw` intact for those functions — and is also why no route below declares a
  // request body schema: Fastify never sees the body to validate against one.
  // `fast-json-stringify` on the *response* side (see fastify-response-schemas.ts) needs none of
  // this and is unaffected.
  const passthroughBodyParser = (_request: unknown, _payload: unknown, done: (error: null, body?: unknown) => void) => done(null, undefined);
  app.addContentTypeParser("application/json", passthroughBodyParser);
  app.addContentTypeParser("text/plain", passthroughBodyParser);
  app.addContentTypeParser("*", passthroughBodyParser);

  const resolveOriginPolicy = createOriginPolicyResolver(options);
  const ownsRegistry = options.streamRegistry === undefined;
  const streamRegistry = options.streamRegistry ?? new InMemoryResumableAgentStreamRegistry(options.streamLimits ?? {});
  const context: FastifyRouteContext = {
    runtime, options,
    errorOptions: {
      ...(options.businessMessages ? { businessMessages: options.businessMessages } : {}),
      includeErrorDetail: options.includeErrorDetail ?? false,
      ...(options.toolTrace ? { toolTrace: options.toolTrace } : {}),
      ...(options.reasoning ? { reasoning: options.reasoning } : {}),
      ...(options.reasoningSentence ? { reasoningSentence: options.reasoningSentence } : {}),
      ...(options.reasoningSummary ? { reasoningSummary: options.reasoningSummary } : {}),
      ...(options.onStreamError ? { onStreamError: options.onStreamError } : {}),
    },
    chatInputOptions: { ...(options.attachmentOnlyContent ? { attachmentOnlyContent: options.attachmentOnlyContent } : {}) },
    historyEventLimit: options.historyEventLimit ?? 500,
    policyFor: (request) => resolveOriginPolicy(request.raw),
  };

  app.addHook("onRequest", async (request, reply) => {
    clientError.trackResponse(request.raw, reply.raw);
    const policy = context.policyFor(request);
    // No CORS headers on a rejected origin — matches agent-api-handler.ts's own json(response, 403, ...)
    // call, which passes no policy for this one response, on purpose: echoing access-control-allow-origin
    // back to an origin this policy just refused would say the opposite of what the status code says.
    if (rejectsApiOrigin(request.raw, request.raw.url ?? "/", policy)) {
      reply.hijack();
      applyResponseHeaders(reply.raw);
      reply.raw.statusCode = 403;
      reply.raw.setHeader("content-type", "application/json; charset=utf-8");
      reply.raw.end(JSON.stringify({ error: { code: "denied", message: "Browser origin is not allowed" } }));
      return;
    }
    if (request.method === "OPTIONS") {
      reply.hijack();
      respondToPreflight(request.raw, reply.raw, policy);
    }
  });

  app.setNotFoundHandler((request, reply) => {
    const policy = context.policyFor(request);
    applyResponseHeaders(reply.raw, policy);
    void reply.code(404).send(notFoundBody());
  });

  registerJsonRoutes(app, context, streamRegistry);
  registerSseRoutes(app, context, streamRegistry);

  app.addHook("onClose", async () => {
    if (ownsRegistry) await streamRegistry.close();
  });

  return app;
}
