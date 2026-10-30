import type { IncomingMessage } from "node:http";
import type { IdentityResolver, JsonValue, SecurityContext, TurnApplicationContext } from "@0xsyncroot/contracts";
import { resolveRequestIdentity } from "./identity-resolvers.js";

/**
 * The two delivery-level extension points every `/api/*` transport binding needs — currently
 * `createAgentApiHandler` (raw `node:http`) and the Fastify binding in `./fastify/`. Kept as its
 * own small module, pulled out of `agent-api-handler.ts`, so a second transport reuses the exact
 * same identity-resolution and request-scoping logic rather than a hand-copied twin of it: two
 * *routing tables* are fine (a plain if-chain versus Fastify's router are genuinely different
 * things), but two copies of what a request is actually authorized against are not.
 */
export interface RequestScopeOptions {
  /**
   * A product's own extension point: pulls whatever extra, product-specific values its identity
   * resolver needs out of the raw request (a session-binding header, for instance) into
   * `IdentityEvidence.attributes`. This package reads no header by that name itself — it only
   * carries the caller's own extraction through to `resolver.resolve()` unread.
   */
  readonly identityAttributes?: (request: IncomingMessage) => Readonly<Record<string, string>>;
  /**
   * A product's own extension point for a request-scoped credential a delegated MCP connector
   * needs at tool-execution time (see `PrincipalCredentialScope` in `@0xsyncroot/contracts`): wraps
   * every `runTurn`/`resumeTurn`/`resumeInteraction` call this handler makes. The credential
   * itself is the product's to read off `request` and bind for the call's duration — this package
   * never sees or carries it, so it cannot land in a journal, a plugin config or an error message.
   */
  readonly runWithRequestScope?: <T>(
    context: { readonly request: IncomingMessage; readonly security: SecurityContext },
    task: () => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
}

export function resolveIdentity(
  identityResolver: IdentityResolver, options: RequestScopeOptions, request: IncomingMessage, purpose: string,
): Promise<SecurityContext> {
  return resolveRequestIdentity(request, identityResolver, purpose, undefined, options.identityAttributes?.(request));
}

export function withRequestScope<T>(
  options: RequestScopeOptions, request: IncomingMessage, security: SecurityContext, task: () => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  return options.runWithRequestScope ? options.runWithRequestScope({ request, security }, task, signal) : task();
}

/** `TurnApplicationContext` from the security context's signed trusted claims plus the caller's own untrusted `agentContext`. */
export function applicationContext(
  security: SecurityContext, untrusted: JsonValue | undefined,
): { readonly applicationContext?: TurnApplicationContext } {
  if (!security.trustedContext && untrusted === undefined) return {};
  return {
    applicationContext: Object.freeze({
      ...(security.trustedContext ? { trusted: security.trustedContext } : {}),
      ...(untrusted !== undefined ? { untrusted } : {}),
    }),
  };
}
