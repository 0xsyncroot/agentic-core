/// <reference path="./harness-attempt.ts" />
/// <reference path="./harness-errors.ts" />
/** @internal Built-in adapter for the Agentic web harness HTTP/SSE contract. */
class HarnessHttpTransport implements AgentChatTransport {
  readonly #baseUrl: string;
  readonly #endpoints: AgentChatHarnessEndpoints;
  readonly #headersProvider: AgentChatHeaderProvider | undefined;
  readonly #credentials: RequestCredentials;
  readonly #requestExecutor: AgentChatRequestExecutor;
  readonly #protocol: AgentChatStreamProtocol;
  readonly #reconnect: HarnessReconnectPolicy;
  readonly #streamReset: { readonly header: string; readonly value: string } | undefined;
  /**
   * Resume position per request. A resend of the same request (the widget does this once the
   * backend answers again after the transport's own window ran out) continues from the last event
   * it saw instead of replaying the turn, and the body it re-posts is the identical one.
   */
  readonly #resumes = new Map<string, HarnessStreamResumeState>();

  constructor(options: AgentChatConnectionOptions) {
    const base = new URL(String(options.baseUrl), document.baseURI);
    if (base.protocol !== "http:" && base.protocol !== "https:") throw new TypeError("connection.baseUrl must use http or https");
    if (base.search || base.hash) throw new TypeError("connection.baseUrl cannot contain a query or hash");
    this.#baseUrl = base.href.endsWith("/") ? base.href : `${base.href}/`;
    this.#endpoints = options.endpoints ?? {};
    this.#headersProvider = options.headers;
    this.#credentials = options.credentials ?? "omit";
    this.#requestExecutor = options.request ?? ((url, init) => globalThis.fetch(url, init));
    this.#protocol = options.protocol ?? defaultHarnessStreamProtocol;
    this.#reconnect = reconnectPolicy(options.reconnect);
    this.#streamReset = options.streamReset?.header ? { header: options.streamReset.header, value: options.streamReset.value ?? "reset" } : undefined;
  }

  get baseUrl(): string { return this.#baseUrl.replace(/\/$/, ""); }
  async checkConnection(context: AgentChatOperationContext): Promise<unknown> {
    const endpoint = this.#endpoints.runtime;
    if (endpoint === false) return { disabled: true };
    const response = await this.#request(endpoint ?? "api/runtime", { method: "GET" }, context);
    if (!response.ok) throw await harnessResponseError(response);
    try { return await response.json() as unknown; } catch { return undefined; }
  }

  async loadSessions(context: AgentChatOperationContext, cursor?: string, query?: string): Promise<AgentChatSessionPage> {
    context = { ...context, operation: "sessions" };
    if (this.#endpoints.sessions === false) throw new Error("Dịch vụ chưa hỗ trợ lịch sử trò chuyện.");
    const url = new URL(await this.#endpoint(this.#endpoints.sessions ?? "api/sessions", context));
    if (cursor) url.searchParams.set("cursor", cursor);
    if (query) url.searchParams.set("q", query);
    if (context.agentProfileId) url.searchParams.set("agentProfileId", context.agentProfileId);
    const response = await this.#request(url, { method: "GET" }, context);
    if (!response.ok) throw await harnessResponseError(response);
    const payload = await response.json() as unknown;
    if (!transportRecord(payload) || !Array.isArray(payload.sessions)) throw new Error("Dữ liệu lịch sử không hợp lệ.");
    const sessions = payload.sessions.flatMap((entry): AgentChatSessionSummary[] => transportRecord(entry) &&
      typeof entry.sessionId === "string" && SESSION_PATTERN.test(entry.sessionId) && typeof entry.title === "string" && typeof entry.createdAt === "string"
      ? [{ sessionId: entry.sessionId, title: entry.title, createdAt: entry.createdAt }] : []);
    return { sessions, ...(typeof payload.nextCursor === "string" && payload.nextCursor ? { nextCursor: payload.nextCursor } : {}) };
  }
  async loadHistory(context: AgentChatOperationContext): Promise<readonly AgentChatHistoryMessage[]> {
    const endpoint = this.#endpoints.history;
    if (endpoint === false) return [];
    const response = await this.#request(endpoint ?? ((value) => `api/sessions/${encodeURIComponent(value.sessionId)}`), { method: "GET" }, context);
    if (!response.ok) throw await harnessResponseError(response);
    const payload = await response.json() as unknown;
    return harnessHistoryMessages(payload, context.sessionId);
  }

  async send(request: AgentChatTurnRequest, context: AgentChatOperationContext & AgentChatTransportEventSink & AgentChatTurnFiles): Promise<AgentChatTurnResult> {
    let body: string;
    try {
      body = harnessTurnJson(request);
    } catch (cause) {
      throw new AgentChatTransportError("Could not serialize the request to the assistant as JSON.", { code: "invalid-request", cause, transportFailure: true });
    }
    return this.#sendResumableStream(this.#endpoints.turnStream ?? "api/chat/stream", harnessTurnBody(body, context.attachmentFiles), context);
  }

  async resolveInteraction(
    request: AgentChatInteractionRequest,
    context: AgentChatOperationContext & AgentChatTransportEventSink,
  ): Promise<AgentChatTurnResult> {
    const endpoint = this.#endpoints.interactionStream;
    if (endpoint === false) throw new AgentChatTransportError("The gateway does not support resuming an interaction.", { code: "interaction-disabled", transportFailure: true });
    const body = JSON.stringify({
      kind: request.kind,
      sessionId: request.sessionId,
      requestId: request.requestId,
      ...(request.kind === "approval"
        ? { decision: request.decision }
        : { action: request.action, ...(request.content === undefined ? {} : { content: request.content }) }),
      ...(request.agentProfileId ? { agentProfileId: request.agentProfileId } : {}),
    });
    return this.#sendResumableStream(
      endpoint ?? `api/interactions/${encodeURIComponent(request.interactionId)}/stream`,
      body,
      context,
    );
  }

  async cancelTurn(context: AgentChatOperationContext): Promise<void> {
    const endpoint = this.#endpoints.cancelTurn;
    if (endpoint === false) return;
    const response = await this.#request(
      endpoint ?? "api/chat/cancel",
      { method: "POST", body: JSON.stringify({ sessionId: context.sessionId, requestId: context.requestId }) },
      context,
      { json: true },
    );
    if (!response.ok) throw await harnessResponseError(response);
  }

  async interjectTurn(request: { readonly content: string }, context: AgentChatOperationContext): Promise<boolean> {
    const endpoint = this.#endpoints.interjectTurn;
    if (endpoint === false) return false;
    const response = await this.#request(
      endpoint ?? "api/chat/interject",
      { method: "POST", body: JSON.stringify({ sessionId: context.sessionId, requestId: context.requestId, content: request.content }) },
      context,
      { json: true },
    );
    if (!response.ok) throw await harnessResponseError(response);
    // 202 means a turn took it; 200 means nothing did. Read the body rather than the status so a
    // gateway that answers 200 for both still reports the truth.
    try { return ((await response.json()) as { accepted?: unknown }).accepted === true; } catch { return false; }
  }

  async #sendResumableStream(
    endpoint: AgentChatEndpoint,
    body: string | FormData,
    context: AgentChatOperationContext & AgentChatTransportEventSink,
  ): Promise<AgentChatTurnResult> {
    const key = context.requestId;
    const resume: HarnessStreamResumeState = this.#resumes.get(key) ?? {};
    this.#resumes.set(key, resume);
    // Bounded: after `maxTotalMs` (or `maxAttempts`) the failure goes up once; the widget decides what to show.
    const startedAt = Date.now();
    try {
      for (let reconnect = 0; ; reconnect += 1) {
        try { return await this.#readStream(endpoint, body, context, resume); }
        catch (cause) {
          if (context.signal.aborted) throw context.signal.reason ?? cause;
          if (reconnect >= this.#reconnect.maxAttempts || !retryableStreamFailure(cause)) throw cause;
          const exponential = Math.min(this.#reconnect.maxDelayMs, this.#reconnect.baseDelayMs * 2 ** reconnect);
          const jittered = exponential === 0 ? 0 : Math.round(exponential * (0.75 + Math.random() * 0.5));
          const serverDelay = resume.retryDelayMs === undefined ? undefined : Math.min(this.#reconnect.maxDelayMs, Math.max(0, resume.retryDelayMs));
          const delay = serverDelay ?? jittered;
          if (this.#reconnect.maxTotalMs > 0 && Date.now() - startedAt + delay >= this.#reconnect.maxTotalMs) throw cause;
          context.onEvent({ type: "activity", activity: { id: "transport-reconnect", code: "retrying", state: "active" } });
          await waitForReconnect(delay, context.signal);
        }
      }
    } catch (failure) {
      // A failed request is kept so a resend with the same id resumes; a cancelled or final one is not.
      if (context.signal.aborted || !retryableStreamFailure(failure)) this.#resumes.delete(key);
      else if (this.#resumes.size > 32) this.#resumes.delete(this.#resumes.keys().next().value as string);
      throw failure;
    }
  }

  async #readStream(
    endpoint: AgentChatEndpoint,
    body: string | FormData,
    context: AgentChatOperationContext & AgentChatTransportEventSink,
    resume: HarnessStreamResumeState,
  ): Promise<AgentChatTurnResult> {
    const guard = new HarnessAttemptGuard(context.signal);
    try {
      return await this.#readAttempt(endpoint, body, context, resume, guard);
    } catch (cause) {
      // Our own clock ended the attempt: say so in the transport's vocabulary so it is resumed.
      if (guard.expired && !context.signal.aborted) {
        throw new AgentChatTransportError(
          guard.expired === "headers" ? "The assistant did not answer in time." : "The assistant stopped sending data.",
          { code: guard.expired === "headers" ? "request-timeout" : "stream-idle", retryable: true, transportFailure: true, cause },
        );
      }
      throw cause;
    } finally {
      guard.dispose();
    }
  }

  async #readAttempt(
    endpoint: AgentChatEndpoint,
    body: string | FormData,
    context: AgentChatOperationContext & AgentChatTransportEventSink,
    resume: HarnessStreamResumeState,
    guard: HarnessAttemptGuard,
  ): Promise<AgentChatTurnResult> {
    guard.waitForHeaders(this.#reconnect.headersTimeoutMs);
    const response = await this.#request(
      endpoint,
      { method: "POST", body, ...(resume.lastEventId ? { headers: { "last-event-id": resume.lastEventId } } : {}) },
      context,
      // A form names its own content type, boundary included; setting one here would break it.
      { json: typeof body === "string", eventStream: true, signal: guard.signal },
    );
    guard.touch(this.#reconnect.idleTimeoutMs);
    if (!response.ok) throw await harnessResponseError(response);
    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (!contentType?.includes("text/event-stream")) {
      throw new AgentChatTransportError(`The chat endpoint must return SSE; received ${contentType ?? "no Content-Type"}.`, { code: "invalid-content-type", status: response.status, transportFailure: true });
    }
    if (!response.body) throw new AgentChatTransportError("This browser does not support a streaming response.", { code: "stream-unavailable", transportFailure: true });

    // Only a resume can be answered as a fresh run; the first attempt never carries the header.
    if (this.#streamReset && response.headers.get(this.#streamReset.header) === this.#streamReset.value) {
      delete resume.lastEventId;
      context.onEvent({ type: "stream-reset" });
    }
    const reader = response.body.getReader();
    const textDecoder = new TextDecoder();
    const sseDecoder = new AgentChatSseDecoder();
    let result: AgentChatTurnResult | null = null;
    let streamError: Error | null = null;
    const consume = (frames: readonly AgentChatSseFrame[]) => {
      for (const frame of frames) {
        let decoded: AgentChatStreamProtocolResult;
        try { decoded = this.#protocol(frame, context); }
        catch (cause) {
          throw cause instanceof AgentChatTransportError ? cause : new AgentChatTransportError("Could not decode the SSE data.", { code: "invalid-sse", cause, details: frame, transportFailure: true });
        }
        const events = decoded === null ? [] : Array.isArray(decoded) ? decoded : [decoded];
        for (const event of events) {
          if (event.type === "result") result = event.result;
          else if (event.type === "error") streamError = event.error;
          else context.onEvent(event);
        }
        if (frame.id !== undefined) resume.lastEventId = frame.id;
        if (frame.retry !== undefined) resume.retryDelayMs = frame.retry;
      }
    };

    const stopped = new Promise<never>((_, reject) => {
      if (guard.signal.aborted) reject(guard.signal.reason);
      else guard.signal.addEventListener("abort", () => reject(guard.signal.reason), { once: true });
    });
    stopped.catch(() => undefined);
    let finished = false;
    try {
      while (true) {
        // A real fetch errors the body when the attempt is aborted; a stream that does not (a proxy
        // buffer, a test double) would leave this read pending forever, so the abort is raced in.
        const chunk = await Promise.race([reader.read(), stopped]);
        guard.touch(this.#reconnect.idleTimeoutMs);
        if (chunk.value) consume(sseDecoder.push(textDecoder.decode(chunk.value, { stream: !chunk.done })));
        if (result || streamError) break;
        if (chunk.done) {
          consume(sseDecoder.finish(textDecoder.decode()));
          finished = true;
          break;
        }
      }
    } finally {
      if (!finished) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (streamError) throw streamError;
    if (!result) throw new AgentChatTransportError("The runtime ended the stream without returning a result.", { code: "missing-result", retryable: true, transportFailure: true });
    return result;
  }

  async #request(
    endpoint: AgentChatEndpoint,
    init: RequestInit,
    context: AgentChatOperationContext,
    options: { readonly json?: boolean; readonly eventStream?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<Response> {
    const url = await this.#endpoint(endpoint, context);
    const httpContext: AgentChatHttpRequestContext = { ...context, url };
    const provided = typeof this.#headersProvider === "function" ? await this.#headersProvider(httpContext) : this.#headersProvider;
    const headers = new Headers(provided);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (options.json) headers.set("content-type", "application/json");
    if (options.eventStream) headers.set("accept", "text/event-stream");
    try {
      return await this.#requestExecutor(url, { ...init, headers, credentials: this.#credentials, signal: options.signal ?? context.signal }, httpContext);
    } catch (cause) {
      if (context.signal.aborted) throw cause;
      const target = new URL(url);
      const safeUrl = `${target.origin}${target.pathname}`;
      throw new AgentChatTransportError(
        `Could not reach ${safeUrl}. Check the web harness, the endpoint, CORS, and Content Security Policy.`,
        { code: "network-error", retryable: true, transportFailure: true, details: { operation: context.operation, url: safeUrl }, cause },
      );
    }
  }

  async #endpoint(endpoint: AgentChatEndpoint, context: AgentChatOperationContext): Promise<string> {
    const endpointContext: AgentChatEndpointContext = { ...context, baseUrl: this.baseUrl };
    const resolved = typeof endpoint === "function" ? await endpoint(endpointContext) : endpoint;
    const raw = String(resolved);
    const target = resolved instanceof URL
      ? new URL(resolved.href)
      : new URL(raw, raw.startsWith("/") ? new URL(this.#baseUrl).origin : this.#baseUrl);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new TypeError("Harness endpoints must use http or https");
    return target.href;
  }
}
