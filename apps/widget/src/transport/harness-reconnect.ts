interface HarnessReconnectPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Wall-clock bound across all resumptions of one request; `0` means only `maxAttempts` bounds it. */
  readonly maxTotalMs: number;
  /** How long one attempt may wait for response headers; `0` disables. */
  readonly headersTimeoutMs: number;
  /** How long an open stream may stay silent, heartbeats included; `0` disables. */
  readonly idleTimeoutMs: number;
}

interface HarnessStreamResumeState {
  lastEventId?: string;
  retryDelayMs?: number;
}

function reconnectInteger(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

function reconnectPolicy(value: AgentChatConnectionOptions["reconnect"]): HarnessReconnectPolicy {
  if (value === false) return { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0, maxTotalMs: 0, headersTimeoutMs: 0, idleTimeoutMs: 0 };
  const maxAttempts = reconnectInteger("connection.reconnect.maxAttempts", value?.maxAttempts ?? 3, 0, 100);
  const baseDelayMs = reconnectInteger("connection.reconnect.baseDelayMs", value?.baseDelayMs ?? 250, 0, 60_000);
  const maxDelayMs = reconnectInteger("connection.reconnect.maxDelayMs", value?.maxDelayMs ?? 4_000, 0, 60_000);
  if (maxDelayMs < baseDelayMs) throw new TypeError("connection.reconnect.maxDelayMs must be at least baseDelayMs");
  const maxTotalMs = reconnectInteger("connection.reconnect.maxTotalMs", value?.maxTotalMs ?? 0, 0, 3_600_000);
  const headersTimeoutMs = reconnectInteger("connection.reconnect.headersTimeoutMs", value?.headersTimeoutMs ?? 30_000, 0, 600_000);
  const idleTimeoutMs = reconnectInteger("connection.reconnect.idleTimeoutMs", value?.idleTimeoutMs ?? 45_000, 0, 3_600_000);
  return { maxAttempts, baseDelayMs, maxDelayMs, maxTotalMs, headersTimeoutMs, idleTimeoutMs };
}

function retryableStreamFailure(cause: unknown): boolean {
  if (cause instanceof AgentChatTransportError) return cause.retryable === true;
  const name = cause && typeof cause === "object" && "name" in cause ? String((cause as { name: unknown }).name) : "";
  return name === "TypeError" || name === "NetworkError";
}

async function waitForReconnect(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { globalThis.clearTimeout(timer); reject(signal.reason); };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
