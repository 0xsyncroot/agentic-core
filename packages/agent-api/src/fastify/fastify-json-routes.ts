import type { FastifyInstance } from "fastify";
import { AgenticError } from "@0xsyncroot/contracts";
import { resumeApproval } from "../approval-api.js";
import { cancelInput, interjectInput, SESSION_PATTERN } from "../chat-input.js";
import { acceptChatTurn } from "../inline-attachments.js";
import { sessionHistoryEvents } from "../session-history.js";
import { sessionDirectory } from "../session-directory.js";
import { visibleMessages } from "../history-view.js";
import { applicationContext } from "../request-context.js";
import { resultPayload } from "../result-payload.js";
import { runtimeAnswer } from "../runtime-answer.js";
import { resumableAgentStreamKey } from "../resumable-agent-stream.js";
import { jsonRoute, resolveIdentity, withRequestScope, type FastifyRouteContext } from "./fastify-context.js";
import {
  APPROVAL_RESPONSE_SCHEMA, CANCEL_RESPONSE_SCHEMA, CHAT_RESPONSE_SCHEMA, HEALTH_RESPONSE_SCHEMA, INTERJECT_RESPONSE_SCHEMA,
  RUNTIME_RESPONSE_SCHEMA, SESSIONS_RESPONSE_SCHEMA,
} from "./fastify-response-schemas.js";
import type { ResumableAgentStreamRegistry } from "../resumable-agent-stream.js";

/**
 * Every non-SSE `/api/*` route, registered on Fastify's own router (param matching, method
 * dispatch) instead of `agent-api-handler.ts`'s hand-rolled if-chain — the same business logic
 * either way, called through the exact same exported functions that chain uses.
 *
 * `/api/sessions/*` and `/api/approvals/*` are wildcard routes, not `:sessionId`/`:approvalId`
 * params: `agent-api-handler.ts`'s original slice-based routing (`pathname.slice("/api/.../".length)`)
 * never restricted the id to a single path segment the way Fastify's `:param` syntax would, and a
 * segment-restricted match would 404 instead of the original's 400 "sessionId/approvalId is
 * invalid" for the (already-rejected-downstream) case of an id containing a `/`.
 */
export function registerJsonRoutes(app: FastifyInstance, context: FastifyRouteContext, streamRegistry: ResumableAgentStreamRegistry): void {
  app.get("/api/health", { schema: { response: HEALTH_RESPONSE_SCHEMA } },
    jsonRoute(context, async () => ({ status: "ok" as const })));

  app.get("/api/runtime", { schema: { response: RUNTIME_RESPONSE_SCHEMA } },
    jsonRoute(context, async (request) => {
      // A connectivity probe only; tenant/profile-specific capabilities are discovered inside the authenticated turn boundary.
      await resolveIdentity(context, request, "agent-api-runtime-metadata");
      return runtimeAnswer(context.options);
    }));

  app.get("/api/sessions", jsonRoute(context, async (request) => sessionDirectory(context.runtime.sessions,
    new URL(request.url, "http://localhost").searchParams, await resolveIdentity(context, request, "agent-api-session-directory"), context.options.sessionAgentProfileId)));

  app.get<{ Params: { "*": string } }>("/api/sessions/*", { schema: { response: SESSIONS_RESPONSE_SCHEMA } },
    jsonRoute(context, async (request) => {
      const sessionId = decodeURIComponent((request.params as { readonly "*": string })["*"]);
      if (!SESSION_PATTERN.test(sessionId)) throw new AgenticError("validation", "sessionId is invalid");
      const events = await sessionHistoryEvents(context.runtime.sessions, sessionId, await resolveIdentity(context, request, "agent-api-session-history"), context.historyEventLimit);
      return { sessionId, messages: visibleMessages(events, context.options) };
    }));

  app.post("/api/chat", { schema: { response: CHAT_RESPONSE_SCHEMA } },
    jsonRoute(context, async (request) => {
      const { input, security: requestSecurity } = await acceptChatTurn(request.raw, context.chatInputOptions, context.options.attachmentStore,
        () => resolveIdentity(context, request, "agent-api-chat"));
      const startedAt = performance.now();
      const result = await withRequestScope(context, request, requestSecurity, () => context.runtime.agent.runTurn({
        sessionId: input.sessionId, content: input.content, idempotencyKey: input.requestId, security: requestSecurity,
        ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}),
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
        ...applicationContext(requestSecurity, input.agentContext),
      }));
      return resultPayload(result, startedAt, context.options.businessMessages);
    }));

  app.post("/api/chat/cancel", { schema: { response: CANCEL_RESPONSE_SCHEMA } },
    jsonRoute(context, async (request, reply) => {
      const input = await cancelInput(request.raw);
      const security = await resolveIdentity(context, request, "agent-api-chat-cancel");
      const cancelled = await streamRegistry.cancel(resumableAgentStreamKey(security, input));
      void reply.code(cancelled ? 202 : 200);
      return { cancelled };
    }));

  // Same shape as /api/chat/cancel and for the same reason: whoever typed the sentence has to
  // learn whether a turn took it, so the answer is 202/200 rather than a silent absorb.
  app.post("/api/chat/interject", { schema: { response: INTERJECT_RESPONSE_SCHEMA } },
    jsonRoute(context, async (request, reply) => {
      const input = await interjectInput(request.raw);
      const security = await resolveIdentity(context, request, "agent-api-chat-interject");
      const accepted = await streamRegistry.interject(resumableAgentStreamKey(security, input), input.content);
      void reply.code(accepted ? 202 : 200);
      return { accepted };
    }));

  app.post<{ Params: { "*": string } }>("/api/approvals/*", { schema: { response: APPROVAL_RESPONSE_SCHEMA } },
    jsonRoute(context, async (request) => {
      const approvalId = decodeURIComponent((request.params as { readonly "*": string })["*"]);
      const resumed = await resumeApproval(
        request.raw, context.runtime.agent, context.runtime.identityResolver, approvalId,
        context.options.identityAttributes?.(request.raw), context.options.runWithRequestScope,
      );
      return resultPayload(resumed.result, resumed.startedAt, context.options.businessMessages);
    }));
}
