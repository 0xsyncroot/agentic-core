import {
  AgenticError,
  type JudgmentAnswer,
  type JudgmentCallOptions,
  type JudgmentPort,
  type JudgmentRequest,
  type JudgmentResult,
} from "@0xsyncroot/contracts";
import type { TypeSafeJudgmentConfig } from "./config.js";

export const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-1.13.0";
const DEFAULT_TIMEOUT_MS = 1_500;

interface TypeSafeResponse {
  readonly model?: unknown;
  readonly answers?: unknown;
  readonly usage?: { readonly input_tokens?: unknown; readonly output_tokens?: unknown };
  readonly error?: { readonly message?: unknown };
}

/** https only, except loopback http for local fakes. No credentials, query or fragment: the key travels in a header. */
export function resolveTypeSafeBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || TYPESAFE_DEFAULT_BASE_URL;
  let url: URL;
  try { url = new URL(raw); } catch { throw new AgenticError("validation", "TypeSafe base URL is not a valid URL"); }
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !loopback) throw new AgenticError("validation", "TypeSafe base URL must use https");
  if (url.username || url.password) throw new AgenticError("validation", "TypeSafe base URL must not embed credentials");
  if (url.search || url.hash) throw new AgenticError("validation", "TypeSafe base URL must not carry a query or fragment");
  return url.href.replace(/\/+$/u, "");
}

function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }

/** Judgments with probabilities from TypeSafe's System One (`POST /v1/systemone`). Data for callers to weigh, never a verdict. */
export class TypeSafeJudgmentAdapter implements JudgmentPort {
  readonly providerId = "typesafe";
  readonly model: string;
  readonly #apiKey: string;
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(config: TypeSafeJudgmentConfig) {
    if (!config.apiKey?.trim()) throw new AgenticError("validation", "TypeSafe API key is required");
    this.#apiKey = config.apiKey.trim();
    this.#url = `${resolveTypeSafeBaseUrl(config.baseUrl)}/v1/systemone`;
    this.model = config.model?.trim() || DEFAULT_MODEL;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1) throw new AgenticError("validation", "TypeSafe timeoutMs must be a positive integer");
    this.#fetch = config.fetch ?? fetch;
  }

  async judge(request: JudgmentRequest, signal: AbortSignal, options?: JudgmentCallOptions): Promise<JudgmentResult> {
    const timeoutMs = options?.timeoutMs ?? this.#timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new AgenticError("validation", "TypeSafe call timeoutMs must be a positive integer");
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const combined = AbortSignal.any([signal, deadline.signal]);
    const interrupted = (cause: unknown): AgenticError =>
      signal.aborted ? new AgenticError("cancelled", "TypeSafe request was cancelled", false, { cause })
        : new AgenticError("timeout", `TypeSafe request exceeded ${timeoutMs} ms`, false, { cause });
    let response: Response;
    let payload: TypeSafeResponse = {};
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        signal: combined,
        headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ state: request.state, model: this.model, questions: request.questions }),
      });
      try { payload = (await response.json()) as TypeSafeResponse; } catch (error) {
        if (combined.aborted) throw error;
        /* Not JSON: the status decides. */
      }
    } catch (error) {
      if (combined.aborted) throw interrupted(error);
      throw new AgenticError("transient", "TypeSafe transport failed", true, { cause: error });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw this.#statusError(response, payload);
    return this.#result(request, payload);
  }

  #statusError(response: Response, payload: TypeSafeResponse): AgenticError {
    const status = response.status;
    const raw = typeof payload.error?.message === "string" ? payload.error.message : response.statusText;
    const detail = raw.split(this.#apiKey).join("[redacted]").slice(0, 300);
    const retryable = status === 408 || status === 429 || status === 529 || status >= 500;
    return new AgenticError(retryable ? "transient" : "permanent", `TypeSafe request failed (${status}): ${detail}`, retryable);
  }

  #result(request: JudgmentRequest, payload: TypeSafeResponse): JudgmentResult {
    const answers = payload.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      throw new AgenticError("permanent", "TypeSafe response has no answers");
    }
    for (const [id, answer] of Object.entries(answers as Record<string, unknown>)) {
      const question = request.questions[id];
      const typed = answer as { type?: unknown; noul?: unknown } | null;
      if (!question) throw new AgenticError("permanent", "TypeSafe answered a question that was not asked");
      if (!typed || typed.type !== question.type) throw new AgenticError("permanent", `TypeSafe answer type does not match question type "${question.type}"`);
      if (question.type === "noul" && !finite(typed.noul)) throw new AgenticError("permanent", "TypeSafe noul answer is not a number");
    }
    const inputTokens = payload.usage?.input_tokens;
    const outputTokens = payload.usage?.output_tokens;
    return {
      modelId: typeof payload.model === "string" ? payload.model : this.model,
      answers: answers as Readonly<Record<string, JudgmentAnswer>>,
      ...(finite(inputTokens) || finite(outputTokens)
        ? { usage: { ...(finite(inputTokens) ? { inputTokens } : {}), ...(finite(outputTokens) ? { outputTokens } : {}) } }
        : {}),
    };
  }
}
