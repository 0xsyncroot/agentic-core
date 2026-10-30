import type { IncomingMessage, ServerResponse } from "node:http";

export interface WebApplicationOptions {
  /** Exact browser origins allowed to call /api from an embedded widget. Use "*" only for public, credential-free deployments. */
  readonly allowedOrigins?: readonly string[];
  readonly allowCredentials?: boolean;
}

export interface ResponsePolicy {
  readonly corsOrigin: string | undefined;
  readonly allowCredentials: boolean;
}

function allowedOrigins(options: WebApplicationOptions): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of options.allowedOrigins ?? []) {
    const candidate = value.trim();
    if (!candidate) continue;
    if (candidate === "*") {
      origins.add(candidate);
      continue;
    }
    let parsed: URL;
    try { parsed = new URL(candidate); }
    catch { throw new Error(`Invalid web widget origin: ${candidate}`); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== candidate) {
      throw new Error(`Web widget origin must be an exact http(s) origin without a path: ${candidate}`);
    }
    origins.add(parsed.origin);
  }
  if (options.allowCredentials && origins.has("*")) throw new Error("Credentialed widget access cannot use wildcard allowed origin");
  return origins;
}

export function createOriginPolicyResolver(options: WebApplicationOptions): (request: IncomingMessage) => ResponsePolicy {
  const origins = allowedOrigins(options);
  const allowCredentials = options.allowCredentials === true;
  return (request) => {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    if (!origin) return { corsOrigin: undefined, allowCredentials };
    let sameHost = false;
    try { sameHost = new URL(origin).host === request.headers.host; } catch { /* Invalid origins are rejected by the caller. */ }
    const corsOrigin = sameHost || origins.has(origin) ? origin : origins.has("*") ? "*" : undefined;
    return { corsOrigin, allowCredentials };
  };
}

export function applyCorsHeaders(response: ServerResponse, policy: ResponsePolicy | undefined): void {
  if (!policy?.corsOrigin) return;
  response.setHeader("access-control-allow-origin", policy.corsOrigin);
  response.setHeader("vary", "origin");
  if (policy.allowCredentials && policy.corsOrigin !== "*") response.setHeader("access-control-allow-credentials", "true");
}

export function rejectsApiOrigin(request: IncomingMessage, pathname: string, policy: ResponsePolicy): boolean {
  return pathname.startsWith("/api/") && typeof request.headers.origin === "string" && policy.corsOrigin === undefined;
}

export function respondToPreflight(request: IncomingMessage, response: ServerResponse, policy: ResponsePolicy): void {
  applyCorsHeaders(response, policy);
  response.statusCode = 204;
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", request.headers["access-control-request-headers"] ?? "content-type, authorization");
  response.setHeader("access-control-max-age", "600");
  response.setHeader("vary", "origin, access-control-request-headers");
  response.end();
}
