import type { ChatMessage, SessionEvent, TurnControlPolicy, TurnControlState, TurnTerminalDecision } from "@0xsyncroot/contracts";
import type { CallFacts, ReviewFacts, RunFacts, StepFacts } from "./step-facts.js";
import type { Next } from "./turn-end-model.js";

/** Accept reasons the work-remains gate writes: the policy had objected that work remains. */
export const GATE_ACCEPTS = new Set(["work-remains-final-step", "work-remains-unmoved"]);
const TURN_ID = "replayed-turn";

/**
 * What every replay model shares for one run: a policy that answers each review with the verdict the journal recorded, and
 * the journal the turn-end logic reads (tool results and control decisions), rebuilt from the recorded facts as the loop
 * would have written them.
 */
export class RecordedRun {
  readonly events: SessionEvent[] = [];
  readonly controlFeedback: ChatMessage[] = [];
  readonly signal = new AbortController().signal;
  readonly policy: TurnControlPolicy;
  /** The recorded decision the scripted policy answers with on the review under way. */
  raw: TurnTerminalDecision = { decision: "accept" };
  /** Objections the run later ended on with the policy's fallback: those objections carried one. */
  readonly #fallbacks: Set<number>;

  constructor(readonly run: RunFacts) {
    const answer = async () => this.raw;
    this.policy = { id: "replay", revision: "1", beforeModelStep: async () => ({}), reviewTerminal: answer, reviewToolCalls: answer };
    this.#fallbacks = new Set(run.steps.flatMap((step) => (step.reviews ?? []).filter((review) => review.decision === "fallback").map((review) => review.feedback ?? 0)));
  }

  /** What the policy said before any runtime gate, rebuilt from what the journal recorded after them. */
  rawDecision(facts: StepFacts, review: ReviewFacts): TurnTerminalDecision {
    const feedback = `objection-${review.feedback ?? 0}`;
    const delivered = review.delivered ? { delivered: true } as const : {};
    if (review.decision === "accept") {
      if (review.reason && GATE_ACCEPTS.has(review.reason)) return { decision: "continue", feedback, workRemains: true, ...delivered };
      if (review.reason === "closing-step-objection") return { decision: "continue", feedback };
      const partial = this.run.steps.at(-1) === facts && this.run.end.kind === "end" && this.run.end.status === "partial";
      return { decision: "accept", ...(review.reason === "policy" ? { reason: "policy" } : {}), ...(partial ? { outcome: "partial" } : {}) };
    }
    if (review.decision === "close") return { decision: "continue", feedback, workRemains: true, ...delivered };
    const fallback = review.decision === "fallback" || this.#fallbacks.has(review.feedback ?? 0);
    return { decision: "continue", feedback, ...(review.workRemains ? { workRemains: true } : {}), ...delivered, ...(fallback ? { fallback: "fallback" } : {}) };
  }

  /** A step the journal shows no end for: the turn stopped around it (a cancel, a lost lease), which no budget decided. */
  interrupted(): Next { return this.run.end.kind === "failed" ? { kind: "failed", code: this.run.end.code ?? "unknown" } : this.recordedEnd(); }

  recordedEnd(): Next {
    const end = this.run.end;
    if (end.kind === "end") return { kind: "end", status: end.status, ...(end.reason ? { reason: end.reason } : {}), ...(end.decision ? { decision: end.decision } : {}) };
    return { kind: "failed", code: end.kind === "failed" ? end.code ?? "unknown" : "open" };
  }

  result(call: CallFacts, policy: boolean): void {
    this.#event("tool/result", { state: call.state, dispatched: call.dispatched === true,
      ...(call.gain && call.gain !== "none" ? { informationGain: call.gain } : {}), ...(policy ? { initiator: "policy" } : {}) });
  }

  decision(phase: string, decision: string, details: Record<string, unknown>): void {
    this.#event("turn/control-decision", { policyId: this.policy.id, phase, decision, ...details });
  }

  state(facts: StepFacts): TurnControlState {
    return { turnId: TURN_ID, stepIndex: facts.i, context: { events: [...this.events] } } as unknown as TurnControlState;
  }

  /** The step's length from the journal's clock: its start to its end. */
  duration(facts: StepFacts): number { return Math.max(0, (facts.t[1] ?? facts.t[0] ?? 0) - (facts.t[0] ?? 0)); }

  #event(type: string, payload: Record<string, unknown>): void {
    this.events.push({ type, seq: this.events.length + 1, turnId: TURN_ID, payload } as unknown as SessionEvent);
  }
}
