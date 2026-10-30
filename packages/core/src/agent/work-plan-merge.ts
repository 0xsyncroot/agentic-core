import { WORK_PLAN_LIMITS, type WorkPlanProposal, type WorkPlanStep, type WorkStepStatus } from "@0xsyncroot/contracts";

/**
 * How a proposal is read against the plan it may update.
 *
 * `active` is the plan of this task: a step keeps its identity by id, then by wording, then by
 * place. `dormant` is the unfinished plan of the previous task, which a new message may or may
 * not continue: only the wording can tell, since a fresh plan numbers its steps from 1 again.
 */
export type PlanMatching = "active" | "dormant";

export interface MergedProposal {
  readonly goal: string;
  readonly steps: readonly WorkPlanStep[];
  /** How many proposed steps were recognised as steps of the base plan. */
  readonly matched: number;
  /** What the runtime changed in the proposal, in English, for the model to read with the result. */
  readonly notes: readonly string[];
}

const MAX_NOTES = 20;

/** Wording as matching reads it: trimmed, single-spaced, case-folded. */
export function normalizedWording(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function cut(value: string, limit: number, what: string, notes: string[]): string {
  if (value.length <= limit) return value;
  notes.push(`The ${what} was cut to ${limit} characters.`);
  return value.slice(0, limit);
}

/**
 * The id as the runtime can carry it (`WORK_STEP_ID_PATTERN`): accents folded, every other
 * character outside the safe set turned into "-", leading punctuation dropped. Deterministic, so
 * the model's own id maps to the same step every time it sends it.
 */
function safeStepId(raw: string, position: number): string {
  const folded = raw.normalize("NFD").replace(/\p{M}+/gu, "");
  const safe = folded.replace(/[^A-Za-z0-9._:-]+/gu, "-").replace(/^[^A-Za-z0-9]+/u, "").slice(0, WORK_PLAN_LIMITS.id);
  return safe || `step-${position}`;
}

function uniqueId(id: string, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) return id;
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${id.slice(0, WORK_PLAN_LIMITS.id - tail.length)}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The base step a proposed step names by its id, as the runtime would carry that id. */
function namedStep(base: readonly WorkPlanStep[] | undefined, id: string, position: number): WorkPlanStep | undefined {
  const safe = safeStepId(id, position);
  return base?.find((baseStep) => baseStep.id === safe);
}

/**
 * Ids of proposed steps that carry no description and name no step of the base plan: a description
 * the runtime has nowhere to take from. The caller refuses such a proposal before merging it.
 */
export function unresolvedStepIds(base: readonly WorkPlanStep[] | undefined, proposal: WorkPlanProposal): readonly string[] {
  return proposal.steps.flatMap((step, index) =>
    step.description === undefined && !namedStep(base, step.id, index + 1) ? [step.id] : []);
}

/**
 * The proposal's steps each with a description: one sent without it takes the stored description of
 * the base step with the same id. Total: a step that names nothing (the caller refuses those) is
 * described by its id, so a merge never throws.
 */
function described(base: readonly WorkPlanStep[] | undefined, proposal: WorkPlanProposal): readonly WorkPlanStep[] {
  return proposal.steps.map((step, index): WorkPlanStep => ({
    ...step, description: step.description ?? namedStep(base, step.id, index + 1)?.description ?? step.id,
  }));
}

/** The proposal cut to the plan's limits, each step with an id the runtime can carry. */
function boundedSteps(steps: readonly WorkPlanStep[], notes: string[]): readonly WorkPlanStep[] {
  const taken = new Set<string>();
  return steps.map((step, index): WorkPlanStep => {
    const safe = safeStepId(step.id, index + 1);
    const id = uniqueId(safe, taken);
    taken.add(id);
    if (id !== step.id) notes.push(`Step id "${step.id.slice(0, 40)}" is "${id}" (ids use only letters, digits, ".", "_", ":" and "-", and are unique).`);
    const outcome = step.outcome === undefined ? undefined : cut(step.outcome, WORK_PLAN_LIMITS.outcome, `outcome of step "${id}"`, notes);
    return {
      id, status: step.status,
      description: cut(step.description, WORK_PLAN_LIMITS.description, `description of step "${id}"`, notes),
      ...(outcome ? { outcome } : {}),
    };
  });
}

/**
 * Which base step each proposed step continues, by proposed index.
 *
 * Wording that names one step exactly outranks an id that names another: when a model renumbers
 * its steps it keeps what they say, and an id collision would otherwise hand one step's history to
 * another. An id alone still identifies a step whose wording was rewritten, and a step in the same
 * place is the last resort for a plan whose ids and wording both changed.
 */
function matchSteps(base: readonly WorkPlanStep[], proposed: readonly WorkPlanStep[], matching: PlanMatching): ReadonlyMap<number, number> {
  const matches = new Map<number, number>();
  const used = new Set<number>();
  const link = (proposedIndex: number, baseIndex: number) => { matches.set(proposedIndex, baseIndex); used.add(baseIndex); };
  const pass = (accepts: (step: WorkPlanStep, baseStep: WorkPlanStep, proposedIndex: number, baseIndex: number) => boolean) => {
    proposed.forEach((step, proposedIndex) => {
      if (matches.has(proposedIndex)) return;
      const baseIndex = base.findIndex((baseStep, index) => !used.has(index) && accepts(step, baseStep, proposedIndex, index));
      if (baseIndex >= 0) link(proposedIndex, baseIndex);
    });
  };
  const sameWording = (step: WorkPlanStep, baseStep: WorkPlanStep) => normalizedWording(step.description) === normalizedWording(baseStep.description);
  if (matching === "active") pass((step, baseStep) => step.id === baseStep.id && sameWording(step, baseStep));
  pass(sameWording);
  if (matching === "active") {
    pass((step, baseStep) => step.id === baseStep.id);
    pass((_step, _baseStep, proposedIndex, baseIndex) => proposedIndex === baseIndex);
  }
  return matches;
}

/** A proposed step read as the continuation of a base step: its identity kept, its completion never undone. */
function continued(step: WorkPlanStep, baseStep: WorkPlanStep, notes: string[]): WorkPlanStep {
  if (step.id !== baseStep.id) notes.push(`Step "${step.id}" continues step "${baseStep.id}" and keeps that id.`);
  if (baseStep.status === "completed") {
    if (step.status !== "completed" || normalizedWording(step.description) !== normalizedWording(baseStep.description)) {
      notes.push(`Step "${baseStep.id}" is already completed; it stays completed with its description.`);
    }
    const outcome = baseStep.outcome ?? step.outcome;
    return { id: baseStep.id, description: baseStep.description, status: "completed", ...(outcome ? { outcome } : {}) };
  }
  // The outcome of a step in progress says what it starts; completing the step without a result of its own does not make that its result.
  const startsOnly = baseStep.status === "in_progress" && step.status === "completed";
  const outcome = step.outcome ?? (startsOnly ? undefined : baseStep.outcome);
  return { id: baseStep.id, description: step.description, status: step.status, ...(outcome ? { outcome } : {}) };
}

interface Placed {
  readonly step: WorkPlanStep;
  /** The base step it continues; absent for a step the proposal added. */
  readonly baseIndex?: number;
}

/**
 * The proposal laid over the base plan. Completed base steps the proposal left out are carried
 * forward after the step they followed; unfinished ones it left out are dropped, since the model
 * changed its approach. A step the proposal added never takes an id a kept step holds.
 */
function laidOver(base: readonly WorkPlanStep[], proposed: readonly WorkPlanStep[], matches: ReadonlyMap<number, number>, notes: string[]): WorkPlanStep[] {
  const placed: Placed[] = proposed.map((step, proposedIndex) => {
    const baseIndex = matches.get(proposedIndex);
    return baseIndex === undefined ? { step } : { step: continued(step, base[baseIndex]!, notes), baseIndex };
  });
  base.forEach((baseStep, baseIndex) => {
    if (baseStep.status !== "completed" || placed.some((entry) => entry.baseIndex === baseIndex)) return;
    notes.push(`Completed step "${baseStep.id}" was missing from the update; it was kept.`);
    let anchor = -1;
    placed.forEach((entry, index) => { if (entry.baseIndex !== undefined && entry.baseIndex < baseIndex) anchor = index; });
    placed.splice(anchor + 1, 0, { step: baseStep, baseIndex });
  });
  const kept = new Set(placed.flatMap((entry) => entry.baseIndex === undefined ? [] : [entry.step.id]));
  const taken = new Set(placed.map((entry) => entry.step.id));
  return placed.map((entry) => {
    if (entry.baseIndex !== undefined || !kept.has(entry.step.id)) return entry.step;
    const id = uniqueId(entry.step.id, taken);
    taken.add(id);
    notes.push(`Step id "${entry.step.id}" belongs to another step; the new step is "${id}".`);
    return { ...entry.step, id };
  });
}

/** One step in progress while work remains: the one just marked so, else the first one the model marked, else the first pending. */
function withOneStepInProgress(steps: WorkPlanStep[], notes: string[], marked?: WorkPlanStep): WorkPlanStep[] {
  const inProgress = steps.filter((step) => step.status === "in_progress");
  if (inProgress.length > 1) {
    const kept = marked && inProgress.includes(marked) ? marked : inProgress[0];
    const others = inProgress.filter((step) => step !== kept);
    notes.push(`Only one step can be in progress; ${others.map((step) => `"${step.id}"`).join(", ")} set back to pending.`);
    return steps.map((step) => others.includes(step) ? { ...step, status: "pending" } : step);
  }
  if (inProgress.length === 0) {
    const next = steps.find((step) => step.status === "pending");
    if (next) {
      notes.push(`No step was in progress; "${next.id}" is now in progress.`);
      return steps.map((step) => step === next ? { ...step, status: "in_progress" } : step);
    }
  }
  return steps;
}

/**
 * A proposal made into a plan the runtime can keep, against the base plan it updates (none for a
 * new plan). Never throws: whatever the model sent that the plan cannot hold is changed, and each
 * change is noted for the model, which reads the plan as it now stands.
 */
export function mergeProposal(base: readonly WorkPlanStep[] | undefined, proposal: WorkPlanProposal, matching: PlanMatching): MergedProposal {
  const notes: string[] = [];
  const goal = cut(proposal.goal, WORK_PLAN_LIMITS.goal, "goal", notes);
  const proposed = boundedSteps(described(base, proposal), notes);
  const matches = base ? matchSteps(base, proposed, matching) : new Map<number, number>();
  let steps = base ? laidOver(base, proposed, matches, notes) : [...proposed];
  if (steps.length > WORK_PLAN_LIMITS.steps) {
    notes.push(`A plan holds at most ${WORK_PLAN_LIMITS.steps} steps; the first ${WORK_PLAN_LIMITS.steps} were kept.`);
    steps = steps.slice(0, WORK_PLAN_LIMITS.steps);
  }
  steps = withOneStepInProgress(steps, notes);
  return { goal, steps, matched: matches.size, notes: [...new Set(notes)].slice(0, MAX_NOTES) };
}

/** The step of `base` an id names: as the plan shows it, else as the runtime would carry the id the model first wrote. */
export function stepNamedBy(base: readonly WorkPlanStep[], id: string): WorkPlanStep | undefined {
  return base.find((step) => step.id === id) ?? namedStep(base, id, 0);
}

/**
 * One step's status and outcome set by its id, every other step and all descriptions kept: progress without restating the
 * plan. A completed step stays completed with its outcome, as in a merge; then one step is in progress, the marked one when
 * it was marked so. `target` is a step of `base` (`stepNamedBy`).
 */
export function markStep(
  base: readonly WorkPlanStep[], target: WorkPlanStep, mark: { readonly status: WorkStepStatus; readonly outcome: string },
): { readonly steps: readonly WorkPlanStep[]; readonly notes: readonly string[] } {
  const notes: string[] = [];
  let marked = target;
  if (target.status === "completed") {
    if (mark.status !== "completed" || mark.outcome !== target.outcome) notes.push(`Step "${target.id}" is already completed; it stays completed with its outcome.`);
  } else marked = { ...target, status: mark.status, outcome: cut(mark.outcome, WORK_PLAN_LIMITS.outcome, `outcome of step "${target.id}"`, notes) };
  const steps = withOneStepInProgress(base.map((step) => step === target ? marked : step), notes, marked);
  return { steps, notes };
}

/** Steps whose status, description or outcome differs from the plan before, new steps included. */
export function changedStepIds(before: readonly WorkPlanStep[], after: readonly WorkPlanStep[]): readonly string[] {
  const previous = new Map(before.map((step) => [step.id, step]));
  return after.filter((step) => {
    const was = previous.get(step.id);
    return !was || was.status !== step.status || was.description !== step.description || was.outcome !== step.outcome;
  }).map((step) => step.id);
}
