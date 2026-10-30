import { AgenticError, TOOL_EXECUTION_RESPONSE_PROTOCOL, attemptFailure, parseModelImages, toolNextCallReads, type HumanInteractionAction, type JsonValue, type ToolExecutionBroker, type ToolExecutionResponse, type ToolNextCall, type ToolResultSpool } from "@0xsyncroot/contracts";
import { classifyError } from "./error-classifier.js";
import type { HumanInteractionValidator } from "./human-interaction-validator.js";
import type { PreparedToolExecution, ToolExecutionResult } from "./tool-execution-coordinator.js";
import { freezeJson, withHardTimeout } from "./tool-execution-support.js";
import type { ToolInputValidator } from "./tool-input-validator.js";
import { boundToolResult } from "./tool-result-bounds.js";

/** The user's answer a resumed call runs with: the question it asked, what the user did, and the tool's own continuation. */
export interface ToolRunInteraction {
  readonly interactionId: string;
  readonly action: HumanInteractionAction;
  readonly content?: JsonValue;
  readonly continuation?: JsonValue;
}

/** What running one call needs: the broker that dispatches it, and what checks, bounds and keeps what it returns. */
export interface ToolRunDependencies {
  readonly broker: ToolExecutionBroker;
  readonly validator: ToolInputValidator;
  readonly interactionValidator: HumanInteractionValidator;
  /** Keeps the whole of a result that had to be cut, so the model can read the rest. */
  readonly spool?: ToolResultSpool;
  readonly maxToolResultChars: number;
}

/**
 * Runs one prepared, authorized call: dispatches it under its own timeout and the turn's signal, reads the broker's response
 * (a result, or a question for the user), validates the output against the tool's schema, and bounds it to the result budget.
 * Which calls may run — the ceiling, the repeat guard, authorization — is the coordinator's (`ToolExecutionCoordinator`).
 */
export async function runPreparedCall(
  execution: PreparedToolExecution, parentSignal: AbortSignal, interaction: ToolRunInteraction | undefined, dependencies: ToolRunDependencies,
): Promise<ToolExecutionResult> {
  if (parentSignal.aborted) {
    return freezeJson({
      executionId: execution.executionId, state: "cancelled", dispatched: false,
      error: { type: "tool_error", code: "cancelled", retryable: false, message: "Tool call cancelled before dispatch" },
    });
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", onAbort, { once: true });
  let dispatched = false;
  try {
    dispatched = true;
    const invocation = {
      callId: execution.call.id, sessionId: execution.context.sessionId,
      turnId: execution.context.turnId, stepId: execution.context.stepId,
      arguments: execution.arguments, security: execution.context.security,
      idempotencyKey: `tool:${execution.executionId}`,
      ...(interaction ? { interaction } : {}),
      ...(execution.context.applicationContext ? { applicationContext: execution.context.applicationContext } : {}),
    };
    const operation = dependencies.broker.dispatch({ definition: execution.definition, invocation }, controller.signal);
    const rawResponse = await withHardTimeout(operation, Math.min(execution.definition.timeoutMs, execution.context.bestEffort?.timeoutMs ?? Infinity), controller);
    const response: ToolExecutionResponse = rawResponse && typeof rawResponse === "object" && !Array.isArray(rawResponse) &&
      rawResponse.protocol === TOOL_EXECUTION_RESPONSE_PROTOCOL &&
      (rawResponse.kind === "completed" || rawResponse.kind === "interaction-required")
      ? rawResponse as ToolExecutionResponse
      : { protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "completed", result: rawResponse as JsonValue };
    if (response.kind === "interaction-required") {
      dependencies.interactionValidator.validateRequest(response.request);
      const serializedContinuation = response.continuation === undefined ? undefined : JSON.stringify(response.continuation);
      if (serializedContinuation !== undefined && serializedContinuation.length > dependencies.maxToolResultChars) {
        throw new AgenticError("budget-exceeded", `Tool continuation exceeds ${dependencies.maxToolResultChars} characters`);
      }
      return freezeJson({
        executionId: execution.executionId, state: "awaiting_interaction", dispatched,
        interaction: response.request,
        ...(serializedContinuation === undefined ? {} : { continuation: JSON.parse(serializedContinuation) as JsonValue }),
      });
    }
    const result = response.result;
    const images = parseModelImages(response.images);
    dependencies.validator.validate(execution.definition.outputSchema, result, "tool output");
    const serialized = JSON.stringify(result);
    const maxResultChars = execution.definition.maxResultChars ?? dependencies.maxToolResultChars;
    // Over budget, the largest list is cut and the cut is recorded; only a result no cut can
    // bound is refused, and then with its size and a way out, because "exceeds 12000
    // characters" alone read as a dead end and the model went on without the data.
    const bounded = boundToolResult(JSON.parse(serialized) as JsonValue, maxResultChars);
    if (JSON.stringify(bounded.value).length > maxResultChars) {
      throw new AgenticError("budget-exceeded", `Tool output exceeds ${maxResultChars} characters (${serialized.length} returned) and could not be cut under that budget. Nothing was kept; call again with a narrower scope.`);
    }
    const resultId = (bounded.marks.length > 0 || execution.definition.retainResult) && dependencies.spool
      ? dependencies.spool.put({ tenantId: execution.context.security.tenantId, sessionId: execution.context.sessionId },
          { toolId: execution.definition.id, value: JSON.parse(serialized) as JsonValue })
      : undefined;
    const marks = resultId ? bounded.marks.map((mark) => ({ ...mark, resultId })) : bounded.marks;
    // A result that says it failed already stops the step's later state-changing calls; it never also reports a halt.
    const failedResult = attemptFailure({ state: "succeeded", result: bounded.value }) !== undefined;
    const halts = response.halt === "state-changed" && !failedResult;
    // A follow-up read is named only by a result that did what was asked; a malformed one names nothing.
    const nextCall = failedResult ? undefined : wellFormedNextCall(response.nextCall);
    return freezeJson({ executionId: execution.executionId, state: "succeeded", dispatched, result: bounded.value,
      ...(images?.length ? { images } : {}), ...(halts ? { halt: "state-changed" as const } : {}), ...(nextCall ? { nextCall } : {}),
      ...(resultId ? { resultId } : {}), ...(marks.length > 0 ? { truncation: marks } : {}) });
  } catch (error) {
    const details = classifyError(error);
    const state = !dispatched
      ? (details.code === "cancelled" ? "cancelled" : "not_started")
      : (["timeout", "cancelled", "unknown-outcome"].includes(details.code) ? "outcome_unknown" : "failed");
    return freezeJson({ executionId: execution.executionId, state, dispatched, error: { type: "tool_error", ...details } });
  } finally {
    parentSignal.removeEventListener("abort", onAbort);
  }
}

/**
 * The tool's `nextCall` when it names a tool, gives its arguments as an object and says why; anything else is no hint. Its
 * `reads` is kept only as the contract types it (`toolNextCallReads`); a malformed one is dropped and the call stays.
 */
function wellFormedNextCall(next: unknown): ToolNextCall | undefined {
  if (!next || typeof next !== "object" || Array.isArray(next)) return undefined;
  const { toolId, arguments: args, why, reads } = next as Record<string, unknown>;
  if (typeof toolId !== "string" || !toolId || typeof why !== "string" || !args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const typed = toolNextCallReads(reads);
  return { toolId, arguments: args as ToolNextCall["arguments"], why, ...(typed ? { reads: typed } : {}) };
}
