import { AgenticError, TOOL_EXECUTION_RESPONSE_PROTOCOL, type CapabilityUnavailableReason, type HumanInteractionAction, type HumanInteractionRequest, type JsonValue, type RuntimeSnapshot, type SecurityContext, type ToolAuthorizationInteraction, type TurnApplicationContext, type ToolCall, type ToolDefinition, type ToolExecutionBroker, type ToolExecutionPolicy, type ToolExecutionResponse, type ToolExecutionState, type ToolPolicyDecision, type ToolResultSpool } from "@0xsyncroot/contracts";
import { sha256 } from "../../../src/hash.js";
import type { AgentRuntimeOptions } from "../../../src/agent/agent-options.js";
import { classifyError } from "./error-classifier.js";
import { JsonSchemaToolInputValidator, type ToolInputValidator } from "../../../src/agent/tool-input-validator.js";
import { PermissionToolExecutionPolicy } from "../../../src/security/permission-tool-execution-policy.js";
import { InProcessToolExecutionBroker } from "../../../src/tools/in-process-tool-broker.js";
import { HumanInteractionValidator } from "../../../src/agent/human-interaction-validator.js";
import { bindApprovalPresentation } from "../../../src/agent/approval-presentation.js";
import { settleCover, type ApprovalCoverLookup } from "../../../src/agent/approval-cover.js";
import { settleStanding, type StandingApprovalLookup } from "../../../src/agent/standing-approval.js";
import { boundToolResult, type TruncationMark } from "../../../src/agent/tool-result-bounds.js";
import { CallRepeats, repeatedCallMessage, toolCallFingerprint } from "../../../src/agent/tool-call-fingerprint.js";
import { parseModelImages, type ModelImage } from "@0xsyncroot/contracts";
import { errorCode, freezeJson, parseArguments, validateToolArguments, withHardTimeout } from "../../../src/agent/tool-execution-support.js";

export interface ToolExecutionContext {
  readonly sessionId: string; readonly turnId: string; readonly stepId: string; readonly security: SecurityContext; readonly runtime: RuntimeSnapshot;
  readonly executionIdOverride?: string;
  readonly applicationContext?: TurnApplicationContext;
}
export interface ToolExecutionResult {
  readonly executionId: string;
  readonly state: Extract<ToolExecutionState, "awaiting_interaction" | "denied" | "succeeded" | "failed" | "cancelled" | "not_started" | "outcome_unknown">;
  readonly dispatched: boolean;
  readonly result?: JsonValue;
  readonly images?: readonly ModelImage[];
  readonly resultId?: string;
  readonly error?: JsonValue;
  readonly truncation?: readonly TruncationMark[];
  readonly policyDecision?: ToolPolicyDecision;
  readonly interaction?: HumanInteractionRequest;
  readonly continuation?: JsonValue;
  readonly unavailable?: CapabilityUnavailableReason;
}
export interface PreparedToolExecution {
  readonly call: ToolCall;
  readonly context: ToolExecutionContext;
  readonly definition: ToolDefinition;
  readonly executionId: string;
  readonly arguments: JsonValue;
  readonly policyDecision: ToolPolicyDecision;
}
export type ToolPreparation =
  | { readonly kind: "ready"; readonly execution: PreparedToolExecution }
  | { readonly kind: "approval"; readonly execution: PreparedToolExecution }
  | { readonly kind: "terminal"; readonly outcome: ToolExecutionResult };

export class ToolExecutionCoordinator {
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #repeats = new CallRepeats();
  readonly #unofferedRepeats = new CallRepeats();
  readonly #seenCallIds = new Set<string>();
  #toolCallCount = 0;
  #ceiling: number;

  constructor(
    tools: readonly ToolDefinition[],
    private readonly options: AgentRuntimeOptions,
    private readonly policy: ToolExecutionPolicy = new PermissionToolExecutionPolicy(),
    private readonly broker: ToolExecutionBroker = new InProcessToolExecutionBroker(),
    private readonly validator: ToolInputValidator = new JsonSchemaToolInputValidator(),
    private readonly interactionValidator = new HumanInteractionValidator(),
    private readonly spool?: ToolResultSpool,
    private readonly isPlanningCall: (name: string) => boolean = () => false,
    private readonly approvals: { readonly approvalCover?: ApprovalCoverLookup; readonly standingApproval?: StandingApprovalLookup } = {},
  ) {
    this.#ceiling = options.maxToolCalls;
    for (const tool of tools) {
      if (this.#tools.has(tool.id)) throw new AgenticError("conflict", `Duplicate tool ID: ${tool.id}`);
      this.validator.validateSchema(tool.inputSchema);
      if (tool.modelInputSchema !== undefined) this.validator.validateSchema(tool.modelInputSchema);
      this.validator.validateSchema(tool.outputSchema);
      if (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs <= 0) throw new AgenticError("validation", `Invalid timeout for tool: ${tool.id}`);
      if (tool.maxResultChars !== undefined && (!Number.isInteger(tool.maxResultChars) || tool.maxResultChars <= 0)) {
        throw new AgenticError("validation", `Invalid result budget for tool: ${tool.id}`);
      }
      this.#tools.set(tool.id, tool);
    }
  }

  definition(call: ToolCall): ToolDefinition | undefined { return this.#tools.get(call.name); }

  get budgetExhausted(): boolean { return this.#toolCallCount >= this.#ceiling; }

  extendToolCalls(by: number, hardMax: number): boolean { return this.#ceiling < hardMax && (this.#ceiling = Math.min(hardMax, this.#ceiling + by)) > 0; }

  executionId(call: ToolCall, context: ToolExecutionContext): string {
    return context.executionIdOverride ?? sha256({ sessionId: context.sessionId, turnId: context.turnId, stepId: context.stepId, callId: call.id, toolId: call.name });
  }

  async prepare(call: ToolCall, context: ToolExecutionContext, interaction?: ToolAuthorizationInteraction): Promise<ToolPreparation> {
    const fingerprint = toolCallFingerprint(call.name, call.arguments);
    const repeated = this.#repeats.next(fingerprint);
    const asks = this.definition(call)?.asksUser === true;
    if (!asks) this.#toolCallCount += 1;
    try {
      const preparation = await this.#authorize(call, context, interaction, true, () => {
        if (this.#seenCallIds.has(call.id)) throw new AgenticError("cycle-detected", `Duplicate tool call ID: ${call.id}`);
        if (!asks && this.#toolCallCount > this.#ceiling) throw new AgenticError("budget-exceeded", `Tool-call budget ${this.#ceiling} exceeded`);
        if (repeated > this.options.maxRepeatedToolCalls && !this.isPlanningCall(call.name)) {
          throw new AgenticError("cycle-detected", repeatedCallMessage(call.name, repeated - 1, this.#repeats.lastResult(fingerprint)));
        }
      });
      if (preparation.kind === "terminal" && !["cycle-detected", "budget-exceeded"].includes(errorCode(preparation.outcome))) this.#remember(call, preparation.outcome);
      return preparation;
    } finally {
      this.#seenCallIds.add(call.id);
    }
  }

  #remember(call: ToolCall, outcome: ToolExecutionResult): void { this.#repeats.settle(toolCallFingerprint(call.name, call.arguments), outcome); }

  refuseUnoffered(call: ToolCall, refusal: ToolExecutionResult): ToolExecutionResult {
    const fingerprint = toolCallFingerprint(call.name, call.arguments);
    const repeated = this.#unofferedRepeats.next(fingerprint);
    this.#toolCallCount += 1;
    try {
      if (this.#seenCallIds.has(call.id)) throw new AgenticError("cycle-detected", `Duplicate tool call ID: ${call.id}`);
      if (this.#toolCallCount > this.#ceiling) throw new AgenticError("budget-exceeded", `Tool-call budget ${this.#ceiling} exceeded`);
      if (repeated > this.options.maxRepeatedToolCalls) {
        throw new AgenticError("cycle-detected", repeatedCallMessage(call.name, repeated - 1, this.#unofferedRepeats.lastResult(fingerprint)));
      }
      this.#unofferedRepeats.settle(fingerprint, refusal);
      return freezeJson({ ...refusal });
    } catch (error) {
      return freezeJson({ ...refusal, error: { type: "tool_error", ...classifyError(error) } });
    } finally {
      this.#seenCallIds.add(call.id);
    }
  }

  async prepareResumed(call: ToolCall, context: ToolExecutionContext, interaction?: ToolAuthorizationInteraction): Promise<ToolPreparation> {
    return this.#authorize(call, context, interaction, false, () => undefined);
  }

  async #authorize(
    call: ToolCall, context: ToolExecutionContext, interaction: ToolAuthorizationInteraction | undefined, fresh: boolean, guard: () => void,
  ): Promise<ToolPreparation> {
    const executionId = this.executionId(call, context);
    let policyDecision: ToolPolicyDecision | undefined;
    try {
      guard();
      const tool = this.#tools.get(call.name);
      if (!tool) throw new AgenticError("validation", `Unknown tool: ${call.name}`);
      const args = parseArguments(call.arguments);
      this.validator.validate(tool.inputSchema, args, "tool input");
      await validateToolArguments(tool, args, context.security);
      const authorizationInput = {
        ...context, callId: call.id, executionId, tool, arguments: args,
        ...(interaction ? { interaction } : {}),
      };
      policyDecision = bindApprovalPresentation(await this.policy.authorize(authorizationInput));
      const coverable = fresh && !interaction && policyDecision.outcome === "require_approval" && policyDecision.coverable !== false
        && tool.repeatableRows !== undefined && !tool.asksUser && !tool.origin;
      policyDecision = settleCover(policyDecision, coverable ? await this.approvals.approvalCover?.(tool, args, policyDecision) : undefined);
      const standable = fresh && !interaction && policyDecision.outcome === "require_approval" && !tool.asksUser;
      policyDecision = settleStanding(policyDecision, standable ? await this.approvals.standingApproval?.(tool, policyDecision) : undefined);
      if (policyDecision.outcome === "deny") throw new AgenticError("denied", policyDecision.reason);
      const execution = { call, context, definition: tool, executionId, arguments: args, policyDecision };
      if (policyDecision.outcome === "require_approval") return freezeJson({ kind: "approval", execution });
      return freezeJson({ kind: "ready", execution });
    } catch (error) {
      const details = classifyError(error);
      const state = details.code === "denied" || details.code === "approval-required" ? "denied" : "not_started";
      return freezeJson({ kind: "terminal", outcome: {
        executionId, state, dispatched: false, error: { type: "tool_error", ...details },
        ...(policyDecision ? { policyDecision } : {}),
      } });
    }
  }

  async run(
    execution: PreparedToolExecution,
    parentSignal: AbortSignal,
    interaction?: { readonly interactionId: string; readonly action: HumanInteractionAction; readonly content?: JsonValue; readonly continuation?: JsonValue },
  ): Promise<ToolExecutionResult> {
    const outcome = await this.#run(execution, parentSignal, interaction);
    this.#remember(execution.call, outcome);
    return outcome;
  }

  async #run(
    execution: PreparedToolExecution,
    parentSignal: AbortSignal,
    interaction?: { readonly interactionId: string; readonly action: HumanInteractionAction; readonly content?: JsonValue; readonly continuation?: JsonValue },
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
      const operation = this.broker.dispatch({ definition: execution.definition, invocation }, controller.signal);
      const rawResponse = await withHardTimeout(operation, execution.definition.timeoutMs, controller);
      const response: ToolExecutionResponse = rawResponse && typeof rawResponse === "object" && !Array.isArray(rawResponse) &&
        rawResponse.protocol === TOOL_EXECUTION_RESPONSE_PROTOCOL &&
        (rawResponse.kind === "completed" || rawResponse.kind === "interaction-required")
        ? rawResponse as ToolExecutionResponse
        : { protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "completed", result: rawResponse as JsonValue };
      if (response.kind === "interaction-required") {
        this.interactionValidator.validateRequest(response.request);
        const serializedContinuation = response.continuation === undefined ? undefined : JSON.stringify(response.continuation);
        if (serializedContinuation !== undefined && serializedContinuation.length > this.options.maxToolResultChars) {
          throw new AgenticError("budget-exceeded", `Tool continuation exceeds ${this.options.maxToolResultChars} characters`);
        }
        return freezeJson({
          executionId: execution.executionId, state: "awaiting_interaction", dispatched,
          interaction: response.request,
          ...(serializedContinuation === undefined ? {} : { continuation: JSON.parse(serializedContinuation) as JsonValue }),
        });
      }
      const result = response.result;
      const images = parseModelImages(response.images);
      this.validator.validate(execution.definition.outputSchema, result, "tool output");
      const serialized = JSON.stringify(result);
      const maxResultChars = execution.definition.maxResultChars ?? this.options.maxToolResultChars;
      const bounded = boundToolResult(JSON.parse(serialized) as JsonValue, maxResultChars);
      if (JSON.stringify(bounded.value).length > maxResultChars) {
        throw new AgenticError("budget-exceeded", `Tool output exceeds ${maxResultChars} characters (${serialized.length} returned) and could not be cut under that budget. Nothing was kept; call again with a narrower scope.`);
      }
      const resultId = (bounded.marks.length > 0 || execution.definition.retainResult) && this.spool
        ? this.spool.put({ tenantId: execution.context.security.tenantId, sessionId: execution.context.sessionId },
            { toolId: execution.definition.id, value: JSON.parse(serialized) as JsonValue })
        : undefined;
      const marks = resultId ? bounded.marks.map((mark) => ({ ...mark, resultId })) : bounded.marks;
      return freezeJson({ executionId: execution.executionId, state: "succeeded", dispatched, result: bounded.value,
        ...(images?.length ? { images } : {}),
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

  async execute(call: ToolCall, context: ToolExecutionContext, parentSignal: AbortSignal): Promise<ToolExecutionResult> {
    const preparation = await this.prepare(call, context);
    if (preparation.kind === "terminal") return preparation.outcome;
    if (preparation.kind === "approval") {
      return freezeJson({
        executionId: preparation.execution.executionId, state: "denied", dispatched: false,
        policyDecision: preparation.execution.policyDecision,
        error: { type: "tool_error", code: "approval-required", retryable: false, message: preparation.execution.policyDecision.reason },
      });
    }
    return this.run(preparation.execution, parentSignal);
  }
}
