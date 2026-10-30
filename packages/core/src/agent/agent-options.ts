import type { JudgmentSeamModes } from "./observation-review.js";
import type { AgentTelemetrySink, ContextCompactionPolicy, ConversationCompactor, MemoryContextPolicy, StandingApprovalSource, ToolExecutionBroker, ToolExecutionPolicy, ToolGroupCatalog, ToolResultSpool, TurnAdmissionController, TurnContextProvider, TurnControlPolicy } from "@0xsyncroot/contracts";
import type { ModelInstructions } from "./context-budget-text.js";
import type { ContinueQuestionWording } from "./runtime-question.js";

export interface AgentRuntimeOptions {
  /** Hard step ceiling: the progress-based allowance grows up to it, never past it. */
  readonly maxSteps: number;
  /** Steps granted before any progress is observed. Clamped to `maxSteps`. */
  readonly initialStepBudget: number;
  /** Steps re-granted whenever a step produced an observation the turn had not seen. */
  readonly stepBudgetExtension: number;
  readonly maxLlmAttempts: number;
  readonly retryBaseDelayMs: number;
  /** Hard tool-call ceiling: one fixed number, whether or not the turn still progresses. Asking the user is not counted. */
  readonly maxToolCalls: number;
  readonly maxRepeatedToolCalls: number;
  /**
   * Rounds of reads a turn-control policy may make before one model call. After each round the
   * policy is asked again and, while it names reads this step has not made, they run too — so a
   * policy paging through a source hands the model the whole of it, not a page per step. One round
   * asks once: the reads run and the model is called.
   */
  readonly maxObservationRounds: number;
  readonly maxToolResultChars: number;
  readonly maxContextChars: number;
  readonly maxInputChars: number;
  /** Silence after which the watch ends the turn partial (`time-limit`): no step and no tool call for this long. It never makes a step final. */
  readonly turnTimeoutMs: number;
  readonly llmAttemptTimeoutMs: number;
  /**
   * Silence after which a model call is made once more, identically, and the first of the two to yield is used (see
   * AttemptRace). Only for an adapter whose stream shows progress (`features.progressStreaming`). 0 turns it off; a value
   * not below `llmAttemptTimeoutMs` never fires.
   */
  readonly llmHedgeAfterMs: number;
  /**
   * Text one model attempt may stream. An attempt whose text loops, or runs past this, is cut and the step generated again
   * (AnswerBound): a provider without an output ceiling otherwise lets a degenerate generation run to its own token limit.
   */
  readonly maxAnswerChars: number;
  /**
   * How long a turn's open waits for the memory search (connect, queue and query). Memory is advisory context: past this the
   * turn goes on without it and journals `memory/context-unavailable`. The store takes no signal, so an abandoned search runs on.
   */
  readonly memoryContextTimeoutMs: number;
  /**
   * How long a turn's open waits for the advisory judgments that only trim what the turn is offered (skill relevance, tool
   * relevance). Past it the turn goes on without them, every skill and tool group offered, and the abandoned judgment runs
   * to its own deadline in the background. The deciding skill suggestion is not bounded by it.
   */
  readonly advisorySetupBudgetMs: number;
  readonly leaseTtlMs: number;
  readonly leaseRenewIntervalMs: number;
  readonly approvalTtlMs: number;
  /**
   * How long a question a tool asked stays answerable. Separate from approvals: a form is filled in
   * at the user's pace, often after they look something up, while an approval is a yes or no.
   */
  readonly interactionTtlMs: number;
  /**
   * How the runtime's final-budget step asks the model (TurnNext `closing`: no work tool offered by the runtime's own
   * decision, only the tools that ask the user). "plain", the default, asks without private reasoning
   * (`LlmAdapter.plainParameters`): the step only reports what the turn holds, and reasoning there cost its time without
   * changing the answer. "keep" asks it as every other step.
   */
  readonly closingStepReasoning?: "plain" | "keep";
}

export interface AgentRuntimeDependencies {
  /** Explicit product language for model-facing runtime notices and closing instructions. */
  readonly modelInstructions?: ModelInstructions;
  /** Omitted means the neutral core does not inject memory automatically. */
  readonly memoryContextPolicy?: MemoryContextPolicy;
  readonly toolExecutionPolicy?: ToolExecutionPolicy;
  readonly admissionController?: TurnAdmissionController;
  readonly toolExecutionBroker?: ToolExecutionBroker;
  /** Where a cut tool result is kept for `read_result`. Without it a cut is final. */
  readonly toolResultSpool?: ToolResultSpool;
  readonly conversationCompactor?: ConversationCompactor;
  readonly contextCompactionPolicy?: ContextCompactionPolicy;
  /** Trusted composition hook invoked after the session writer lease is acquired. */
  readonly turnContextProvider?: TurnContextProvider;
  /** Trusted composition policy; omitted preserves the permissive model-driven loop. */
  readonly turnControlPolicy?: TurnControlPolicy;
  readonly telemetry?: AgentTelemetrySink;
  /** How each fast-judgment seam of the loop runs when a judgment provider is mounted; unset seams are off. */
  readonly judgmentSeams?: JudgmentSeamModes;
  /**
   * Where else the composition's data lives besides the attached files, by name, each described in one sentence. The
   * `next-call` judge weighs a read of an attached file against them. Omitted, only the attached files are named.
   */
  readonly nextCallSources?: Readonly<Record<string, string>>;
  /** The model id the skill-suggestion fallback asks when the judge gave no verdict (measured choice per deployment); omitted, the turn's chat model. */
  readonly judgmentFallbackModel?: string;
  /**
   * The product's words for asking whether to go on when a turn ended partial with work left (`turn-end.ts`: a sub-goal
   * the results do not show done). Omitted, the runtime never asks: the turn ends partial with its answer, as before.
   */
  readonly continueQuestion?: ContinueQuestionWording;
  /**
   * The person's standing approval ("never ask me"): a new call the policy would put on a card runs without one while it
   * answers. Never a denied call, a question, or a card already shown. Omitted, every card is asked.
   */
  readonly standingApproval?: StandingApprovalSource;
  /**
   * The composition's tool groups and the tool that loads one (`TurnToolSelection`): with a judge and `toolRelevance` on, a
   * turn is offered only the groups its request may need. Omitted, every turn is offered every tool.
   */
  readonly toolGroups?: ToolGroupCatalog;
}

export const DEFAULT_AGENT_OPTIONS: AgentRuntimeOptions = {
  // initialStepBudget stays below maxSteps so the progressive allowance is live on the
  // defaults too; equal values would pin it at the ceiling and make the mechanism inert.
  // The tool-call ceiling equals the former 4× growth limit of a 24-call ceiling: no progressing turn gets less room.
  maxSteps: 8, initialStepBudget: 4, stepBudgetExtension: 4, maxLlmAttempts: 3, retryBaseDelayMs: 250, maxToolCalls: 96,
  // One result may take about a quarter of the context budget; over that its largest list is
  // cut with a marker rather than the call failing. 12_000 was too small for a real payroll
  // read — a month of attendance for one unit — and the model then reported without the data.
  maxRepeatedToolCalls: 2, maxObservationRounds: 1, maxToolResultChars: 32_000, maxContextChars: 120_000, maxInputChars: 32_000,
  // Silence, not a task length. Claude, Cursor and ChatGPT keep going while a turn still
  // produces a step, a tool result or a stream chunk; they cut a connection that has gone quiet.
  // 300_000 is that quiet stretch. A working reconciliation resets it on every step and tool
  // call, so it is not a five-minute cap on the job. The model-call figure is the same kind of
  // clock: 45s with no stream event, not 45s of an answer that is still arriving.
  turnTimeoutMs: 300_000, llmAttemptTimeoutMs: 45_000, leaseTtlMs: 30_000, leaseRenewIntervalMs: 10_000,
  // Healthy first events come well under 20 s, while a hung call stays silent until the provider's gateway cuts it. Past
  // 20 s of silence a call is far more likely hung than slow, and a second one usually answers before the 45 s bound
  // would retry (docs/incidents/2026-10-12-core-silent-model-calls.md).
  llmHedgeAfterMs: 20_000,
  // A backstop for any product: a loop is cut long before it. A product sizes its own from its answers and its delivery
  // budget (the harness reads AGENTIC_AGENT_MAX_ANSWER_CHARS).
  maxAnswerChars: 100_000,
  // The model-facing search tool on the same store gives up at 2 s; a cold connection can still need seconds, so the open waits longer.
  // The harness reads AGENTIC_AGENT_MEMORY_CONTEXT_TIMEOUT_MS.
  memoryContextTimeoutMs: 5_000,
  // Answered relevance judgments take well under 300 ms; a call still open at 800 ms is in the gateway's slow tail, which
  // would otherwise hold the first model call for the whole 2 s judgment deadline.
  advisorySetupBudgetMs: 800,
  // A card stays answerable for a working day (the interaction cap): a person answers at their own pace, as an agent CLI's
  // prompt waits for them. What guards a late answer is the binding (grants, runtime, policy), checked on resume; a card past
  // its time is answered as the person's next message by the widget. A shorter expiry locks cards whose answer the agent
  // then never hears about.
  approvalTtlMs: 8 * 60 * 60_000, interactionTtlMs: 8 * 60 * 60_000,
};

/** Options where 0 is meaningful: no delay before a retry, no second model call. */
const NON_NEGATIVE_OPTIONS: ReadonlySet<string> = new Set(["retryBaseDelayMs", "llmHedgeAfterMs"]);

export function resolveAgentOptions(options: number | Partial<AgentRuntimeOptions>): AgentRuntimeOptions {
  const resolved = { ...DEFAULT_AGENT_OPTIONS, ...(typeof options === "number" ? { maxSteps: options } : options) };
  for (const [name, value] of Object.entries(resolved)) {
    if (name === "closingStepReasoning") {
      if (value !== undefined && value !== "plain" && value !== "keep") throw new Error("closingStepReasoning must be plain or keep");
      continue;
    }
    const invalid = typeof value !== "number" || !Number.isInteger(value) || (NON_NEGATIVE_OPTIONS.has(name) ? value < 0 : value <= 0);
    if (invalid) throw new Error(`${name} must be ${NON_NEGATIVE_OPTIONS.has(name) ? "a non-negative" : "a positive"} integer`);
  }
  if (resolved.leaseRenewIntervalMs * 2 >= resolved.leaseTtlMs) {
    throw new Error("leaseRenewIntervalMs must be less than half of leaseTtlMs");
  }
  return resolved;
}
