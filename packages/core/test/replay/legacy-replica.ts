import { classifyLlmTerminal } from "./legacy-sources/llm-finish-policy.js";
import type { StepBudget } from "./legacy-sources/step-budget.js";
import type { CallFacts } from "./step-facts.js";
import type { Next } from "./turn-end-model.js";

/**
 * REPLICA of turn-end logic that lives inline in private code at commit 583c295, copied so the replay can run it on recorded
 * facts without touching the source. Each piece names the lines it copies. `REPLICA_SOURCES` lists the same code as anchors
 * in the frozen copies of that commit's files (legacy-sources/): the drift test fails when a copy and this replica disagree.
 *
 * Exported pieces (StepBudget, reviewTurnOutput, workRemainsReview, recoverable, STEP_RETRIES, classifyLlmTerminal) are not
 * copied: the model imports them from legacy-sources/.
 */

/** step-answer.ts:14 @583c295: the stop cause of a closing step the work-remains gate asked for. */
export const WORK_REMAINS_CLOSING = "work-remains-unmoved";

/** turn-step-loop.ts:39-40 @583c295: calls added while the work still progresses, and the hard factor over the configured ceiling. */
export const TOOL_CALL_EXTENSION = 16;
export const TOOL_CALL_HARD_FACTOR = 4;
/** tool-batch-executor.ts:34 @583c295: refusals of one target that still count as feedback. */
export const REFUSALS_HEARD = 3;

/**
 * tool-execution-coordinator.ts:90,93,103-104,137 @583c295: the turn's tool-call count and ceiling. An ask tool is not counted
 * unless the step lacked it (a refused unoffered call is counted whatever it is); a call not started behind a failure or a pause
 * never reached the coordinator.
 */
export class ToolCallCeiling {
  count = 0;
  constructor(public ceiling: number) {}
  get exhausted(): boolean { return this.count >= this.ceiling; }
  extend(by: number, hardMax: number): boolean { return this.ceiling < hardMax && (this.ceiling = Math.min(hardMax, this.ceiling + by)) > 0; }
  record(call: CallFacts): void { if (countsAgainstCeiling(call)) this.count += 1; }
}

/** tool-execution-coordinator.ts:103-104,137 @583c295: whether the coordinator counts a call against the ceiling. */
export const countsAgainstCeiling = (call: CallFacts): boolean => !call.skipped && (!call.asks || call.offered === false);

/** turn-step-loop.ts:190-196 @583c295: whether the step is a final step, and the stop cause it carries. */
export function finalStepTrigger(input: {
  readonly budget: StepBudget; readonly ceiling: ToolCallCeiling; readonly maxToolCalls: number; readonly stepIndex: number; readonly now: number;
  readonly closing: boolean; readonly failure: string | undefined;
}): { readonly final: boolean; readonly reason?: string } {
  const { budget, ceiling } = input;
  const toolBudgetReached = ceiling.exhausted
    && !(budget.progressing && ceiling.extend(TOOL_CALL_EXTENSION, input.maxToolCalls * TOOL_CALL_HARD_FACTOR));
  const final = toolBudgetReached || budget.isFinalStep(input.stepIndex, input.now) || input.closing || input.failure !== undefined;
  if (!final) return { final };
  const reason = input.failure ? `step-failure (${input.failure})` : toolBudgetReached ? "tool-call-limit"
    : input.closing ? WORK_REMAINS_CLOSING : budget.stopReason(input.stepIndex, input.now);
  return { final, reason };
}

export interface BatchClass {
  readonly progressed: boolean; readonly planningOnly: boolean; readonly planChanged: boolean;
  readonly unavailableOnly: boolean; readonly refusedOnly: boolean;
}

/** tool-batch-executor.ts:73-84,113-121,132-134,222 @583c295: what one batch of the model's calls amounts to. */
export function classifyBatch(calls: readonly CallFacts[], planChanged: boolean): BatchClass {
  let progressed = false;
  let dispatchedCalls = 0;
  let planningCalls = 0;
  let unavailableCalls = 0;
  let workCalls = 0;
  let refusedCalls = 0;
  for (const call of calls) {
    if (call.skipped) continue;
    if (call.offered === false) unavailableCalls += 1;
    if (!call.plan) { workCalls += 1; if (call.failure && (call.failures ?? 0) < REFUSALS_HEARD) refusedCalls += 1; }
    if (call.dispatched && call.state === "succeeded") {
      dispatchedCalls += 1;
      if (call.plan) planningCalls += 1;
      else if (call.gain === "new") progressed = true;
    }
  }
  return { progressed, planningOnly: dispatchedCalls > 0 && planningCalls === dispatchedCalls && workCalls === 0, planChanged,
    unavailableOnly: calls.length > 0 && unavailableCalls === calls.length, refusedOnly: !progressed && workCalls > 0 && refusedCalls === workCalls };
}

/** step-disposition.ts:189-193 @583c295: the budget mutator a completed batch calls. */
export function recordBatch(budget: StepBudget, stepIndex: number, batch: BatchClass, durationMs: number): void {
  if (batch.planningOnly) budget.recordPlanningStep(durationMs, batch.planChanged);
  else if (batch.unavailableOnly || batch.refusedOnly) budget.recordRefusedStep(durationMs);
  else budget.recordStepOutcome(stepIndex, batch.progressed, durationMs);
}

/**
 * step-answer.ts:29-86 @583c295: how a step whose output was accepted ends the turn, or buys one more step when the model
 * said nothing or reached for a tool on a step that had to answer.
 */
export function finishStep(input: {
  readonly budget: StepBudget; readonly stepIndex: number; readonly finalBudgetStep: boolean; readonly stopReason: string | undefined;
  readonly suppressed: boolean; readonly text: boolean; readonly toolCalls: number; readonly finishReason: string; readonly now: number;
  readonly accepted?: { readonly outcome?: string; readonly reason?: string };
}): Next {
  const { budget, stepIndex } = input;
  const content = input.text ? "text" : null;
  const terminal = input.toolCalls > 0 ? "completed"
    : classifyLlmTerminal({ type: "final", content, toolCalls: [], finishReason: input.finishReason });
  const silent = !input.text;
  const calledATool = input.suppressed;
  if ((silent || calledATool) && budget.grantResponseRecovery(stepIndex, input.finalBudgetStep, input.now)) return { kind: "continue" };
  const resourceStop = input.finalBudgetStep || calledATool;
  const outcome = resourceStop || terminal !== "completed" || input.accepted?.outcome === "partial" ? "partial" : "completed";
  const workClosing = input.stopReason === WORK_REMAINS_CLOSING;
  const decision = resourceStop && !workClosing ? "budget-reached" : outcome === "partial" ? "partial" : "finish";
  const reason = resourceStop ? input.stopReason ?? budget.stopReason(stepIndex, input.now) : silent ? "empty-response" : input.finishReason;
  return { kind: "end", status: outcome, decision, reason };
}

/**
 * turn-step-loop.ts:76,93 @583c295: the loop runs while the step index is within the granted allowance; a step that leads on
 * past it ends the loop with no outcome, and the turn fails (`permanent`).
 */
export function pastAllowance(budget: StepBudget, stepIndex: number, next: Next): Next {
  return (next.kind === "continue" || next.kind === "close") && stepIndex + 1 > budget.granted ? { kind: "failed", code: "permanent" } : next;
}

/** step-failure-recovery.ts:38 @583c295: the stop cause of the product's sentence after a step failed past its retry. */
export const failureFallbackReason = (code: string): string => `step-failure:${code}`;

/**
 * Code the replica copies, as anchors: the smallest node of `kind` in `file` whose source contains `marker`. `file` names the
 * source at 583c295; its frozen copy in legacy-sources/ is what is read.
 */
export interface SourceAnchor { readonly file: string; readonly kind: string; readonly marker: string }

const anchor = (file: string, kind: string, marker: string): SourceAnchor => ({ file: `packages/core/src/agent/${file}`, kind, marker });

export const REPLICA_SOURCES: readonly SourceAnchor[] = [
  anchor("turn-step-loop.ts", "VariableStatement", "const TOOL_CALL_EXTENSION"),
  anchor("turn-step-loop.ts", "VariableStatement", "const TOOL_CALL_HARD_FACTOR"),
  anchor("turn-step-loop.ts", "VariableStatement", "const toolBudgetReached"),
  anchor("turn-step-loop.ts", "VariableStatement", "const finalBudgetStep"),
  anchor("turn-step-loop.ts", "VariableStatement", "const stopReason"),
  anchor("turn-step-loop.ts", "ForStatement", "stepIndex <= loop.budget.granted"),
  anchor("tool-execution-coordinator.ts", "GetAccessor", "get budgetExhausted"),
  anchor("tool-execution-coordinator.ts", "MethodDeclaration", "extendToolCalls(by"),
  anchor("tool-execution-coordinator.ts", "IfStatement", "if (!asks) this.#toolCallCount += 1"),
  anchor("tool-execution-coordinator.ts", "MethodDeclaration", "refuseUnoffered(call"),
  anchor("tool-batch-executor.ts", "VariableStatement", "const REFUSALS_HEARD"),
  anchor("tool-batch-executor.ts", "IfStatement", "stop?.stops(this.coordinator.definition(call))"),
  anchor("tool-batch-executor.ts", "IfStatement", "if (!available) unavailableCalls += 1"),
  anchor("tool-batch-executor.ts", "IfStatement", "if (!isPlanning) { workCalls += 1"),
  anchor("tool-batch-executor.ts", "IfStatement", "if (outcome.dispatched && outcome.state === \"succeeded\")"),
  anchor("tool-batch-executor.ts", "ReturnStatement", "return { kind: \"completed\", progressed"),
  anchor("tool-batch-executor.ts", "ReturnStatement", "refused: tried.attempt.failure"),
  anchor("step-disposition.ts", "IfStatement", "budget.canApplyInterjection(stepIndex)"),
  anchor("step-disposition.ts", "VariableStatement", "const closingStep ="),
  anchor("step-disposition.ts", "VariableStatement", "const review = (candidate"),
  anchor("step-disposition.ts", "VariableStatement", "const closeOut ="),
  anchor("step-disposition.ts", "VariableStatement", "const sendBack ="),
  anchor("step-disposition.ts", "TryStatement", "const outputReview = await review(final)"),
  anchor("step-disposition.ts", "IfStatement", "if (final.toolCalls.length > 0)"),
  anchor("step-answer.ts", "FunctionDeclaration", "export async function finishStep("),
  anchor("step-answer.ts", "VariableStatement", "export const WORK_REMAINS_CLOSING"),
  anchor("step-failure-recovery.ts", "FunctionDeclaration", "export async function failureFallback("),
  anchor("work-remains-gate.ts", "VariableStatement", "const MAX_STALLED_WORK_LAPS"),
];
