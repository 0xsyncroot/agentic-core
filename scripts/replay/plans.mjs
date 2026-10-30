import { token } from "./enums.mjs";

/** A plan snapshot as facts: its state, what wrote it, and per step an ordinal and a status. */
export function planFacts(payload, planIds) {
  return { state: token(payload.state), ...(payload.cause ? { cause: token(payload.cause) } : {}),
    steps: (payload.steps ?? []).map((step) => ({ id: planIds.of(step.id), status: token(step.status) })) };
}

/** Whether each step's plan calls left the work plan's goal and steps different from what they were before the step. */
export function planChanges(sessionRows, stepsById) {
  const changed = new Map();
  let shape = "";
  for (const row of sessionRows) {
    if (row.type !== "work/plan-updated") continue;
    const next = JSON.stringify({ goal: row.p.goal, steps: row.p.steps });
    const step = stepsById.get(row.step_id);
    if (step && next !== shape) changed.set(step, true);
    shape = next;
  }
  return changed;
}

/** The plan in effect when each turn began and the plan updates each turn wrote, in journal order. */
export function plansByTurn(sessionRows) {
  const plans = new Map();
  let current;
  for (const row of sessionRows) {
    if (!row.turn_id) continue;
    if (!plans.has(row.turn_id)) plans.set(row.turn_id, { start: current, updates: [] });
    if (row.type !== "work/plan-updated") continue;
    current = row.p;
    plans.get(row.turn_id).updates.push({ stepId: row.step_id, payload: row.p });
  }
  return plans;
}
