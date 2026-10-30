import { AgenticError, type BestEffortRead, type CapabilityUnavailableReason, type HumanInteractionRequest, type JsonValue, type ModelImage, type RuntimeSnapshot, type SecurityContext, type ToolAuthorizationInteraction, type TurnApplicationContext, type ToolCall, type ToolDefinition, type ToolExecutionBroker, type ToolExecutionPolicy, type ToolExecutionState, type ToolNextCall, type ToolPolicyDecision, type ToolResultSpool } from "@0xsyncroot/contracts";
import { sha256 } from "../hash.js";
import type { AgentRuntimeOptions } from "./agent-options.js";
import { classifyError } from "./error-classifier.js";
import { JsonSchemaToolInputValidator, type ToolInputValidator } from "./tool-input-validator.js";
import { PermissionToolExecutionPolicy } from "../security/permission-tool-execution-policy.js";
import { InProcessToolExecutionBroker } from "../tools/in-process-tool-broker.js";
import { HumanInteractionValidator } from "./human-interaction-validator.js";
import { bindApprovalPresentation } from "./approval-presentation.js";
import { settleCover, type ApprovalCoverLookup } from "./approval-cover.js";
import { settleStanding, type StandingApprovalLookup } from "./standing-approval.js";
import type { TruncationMark } from "./tool-result-bounds.js";
import { CallRepeats, repeatedCallMessage, toolCallFingerprint } from "./tool-call-fingerprint.js";
import { errorCode, freezeJson, parseArguments, validateToolArguments } from "./tool-execution-support.js";
import { runPreparedCall, type ToolRunInteraction } from "./tool-call-run.js";

export interface ToolExecutionContext {
  readonly sessionId: string; readonly turnId: string; readonly stepId: string; readonly security: SecurityContext; readonly runtime: RuntimeSnapshot;
  readonly executionIdOverride?: string;
  /** The turn's host context, handed to the tool with the call (`ToolInvocation.applicationContext`). */
  readonly applicationContext?: TurnApplicationContext;
  /** A policy's best-effort read: it runs no longer than this, and a result that is not a success is never shown to the model. */
  readonly bestEffort?: BestEffortRead;
}
export interface ToolExecutionResult {
  readonly executionId: string;
  readonly state: Extract<ToolExecutionState, "awaiting_interaction" | "denied" | "succeeded" | "failed" | "cancelled" | "not_started" | "outcome_unknown">;
  readonly dispatched: boolean;
  readonly result?: JsonValue;
  readonly images?: readonly ModelImage[];
  readonly resultId?: string;
  readonly error?: JsonValue;
  /** Lists shortened to fit the result budget; the model and the journal are both told. */
  readonly truncation?: readonly TruncationMark[];
  /** The call succeeded and changed the scope the step's later calls were chosen against (`ToolCompletedResponse.halt`). */
  readonly halt?: "state-changed";
  /** The read the tool says this result calls for next (`ToolCompletedResponse.nextCall`). */
  readonly nextCall?: ToolNextCall;
  readonly policyDecision?: ToolPolicyDecision;
  readonly interaction?: HumanInteractionRequest;
  readonly continuation?: JsonValue;
  /** The capability itself is missing this turn (`CapabilityUnavailableReason`): journaled with the refusal, final for the turn. */
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
  /** Repeats of calls the step was not offered, apart: refusing a write twice must not block it once it is offered. */
  readonly #unofferedRepeats = new CallRepeats();
  readonly #seenCallIds = new Set<string>();
  #toolCallCount = 0;
  #wrote = false;

  constructor(
    tools: readonly ToolDefinition[],
    private readonly options: AgentRuntimeOptions,
    private readonly policy: ToolExecutionPolicy = new PermissionToolExecutionPolicy(),
    private readonly broker: ToolExecutionBroker = new InProcessToolExecutionBroker(),
    private readonly validator: ToolInputValidator = new JsonSchemaToolInputValidator(),
    private readonly interactionValidator = new HumanInteractionValidator(),
    /** Keeps the whole of a result that had to be cut, so the model can read the rest. */
    private readonly spool?: ToolResultSpool,
    private readonly isPlanningCall: (name: string) => boolean = () => false, // restating a plan is no repeat (as in Codex)
    /** What answers a new call's card without asking (approval-cover, then the actor's standing approval); never a resumed call's. */
    private readonly approvals: { readonly approvalCover?: ApprovalCoverLookup; readonly standingApproval?: StandingApprovalLookup } = {},
  ) {
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

  /** The turn's tool-call ceiling is one fixed number (`maxToolCalls`): a turn reaching it stops, progressing or not. */
  get budgetExhausted(): boolean { return this.#toolCallCount >= this.options.maxToolCalls; }
  /** Calls counted against the tool-call ceiling so far: every call but one that asks the user, offered or not. */
  get toolCalls(): number { return this.#toolCallCount; }
  /** A call whose tool declares a side effect ran and succeeded under this coordinator: a write that happened. */
  get wrote(): boolean { return this.#wrote; }

  executionId(call: ToolCall, context: ToolExecutionContext): string {
    return context.executionIdOverride ?? sha256({ sessionId: context.sessionId, turnId: context.turnId, stepId: context.stepId, callId: call.id, toolId: call.name });
  }

  async prepare(call: ToolCall, context: ToolExecutionContext, interaction?: ToolAuthorizationInteraction): Promise<ToolPreparation> {
    const fingerprint = toolCallFingerprint(call.name, call.arguments);
    const repeated = this.#repeats.next(fingerprint);
    // Asking the user is not work: it never counts against the tool-call ceiling, so a question can always be a form.
    const asks = this.definition(call)?.asksUser === true;
    if (!asks) this.#toolCallCount += 1;
    try {
      const preparation = await this.#authorize(call, context, interaction, true, () => {
        if (this.#seenCallIds.has(call.id)) throw new AgenticError("cycle-detected", `Duplicate tool call ID: ${call.id}`);
        if (!asks && this.#toolCallCount > this.options.maxToolCalls) throw new AgenticError("budget-exceeded", `Tool-call budget ${this.options.maxToolCalls} exceeded`);
        if (repeated > this.options.maxRepeatedToolCalls && !this.isPlanningCall(call.name)) {
          throw new AgenticError("cycle-detected", repeatedCallMessage(call.name, repeated - 1, this.#repeats.lastResult(fingerprint)));
        }
      });
      // A refusal the guard itself wrote is not what the call returned: quoting it back would bury the real result.
      if (preparation.kind === "terminal" && !["cycle-detected", "budget-exceeded"].includes(errorCode(preparation.outcome))) this.#remember(call, preparation.outcome);
      return preparation;
    } finally {
      this.#seenCallIds.add(call.id);
    }
  }

  #remember(call: ToolCall, outcome: ToolExecutionResult): void { this.#repeats.settle(toolCallFingerprint(call.name, call.arguments), outcome); }

  /**
   * Counts a call the step was not offered and answers it with `refusal`; nothing is prepared or run.
   *
   * Outside the tool-call ceiling and the repeat guard, a step holding only such calls is refunded, and
   * a model that keeps calling a tool the turn does not have runs on to the step ceiling. Counted like
   * any call, they meet the same ceiling and a
   * repeat guard of their own; when one trips its refusal is the guard's, and the missing-capability
   * marker still rides along. Their repeats are kept apart from real calls': shared, a write refused
   * twice while a policy held writes back would be blocked as a repeat on the step it is offered again.
   */
  refuseUnoffered(call: ToolCall, refusal: ToolExecutionResult): ToolExecutionResult {
    const fingerprint = toolCallFingerprint(call.name, call.arguments);
    const repeated = this.#unofferedRepeats.next(fingerprint);
    this.#toolCallCount += 1;
    try {
      if (this.#seenCallIds.has(call.id)) throw new AgenticError("cycle-detected", `Duplicate tool call ID: ${call.id}`);
      if (this.#toolCallCount > this.options.maxToolCalls) throw new AgenticError("budget-exceeded", `Tool-call budget ${this.options.maxToolCalls} exceeded`);
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

  /**
   * Prepares a call a user has just resumed: the approved write, or the tool a question belongs to.
   *
   * It is re-validated and re-authorized exactly like a fresh call, but it is not a new call of this
   * turn: the turn that proposed it counted it against the call budget and the repetition guard, and
   * its id belongs to that turn's calls — providers reuse ids across turns, and the model may send
   * the same id again here without repeating anything.
   */
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
      const standable = fresh && !interaction && policyDecision.outcome === "require_approval" && policyDecision.standable !== false && !tool.asksUser;
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

  async run(execution: PreparedToolExecution, parentSignal: AbortSignal, interaction?: ToolRunInteraction): Promise<ToolExecutionResult> {
    const outcome = await runPreparedCall(execution, parentSignal, interaction, {
      broker: this.broker, validator: this.validator, interactionValidator: this.interactionValidator,
      maxToolResultChars: this.options.maxToolResultChars, ...(this.spool ? { spool: this.spool } : {}),
    });
    this.#remember(execution.call, outcome);
    if (outcome.dispatched && outcome.state === "succeeded" && execution.definition.sideEffect !== "none") this.#wrote = true;
    return outcome;
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
