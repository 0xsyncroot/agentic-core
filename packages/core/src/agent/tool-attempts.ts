import { attemptFailure, attemptSignature, type JsonValue, type ToolAttempt, type ToolCall } from "@0xsyncroot/contracts";

/**
 * Counts failed calls per target in a turn and says, beside the result, when to stop repeating.
 *
 * Escalates the way open agent harnesses that keep agents at a task do (OpenHands reminds at the third
 * identical error before declaring the run stuck; Codex's goal loop calls a step blocked only after three
 * rounds on the same blocker): the second failure asks to do what the refusal says, the third lists what
 * already failed, the fifth says to stop retrying unchanged and name the blocker. A success clears the count.
 */
export class ToolAttemptLedger {
  readonly #failures = new Map<string, number>();
  readonly #reasons = new Map<string, string>();

  record(call: ToolCall, outcome: { readonly state: string; readonly result?: JsonValue; readonly error?: JsonValue }): { readonly attempt: ToolAttempt; readonly note?: string } {
    const signature = attemptSignature(call.name, call.arguments);
    const failure = attemptFailure(outcome);
    if (!failure) {
      this.#failures.delete(signature);
      this.#reasons.delete(signature);
      return { attempt: { signature, failures: 0 } };
    }
    const failures = (this.#failures.get(signature) ?? 0) + 1;
    this.#failures.set(signature, failures);
    this.#reasons.set(signature, failure);
    // Never "use another tool": the runtime cannot know which tool the task's procedure names, and that wording takes the
    // model off the procedure. A refusal says what to fix; that is the way on.
    const note = failures === 2
      ? `Runtime check: this call has now failed twice (${failure}). Repeated unchanged it will fail again: do what the refusal says to fix, and read the current state again if it may have changed.`
      : failures === 3
        ? `Runtime check: third failure on this call (${failure}). Failed in this turn: ${this.#tried()}. Fix what the refusals name; when the same refusal returns whatever you change, the input you are passing is the problem — read it again.`
        : failures >= 5
          ? `Runtime check: ${failures} failures on this call (${failure}); stop retrying it unchanged. Unless a refusal names a fix you have not tried, say exactly what blocks it and which attempts failed.`
          : undefined;
    return { attempt: { signature, failure, failures }, ...(note ? { note } : {}) };
  }

  #tried(): string {
    return [...this.#failures.entries()].slice(-5).map(([signature, count]) => `${signature.slice(0, 120)} → ${this.#reasons.get(signature)} ×${count}`).join("; ");
  }
}
