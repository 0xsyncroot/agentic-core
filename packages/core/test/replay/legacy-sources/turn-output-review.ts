import type { ChatMessage, LlmResponseStatus, ToolDefinition, TurnControlPolicy, TurnControlServices, TurnControlState, TurnModelDirective } from "@0xsyncroot/contracts";
import { choiceViolationFallback, toolChoiceViolation } from "./choice-violation.js";
import { validateTerminalDecision, type TurnOutputReview } from "./turn-control.js";
import { turnControlObjection } from "./turn-control-feedback.js";
import { workRemainsReview } from "./work-remains-gate.js";

export const CLOSING_STEP_OBJECTION = "closing-step-objection";

function objectionOutcome(input: {
  readonly strikes: number; readonly finalBudgetStep: boolean; readonly grantClosingStep?: () => boolean;
}): { readonly escalate: boolean; readonly deduplicated: boolean } {
  const exhausted = input.finalBudgetStep && (input.strikes >= 1 || input.grantClosingStep?.() !== true);
  const deduplicated = input.strikes >= 2 || exhausted;
  return { escalate: input.strikes === 1 && !deduplicated, deduplicated };
}

function strikesFor(controlFeedback: readonly ChatMessage[] | undefined, feedback: string, state: TurnControlState): number {
  const events = state.context.events.filter((event) => event.turnId === state.turnId);
  const progress = events.filter((event) => {
    const payload = event.payload as Record<string, unknown> | null;
    return event.type === "tool/result" && payload?.dispatched === true && payload.state === "succeeded" && payload.informationGain === "new";
  }).at(-1);
  if (progress) return events.filter((event) => {
    const payload = event.payload as Record<string, unknown> | null;
    return event.seq > progress.seq && event.type === "turn/control-decision" &&
      payload?.decision === "continue" && payload.reason === feedback;
  }).length;
  return (controlFeedback ?? []).filter((message) => turnControlObjection(message) === feedback).length;
}

export async function reviewTurnOutput(input: {
  readonly policy?: TurnControlPolicy;
  readonly state: TurnControlState;
  readonly directive: TurnModelDirective;
  readonly selectedTools: readonly ToolDefinition[];
  readonly candidate: { readonly content: string | null; readonly finishReason: string; readonly status?: LlmResponseStatus;
    readonly toolCalls: readonly { readonly id: string; readonly name: string; readonly arguments: string }[] };
  readonly finalBudgetStep: boolean;
  readonly closingStep?: boolean;
  readonly grantClosingStep?: () => boolean;
  readonly reserveWorkClosingStep?: () => boolean;
  readonly controlFeedback?: readonly ChatMessage[];
  readonly isPlanningCall?: (name: string) => boolean;
  readonly signal: AbortSignal;
  readonly services?: TurnControlServices;
}): Promise<TurnOutputReview> {
  const violation = toolChoiceViolation(input.directive, input.selectedTools, input.candidate.toolCalls, input.isPlanningCall);
  if (violation) {
    const fallback = choiceViolationFallback(input.policy, input.state);
    const outcome = objectionOutcome({ strikes: strikesFor(input.controlFeedback, violation, input.state), finalBudgetStep: input.finalBudgetStep });
    return { kind: "continue", phase: "choice-violation", feedback: violation, fallback,
      ...(outcome.escalate ? { escalate: true } : {}), ...(outcome.deduplicated ? { deduplicated: true } : {}) };
  }
  if (!input.policy) return { kind: "proceed" };
  if (input.candidate.toolCalls.length > 0) {
    if (!input.policy.reviewToolCalls) return { kind: "proceed" };
    const toolDecision = validateTerminalDecision(await input.policy.reviewToolCalls({
      ...input.state,
      directive: input.directive,
      toolCalls: input.candidate.toolCalls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
    }, input.signal, input.services ?? {}));
    if (toolDecision.decision !== "continue") return { kind: "proceed" };
    if (toolDecision.workRemains) return workRemainsReview("tool-call", toolDecision, input.state, input.policy.id, input.finalBudgetStep, input.candidate.content);
    const outcome = objectionOutcome({ strikes: strikesFor(input.controlFeedback, toolDecision.feedback, input.state), finalBudgetStep: input.finalBudgetStep });
    return { kind: "continue", phase: "tool-call", feedback: toolDecision.feedback,
      ...(toolDecision.fallback ? { fallback: toolDecision.fallback } : {}),
      ...(outcome.escalate ? { escalate: true } : {}), ...(outcome.deduplicated ? { deduplicated: true } : {}) };
  }
  const terminalDecision = validateTerminalDecision(await input.policy.reviewTerminal({
    ...input.state,
    directive: input.directive,
    candidate: {
      content: input.candidate.content, finishReason: input.candidate.finishReason,
      ...(input.candidate.status ? { status: input.candidate.status } : {}),
    },
  }, input.signal, input.services ?? {}));
  if (terminalDecision.decision !== "continue") return { kind: "proceed", terminalDecision };
  if (terminalDecision.workRemains) {
    return workRemainsReview("terminal", terminalDecision, input.state, input.policy.id, input.finalBudgetStep, input.candidate.content, input.reserveWorkClosingStep);
  }
  if (input.closingStep) {
    return { kind: "proceed", terminalDecision: Object.freeze({ decision: "accept", outcome: "partial", reason: CLOSING_STEP_OBJECTION,
      ...(terminalDecision.fallback ? { notice: terminalDecision.fallback } : {}) }) };
  }
  const outcome = objectionOutcome({
    strikes: strikesFor(input.controlFeedback, terminalDecision.feedback, input.state), finalBudgetStep: input.finalBudgetStep,
    ...(input.grantClosingStep ? { grantClosingStep: input.grantClosingStep } : {}),
  });
  return { kind: "continue", phase: "terminal", feedback: terminalDecision.feedback,
    ...(terminalDecision.fallback ? { fallback: terminalDecision.fallback } : {}),
    ...(outcome.escalate ? { escalate: true } : {}), ...(outcome.deduplicated ? { deduplicated: true } : {}) };
}
