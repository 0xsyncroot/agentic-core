import { attemptFailure, type EventDraft, type JsonValue, type ToolCall, type ToolDefinition } from "@0xsyncroot/contracts";
import type { ToolBatchContext } from "./tool-call-drafts.js";
import { toolResultContent } from "./tool-result-bounds.js";

/**
 * Stops a step's state-changing calls at its first work call that does not succeed.
 *
 * A model sends several calls in one step when it knows all their arguments now; each later call assumes the earlier ones
 * went through. "Does not succeed" is `attemptFailure`: an error, a refusal, or a result that says so itself (a click the
 * screen rejected comes back as a result with status "rejected", not as an error). After that, a later call that changes
 * state, or asks the user, would act on a state that did not happen: the next click lands on a screen nobody planned for,
 * and a question hands the user a step that never ran. Those calls are not started. A call whose tool reads only still runs,
 * since what it shows helps the model decide again. A call that could not run anyway (a tool the runtime does not know, or
 * one the step was not offered) keeps its own refusal, which says why.
 *
 * A call that succeeded but says it changed the scope the later calls were chosen against (`halt` "state-changed": another
 * page, a dialog opened or closed) stops them the same way: they were aimed at a scope that is gone. Its reads still run.
 *
 * The stop is decided before the call is prepared: no policy decision, no approval card, no charge against the tool-call
 * ceiling or the repeat guard, no attempt recorded. The step is accounted by the calls that ran, so a refused call with the
 * calls it stopped behind it is refunded like that refusal alone. A runtime policy's own reads are not stopped.
 */
export class StepFailureStop {
  #stopped?: { readonly toolId: string; readonly order: number; readonly halted: boolean };

  /** `calls`: the step's calls as the model sent them, the order its message counts in. */
  constructor(private readonly calls: readonly ToolCall[]) {}

  /** Notes a work call's outcome; the first that did not succeed, or that halted, is the one later calls stop behind. */
  observe(call: ToolCall, outcome: { readonly state: string; readonly result?: JsonValue; readonly error?: JsonValue; readonly halt?: "state-changed" }): void {
    if (this.#stopped) return;
    const failed = attemptFailure(outcome) !== undefined;
    if (!failed && outcome.halt !== "state-changed") return;
    this.#stopped = { toolId: call.name, order: this.calls.indexOf(call) + 1, halted: !failed };
  }

  /** A work call failed or halted earlier in the step, and this tool changes state or asks the user. */
  stops(definition: ToolDefinition | undefined): boolean {
    return this.#stopped !== undefined && definition !== undefined && (definition.sideEffect !== "none" || definition.asksUser === true);
  }

  /** The result of a call `stops` held back: journaled like any call that was not started, and what the model reads. */
  notStarted(call: ToolCall, context: ToolBatchContext, executionId: string): { readonly draft: EventDraft; readonly content: string } {
    const stopped = this.#stopped!;
    const cause = stopped.halted
      ? "succeeded and changed the scope this call was chosen for (another page, or a dialog opened or closed)"
      : "did not succeed";
    const error = {
      type: "tool_error", code: "not-started", retryable: true,
      message: `Not run: ${stopped.toolId} (call ${stopped.order} of this step, in your order) ${cause} before it. Decide again from its result.`,
    };
    return {
      draft: {
        type: "tool/result", turnId: context.turnId, stepId: context.stepId, callId: call.id,
        payload: { callId: call.id, executionId, toolId: call.name, state: "not_started", dispatched: false, error },
      },
      content: toolResultContent({ error }),
    };
  }
}
