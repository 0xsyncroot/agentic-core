import type { TurnEndDecision, TurnEndStatus } from "../sessions/core-events.js";
import type { JsonValue } from "../shared/json.js";
import { TOOL_EXECUTION_STATES, type ToolExecutionState } from "../tools/tool.js";
import { WORK_PLAN_STATES, WORK_STEP_STATUSES, type WorkPlanState, type WorkPlanStep } from "./work-plan.js";

export type TurnWorkStatus = TurnEndStatus | "failed" | "in_progress";

export interface TurnWorkTool {
  readonly callId: string;
  readonly executionId: string;
  readonly toolId: string;
  /** The state the call's result recorded, in whichever turn it was written; else its latest reported state. */
  readonly state: ToolExecutionState;
  readonly workStepId?: string;
  readonly initiator?: "policy";
}

export interface TurnWorkPlan {
  readonly planId: string;
  readonly state: WorkPlanState;
  /** Only the steps whose status, description or outcome changed within this turn, in plan order. */
  readonly steps: readonly WorkPlanStep[];
}

/** What one turn did, as history shows it: timing, outcome, the plan steps it moved and the calls it made. */
export interface TurnWork {
  readonly turnId: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly status: TurnWorkStatus;
  readonly decision?: TurnEndDecision;
  /** The paused turn this one resumed. */
  readonly continuesTurnId?: string;
  /** The turn's announcement: its first narration that was not the opening line, a draft a turn-control policy sent back and kept, nor superseded by a later one. */
  readonly narration?: { readonly narrationId: string; readonly content: string };
  readonly plan?: TurnWorkPlan;
  readonly tools: readonly TurnWorkTool[];
}

/** The part of a journal event the projection reads; every SessionEvent is one. */
export interface TurnWorkEvent {
  readonly type: string;
  readonly turnId?: string;
  readonly stepId?: string;
  readonly callId?: string;
  readonly occurredAt?: string;
  readonly payload: JsonValue;
}

type JsonObject = Readonly<Record<string, JsonValue>>;
const TURN_END_STATUSES = new Set<string>(["completed", "partial", "awaiting_approval", "awaiting_interaction"] satisfies TurnEndStatus[]);
const TURN_END_DECISIONS = new Set<string>(["finish", "partial", "budget-reached"] satisfies TurnEndDecision[]);
const TOOL_STATES = new Set<string>(TOOL_EXECUTION_STATES);
const PLAN_STATES = new Set<string>(WORK_PLAN_STATES);
const STEP_STATUSES = new Set<string>(WORK_STEP_STATUSES);
/** How a step ends when a turn-control policy sent its output back, or ended the turn on its fallback. */
const SENT_BACK_STEP_REASONS = new Set(["turn-control-continue", "turn-control-fallback"]);

/** A legacy plan had no lifecycle of its own; the turn that wrote it is the best account of how it ended. */
const LEGACY_PLAN_STATE: Readonly<Record<TurnWorkStatus, WorkPlanState>> = {
  completed: "completed", partial: "stopped", awaiting_approval: "awaiting_user", awaiting_interaction: "awaiting_user",
  failed: "failed", in_progress: "active",
};

function objectOf(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function planSteps(value: JsonValue | undefined): readonly WorkPlanStep[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index): WorkPlanStep => {
    const step = objectOf(entry);
    const outcome = text(step.outcome);
    return {
      // Legacy steps may lack an id; their position is the only identity they ever had.
      id: text(step.id) ?? String(index + 1),
      description: typeof step.description === "string" ? step.description : "",
      status: STEP_STATUSES.has(String(step.status)) ? step.status as WorkPlanStep["status"] : "pending",
      ...(outcome ? { outcome } : {}),
    };
  });
}

function stepChanged(step: WorkPlanStep, before: WorkPlanStep | undefined): boolean {
  return !before || before.status !== step.status || before.description !== step.description || before.outcome !== step.outcome;
}

interface TurnPlanTrace {
  readonly baseline: ReadonlyMap<string, WorkPlanStep>;
  readonly order: number;
  latest: readonly WorkPlanStep[];
  state: WorkPlanState | undefined;
}

interface TurnTrace {
  readonly turnId: string;
  startedAt?: string;
  endedAt?: string;
  status: TurnWorkStatus;
  decision?: TurnEndDecision;
  continuesTurnId?: string;
  readonly narrations: { readonly narrationId: string; readonly content: string; readonly stepId?: string }[];
  /** Steps a turn-control policy sent back: narration journaled in one of them is a kept draft. */
  readonly sentBackSteps: Set<string>;
  readonly plans: Map<string, TurnPlanTrace>;
  readonly executions: string[];
}

interface ExecutionTrace {
  readonly callId: string;
  readonly toolId: string;
  readonly initiator?: "policy";
  state?: ToolExecutionState;
  result?: { readonly state: ToolExecutionState; readonly workStepId?: string };
}

/**
 * Projects journal events onto the work each turn did, for history and result views.
 *
 * Pure and order-driven, like the journal itself: events are read oldest first. A call belongs to
 * the turn of its first intent (an approved call is recorded again when it resumes, under the
 * same execution) and takes its state from its result wherever that was written. A plan step is
 * listed under a turn only when that turn changed it, so a task spread over a pause and its
 * continuations shows each step once per change. A plan journaled before plans had an identity
 * is scoped to its own turn and closed the way that turn ended. The turn's narration is its
 * announcement: a draft answer a turn-control policy sent back and kept on screen is journaled as
 * narration too, in the step that was sent back, and is never taken for it.
 */
export function projectTurnWork(events: readonly TurnWorkEvent[]): readonly TurnWork[] {
  const turns = new Map<string, TurnTrace>();
  const executions = new Map<string, ExecutionTrace>();
  const planSnapshots = new Map<string, readonly WorkPlanStep[]>();
  const planOrder = new Map<string, number>();
  for (const event of events) {
    if (!event.turnId) continue;
    let turn = turns.get(event.turnId);
    if (!turn) {
      turn = { turnId: event.turnId, status: "in_progress", narrations: [], sentBackSteps: new Set(), plans: new Map(), executions: [] };
      turns.set(event.turnId, turn);
    }
    const payload = objectOf(event.payload);
    if (event.type === "turn/start") {
      if (event.occurredAt) turn.startedAt = event.occurredAt;
      const fromTurnId = text(objectOf(payload.continuation).fromTurnId);
      if (fromTurnId) turn.continuesTurnId = fromTurnId;
    } else if (event.type === "turn/end" || event.type === "turn/failed") {
      if (event.occurredAt) turn.endedAt = event.occurredAt;
      turn.status = event.type === "turn/failed" ? "failed"
        : TURN_END_STATUSES.has(String(payload.status)) ? payload.status as TurnEndStatus : "completed";
      if (TURN_END_DECISIONS.has(String(payload.decision))) turn.decision = payload.decision as TurnEndDecision;
    } else if (event.type === "assistant/narration") {
      const narrationId = text(payload.narrationId);
      const content = text(payload.content);
      // The opening line only acknowledges the request: it is not the turn's account of its work.
      if (narrationId && content && payload.opening !== true) turn.narrations.push({ narrationId, content, ...(event.stepId ? { stepId: event.stepId } : {}) });
    } else if (event.type === "assistant/narration-superseded") {
      // A superseded narration left the chat; it leaves the turn's account too.
      const superseded = turn.narrations.findIndex((candidate) => candidate.narrationId === text(payload.narrationId));
      if (superseded >= 0) turn.narrations.splice(superseded, 1);
    } else if (event.type === "step/end") {
      if (event.stepId && SENT_BACK_STEP_REASONS.has(String(payload.reason))) turn.sentBackSteps.add(event.stepId);
    } else if (event.type === "work/plan-updated") {
      const planId = text(payload.planId) ?? `legacy:${event.turnId}`;
      const steps = planSteps(payload.steps);
      if (!planOrder.has(planId)) planOrder.set(planId, planOrder.size);
      let trace = turn.plans.get(planId);
      if (!trace) {
        const before = planSnapshots.get(planId) ?? [];
        trace = { baseline: new Map(before.map((step) => [step.id, step])), order: planOrder.get(planId)!, latest: steps, state: undefined };
        turn.plans.set(planId, trace);
      }
      trace.latest = steps;
      trace.state = PLAN_STATES.has(String(payload.state)) ? payload.state as WorkPlanState : undefined;
      planSnapshots.set(planId, steps);
    } else if (event.type === "tool/intent" || event.type === "tool/state" || event.type === "tool/result") {
      recordToolEvent(event.type, payload, turn, executions, event.callId);
    }
  }
  return [...turns.values()].map((turn) => turnWork(turn, executions));
}

function recordToolEvent(type: string, payload: JsonObject, turn: TurnTrace, executions: Map<string, ExecutionTrace>, envelopeCallId?: string): void {
  const executionId = text(payload.executionId);
  if (!executionId) return;
  const state = TOOL_STATES.has(String(payload.state)) ? payload.state as ToolExecutionState : undefined;
  const known = executions.get(executionId);
  if (type === "tool/intent") {
    if (known) return;
    const callId = text(payload.callId) ?? envelopeCallId;
    const toolId = text(payload.toolId);
    if (!callId || !toolId) return;
    executions.set(executionId, { callId, toolId, ...(payload.initiator === "policy" ? { initiator: "policy" as const } : {}), state: "prepared" });
    turn.executions.push(executionId);
    return;
  }
  // State and result rows of a call whose intent is outside the events cannot be placed in a turn.
  if (!known || !state) return;
  if (type === "tool/state") known.state = state;
  else {
    const workStepId = text(payload.workStepId);
    known.result = { state, ...(workStepId ? { workStepId } : {}) };
  }
}

function turnWork(turn: TurnTrace, executions: ReadonlyMap<string, ExecutionTrace>): TurnWork {
  const startedMs = turn.startedAt ? Date.parse(turn.startedAt) : Number.NaN;
  const endedMs = turn.endedAt ? Date.parse(turn.endedAt) : Number.NaN;
  const durationMs = endedMs - startedMs;
  // A turn that replaced a plan also journaled the old plan's closing state; the newest plan is its own.
  const [planId, trace] = [...turn.plans.entries()].sort(([, left], [, right]) => right.order - left.order)[0] ?? [];
  const narration = turn.narrations.find((candidate) => !candidate.stepId || !turn.sentBackSteps.has(candidate.stepId));
  const tools = turn.executions.map((executionId): TurnWorkTool => {
    const execution = executions.get(executionId)!;
    return {
      callId: execution.callId, executionId, toolId: execution.toolId,
      state: execution.result?.state ?? execution.state ?? "prepared",
      ...(execution.result?.workStepId ? { workStepId: execution.result.workStepId } : {}),
      ...(execution.initiator ? { initiator: execution.initiator } : {}),
    };
  });
  return {
    turnId: turn.turnId,
    ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
    ...(turn.endedAt ? { endedAt: turn.endedAt } : {}),
    ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
    status: turn.status,
    ...(turn.decision ? { decision: turn.decision } : {}),
    ...(turn.continuesTurnId ? { continuesTurnId: turn.continuesTurnId } : {}),
    ...(narration ? { narration: { narrationId: narration.narrationId, content: narration.content } } : {}),
    ...(planId && trace ? { plan: {
      planId,
      state: trace.state ?? LEGACY_PLAN_STATE[turn.status],
      steps: trace.latest.filter((step) => stepChanged(step, trace.baseline.get(step.id))),
    } } : {}),
    tools,
  };
}
