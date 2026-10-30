import { WORK_PLAN_CAUSES, WORK_PLAN_LIMITS, WORK_PLAN_STATES, WORK_STEP_ID_PATTERN, WORK_STEP_STATUSES } from "../work/work-plan.js";
import { boundedString, isObject, nonEmpty, type JsonObject } from "./event-payload-guards.js";

const PLAN_CAUSE_SET = new Set<string>(WORK_PLAN_CAUSES);
const PLAN_STATE_SET = new Set<string>(WORK_PLAN_STATES);
const STEP_STATUS_SET = new Set<string>(WORK_STEP_STATUSES);

/**
 * Plans the runtime identifies are checked in full; legacy snapshots journaled before plans had an
 * identity keep the three fields they always had, so old sessions still append and replay.
 */
export function assertValidPlanPayload(payload: JsonObject): void {
  if (typeof payload.goal !== "string" || !Array.isArray(payload.steps) || typeof payload.updatedAt !== "string") {
    throw new Error("work/plan-updated requires goal, steps and updatedAt");
  }
  if (payload.cause !== undefined && !PLAN_CAUSE_SET.has(String(payload.cause))) throw new Error("work/plan-updated has an unknown cause");
  if (payload.changedStepIds !== undefined &&
      (!Array.isArray(payload.changedStepIds) || payload.changedStepIds.some((id) => typeof id !== "string"))) {
    throw new Error("work/plan-updated changedStepIds must be a list of step ids");
  }
  if (payload.planId === undefined && payload.revision === undefined && payload.state === undefined) return;
  if (!nonEmpty(payload.planId) || !Number.isInteger(payload.revision) || Number(payload.revision) < 1 ||
      !PLAN_STATE_SET.has(String(payload.state))) {
    throw new Error("work/plan-updated requires planId, a positive revision and a known state together");
  }
  if (!boundedString(payload.goal, WORK_PLAN_LIMITS.goal) || payload.steps.length > WORK_PLAN_LIMITS.steps) {
    throw new Error("work/plan-updated exceeds the plan limits");
  }
  const ids = new Set<string>();
  for (const step of payload.steps) {
    if (!isObject(step) || typeof step.id !== "string" || !WORK_STEP_ID_PATTERN.test(step.id) || ids.has(step.id) ||
        !boundedString(step.description, WORK_PLAN_LIMITS.description) || !STEP_STATUS_SET.has(String(step.status)) ||
        (step.outcome !== undefined && !boundedString(step.outcome, WORK_PLAN_LIMITS.outcome))) {
      throw new Error("work/plan-updated steps require unique safe ids, bounded text and a known status");
    }
    ids.add(step.id);
  }
}
