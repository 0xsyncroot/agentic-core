import { AgenticError } from "@0xsyncroot/contracts";
import { StepBudget } from "./legacy-sources/step-budget.js";
import { recoverable, STEP_RETRIES } from "./legacy-sources/step-failure-recovery.js";
import { normalizedContentHash, type TurnOutputReview } from "./legacy-sources/turn-control.js";
import { turnControlFeedback } from "./legacy-sources/turn-control-feedback.js";
import { reviewTurnOutput } from "./legacy-sources/turn-output-review.js";
import { classifyBatch, failureFallbackReason, finalStepTrigger, finishStep, pastAllowance, recordBatch, ToolCallCeiling, type BatchClass } from "./legacy-replica.js";
import { GATE_ACCEPTS, RecordedRun } from "./recorded-run.js";
import type { CallFacts, ReplayOptions, ReviewFacts, RunFacts, StepFacts } from "./step-facts.js";
import type { Next, ReviewVerdict, StepDecision, TurnEndModel, TurnEndSession } from "./turn-end-model.js";

/** Variants of the legacy rules, for proving that the replay output depends on them. */
export interface LegacyVariant {
  /** Replaces the StepBudget options the run would get. */
  readonly options?: Partial<ReplayOptions>;
  /** Replaces the replica's mutator dispatch for a completed batch (legacy-replica.ts `recordBatch`). */
  readonly recordBatch?: (budget: StepBudget, stepIndex: number, batch: BatchClass, calls: readonly CallFacts[], durationMs: number) => void;
}

/**
 * The turn-end logic at commit 583c295, driven by recorded facts: that commit's StepBudget and output review (and through it
 * the work-remains gate), run from the frozen copies in legacy-sources/, and the labelled replica of the inline parts
 * (legacy-replica.ts). Time comes from the journal's clock, relative to the run's start.
 */
export class LegacyTurnEndModel implements TurnEndModel {
  readonly name = "legacy@583c295";
  constructor(private readonly variant: LegacyVariant = {}) {}
  start(run: RunFacts, options: ReplayOptions): TurnEndSession { return new LegacySession(run, { ...options, ...this.variant.options }, this.variant); }
}

class LegacySession implements TurnEndSession {
  readonly #journal: RecordedRun;
  readonly #ceiling: ToolCallCeiling;
  #budget: StepBudget | undefined;
  #closing = false;
  #failure: string | undefined;
  #failures = 0;

  constructor(private readonly run: RunFacts, private readonly options: ReplayOptions, private readonly variant: LegacyVariant) {
    this.#journal = new RecordedRun(run);
    this.#ceiling = new ToolCallCeiling(options.maxToolCalls);
  }

  async step(facts: StepFacts): Promise<StepDecision> {
    if (facts.mode === "none" && this.#budget === undefined && this.run.resume !== "none") return this.#resumed(facts);
    const now = facts.t[0] ?? 0;
    const budget = this.#budget ??= new StepBudget({ ...this.options }, facts.i, 0);
    budget.noteActivity(now);
    const trigger = finalStepTrigger({ budget, ceiling: this.#ceiling, maxToolCalls: this.options.maxToolCalls, stepIndex: facts.i, now,
      closing: this.#closing, failure: this.#failure });
    const decide = (stepNext: Next, review?: ReviewVerdict, failedStep = false): StepDecision => {
      // turn-step-loop.ts:82 @583c295 (replica): a step that ran clears the run of failures, unless a closing step is ordered.
      if (!failedStep && (stepNext.kind === "continue" || stepNext.kind === "close") && this.#failure === undefined) this.#failures = 0;
      return { step: facts.i, mode: trigger.final ? "final" : "tools", ...(trigger.reason ? { reason: trigger.reason } : {}),
        ...(review ? { review } : {}), next: pastAllowance(budget, facts.i, stepNext), ledger: this.#ledger() };
    };
    if (!trigger.final) {
      if ((facts.reviews ?? []).some((review) => review.phase === "before-model" && review.decision === "stop")) {
        return decide(this.#journal.recordedEnd(), { decision: "stop" });
      }
      for (const read of facts.reads ?? []) this.#observe(read, true);
    }
    if (facts.end === null) return decide(this.#journal.interrupted());
    const calls = facts.calls ?? [];
    if (facts.end.status === "failed") {
      calls.forEach((call) => this.#observe(call, false));
      return decide(this.#failed(facts, budget), undefined, true);
    }
    if (facts.end.reason === "interjection") {
      if (budget.canApplyInterjection(facts.i, facts.t[1] ?? now)) budget.recordInterjection(facts.i);
      return decide({ kind: "continue" });
    }
    const reviews = (facts.reviews ?? []).filter((review) => review.phase !== "before-model");
    const before = reviews.find((review) => !review.after);
    let accepted: { readonly outcome?: string; readonly reason?: string } | undefined;
    let verdict: ReviewVerdict | undefined;
    if (before) {
      const settled = await this.#review(facts, before, trigger.final, before.phase === "tool-call");
      if (settled.next) return decide(settled.next, settled.verdict);
      accepted = settled.accepted;
      verdict = settled.verdict;
    }
    // A call that paused the turn for the user has no result yet: the pause itself shows the batch ran.
    const paused = facts.end.status?.startsWith("awaiting_") === true;
    const batchRuns = (calls.length > 0 || paused) && !facts.suppressed;
    if (batchRuns) {
      calls.forEach((call) => this.#observe(call, false));
      if (paused) return decide({ kind: "pause" }, verdict);
      const batch = classifyBatch(calls, facts.planChanged === true);
      if (this.variant.recordBatch) this.variant.recordBatch(budget, facts.i, batch, calls, this.#journal.duration(facts));
      else recordBatch(budget, facts.i, batch, this.#journal.duration(facts));
      const after = reviews.find((review) => review.after);
      if (!after) return decide({ kind: "continue" }, verdict);
      const settled = await this.#review(facts, after, trigger.final, false);
      if (settled.next) return decide(settled.next, settled.verdict);
      accepted = settled.accepted;
      verdict = settled.verdict;
    }
    const next = finishStep({ budget, stepIndex: facts.i, finalBudgetStep: trigger.final, stopReason: trigger.reason, suppressed: facts.suppressed === true,
      text: facts.answer === "text", toolCalls: batchRuns ? calls.length : 0, finishReason: facts.end.reason ?? "stop", now: facts.t[1] ?? now,
      ...(accepted ? { accepted } : {}) });
    return decide(next, verdict);
  }

  /** The first step of a resumed run spends the resumed call outside the budget; the loop's budget starts at the next step. */
  #resumed(facts: StepFacts): StepDecision {
    (facts.calls ?? []).forEach((call) => this.#journal.result(call, false));
    const last = this.run.steps.at(-1) === facts;
    const next: Next = facts.end?.status?.startsWith("awaiting_") ? { kind: "pause" } : last ? this.#journal.recordedEnd() : { kind: "continue" };
    return { step: facts.i, mode: "none", next, ledger: this.#ledger() };
  }

  /** Runs the output review against the recorded policy verdict, and journals what it decided as the loop would. */
  async #review(facts: StepFacts, review: ReviewFacts, finalBudgetStep: boolean, toolPhase: boolean): Promise<{
    readonly next?: Next; readonly verdict?: ReviewVerdict; readonly accepted?: { readonly outcome?: string; readonly reason?: string };
  }> {
    if (review.phase === "choice-violation") return { verdict: { decision: "unknown" }, next: { kind: "failed", code: "unreplayable-directive" } };
    const journal = this.#journal;
    const budget = this.#budget!;
    const now = review.t ?? facts.t[0] ?? 0;
    const closingStep = this.#closing || this.#failure !== undefined;
    const text = review.text ?? (facts.answer === "text" || review.decision === "close");
    const content = !toolPhase && review.answer && text ? `answer-${review.answer}` : null;
    journal.raw = journal.rawDecision(facts, review);
    const outcome: TurnOutputReview = await reviewTurnOutput({
      policy: journal.policy, state: journal.state(facts), directive: {}, selectedTools: [], finalBudgetStep,
      candidate: { content, finishReason: facts.end?.reason ?? "stop", toolCalls: toolPhase ? [{ id: "call", name: "tool", arguments: "{}" }] : [] },
      ...(closingStep ? { closingStep } : {}), controlFeedback: journal.controlFeedback, signal: journal.signal,
      grantClosingStep: () => !closingStep && budget.grantClosingStep(facts.i, now), reserveWorkClosingStep: () => budget.reserveClosingStep(facts.i, now),
    });
    const phase = toolPhase ? "tool-call" : "terminal";
    if (outcome.kind === "close") {
      journal.decision(phase, "close", { reason: outcome.reason, workRemains: true });
      this.#closing = true;
      return { verdict: { decision: "close", reason: outcome.reason }, next: { kind: "close", reason: outcome.reason } };
    }
    if (outcome.kind === "continue") {
      if (outcome.deduplicated && outcome.fallback !== undefined) {
        journal.decision(phase, "fallback", { reason: outcome.feedback });
        return { verdict: { decision: "fallback" }, next: { kind: "end", status: "partial", reason: "turn-control-fallback", decision: "partial" } };
      }
      const hash = phase === "terminal" ? normalizedContentHash(content) : undefined;
      journal.decision(phase, "continue", { reason: outcome.feedback, ...(outcome.workRemains ? { workRemains: true } : {}), ...(hash ? { contentHash: hash } : {}) });
      journal.controlFeedback.push(turnControlFeedback(journal.policy, outcome.feedback));
      budget.recordRejectedStep(journal.duration(facts));
      return { verdict: { decision: "continue" }, next: { kind: "continue" } };
    }
    const decision = outcome.terminalDecision;
    if (!decision) return {};
    journal.decision(phase, "accept", decision.reason ? { reason: decision.reason } : {});
    const reason = decision.reason && (GATE_ACCEPTS.has(decision.reason) || decision.reason === "closing-step-objection") ? decision.reason : decision.reason ? "policy" : undefined;
    return { verdict: { decision: "accept", ...(reason ? { reason } : {}) }, accepted: decision };
  }

  /** The failed-step path of the loop: one retry, then a closing step, then the product's sentence; final codes fail the turn. */
  #failed(facts: StepFacts, budget: StepBudget): Next {
    const code = facts.end?.code ?? "permanent";
    if (!recoverable(new AgenticError(code as never, "replayed step failure"), this.#journal.signal)) return { kind: "failed", code };
    this.#failures += 1;
    if (this.#failures > STEP_RETRIES + 1) return { kind: "end", status: "partial", reason: failureFallbackReason(code), decision: "partial" };
    if (this.#failures > STEP_RETRIES) this.#failure = code;
    budget.grantRecoveryStep(facts.i);
    return { kind: "continue" };
  }

  #observe(call: CallFacts, policy: boolean): void {
    this.#ceiling.record(call);
    if (!call.skipped) this.#journal.result(call, policy);
  }

  #ledger() {
    return { granted: this.#budget?.granted ?? 0, progressing: this.#budget?.progressing ?? true, toolCalls: this.#ceiling.count, toolCallCeiling: this.#ceiling.ceiling };
  }
}
