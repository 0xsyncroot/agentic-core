import { AgenticError } from "@0xsyncroot/contracts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * A provider base URL is https, or http to a loopback fake. It carries no credentials, query or
 * fragment: the API key travels in a header, so nothing in the URL may hold a secret.
 * Returns the URL without a trailing slash.
 */
export function validateProviderBaseUrl(raw: string, name = "baseUrl"): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new AgenticError("validation", `${name} is not a valid URL`); }
  const loopbackHttp = parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopbackHttp) {
    throw new AgenticError("validation", `${name} must be https://, or http:// to a loopback host`);
  }
  if (parsed.username || parsed.password) throw new AgenticError("validation", `${name} must not embed credentials`);
  if (parsed.search || parsed.hash) throw new AgenticError("validation", `${name} must not carry a query or fragment`);
  return parsed.href.replace(/\/+$/u, "");
}
