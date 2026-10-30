import type { JsonValue } from "@0xsyncroot/contracts";
import { canonicalJson, sha256 } from "../hash.js";
import { toJsonValue } from "./json-value.js";
import { toolResultContent } from "./tool-result-bounds.js";
import type { ToolExecutionResult } from "./tool-execution-coordinator.js";

/** How much of a repeated call's last result the block quotes back to the model. */
const EXCERPT_CHARS = 300;

/**
 * What makes two calls the same call: the tool and the value of its arguments.
 *
 * The arguments are compared as parsed JSON in canonical form, so key order and whitespace — which
 * a model varies freely between attempts — do not hide a repeat. Text that is not JSON has no value
 * to compare and stands as written.
 */
export function toolCallFingerprint(name: string, rawArguments: string): string {
  let canonical = rawArguments;
  try { canonical = canonicalJson(JSON.parse(rawArguments) as JsonValue); } catch { /* not JSON: the raw text is its identity */ }
  return sha256({ name, arguments: canonical });
}

/**
 * The beginning of what the model was shown for a call's outcome, in the form the next step reads it.
 *
 * Undefined when the outcome carries nothing to show (a call that paused for a person's answer).
 */
export function toolResultExcerpt(outcome: ToolExecutionResult): string | undefined {
  if (outcome.result === undefined && outcome.error === undefined) return undefined;
  const text = toolResultContent({
    ...(outcome.result !== undefined ? { result: outcome.result } : {}), ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    ...(outcome.truncation ? { truncated: toJsonValue(outcome.truncation) } : {}),
    ...(outcome.resultId ? { resultId: outcome.resultId } : {}),
  });
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text;
}

/**
 * The refusal of a call the turn already made `times` times.
 *
 * It quotes the result those calls got, so the model sees what it keeps asking for the answer to
 * rather than only that it is being stopped. The quote goes to the model as a tool result — never
 * into an instruction, where tool data does not belong.
 */
export function repeatedCallMessage(name: string, times: number, lastResult: string | undefined): string {
  const quote = lastResult === undefined ? "" : ` Its last result: «${lastResult}».`;
  return `Repeated tool call blocked: ${name} was already called ${times} times with these exact arguments.${quote} Change what that result names and call again.`;
}

/**
 * How often the turn made each call, and what the last one returned.
 *
 * A repeat whose result changed is not a loop: reading the screen again after it changed returns a new observation, and
 * refusing it leaves the agent acting on stale references. Only repeats that keep getting the same result count toward
 * the limit.
 */
export class CallRepeats {
  readonly #counts = new Map<string, number>();
  readonly #excerpts = new Map<string, string>();
  readonly #digests = new Map<string, string>();

  /** Counts one more call of `fingerprint` and returns how many there have been. */
  next(fingerprint: string): number {
    const count = (this.#counts.get(fingerprint) ?? 0) + 1;
    this.#counts.set(fingerprint, count);
    return count;
  }

  lastResult(fingerprint: string): string | undefined { return this.#excerpts.get(fingerprint); }

  /** Records what a call returned; a result unlike the last one starts the count again. */
  settle(fingerprint: string, outcome: ToolExecutionResult): void {
    const excerpt = toolResultExcerpt(outcome);
    if (excerpt !== undefined) this.#excerpts.set(fingerprint, excerpt);
    const digest = sha256({ content: toolResultContent({
      ...(outcome.result !== undefined ? { result: outcome.result } : {}), ...(outcome.error !== undefined ? { error: outcome.error } : {}) }) });
    const previous = this.#digests.get(fingerprint);
    if (previous !== undefined && previous !== digest) this.#counts.set(fingerprint, 1);
    this.#digests.set(fingerprint, digest);
  }
}
