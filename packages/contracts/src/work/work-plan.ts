import type { JsonValue } from "../shared/json.js";
import type { ToolDefinition } from "../tools/tool.js";

/** `blocked`: tried and cannot be done now; the outcome says what blocks it. Never written as completed (OpenClaw progress card, Gemini write_todos). */
export const WORK_STEP_STATUSES = ["pending", "in_progress", "completed", "blocked"] as const;
export type WorkStepStatus = typeof WORK_STEP_STATUSES[number];

export interface WorkPlanStep {
  readonly id: string;
  readonly description: string;
  readonly status: WorkStepStatus;
  /** What the step found or did, in the model's words. Results go here, never into the description. */
  readonly outcome?: string;
}

/**
 * Lifecycle of a plan, owned by the runtime rather than the model.
 *
 * `active` is being worked on; `awaiting_user` stopped at a question or an approval and resumes
 * with the answer; the other three are closed and never reopen.
 */
export const WORK_PLAN_STATES = ["active", "awaiting_user", "completed", "stopped", "failed"] as const;
export type WorkPlanState = typeof WORK_PLAN_STATES[number];

/** Why a plan snapshot was produced: a model proposal, a reopen at operation start, or a terminal close. */
export const WORK_PLAN_CAUSES = ["proposal", "restore", "terminal"] as const;
export type WorkPlanCause = typeof WORK_PLAN_CAUSES[number];

export interface WorkPlan {
  /** Runtime identity of the plan. Absent only on payloads journaled before plans had one. */
  readonly planId?: string;
  /** Starts at 1 for a new plan and grows with every journaled change. Absent only on legacy payloads. */
  readonly revision?: number;
  /** Absent only on legacy payloads, which are treated as closed. */
  readonly state?: WorkPlanState;
  readonly goal: string;
  readonly steps: readonly WorkPlanStep[];
  readonly updatedAt: string;
}

/**
 * Sizes a plan may have once the runtime has normalized it.
 *
 * Part of the contract because three parties must agree on them: the ledger truncates to them,
 * the journal boundary refuses anything larger, and clients size their checklist by them.
 */
export const WORK_PLAN_LIMITS = Object.freeze({ steps: 20, id: 100, description: 300, outcome: 500, goal: 300 });

/**
 * Step ids the runtime emits. The model's ids are rewritten to this shape (other characters
 * become "-"), so delivery layers that only pass safe identifiers never drop a step.
 */
export const WORK_STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;

/**
 * A plan as the model wrote it: wording and order only. Identity, scope and closure are the runtime's.
 * A step may name an existing step by its id alone; the runtime then keeps the stored description.
 */
export interface WorkPlanProposal {
  readonly goal: string;
  readonly steps: readonly {
    readonly id: string;
    readonly description?: string;
    readonly status: WorkStepStatus;
    readonly outcome?: string;
  }[];
}

/**
 * Optional task-level planning capability. Core depends on this neutral port;
 * a base or product plugin owns the concrete planning tool and its wording.
 *
 * Core never dispatches the planning tool: it reads the call's arguments through `parseProposal`,
 * applies them to the plan it keeps, and records that plan as the call's result. The provider
 * therefore has no say over identity, matching, limits or closure — only over what a proposal is.
 */
export interface WorkPlanningProvider {
  readonly definition: ToolDefinition;
  /**
   * Reads the planning tool's arguments as a proposal, checking structure only.
   * Throws an AgenticError with code `validation` when the arguments are not a plan at all.
   */
  parseProposal(args: JsonValue): WorkPlanProposal;
  /**
   * The tool that changes one step's status and outcome by its id on the plan the runtime keeps: progress without restating
   * the plan. Core never dispatches it either; absent, the plan moves only through whole-plan updates. Present with `parseMark`.
   */
  readonly markDefinition?: ToolDefinition;
  /** Reads the marking tool's arguments, checking structure only; throws like `parseProposal`. */
  parseMark?(args: JsonValue): Required<Pick<WorkPlanStep, "id" | "status" | "outcome">>;
}
