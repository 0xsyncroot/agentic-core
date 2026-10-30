import { randomUUID } from "node:crypto";
import { createInterruptedToolResults, type EventDraft, type LlmUsage, type RunTurnResult, type TurnControlPolicy, type TurnControlState } from "@0xsyncroot/contracts";
import { classifyError } from "./error-classifier.js";
import { writesDispatched } from "./choice-violation.js";
import type { ClaimedTurn } from "./claimed-turn.js";
import { continueQuestionRequest, type ContinueQuestionWording } from "./runtime-question.js";
import { addUsage, normalizedUsage } from "./llm-usage.js";
import { taskTurnIdsFor } from "./task-turns.js";
import type { TurnLoop } from "./turn-step-loop-input.js";
import { restorePlanState } from "./work-plan-restore.js";

/**
 * What a turn does when one of its steps fails, for any tool, model or product.
 *
 * A failed step must not end the turn on a bare error sentence after many steps of work the user
 * watched (docs/incidents/2026-10-10-core-step-failure-ended-turn.md). A step failing is not the
 * end of the work: the loop tries a fresh step once; if that
 * fails too, the next step closes the turn — no tools, the final-step instruction asks for what was
 * found, how far the work got and what remains; and if even that cannot run, the product's own sentence
 * ends the turn as unfinished, never as failed. A cancelled turn, a denial and a lost lease stay errors:
 * those are decisions, not accidents.
 */
export const STEP_RETRIES = 1;

const FINAL_CODES: ReadonlySet<string> = new Set(["cancelled", "denied", "conflict"]);

export function recoverable(error: unknown, signal: AbortSignal): boolean {
  return !signal.aborted && !FINAL_CODES.has(classifyError(error).code);
}

/** The turn ends on the product's sentence for unfinished work, with what the plan shows done and left, and the failure's cause. */
export async function failureFallback(loop: TurnLoop, stepIndex: number, reason: string): Promise<RunTurnResult> {
  const { turn, setup } = loop;
  const stepId = randomUUID();
  await turn.writer.append([{ type: "step/start", turnId: turn.turnId, stepId, payload: { index: stepIndex } }], `step-start:${stepId}`);
  const plan = setup.planLedger.workPlan;
  const events = await turn.view.events();
  const content = loop.controlPolicy?.fallbackText?.({
    kind: "step-failure", writesDispatched: writesDispatched({ turnId: turn.turnId, context: { events } } as unknown as TurnControlState),
    completedSteps: (plan?.steps ?? []).filter((step) => step.status === "completed").map((step) => step.description),
    remainingSteps: (plan?.steps ?? []).filter((step) => step.status !== "completed").map((step) => step.description),
  }) ?? "";
  return turn.terminator.finishFallback({ stepId, stepIndex, content, reason, usage: loop.usage,
    drafts: [{ type: "assistant/message", turnId: turn.turnId, stepId, requestId: `step-failure:${stepId}`, attemptId: `step-failure:${stepId}`,
      payload: { content, toolCalls: [], finishReason: "step-failure", usage: {} } }],
  });
}

/**
 * The turn the silence watch stopped ends unfinished, not failed.
 *
 * The watch fires only after a stretch with no step and no tool call, so what it stops is a hung model call or a hung tool;
 * the steps before it stand. One append closes what that left open: every call without a result, and the step that hung
 * unless its batch already ended it. The turn then ends on a step of its own after the last one, on the product's sentence
 * for it or on none: never on a draft the model wrote beside its calls, which can claim a write that did not complete. No
 * model is asked to close it, since the model may be what hung. The silence limit is the runtime's own, so the turn asks
 * whether to go on when the product has words for that question.
 */
export async function silenceFallback(turn: ClaimedTurn, silence: unknown, ending: {
  readonly turnControlPolicy?: TurnControlPolicy; readonly continueQuestion?: ContinueQuestionWording;
}): Promise<RunTurnResult> {
  const { turnId, writer, view } = turn;
  const own = (await view.events()).filter((event) => event.turnId === turnId);
  const ended = new Set(own.filter((event) => event.type === "step/end").map((event) => event.stepId));
  const starts = own.filter((event) => event.type === "step/start");
  const stopped = classifyError(silence);
  const closing: EventDraft[] = [
    ...createInterruptedToolResults(own, turnId),
    ...starts.filter((event) => event.stepId && !ended.has(event.stepId))
      .map((event): EventDraft => ({ type: "step/end", turnId, stepId: event.stepId!, payload: { status: "failed", ...stopped } })),
  ];
  if (closing.length > 0) await writer.append(closing, `silence-closure:${turnId}`);
  const events = await view.events();
  const steps = restorePlanState(events, taskTurnIdsFor(events, turnId)).state.current?.steps ?? [];
  const usage = own.filter((event) => event.type === "usage/recorded")
    .reduce((total, event) => addUsage(total, normalizedUsage(event.payload as LlmUsage)), normalizedUsage(undefined));
  const stepIndex = Math.max(0, ...starts.map((event) => Number((event.payload as { index?: unknown }).index) || 0)) + 1;
  const stepId = randomUUID();
  await writer.append([{ type: "step/start", turnId, stepId, payload: { index: stepIndex } }], `step-start:${stepId}`);
  const content = ending.turnControlPolicy?.fallbackText?.({
    kind: "time-limit", writesDispatched: writesDispatched({ turnId, context: { events } } as unknown as TurnControlState),
    completedSteps: steps.filter((step) => step.status === "completed").map((step) => step.description),
    remainingSteps: steps.filter((step) => step.status !== "completed").map((step) => step.description),
  }) ?? "";
  return turn.terminator.finishFallback({ stepId, stepIndex, content, reason: "time-limit", usage,
    ...(ending.continueQuestion ? { question: continueQuestionRequest(ending.continueQuestion) } : {}),
    drafts: [{ type: "assistant/message", turnId, stepId, requestId: `time-limit:${stepId}`, attemptId: `time-limit:${stepId}`,
      payload: { content, toolCalls: [], finishReason: "time-limit", usage: {} } }],
  });
}
