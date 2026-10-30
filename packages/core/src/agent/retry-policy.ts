import { setTimeout as delay } from "node:timers/promises";
import type { ClassifiedError } from "./error-classifier.js";

export class ExponentialRetryPolicy {
  constructor(readonly maxAttempts: number, private readonly baseDelayMs: number) {}
  shouldRetry(error: ClassifiedError, attempt: number): boolean { return error.retryable && attempt < this.maxAttempts; }
  async wait(attempt: number, signal: AbortSignal): Promise<void> {
    await delay(this.baseDelayMs * 2 ** (attempt - 1), undefined, { signal });
  }
}
