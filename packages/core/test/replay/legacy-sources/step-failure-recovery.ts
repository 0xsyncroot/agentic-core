import { randomUUID } from "node:crypto";
import type { RunTurnResult, TurnControlState } from "@0xsyncroot/contracts";
import { classifyError } from "./error-classifier.js";
import { writesDispatched } from "./choice-violation.js";
import type { TurnLoop } from "../../../src/agent/turn-step-loop-input.js";

export const STEP_RETRIES = 1;

const FINAL_CODES: ReadonlySet<string> = new Set(["cancelled", "denied", "conflict"]);

export function recoverable(error: unknown, signal: AbortSignal): boolean {
  return !signal.aborted && !FINAL_CODES.has(classifyError(error).code);
}

export async function failureFallback(loop: TurnLoop, stepIndex: number, code: string): Promise<RunTurnResult> {
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
  return turn.terminator.finishFallback({ stepId, stepIndex, content, reason: `step-failure:${code}`, usage: loop.usage,
    drafts: [{ type: "assistant/message", turnId: turn.turnId, stepId, requestId: `step-failure:${stepId}`, attemptId: `step-failure:${stepId}`,
      payload: { content, toolCalls: [], finishReason: "step-failure", usage: {} } }],
  });
}
