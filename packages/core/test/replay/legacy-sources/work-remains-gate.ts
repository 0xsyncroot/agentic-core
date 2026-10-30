import type { SessionEvent, TurnControlState, TurnTerminalDecision } from "@0xsyncroot/contracts";
import { normalizedContentHash, type TurnOutputReview } from "./turn-control.js";

const MAX_STALLED_WORK_LAPS = 3;

function terminalObjectionsSinceRuntimeEvidence(state: TurnControlState, policyId: string): number {
  const events = state.context.events.filter((event) => event.turnId === state.turnId);
  const runtimeEvidence = events.filter((event) => {
    const payload = event.payload as Record<string, unknown> | null;
    return event.type === "tool/result" && payload?.initiator === "policy" && payload.state === "succeeded" && payload.informationGain === "new";
  }).at(-1)?.seq ?? -1;
  return events.filter((event) => {
    const payload = event.payload as Record<string, unknown> | null;
    return event.seq > runtimeEvidence && event.type === "turn/control-decision" && payload?.policyId === policyId &&
      payload.phase === "terminal" && payload.decision === "continue" && payload.workRemains === true;
  }).length;
}

function stalledWorkLaps(state: TurnControlState, policyId: string): number {
  const events = state.context.events.filter((event) => event.turnId === state.turnId);
  const evidence = events.filter(newEvidence).at(-1)?.seq ?? -1;
  return events.filter((event) => {
    const payload = event.payload as Record<string, unknown> | null;
    return event.seq > evidence && event.type === "turn/control-decision" && payload?.policyId === policyId &&
      payload.decision === "continue" && payload.workRemains === true;
  }).length;
}

function newEvidence(event: SessionEvent): boolean {
  const payload = event.payload as Record<string, unknown> | null;
  return event.type === "tool/result" && payload?.dispatched === true && payload.state === "succeeded" && payload.informationGain === "new";
}

function repeatsObjectedAnswer(state: TurnControlState, policyId: string, content: string | null): boolean {
  const hash = normalizedContentHash(content);
  if (!hash) return false;
  const events = state.context.events.filter((event) => event.turnId === state.turnId);
  const objection = events.filter((event) => {
    const payload = event.payload as Record<string, unknown> | null;
    return event.type === "turn/control-decision" && payload?.policyId === policyId && payload.phase === "terminal" &&
      payload.decision === "continue" && payload.workRemains === true;
  }).at(-1);
  if (!objection || (objection.payload as Record<string, unknown>).contentHash !== hash) return false;
  return !events.some((event) => event.seq > objection.seq && newEvidence(event));
}

export function workRemainsReview(
  phase: "terminal" | "tool-call", decision: Extract<TurnTerminalDecision, { readonly decision: "continue" }>,
  state: TurnControlState, policyId: string, finalBudgetStep: boolean, content: string | null, reserveClosingStep?: () => boolean,
): TurnOutputReview {
  const ended = finalBudgetStep || stalledWorkLaps(state, policyId) >= MAX_STALLED_WORK_LAPS
    || (phase === "terminal" && terminalObjectionsSinceRuntimeEvidence(state, policyId) >= MAX_STALLED_WORK_LAPS)
    || (phase === "terminal" && repeatsObjectedAnswer(state, policyId, content));
  if (ended && phase === "terminal" && !finalBudgetStep && reserveClosingStep?.() === true) {
    return { kind: "close", feedback: decision.feedback, reason: "work-remains-unmoved", noticeFollows: Boolean(decision.fallback?.trim()) };
  }
  if (ended && phase === "terminal") {
    return { kind: "proceed", terminalDecision: Object.freeze({ decision: "accept", outcome: "partial",
      reason: finalBudgetStep ? "work-remains-final-step" : "work-remains-unmoved",
      ...(decision.fallback ? { notice: decision.fallback } : {}) }) };
  }
  return { kind: "continue", phase, feedback: decision.feedback, workRemains: true,
    ...(ended ? { fallback: decision.fallback ?? "", deduplicated: true } : decision.fallback ? { fallback: decision.fallback } : {}) };
}
