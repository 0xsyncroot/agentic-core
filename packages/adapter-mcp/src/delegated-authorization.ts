import { AgenticError, type PrincipalCredentialScope, type SecurityContext } from "@0xsyncroot/contracts";
import type { AuthProvider } from "@modelcontextprotocol/client";
import { digest, principalBinding } from "./shared.js";
import { McpTokenCache, type ExchangedMcpToken } from "./token-cache.js";
import type {
  McpPrincipalAuthorizationContext, McpPrincipalAuthorizationResolver,
} from "./types.js";

/** What a token exchange hands back. Never logged, journaled or placed in `PluginDescriptor.config`. */
export interface McpAccessToken {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  /** Opaque, non-secret account/grant revision used only to partition pooled client state. */
  readonly partition: string;
}

export interface McpTokenExchangeInput {
  readonly serverId: string;
  readonly endpoint: string;
  readonly security: SecurityContext;
  readonly agentProfileId: string;
  /** The request-scoped, non-secret session reference the delivery adapter bound to this principal. */
  readonly credential: string;
}

export interface McpTokenExchange {
  exchange(input: McpTokenExchangeInput, signal: AbortSignal): Promise<McpAccessToken>;
}

export interface McpDelegatedAuthorizationConfig {
  readonly credentials: PrincipalCredentialScope<string>;
  readonly exchange: McpTokenExchange;
  readonly refreshSkewSeconds?: number;
  readonly maxCachedTokens?: number;
  /** Hard bound on one exchange. A token endpoint that hangs must not wedge a pooled client. */
  readonly exchangeTimeoutMs?: number;
}

const MAX_ACCESS_TOKEN_LENGTH = 8192;
const MIN_EXPIRES_IN_SECONDS = 1;
const MAX_EXPIRES_IN_SECONDS = 86_400;
const MAX_PARTITION_LENGTH = 256;

function validateExchangedToken(serverId: string, token: McpAccessToken): void {
  if (typeof token.accessToken !== "string" || !token.accessToken || token.accessToken.length > MAX_ACCESS_TOKEN_LENGTH) {
    throw new AgenticError("permanent", `MCP token exchange for ${serverId} returned an invalid access token`);
  }
  if (!Number.isInteger(token.expiresInSeconds) || token.expiresInSeconds < MIN_EXPIRES_IN_SECONDS || token.expiresInSeconds > MAX_EXPIRES_IN_SECONDS) {
    throw new AgenticError("permanent", `MCP token exchange for ${serverId} returned an invalid expiry`);
  }
  if (typeof token.partition !== "string") {
    throw new AgenticError("permanent", `MCP token exchange for ${serverId} returned an invalid partition`);
  }
  const partition = token.partition.trim();
  if (!partition || partition.length > MAX_PARTITION_LENGTH) {
    throw new AgenticError("permanent", `MCP token exchange for ${serverId} returned an invalid partition`);
  }
}

/**
 * Resolves MCP authorization by exchanging the *calling principal's* own bound credential for an
 * access token, never a deployment/service token. Fails closed when no credential is bound: a
 * caller with no session never gets waved through as anonymous or service-scoped.
 */
export function createDelegatedPrincipalAuthorizationResolver(
  config: McpDelegatedAuthorizationConfig,
): McpPrincipalAuthorizationResolver {
  const refreshSkewSeconds = config.refreshSkewSeconds ?? 30;
  const maxCachedTokens = config.maxCachedTokens ?? 200;
  const exchangeTimeoutMs = config.exchangeTimeoutMs ?? 10_000;
  if (!Number.isInteger(refreshSkewSeconds) || refreshSkewSeconds < 0) throw new Error("MCP refreshSkewSeconds must be a non-negative integer");
  if (!Number.isInteger(exchangeTimeoutMs) || exchangeTimeoutMs <= 0) throw new Error("MCP exchangeTimeoutMs must be a positive integer");
  const cache = new McpTokenCache(maxCachedTokens);

  function cacheKey(context: McpPrincipalAuthorizationContext): string {
    return digest({
      serverId: context.serverId, endpoint: context.endpoint,
      principal: principalBinding(context.security), agentProfileId: context.agentProfileId,
    });
  }

  /**
   * Every exchange is bounded, and one made on behalf of a live call also inherits that call's
   * signal. A refresh triggered later — by `token()` on a pooled client, or by a 401 — has no
   * caller left to inherit from, so the timeout is all that stands between it and a hung token
   * endpoint. Deliberately not `AbortSignal.timeout()`: that timer is unref'd, so it never fires
   * when nothing else happens to be keeping the process's event loop alive — the exact situation
   * a hung token endpoint creates. This one is a plain, ref'd `setTimeout`, always cleared once the
   * exchange it bounds settles, so it never outlives the call or lingers as a leaked handle.
   */
  async function exchangeFresh(context: McpPrincipalAuthorizationContext, caller?: AbortSignal): Promise<ExchangedMcpToken> {
    const credential = config.credentials.current(context.security);
    if (!credential) {
      throw new AgenticError("denied", `MCP delegated authorization has no bound credential for ${context.serverId}`);
    }
    const bound = new AbortController();
    const timer = setTimeout(
      () => bound.abort(new DOMException(`MCP token exchange for ${context.serverId} timed out after ${exchangeTimeoutMs}ms`, "TimeoutError")),
      exchangeTimeoutMs,
    );
    const onCallerAbort = () => bound.abort(caller?.reason);
    if (caller?.aborted) onCallerAbort();
    else caller?.addEventListener("abort", onCallerAbort, { once: true });
    try {
      const token = await config.exchange.exchange({
        serverId: context.serverId, endpoint: context.endpoint,
        security: context.security, agentProfileId: context.agentProfileId, credential,
      }, bound.signal);
      validateExchangedToken(context.serverId, token);
      return {
        accessToken: token.accessToken, partition: token.partition.trim(),
        expiresAt: Date.now() + Math.max(0, token.expiresInSeconds - refreshSkewSeconds) * 1000,
      };
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    }
  }

  return {
    resolve: async (context, signal) => {
      const key = cacheKey(context);
      const current = await cache.get(key, () => exchangeFresh(context, signal));
      const authProvider: AuthProvider = {
        // Goes through the cache rather than closing over `current`: this closure belongs to the
        // pool entry created by the *first* resolve() for this key, so a long-lived pooled client
        // would otherwise keep presenting a token that expired between calls. Refreshing here
        // rather than waiting to be told means the happy path never depends on the server
        // answering a missing bearer with exactly 401 — a 403 would simply fail the call.
        token: async () => (await cache.get(key, () => exchangeFresh(context))).accessToken,
        // The SDK awaits this once on a 401, then retries once: force exactly one re-exchange
        // (coalesced with any exchange already in flight for this key) and never loop beyond that.
        onUnauthorized: async () => {
          await cache.forceRefresh(key, () => exchangeFresh(context));
        },
      };
      return { partition: current.partition, authProvider };
    },
  };
}
