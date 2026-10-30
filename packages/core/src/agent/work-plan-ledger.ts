import type { AgentProgressEvent, EventDraft, JsonValue, SessionEvent, ToolCall, WorkPlan, WorkPlanStep, WorkPlanningProvider, WorkPlanProposal } from "@0xsyncroot/contracts";
import { toJsonValue } from "./json-value.js";
import type { TurnTerminalOutcome, TurnWorkCloser } from "./turn-terminator.js";
import { changedStepIds, unresolvedStepIds } from "./work-plan-merge.js";
import { SubGoalLedger } from "./sub-goal-ledger.js";
import { applyMark, applyProposal, closeDone, closeForOutcome, toWorkPlan, type AppliedProposal, type LedgerPlan, type LedgerState, type PlanEvidence } from "./work-plan-ledger-state.js";
import { restorePlanState } from "./work-plan-restore.js";

export type PlanApplyOutcome =
  | { readonly ok: true; readonly plan: WorkPlan; readonly changedStepIds: readonly string[]; readonly notes: readonly string[]; readonly closedDormant?: WorkPlan }
  | { readonly ok: false; readonly message: string };

export interface WorkPlanLedgerInit {
  readonly turnId: string;
  /** Only a fresh user turn may retire the previous task's dormant plan; a resume never does. */
  readonly isUserTurn: boolean;
  readonly workPlanning: WorkPlanningProvider | undefined;
  readonly events: readonly SessionEvent[];
  readonly taskTurnIds: readonly string[];
  readonly report: (event: AgentProgressEvent) => void;
  /** What the results attributed to each step show (the turn's `SubGoalLedger`); without it no step has a result. */
  readonly evidence?: PlanEvidence;
}

/** The plan a proposal updates: the one this operation owns, else the previous task's unfinished one. */
function planUpdated(state: LedgerState): readonly WorkPlanStep[] | undefined {
  return (state.current ?? state.dormant)?.steps;
}

function parseArguments<T>(raw: string, parse: (args: JsonValue) => T): T | undefined {
  try { return parse(JSON.parse(raw) as JsonValue); }
  catch { return undefined; }
}

/** The provider's marking tool, when it offers one whole: a definition and the parser for its arguments. */
function markingOf(provider: WorkPlanningProvider | undefined): { readonly id: string; readonly parse: NonNullable<WorkPlanningProvider["parseMark"]> } | undefined {
  return provider?.markDefinition && provider.parseMark ? { id: provider.markDefinition.id, parse: provider.parseMark.bind(provider) } : undefined;
}

/**
 * The runtime's own record of the task's work plan, restored once per operation and closed once at
 * its terminal (`TurnWorkCloser`). The model proposes wording through `propose`; everything about
 * identity, matching and closure lives here, per §3.3 — see `work-plan-ledger-state.ts` for the pure
 * merge/close rules and `work-plan-restore.ts` for how an operation finds its starting state.
 */
export class WorkPlanLedger implements TurnWorkCloser {
  #state: LedgerState;
  #touched = false;
  readonly #turnId: string;
  readonly #isUserTurn: boolean;
  readonly #workPlanning: WorkPlanningProvider | undefined;
  readonly #report: (event: AgentProgressEvent) => void;
  readonly #evidence: PlanEvidence;

  private constructor(init: WorkPlanLedgerInit, state: LedgerState) {
    this.#turnId = init.turnId;
    this.#evidence = init.evidence ?? new SubGoalLedger();
    this.#isUserTurn = init.isUserTurn;
    this.#workPlanning = init.workPlanning;
    this.#report = init.report;
    this.#state = state;
  }

  /** Restores the plan this operation starts with and reports a reopened one — never journaled, per §3.3. */
  static restore(init: WorkPlanLedgerInit): WorkPlanLedger {
    const { state, reopened } = restorePlanState(init.events, init.taskTurnIds);
    const ledger = new WorkPlanLedger(init, state);
    if (reopened) ledger.#report({ type: "plan-updated", turnId: init.turnId, plan: reopened, cause: "restore" });
    return ledger;
  }

  /** The active plan this operation owns, or the untouched dormant plan a matching proposal would continue. */
  get workPlan(): WorkPlan | undefined {
    const plan = this.#state.current ?? this.#state.dormant;
    return plan ? toWorkPlan(plan) : undefined;
  }

  /** The plan this operation owns; never the dormant plan of a previous task, which no call of this operation works under. */
  get currentPlan(): WorkPlan | undefined {
    return this.#state.current ? toWorkPlan(this.#state.current) : undefined;
  }

  /** A call that changes the plan: a whole-plan update or a step mark. Neither is dispatched; both are applied here. */
  isPlanningCall(toolName: string): boolean {
    return this.#workPlanning !== undefined && (toolName === this.#workPlanning.definition.id || this.isMarkCall(toolName));
  }

  /** A call that changes one step's status and outcome by its id (`mark`). */
  isMarkCall(toolName: string): boolean {
    return markingOf(this.#workPlanning)?.id === toolName;
  }

  /** The plan step work is being done under right now; a dormant plan is never stamped. */
  currentStepId(): string | undefined {
    return this.#state.current?.steps.find((step) => step.status === "in_progress")?.id;
  }

  /**
   * The plan a step's planning calls would produce, without changing the ledger.
   *
   * Applies every parsable planning call in the step in order, on a scratch copy of the state, so
   * the result matches exactly what `propose` would leave behind once the batch actually runs.
   * `undefined` when the step has no planning call, or none of them parse.
   */
  previewProposals(calls: readonly ToolCall[]): WorkPlan | undefined {
    const provider = this.#workPlanning;
    if (!provider) return undefined;
    const planning = calls.filter((call) => this.isPlanningCall(call.name));
    let state = this.#state;
    let produced: LedgerPlan | undefined;
    const marking = markingOf(provider);
    for (const call of planning) {
      let applied: AppliedProposal | undefined;
      if (marking && call.name === marking.id) {
        // `mark` refuses a step the plan lacks, so the batch never applies it.
        const mark = parseArguments(call.arguments, marking.parse);
        applied = mark ? applyMark(state, mark) : undefined;
      } else {
        const parsed = parseArguments(call.arguments, (args) => provider.parseProposal(args));
        // `propose` refuses a proposal naming a step the plan lacks, so the batch never applies it.
        applied = parsed && unresolvedStepIds(planUpdated(state), parsed).length === 0 ? applyProposal(state, parsed, this.#isUserTurn) : undefined;
      }
      if (!applied) continue;
      state = applied.next;
      produced = applied.plan;
    }
    return produced ? toWorkPlan(produced) : undefined;
  }

  /** Applies a planning call's own arguments; never throws. A parse failure leaves the plan unchanged. */
  propose(args: JsonValue): PlanApplyOutcome {
    if (!this.#workPlanning) return { ok: false, message: "No work-planning provider is mounted" };
    let proposal: WorkPlanProposal;
    try { proposal = this.#workPlanning.parseProposal(args); }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
    const unresolved = unresolvedStepIds(planUpdated(this.#state), proposal);
    if (unresolved.length > 0) {
      // Worded as the tool-input check words a missing field: the model repairs its call after a refusal in this form, and
      // repeats it unchanged after a prose one (docs/incidents/2026-10-17-core-plan-update-refused.md).
      // The path is the proposal's own (`WorkPlanProposal.steps[i]`); a provider's parseProposal keeps the order the model sent.
      const missing = proposal.steps.flatMap((step, index) => step.description === undefined && unresolved.includes(step.id)
        ? [`$.steps[${index}].description is required (no step in the plan has the id "${step.id}")`] : []);
      return { ok: false, message: `Invalid tool input: ${missing.join("; ")}` };
    }
    const applied = applyProposal(this.#state, proposal, this.#isUserTurn);
    this.#state = applied.next;
    this.#touched = true;
    return {
      ok: true, plan: toWorkPlan(applied.plan), changedStepIds: applied.changedStepIds, notes: applied.notes,
      ...(applied.closedDormant ? { closedDormant: toWorkPlan(applied.closedDormant) } : {}),
    };
  }

  /**
   * Applies a marking call's own arguments: one step's status and outcome by its id onto the plan, nothing else touched; never
   * throws. Refused when there is no plan yet or no step has the id, naming the plan's step ids; the plan is then unchanged.
   */
  mark(args: JsonValue): PlanApplyOutcome {
    const marking = markingOf(this.#workPlanning);
    if (!this.#workPlanning || !marking) return { ok: false, message: "No step-marking tool is mounted" };
    let mark: ReturnType<typeof marking.parse>;
    try { mark = marking.parse(args); }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
    const steps = planUpdated(this.#state);
    if (!steps) return { ok: false, message: `Invalid tool input: there is no plan yet; publish it with ${this.#workPlanning.definition.id} first` };
    const applied = applyMark(this.#state, mark);
    if (!applied) {
      return { ok: false, message: `Invalid tool input: $.id "${mark.id}" names no step of the plan; its step ids are ${steps.map((step) => `"${step.id}"`).join(", ")}` };
    }
    this.#state = applied.next;
    this.#touched = true;
    return { ok: true, plan: toWorkPlan(applied.plan), changedStepIds: applied.changedStepIds, notes: applied.notes };
  }

  /** A non-planning call reached the broker this operation: `close("failed")` may now write, per §10.5. */
  noteNonPlanningDispatch(): void { this.#touched = true; }

  /** Closes the operation's own plan at the turn's terminal, per §3.3/§10.5. A dormant-only plan is never closed. */
  async close(outcome: TurnTerminalOutcome): Promise<readonly EventDraft[]> {
    const current = this.#state.current;
    if (!current) return [];
    if (outcome.kind === "failed" && !this.#touched) return [];
    return this.#settle(current, closeForOutcome(current, outcome, this.#evidence));
  }

  /**
   * A terminal answer was reached: before its review reads the plan, every step the model left behind that a settled, non-failed
   * call shows done is completed, status only (`closeDone`); the step in progress stays as the model left it for the review to
   * judge. The close stands if the answer is sent back: the evidence does not change with the answer. The rows to journal, in
   * the terminal close's shape. Only the plan this operation owns closes; an earlier task's plan is never touched.
   */
  closeDoneSteps(): readonly EventDraft[] {
    const current = this.#state.current;
    return current ? this.#settle(current, closeDone(current, this.#evidence)) : [];
  }

  #settle(current: LedgerPlan, closed: LedgerPlan | undefined): readonly EventDraft[] {
    if (!closed) return [];
    this.#state = { ...this.#state, current: closed };
    const changed = changedStepIds(current.steps, closed.steps);
    const plan = toWorkPlan(closed);
    this.#report({ type: "plan-updated", turnId: this.#turnId, plan, cause: "terminal", ...(changed.length > 0 ? { changedStepIds: changed } : {}) });
    return [{
      type: "work/plan-updated", turnId: this.#turnId,
      payload: toJsonValue({ ...plan, cause: "terminal", ...(changed.length > 0 ? { changedStepIds: changed } : {}) }),
    }];
  }
}
