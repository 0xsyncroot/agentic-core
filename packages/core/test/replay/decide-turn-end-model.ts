import { AgenticError } from "@0xsyncroot/contracts";
import { classifyLlmTerminal } from "../../src/agent/llm-finish-policy.js";
import { StepBudget } from "../../src/agent/step-budget.js";
import { recoverable } from "../../src/agent/step-failure-recovery.js";
import { normalizedContentHash, type TurnOutputReview } from "../../src/agent/turn-control.js";
import {
  askReadBack, closesTurn, decide, interjectionFits, NO_TERMINAL_OUTCOME, objectionsHeard, openTurn, recordedBatch, stepRan,
} from "../../src/agent/turn-end.js";
import type { StepOutcomeFacts, StepRecord, TurnEndBounds, TurnLedger, TurnNext } from "../../src/agent/turn-end-facts.js";
import { reviewTurnOutput } from "../../src/agent/turn-output-review.js";
import { classifyBatch, countsAgainstCeiling } from "./legacy-replica.js";
import { GATE_ACCEPTS, RecordedRun } from "./recorded-run.js";
import { RecordedSubGoals } from "./recorded-sub-goals.js";
import type { CallFacts, ReplayOptions, ReviewFacts, RunFacts, StepFacts } from "./step-facts.js";
import type { Ledger, Next, ReviewVerdict, StepDecision, TurnEndModel, TurnEndSession } from "./turn-end-model.js";

/**
 * The current turn-end logic, driven by recorded facts: `openTurn` and `decide()` from turn-end.ts, the current
 * output review (and through it the work-remains gate), and the loop's step order as step-disposition.ts and step-answer.ts
 * run it. What the batch executor and the tool coordinator compute inline (a batch's class, which calls count against the
 * ceiling) comes from the labelled replica, as for the legacy model; a call's recorded `wrote` is the coordinator's write,
 * and the policy's recorded reads, classified as a batch, are the runtime's evidence. Whether a sub-goal is left undone comes
 * from the run's plan facts (`RecordedSubGoals`), as the loop reads its sub-goal ledger. The review reads nothing from the
 * journal: the recorded verdict answers it, and the turn's objections come from the ledger. Time plays no part in any decision.
 *
 * `bounds` is the composition the current rules run under (the recorded runs ran the fixture's legacy options): its numeric
 * step ceiling and its one tool-call ceiling.
 */
export class DecideTurnEndModel implements TurnEndModel {
  readonly name = "decide";
  constructor(private readonly bounds: { readonly maxSteps: number; readonly maxToolCalls: number }) {}
  start(run: RunFacts, options: ReplayOptions): DecideSession { return new DecideSession(run, { ...options, ...this.bounds }); }
}

type DecideOptions = TurnEndBounds;

/** An end `decide()` reached on the run's own facts. `undone`: the sub-goal fact it read, or `no-plan`. */
export interface DecidedEnd {
  readonly partial: boolean;
  /** The end asks the user whether to go on: the continue card. */
  readonly asks: boolean;
  readonly undone: boolean | "no-plan";
}

export class DecideSession implements TurnEndSession {
  readonly #journal: RecordedRun;
  readonly #subGoals: RecordedSubGoals;
  /** How `decide()` ended the run, once it has: partial or not, whether it asks to go on, and the sub-goal fact it read. */
  #ended: DecidedEnd | undefined;
  /** The tool coordinator's count of calls against its ceiling, and whether a write it ran succeeded. */
  #toolCalls = 0;
  #wrote = false;
  #ledger: TurnLedger | undefined;
  #next: TurnNext | undefined;
  #record: StepRecord | undefined;

  constructor(private readonly run: RunFacts, private readonly options: DecideOptions) {
    this.#journal = new RecordedRun(run);
    this.#subGoals = new RecordedSubGoals(run);
  }

  /** How `decide()` ended the run; `undefined` while it has not (a pause, an interruption, or a run still going). */
  get ended(): DecidedEnd | undefined { return this.#ended; }

  async step(facts: StepFacts): Promise<StepDecision> {
    const decision = await this.#run(facts);
    // turn-step-loop.ts: a step that returned without ending the turn ran to its end and clears the run of failures.
    const ran = facts.end?.status !== "failed" && (decision.next.kind === "continue" || decision.next.kind === "close");
    if (ran && this.#ledger !== undefined) this.#ledger = stepRan(this.#ledger);
    return decision;
  }

  async #run(facts: StepFacts): Promise<StepDecision> {
    if (facts.mode === "none" && this.#ledger === undefined && this.run.resume !== "none") return this.#resumed(facts);
    if (this.#ledger === undefined) {
      ({ ledger: this.#ledger, next: this.#next } = openTurn(this.options, facts.i, { toolCalls: this.#toolCalls, wrote: this.#wrote }));
    }
    const next = this.#next!;
    // The loop runs no step past a decided end: no step left and no outcome fails the turn.
    if (next.kind === "end") return { step: facts.i, mode: "none", next: this.#replayed(next, "stop"), ledger: this.#view() };
    const finalReason = next.kind === "closing" ? next.reason : undefined;
    this.#record = { stepIndex: facts.i, ...(finalReason !== undefined ? { finalReason } : {}) };
    const final = finalReason !== undefined;
    const decided = (stepNext: Next, review?: ReviewVerdict): StepDecision => ({ step: facts.i, mode: final ? "final" : "tools",
      ...(finalReason !== undefined ? { reason: finalReason } : {}), ...(review ? { review } : {}), next: stepNext, ledger: this.#view() });
    if (!final) {
      if ((facts.reviews ?? []).some((review) => review.phase === "before-model" && review.decision === "stop")) {
        return decided(this.#journal.recordedEnd(), { decision: "stop" });
      }
      const reads = facts.reads ?? [];
      reads.forEach((read) => this.#observe(read));
      if (classifyBatch(reads, false).progressed) this.#record = { ...this.#record, runtimeEvidence: true };
    }
    if (facts.end === null) return decided(this.#journal.interrupted());
    const calls = facts.calls ?? [];
    const finishReason = facts.end.reason ?? "stop";
    if (facts.end.status === "failed") {
      calls.forEach((call) => this.#observe(call));
      this.#subGoals.ran(facts);
      const code = facts.end.code ?? "permanent";
      const failed = recoverable(new AgenticError(code as never, "replayed step failure"), this.#journal.signal);
      return decided(this.#replayed(this.#decide({ kind: "failed", code, recoverable: failed }), finishReason));
    }
    if (facts.end.reason === "interjection") {
      if (interjectionFits(this.#ledger, this.options, facts.i)) this.#decide({ kind: "interjected" });
      return decided({ kind: "continue" });
    }
    const reviews = (facts.reviews ?? []).filter((review) => review.phase !== "before-model");
    const before = reviews.find((review) => !review.after);
    let accepted: { readonly outcome?: string; readonly reason?: string } | undefined;
    let verdict: ReviewVerdict | undefined;
    if (before) {
      const settled = await this.#review(facts, before, final, before.phase === "tool-call");
      if (settled.next) return decided(settled.next, settled.verdict);
      accepted = settled.accepted;
      verdict = settled.verdict;
    }
    // A call that paused the turn for the user has no result yet: the pause itself shows the batch ran.
    const paused = facts.end.status?.startsWith("awaiting_") === true;
    const batchRuns = (calls.length > 0 || paused) && !facts.suppressed;
    if (batchRuns) {
      calls.forEach((call) => this.#observe(call));
      this.#subGoals.ran(facts);
      if (paused) return decided({ kind: "pause" }, verdict);
      const { progressed, planningOnly, planChanged, unavailableOnly, refusedOnly } = classifyBatch(calls, facts.planChanged === true);
      const workDispatched = calls.some((call) => !call.plan && !call.skipped && call.dispatched === true);
      this.#record = recordedBatch(this.#record!, { progressed, planningOnly, planChanged, unavailableOnly, refusedOnly, workDispatched });
      const after = reviews.find((review) => review.after);
      if (!after) return decided(this.#replayed(this.#decide({ kind: "tools" }), finishReason), verdict);
      const settled = await this.#review(facts, after, final, false);
      if (settled.next) return decided(settled.next, settled.verdict);
      accepted = settled.accepted;
      verdict = settled.verdict;
    }
    const text = facts.answer === "text";
    const completed = batchRuns && calls.length > 0
      || classifyLlmTerminal({ type: "final", content: text ? "text" : null, toolCalls: [], finishReason }) === "completed";
    const answered = this.#decide({ kind: "answer", silent: !text, calledATool: facts.suppressed === true, completed, ...(accepted ? { accepted } : {}) });
    return decided(this.#replayed(answered, finishReason), verdict);
  }

  /** The first step of a resumed run spends the resumed call outside the budget; the loop's ledger opens at the next step. */
  #resumed(facts: StepFacts): StepDecision {
    (facts.calls ?? []).forEach((call) => { this.#wrote ||= call.wrote === true; });
    this.#subGoals.ran(facts);
    const last = this.run.steps.at(-1) === facts;
    const next: Next = facts.end?.status?.startsWith("awaiting_") ? { kind: "pause" } : last ? this.#journal.recordedEnd() : { kind: "continue" };
    return { step: facts.i, mode: "none", next, ledger: this.#view() };
  }

  /** Runs the output review against the recorded policy verdict, and decides the step on what it found as step-disposition.ts does. */
  async #review(facts: StepFacts, review: ReviewFacts, finalBudgetStep: boolean, toolPhase: boolean): Promise<{
    readonly next?: Next; readonly verdict?: ReviewVerdict; readonly accepted?: { readonly outcome?: string; readonly reason?: string };
  }> {
    if (review.phase === "choice-violation") return { verdict: { decision: "unknown" }, next: { kind: "failed", code: "unreplayable-directive" } };
    const journal = this.#journal;
    const closingStep = closesTurn(this.#ledger!);
    const text = review.text ?? (facts.answer === "text" || review.decision === "close");
    const content = !toolPhase && review.answer && text ? `answer-${review.answer}` : null;
    journal.raw = journal.rawDecision(facts, review);
    const outcome: TurnOutputReview = await reviewTurnOutput({
      policy: journal.policy, state: journal.state(facts), directive: {}, selectedTools: [], finalBudgetStep,
      candidate: { content, finishReason: facts.end?.reason ?? "stop", toolCalls: toolPhase ? [{ id: "call", name: "tool", arguments: "{}" }] : [] },
      ...(closingStep ? { closingStep } : {}), signal: journal.signal,
      objections: objectionsHeard(this.#ledger!, this.#record!, { bounds: this.options, countedCalls: this.#toolCalls - this.#ledger!.toolCalls }),
      grantClosingStep: () => !closingStep && this.#readBack(),
    });
    const phase = toolPhase ? "tool-call" : "terminal";
    const finishReason = facts.end?.reason ?? "stop";
    if (outcome.kind === "close") {
      const closed = this.#decide({ kind: "close" });
      return { verdict: { decision: "close", reason: outcome.reason }, next: closed.kind === "end" ? this.#replayed(closed, finishReason) : { kind: "close", reason: outcome.reason } };
    }
    if (outcome.kind === "continue") {
      const answer = phase === "terminal" ? normalizedContentHash(content) : undefined;
      const objection = { kind: "objection", workRemains: outcome.workRemains === true, phase, ...(answer ? { answer } : {}) } as const;
      if (outcome.exhausted && outcome.fallback !== undefined) {
        return { verdict: { decision: "fallback" }, next: this.#replayed(this.#decide({ ...objection, ended: true }), finishReason) };
      }
      return { verdict: { decision: "continue" }, next: this.#replayed(this.#decide({ ...objection, ended: false }), finishReason) };
    }
    const decision = outcome.terminalDecision;
    if (!decision) return {};
    const reason = decision.reason && (GATE_ACCEPTS.has(decision.reason) || decision.reason === "closing-step-objection") ? decision.reason : decision.reason ? "policy" : undefined;
    return { verdict: { decision: "accept", ...(reason ? { reason } : {}) }, accepted: decision };
  }

  /** A review's ask for the read-back step, answered as the loop answers it and recorded for the step's `decide()`. */
  #readBack(): boolean {
    const asked = askReadBack(this.#ledger!, this.#record!, this.options);
    if (!asked) return false;
    this.#record = asked.record;
    return asked.granted;
  }

  #decide(outcome: StepOutcomeFacts): TurnNext {
    const previous = this.#ledger!;
    const undone = this.#subGoals.undone();
    const { ledger, next } = decide(previous, {
      ...this.#record!, outcome, countedCalls: this.#toolCalls - previous.toolCalls, wrote: this.#wrote, ...(undone !== undefined ? { subGoalsUndone: undone } : {}),
    }, this.options);
    if (next.kind === "end" && next.by !== "failure") this.#ended = { partial: next.outcome === "partial", asks: next.ask, undone: undone ?? "no-plan" };
    this.#ledger = ledger;
    this.#next = next;
    this.#record = undefined;
    return next;
  }

  /** What the step leads to, in the replay's terms: a step the loop goes on from is `continue`; ends as the journal writes them. */
  #replayed(next: TurnNext, finishReason: string): Next {
    if (next.kind !== "end") return { kind: "continue" };
    if (next.by === "failure") return { kind: "failed", code: next.reason === NO_TERMINAL_OUTCOME ? "permanent" : next.reason };
    if (next.by === "fallback") return { kind: "end", status: "partial", reason: next.reason, decision: "partial" };
    return { kind: "end", status: next.outcome, decision: next.decision, reason: next.reason ?? finishReason };
  }

  #observe(call: CallFacts): void {
    if (countsAgainstCeiling(call)) this.#toolCalls += 1;
    this.#wrote ||= call.wrote === true;
  }

  #view(): Ledger {
    const ledger = this.#ledger;
    return { granted: ledger?.allowance.granted ?? 0, progressing: ledger ? StepBudget.restore(this.options, ledger.allowance).progressing : true,
      toolCalls: this.#toolCalls, toolCallCeiling: this.options.maxToolCalls };
  }
}
