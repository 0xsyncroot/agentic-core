import { AgenticError } from "@0xsyncroot/contracts";

const MAX_DETAIL_CHARS = 200;

interface ProviderErrorBody { readonly code?: unknown; readonly message?: unknown; readonly status?: unknown }

function providerError(text: string): ProviderErrorBody {
  try {
    const parsed = JSON.parse(text) as { error?: ProviderErrorBody } | null;
    return parsed && typeof parsed === "object" && parsed.error && typeof parsed.error === "object" ? parsed.error : {};
  } catch { return {}; }
}

/** 408, 5xx (including 529) and 429 are worth retrying; a daily quota (`quota_exceeded`) is not. */
export function classifyStatus(status: number, providerCode: unknown): "transient" | "permanent" {
  if (status === 429) return providerCode === "quota_exceeded" ? "permanent" : "transient";
  return status === 408 || status >= 500 ? "transient" : "permanent";
}

export function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

export interface JsonPostOptions {
  readonly url: string;
  readonly apiKey: string;
  readonly body: unknown;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly fetchImpl: typeof fetch;
  readonly operation: string;
}

/**
 * One JSON POST with the adapter's own deadline. The deadline and the caller's abort are told
 * apart: the first is `timeout`, the second `cancelled`. The key only ever goes in a header.
 */
export async function postJson(options: JsonPostOptions): Promise<unknown> {
  const { operation, apiKey } = options;
  if (options.signal.aborted) throw new AgenticError("cancelled", `${operation} was cancelled`);
  const deadline = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; deadline.abort(); }, options.timeoutMs);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  const aborted = (): AgenticError => options.signal.aborted
    ? new AgenticError("cancelled", `${operation} was cancelled`)
    : new AgenticError("timeout", `${operation} exceeded ${options.timeoutMs} ms`, false);
  try {
    let response: Response;
    let text: string;
    try {
      response = await options.fetchImpl(options.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(options.body),
        signal,
      });
      text = await response.text();
    } catch (error) {
      if (signal.aborted || timedOut) throw aborted();
      throw new AgenticError("transient", `${operation} could not reach the speech provider: ${redact(error instanceof Error ? error.message : "network error", apiKey)}`, true);
    }
    if (!response.ok) {
      const body = providerError(text);
      const kind = classifyStatus(response.status, body.code);
      const code = typeof body.code === "string" || typeof body.code === "number" ? ` ${String(body.code)}` : "";
      const detail = typeof body.message === "string" ? `: ${redact(body.message, apiKey).slice(0, MAX_DETAIL_CHARS)}` : "";
      throw new AgenticError(kind, `${operation} failed with HTTP ${response.status}${code}${detail}`, kind === "transient");
    }
    try { return JSON.parse(text) as unknown; } catch {
      throw new AgenticError("permanent", `${operation} returned a body that is not JSON`);
    }
  } finally {
    clearTimeout(timer);
  }
}
