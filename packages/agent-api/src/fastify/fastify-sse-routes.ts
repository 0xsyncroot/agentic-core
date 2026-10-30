import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { applyResponseHeaders } from "../agent-api-handler.js";
import { acceptChatTurn } from "../inline-attachments.js";
import { readInteractionInput, resolveInteraction } from "../interaction-api.js";
import { servePublicAgentStream } from "../public-agent-stream-handler.js";
import { applicationContext } from "../request-context.js";
import { resumableAgentOperationFingerprint, resumableAgentStreamFingerprint, resumableAgentStreamKey, type ResumableAgentStreamRegistry } from "../resumable-agent-stream.js";
import { resolveIdentity, sendRawJsonError, withRequestScope, type FastifyRouteContext } from "./fastify-context.js";

/**
 * The SSE routes: unlike every other route in this binding, these do not go through Fastify's
 * own response pipeline at all. `reply.hijack()` tells Fastify this handler owns `reply.raw` (the
 * same `ServerResponse` `servePublicAgentStream`/`pipeResumableAgentStream` already write
 * `id:`/`event:`/`data:` frames, the heartbeat and the resumable-journal replay to, unchanged) —
 * a route schema and `fast-json-stringify` have nothing to offer a stream whose framing and
 * serialization are already this package's own, and going through Fastify's reply machinery for
 * it would only add buffering behaviour nobody asked for.
 */
export function registerSseRoutes(app: FastifyInstance, context: FastifyRouteContext, streamRegistry: ResumableAgentStreamRegistry): void {
  async function withHijackedErrors(request: FastifyRequest, reply: FastifyReply, run: () => Promise<void>): Promise<void> {
    reply.hijack();
    const policy = context.policyFor(request);
    try {
      await run();
    } catch (error) {
      // servePublicAgentStream never lets an error out once it starts writing the SSE response
      // (it turns one into an `event: error` frame itself) — anything reaching here happened
      // before any byte of this response was sent, so a fresh JSON error response is safe.
      sendRawJsonError(context, reply, policy, error);
    }
  }

  app.post("/api/chat/stream", async (request, reply) => withHijackedErrors(request, reply, async () => {
    const { input, security: requestSecurity } = await acceptChatTurn(request.raw, context.chatInputOptions, context.options.attachmentStore,
      () => resolveIdentity(context, request, "agent-api-chat-stream"));
    await servePublicAgentStream(request.raw, reply.raw, streamRegistry, () => applyResponseHeaders(reply.raw, context.policyFor(request)), {
      key: resumableAgentStreamKey(requestSecurity, input),
      fingerprint: resumableAgentStreamFingerprint(requestSecurity, input),
      run: (stream, signal, interjections) => withRequestScope(context, request, requestSecurity, () => context.runtime.agent.runTurn({
        sessionId: input.sessionId, content: input.content, idempotencyKey: input.requestId, security: requestSecurity, signal, interjections,
        ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}),
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
        ...applicationContext(requestSecurity, input.agentContext),
        onProgress: (progress) => stream.progress(progress), onOutput: (output) => stream.output(output),
        onNarration: (narration) => stream.narration(narration), onReasoning: (reasoning) => stream.reasoning(reasoning),
      }), signal),
    }, context.errorOptions);
  }));

  app.post<{ Params: { interactionId: string } }>("/api/interactions/:interactionId/stream", async (request, reply) => withHijackedErrors(request, reply, async () => {
    const interactionId = decodeURIComponent(request.params.interactionId);
    const input = await readInteractionInput(request.raw);
    const security = await resolveIdentity(context, request, "agent-api-interaction-stream");
    await servePublicAgentStream(request.raw, reply.raw, streamRegistry, () => applyResponseHeaders(reply.raw, context.policyFor(request)), {
      key: resumableAgentStreamKey(security, input),
      fingerprint: resumableAgentOperationFingerprint(security, input, "interaction", {
        kind: input.kind, interactionId,
        ...(input.kind === "approval" ? { decision: input.decision } : { action: input.action, content: input.content ?? null }),
        agentProfileId: input.agentProfileId ?? null,
      }),
      run: (stream, signal, interjections) => withRequestScope(context, request, security, () => resolveInteraction(context.runtime.agent, security, interactionId, input, {
        signal, interjections, onProgress: (progress) => stream.progress(progress), onOutput: (output) => stream.output(output),
        onNarration: (narration) => stream.narration(narration), onReasoning: (reasoning) => stream.reasoning(reasoning),
      }), signal),
    }, context.errorOptions);
  }));
}
