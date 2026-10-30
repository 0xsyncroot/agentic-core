import { WORK_PLAN_STATES, type SessionEvent, type WorkPlan, type WorkPlanState } from "@0xsyncroot/contracts";
import { taskTurnIdsFor, turnContinuation } from "./task-turns.js";
import { toWorkPlan, type LedgerPlan, type LedgerState } from "./work-plan-ledger-state.js";

const PLAN_STATES = new Set<string>(WORK_PLAN_STATES);

function payloadOf(event: SessionEvent): Readonly<Record<string, unknown>> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Readonly<Record<string, unknown>>
    : {};
}

/** A plan-identified `work/plan-updated` payload read back as the ledger's own shape; a legacy or malformed one is not restorable. */
function planOf(event: SessionEvent): LedgerPlan | undefined {
  const payload = payloadOf(event);
  if (typeof payload.planId !== "string" || !payload.planId || typeof payload.revision !== "number" ||
      typeof payload.state !== "string" || !PLAN_STATES.has(payload.state)) {
    return undefined;
  }
  return {
    planId: payload.planId, revision: payload.revision, state: payload.state as WorkPlanState,
    goal: typeof payload.goal === "string" ? payload.goal : "",
    steps: Array.isArray(payload.steps) ? payload.steps as LedgerPlan["steps"] : [],
    updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : new Date(0).toISOString(),
  };
}

function isOpen(plan: LedgerPlan): boolean {
  return plan.state === "active" || plan.state === "awaiting_user";
}

/** The most recent `work/plan-updated` event in the raw tail, whichever turn wrote it. */
function latestPlanEvent(events: readonly SessionEvent[]): SessionEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.type === "work/plan-updated") return events[index];
  }
  return undefined;
}

/**
 * The root (non-continuation) turn nearest before `beforeSeq`: the immediately preceding task's
 * first turn, per §10.7. `undefined` when the current task's own root is outside the bounded tail
 * — the walk has reached the view's edge and nothing further back can be known.
 */
function previousRootTurnId(events: readonly SessionEvent[], beforeSeq: number): string | undefined {
  let candidate: string | undefined;
  let candidateSeq = -1;
  for (const event of events) {
    if (event.type !== "turn/start" || !event.turnId || event.seq >= beforeSeq) continue;
    if (turnContinuation(events, event.turnId)) continue;
    if (event.seq > candidateSeq) { candidate = event.turnId; candidateSeq = event.seq; }
  }
  return candidate;
}

/**
 * The plan state an operation starts with, per §3.3/§10.7: the latest plan in the raw tail is
 * `active` when it belongs to this operation's own task chain and is still open, `dormant` when it
 * is the immediately preceding task's unfinished plan, and otherwise not restored at all — an older
 * plan, one already closed, or a legacy payload with no identity.
 */
export function restorePlanState(events: readonly SessionEvent[], taskTurnIds: readonly string[]): { readonly state: LedgerState; readonly reopened?: WorkPlan } {
  const event = latestPlanEvent(events);
  const plan = event ? planOf(event) : undefined;
  if (!event?.turnId || !plan || !isOpen(plan)) return { state: {} };
  if (taskTurnIds.includes(event.turnId)) return { state: { current: plan }, reopened: toWorkPlan(plan) };
  const currentRoot = taskTurnIds[0];
  const rootSeq = currentRoot ? events.find((candidate) => candidate.type === "turn/start" && candidate.turnId === currentRoot)?.seq : undefined;
  if (rootSeq === undefined) return { state: {} };
  const previousRoot = previousRootTurnId(events, rootSeq);
  const planRoot = taskTurnIdsFor(events, event.turnId)[0];
  return previousRoot && planRoot === previousRoot ? { state: { dormant: plan } } : { state: {} };
}
