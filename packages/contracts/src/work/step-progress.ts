import type { JsonValue } from "../shared/json.js";
import { TOOL_TERMINAL_EXECUTION_STATES, type ToolDefinition, type ToolTerminalExecutionState } from "../tools/tool.js";
import { WORK_PLAN_LIMITS, WORK_STEP_ID_PATTERN, WORK_STEP_STATUSES, type WorkStepStatus } from "./work-plan.js";

/** One call of a model step as the sub-goal ledger records it: ids, its terminal state and flags, never its arguments or result. */
export interface SubGoalCall {
  readonly callId: string;
  readonly toolId: string;
  readonly state: ToolTerminalExecutionState;
  readonly sideEffect: ToolDefinition["sideEffect"] | "unknown";
  /** The call did not do what it was asked (`attemptFailure`): an error, a refusal, or a result that says so, a partial write included. */
  readonly failed?: true;
  /** The call succeeded and changed the scope the step's later calls were chosen against (`ToolCompletedResponse.halt`). */
  readonly halted?: true;
}

/**
 * A sub-goal, which is one step of the work plan: the status the model gave it beside what the results attributed to it show.
 * `shown` is the runtime's: a call of the model attributed to the step did what it was asked and its latest state-changing
 * call did not fail; a step with no attributed call is shown when the plan's own close rule would complete it (in progress or
 * claimed done, and no step of the plan left pending).
 */
export interface SubGoalProgress {
  readonly id: string;
  readonly claimed: WorkStepStatus;
  readonly shown: boolean;
  /** A state-changing call attributed to the step did what it was asked, in this task. */
  readonly wrote: boolean;
  /** The calls of this model step attributed to the step. */
  readonly calls: readonly SubGoalCall[];
}

/**
 * `work/step-progress`: after a model step's calls, each sub-goal of the plan the operation works under. Ids, statuses and
 * flags only: no description, goal or outcome, which are user-facing text written from tenant data.
 */
export interface WorkStepProgressPayload {
  readonly planId: string;
  readonly revision: number;
  readonly subGoals: readonly SubGoalProgress[];
}

const SIDE_EFFECTS = new Set<string>(["none", "idempotent", "nonIdempotent", "unknown"]);
const TERMINAL_STATES = new Set<string>(TOOL_TERMINAL_EXECUTION_STATES);
const STEP_STATUSES = new Set<string>(WORK_STEP_STATUSES);
/** Longest call id the record keeps; ids only, so a longer value is not an id. */
const ID_CHARS = 200;
/** What a tool id looks like: a code identifier, never free text. */
export const STEP_PROGRESS_TOOL_ID_PATTERN = /^[a-z][a-z0-9_-]{0,79}$/u;
/** The tool id recorded for a call whose name is not a code identifier, such as a name the model wrote that no tool carries. */
export const UNRECOGNIZED_TOOL_ID = "unrecognized";

/** The tool id the record keeps for a call named `name`. */
export function stepProgressToolId(name: string): string {
  return STEP_PROGRESS_TOOL_ID_PATTERN.test(name) ? name : UNRECOGNIZED_TOOL_ID;
}

type JsonObject = Record<string, JsonValue>;
const isObject = (value: JsonValue | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: JsonValue | undefined): boolean => typeof value === "string" && value.length > 0 && value.length <= ID_CHARS;
const flag = (value: JsonValue | undefined): boolean => value === undefined || value === true;
/** Only the named fields: a field outside them could carry text, which this record never holds. */
const only = (value: JsonObject, keys: ReadonlySet<string>): boolean => Object.keys(value).every((key) => keys.has(key));
const CALL_KEYS = new Set(["callId", "toolId", "state", "sideEffect", "failed", "halted"]);
const SUB_GOAL_KEYS = new Set(["id", "claimed", "shown", "wrote", "calls"]);
const PAYLOAD_KEYS = new Set(["planId", "revision", "subGoals"]);

function validCall(value: JsonValue): boolean {
  return isObject(value) && only(value, CALL_KEYS) && id(value.callId) && typeof value.toolId === "string" && STEP_PROGRESS_TOOL_ID_PATTERN.test(value.toolId) && TERMINAL_STATES.has(String(value.state)) &&
    SIDE_EFFECTS.has(String(value.sideEffect)) && flag(value.failed) && flag(value.halted);
}

function validSubGoal(value: JsonValue): boolean {
  return isObject(value) && only(value, SUB_GOAL_KEYS) && typeof value.id === "string" && WORK_STEP_ID_PATTERN.test(value.id) && STEP_STATUSES.has(String(value.claimed)) &&
    typeof value.shown === "boolean" && typeof value.wrote === "boolean" && Array.isArray(value.calls) && value.calls.every(validCall);
}

/** The journal boundary for the sub-goal ledger's facts: `work/step-progress`, and the `halt` a `tool/result` carries. */
export function assertValidWorkProgressFacts(type: string, payload: JsonObject): void {
  if (type === "tool/result" && payload.halt !== undefined && payload.halt !== "state-changed") {
    throw new Error("tool/result halt must be state-changed");
  }
  if (type !== "work/step-progress") return;
  const subGoals = payload.subGoals;
  if (!only(payload, PAYLOAD_KEYS) || typeof payload.planId !== "string" || !payload.planId || !Number.isInteger(payload.revision) || Number(payload.revision) < 1 ||
      !Array.isArray(subGoals) || subGoals.length > WORK_PLAN_LIMITS.steps || !subGoals.every(validSubGoal) ||
      new Set(subGoals.map((goal) => (goal as JsonObject).id)).size !== subGoals.length) {
    throw new Error("work/step-progress requires planId, a positive revision and unique sub-goals of ids, statuses and flags only");
  }
}
