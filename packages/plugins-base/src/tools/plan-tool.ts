import {
  AgenticError,
  WORK_PLAN_LIMITS,
  WORK_STEP_STATUSES,
  type JsonValue,
  type WorkPlanProposal,
  type WorkPlanStep,
  type WorkPlanningProvider,
  type WorkStepStatus,
} from "@0xsyncroot/contracts";

const STATUSES = new Set<string>(WORK_STEP_STATUSES);

function refuse(message: string): never {
  throw new AgenticError("validation", message);
}

function objectOf(value: JsonValue | undefined, what: string): Readonly<Record<string, JsonValue>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(`${what} must be an object`);
  return value;
}

function text(value: JsonValue | undefined, what: string): string {
  if (typeof value !== "string" || !value.trim()) refuse(`${what} must be a non-empty string`);
  return value;
}

/**
 * Checks that the arguments are a plan at all — and nothing more.
 *
 * Everything past structure is the runtime's to settle: it matches steps to the plan it keeps,
 * rewrites ids, cuts long text and fixes the in-progress step, and tells the model what it changed.
 * Refusing those here used to fail the call over things the runtime can put right, and a plan the
 * model could not publish was a plan the user never saw.
 */
function parseProposal(args: JsonValue): WorkPlanProposal {
  const plan = objectOf(args, "The plan");
  const goal = text(plan.goal, "goal");
  const steps = plan.steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > WORK_PLAN_LIMITS.steps) {
    refuse(`steps must list from 1 to ${WORK_PLAN_LIMITS.steps} steps`);
  }
  return {
    goal,
    steps: steps.map((entry, index) => {
      const step = objectOf(entry, `Step ${index + 1}`);
      // Optional, as in Codex's update_plan (step + status): a refusal for a missing id is a lost plan.
      const status = step.status;
      if (typeof status !== "string" || !STATUSES.has(status)) refuse(`Step ${index + 1} status must be one of ${WORK_STEP_STATUSES.join(", ")}`);
      if (step.outcome !== undefined && typeof step.outcome !== "string") refuse(`Step ${index + 1} outcome must be a string`);
      const named = typeof step.id === "string" && step.id.trim() ? step.id : undefined;
      // A step with an id alone names an existing step; the runtime keeps its stored description.
      if (step.description === undefined && !named) refuse(`Step ${index + 1} needs a description or the id of a step in the plan`);
      return {
        id: named ?? `step_${index + 1}`, status: status as WorkStepStatus,
        ...(step.description === undefined ? {} : { description: text(step.description, `Step ${index + 1} description`) }),
        ...(typeof step.outcome === "string" && step.outcome.trim() ? { outcome: step.outcome } : {}),
      };
    }),
  };
}

const PLAN_TOOL_ID = "plan_update";
const MARK_TOOL_ID = "plan_mark";
/** What a mark may set: a step started, done or blocked. Pending is the plan's to say, through a revision. */
const MARK_STATUSES = ["in_progress", "completed", "blocked"] as const satisfies readonly WorkStepStatus[];

/**
 * Checks that the arguments name one step, a status a mark may set and an outcome — and nothing more. Every field is
 * required: a field the schema leaves optional is one the model leaves out. Whether the id names a step of the plan is the
 * runtime's to settle, against the plan it keeps.
 */
function parseMark(args: JsonValue): Required<Pick<WorkPlanStep, "id" | "status" | "outcome">> {
  const mark = objectOf(args, "The mark");
  const id = text(mark.id, "id");
  const status = mark.status;
  if (typeof status !== "string" || !(MARK_STATUSES as readonly string[]).includes(status)) refuse(`status must be one of ${MARK_STATUSES.join(", ")}`);
  return { id, status: status as WorkStepStatus, outcome: text(mark.outcome, "outcome") };
}

const DESCRIPTION = [
  "Create or revise the work plan of a task that takes several actions; the user watches it as the task's progress.",
  "Skip it for straightforward work of one or two actions, and never make a single-step plan.",
  `Publish it once, before the work starts. Once a plan exists, mark each step's progress with ${MARK_TOOL_ID} in the same step as the work; send this tool again only to revise the plan: steps added, dropped or reworded when the approach changes.`,
  "Send each update in the same step as the calls that do the work: a step that only updates the plan is not progress on the work.",
  "Send the whole plan each time. Keep every step's id and description the same in each update: they identify the step.",
  "Put what a step found or did in its outcome, never in its description. Keep one step in_progress: the one you are working on.",
  "Steps and outcomes are the user's work in the user's words: no step for loading a skill or instructions, and never a tool, skill, field or other internal name.",
  "A step you tried and cannot do now is blocked, with what blocks it in its outcome; never mark it completed.",
  "The runtime keeps the plan: the result is the plan as it now stands, with notes on anything it normalized.",
  "One sentence written beside your first plan is shown to the user as the plan announcement.",
  "To ask the user something, use request_user_input or reply with no tool call.",
].join(" ");

const MARK_DESCRIPTION = [
  "Mark the progress of one step of the current work plan by its id: the runtime sets that step's status and outcome and keeps the rest of the plan as it is.",
  "The outcome is one short sentence the user reads as the step's result, in the user's words with no tool, skill or internal name: completed, what was done or observed, with the numbers you observed; in_progress, what the step starts; blocked, what blocks it.",
  "Send it in the same step as the calls that do the work: mark the step you finished completed beside the first call of the next step, and the next pending step becomes in_progress.",
  "Your final answer carries no mark: the runtime closes the plan from the results.",
  "Mark a step completed only once you have seen the result that completes it; a step you tried and cannot do now is blocked, never completed. Mark a step in_progress only to take the steps out of order.",
  `To add, drop or reword steps, use ${PLAN_TOOL_ID}.`,
  "The result is the plan as it now stands, with notes on anything the runtime normalized.",
].join(" ");

export function createWorkPlanningProvider(): WorkPlanningProvider & Required<Pick<WorkPlanningProvider, "markDefinition" | "parseMark">> {
  const step = {
    type: "object",
    properties: {
      id: { type: "string", description: "Optional stable identifier of the step, kept unchanged in every update." },
      description: { type: "string", description: "What the step does, in the user's words (no tool, skill or internal name); kept unchanged in every update." },
      status: { type: "string", enum: [...WORK_STEP_STATUSES] },
      outcome: { type: "string", description: "What the step found or did, once it has; shown to the user as it is, so business words only (no tool, skill or internal name)." },
    },
    required: ["description", "status"],
    additionalProperties: false,
  };
  const planSchema = (stepSchema: typeof step) => ({
    type: "object",
    properties: {
      goal: { type: "string" },
      steps: { type: "array", minItems: 1, maxItems: WORK_PLAN_LIMITS.steps, items: stepSchema },
    },
    required: ["goal", "steps"],
    additionalProperties: false,
  });
  const definition: WorkPlanningProvider["definition"] = {
    id: PLAN_TOOL_ID,
    version: "1.0.0",
    description: DESCRIPTION,
    // The model is asked for a description on every step: a new plan has no step to name, and with it out of `required` most
    // first plans come without one. Calls are checked against what the port accepts, a step named by its id alone (a schema
    // that refuses a completed step sent as `{id, status, outcome}` loses it); `parseProposal` and the ledger refuse the rest.
    modelInputSchema: planSchema(step),
    inputSchema: planSchema({ ...step, required: ["status"] }),
    outputSchema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        steps: { type: "array" },
        updatedAt: { type: "string" },
        normalized: { type: "array", items: { type: "string" } },
      },
      required: ["goal", "steps", "updatedAt"],
      additionalProperties: false,
    },
    // Planning is internal agent state; business authorization remains on domain tools.
    requiredPermissions: [],
    sideEffect: "none",
    timeoutMs: 500,
    // The agent runtime applies a plan itself and never dispatches this tool. A host that runs it
    // directly gets the proposal back as a plan, checked the same way.
    execute: async (invocation) => {
      const proposal = parseProposal(invocation.arguments);
      return { goal: proposal.goal, steps: proposal.steps, updatedAt: new Date().toISOString() } as unknown as JsonValue;
    },
  };
  const markSchema = {
    type: "object",
    properties: {
      id: { type: "string", description: "The id of a step of the current plan, as the plan shows it." },
      status: { type: "string", enum: [...MARK_STATUSES] },
      outcome: { type: "string", description: "One short sentence: what was done or observed (completed, with the numbers), what the step starts (in_progress), or what blocks it (blocked)." },
    },
    required: ["id", "status", "outcome"],
    additionalProperties: false,
  };
  const markDefinition: WorkPlanningProvider["definition"] = {
    id: MARK_TOOL_ID,
    version: "1.0.0",
    description: MARK_DESCRIPTION,
    inputSchema: markSchema,
    outputSchema: definition.outputSchema,
    requiredPermissions: [],
    sideEffect: "none",
    timeoutMs: 500,
    // A mark changes the plan the agent runtime keeps, which applies it without dispatching; a host that runs it directly
    // holds no plan, so the call is refused there once its arguments are checked.
    execute: async (invocation) => {
      parseMark(invocation.arguments);
      return refuse(`${MARK_TOOL_ID} needs the plan the agent runtime keeps`);
    },
  };
  return { definition, parseProposal, markDefinition, parseMark };
}
