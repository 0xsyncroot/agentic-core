import { EXTENSION_WINDOW, type StepBudget } from "./step-budget.js";

/**
 * Short, factual note handed to the model so it can steer instead of being truncated. Two independent
 * facts: the last steps learned nothing, and the allowance is close to running out. Either holds
 * without the other, so the note carries whichever do, and is omitted when neither does.
 */
export function stepBudgetNotice(budget: StepBudget, stepIndex: number): string | undefined {
  const clauses = [stallClause(budget), allowanceClause(budget, stepIndex)].filter((clause) => clause !== undefined);
  return clauses.length > 0 ? clauses.join(" ") : undefined;
}

/** That the last steps learned nothing, from the second repeat: told at the first, it reads "answer now" beside an audit's "keep going". */
function stallClause(budget: StepBudget): string | undefined {
  if (budget.progressing) return undefined;
  return `The last ${budget.stalls} steps returned only observations this turn already had. Repeating those calls cannot add anything:`
    + " gather something you genuinely do not have yet, or answer now with what you have.";
}

/**
 * Only a limit that binds is stated: the hard ceiling, or an allowance that stopped growing. A self-extending one is no
 * limit, and "N steps left, otherwise answer now" beside it pushes the model to stop early. Codex and Gemini CLI state no
 * budget.
 */
function allowanceClause(budget: StepBudget, stepIndex: number): string | undefined {
  const remaining = budget.remainingAfter(stepIndex);
  if (remaining > EXTENSION_WINDOW) return undefined;
  const atCeiling = budget.granted >= budget.ceiling;
  if (!atCeiling && budget.progressing) return undefined;
  const reason = atCeiling
    ? "this turn has reached its hard step ceiling"
    : "an allowance only grows on steps that observe something new";
  return `You have ${remaining} tool-calling step(s) left for this turn and ${reason}.`
    + " Spend them on the single most valuable remaining call, then answer with what you have and state"
    + " explicitly what is still unverified.";
}
