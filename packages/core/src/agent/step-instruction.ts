import type { ChatMessage, LlmToolChoice } from "@0xsyncroot/contracts";
import type { ModelInstructions } from "./context-budget-text.js";

/**
 * Where the loop's instructions for the step about to run come from.
 *
 * These are the only system messages that speak about *this* step — it is the last one, a hard
 * tool choice applies, the allowance is nearly spent, the last reply gave the user nothing — and
 * they mean something only next to where the model will write. `ContextWindowPolicy` keeps them
 * there, after the conversation, while every other system message goes to the front.
 */
export const STEP_INSTRUCTION_PROVENANCE = {
  budget: "agent-loop-budget",
  finalAnswer: "agent-loop:final-answer",
  toolChoice: "agent-loop:tool-choice",
  language: "agent-loop:language",
  /** A turn-control objection the model has not acted on yet: it speaks about this step too. */
  objection: "agent-loop:objection",
  /** A load-on-demand skill the turn's judge found the request needs, named at the end of the first step. */
  skill: "agent-loop:skill-suggestion",
} as const;

type StepInstructionProvenance = typeof STEP_INSTRUCTION_PROVENANCE[keyof typeof STEP_INSTRUCTION_PROVENANCE];
const PROVENANCES: ReadonlySet<string> = new Set(Object.values(STEP_INSTRUCTION_PROVENANCE));

export function stepInstruction(content: string, provenance: StepInstructionProvenance): ChatMessage {
  return { role: "system", content, context: { trust: "instruction", retention: "required", provenance } };
}

/**
 * An objection raised since the model's last tool step, kept next to where it writes. Sent to the
 * front it sits under the whole system prompt while the budget notice's "otherwise answer now" is
 * the last thing read, and the model answers into the same objection again and again
 * (docs/incidents/2026-10-10-core-objection-far-from-tail.md). A message that is already a step
 * instruction (a recovery instruction) keeps its own provenance.
 */
export function asCurrentObjection(message: ChatMessage): ChatMessage {
  if (isStepInstruction(message)) return message;
  return { ...message, context: { trust: "instruction", retention: "required", provenance: STEP_INSTRUCTION_PROVENANCE.objection } };
}

/**
 * Opens the request's last message on every step that offers tools: the loop already runs a step's calls in the order
 * they come and stops the state-changing ones behind a failure, and a permission stated only mid-prompt is not acted on.
 * It names no tool and no method, and it is the same bytes on every step: a tail that names a tool becomes the procedure,
 * and a tail that changes from step to step steers. A composition may give it in its users' language
 * (`ModelInstructions.stepCallsInstruction`), so that the tail stays in one language.
 *
 * "Every call you know" also reads as the plan's marks once the work is done, and a reply of marks alone costs a whole model
 * step before the answer; the same rule stated only in the system prompt does not hold against this line, so the line itself
 * says the answer goes with no call and that the runtime closes the plan (`closeForOutcome`).
 */
export const DEFAULT_STEP_CALLS_INSTRUCTION =
  "Send every call whose arguments you already know in this step, in the order they must run; wait only for a result you have not seen."
  + " Once no call is left to send, answer with no call at all, plan updates included: the runtime closes the plan's steps from the results.";

/**
 * The request's last message, its freshest text, where a rule holds against everything read before it. Lines in this order: the step-calls line when the step offers calls (tools offered, a
 * tool choice that is neither none nor a named tool, not the turn's last step: a named tool is the only call the step may make), the composition's closing instruction, the closing lines of the
 * skills in effect. One message, so the closing instruction stays the last rule the composition itself states and the line
 * about calls is never read after it.
 */
export function closingMessage(instructions: ModelInstructions | undefined, step: {
  readonly tools: readonly unknown[]; readonly toolChoice?: LlmToolChoice; readonly finalStep?: boolean; readonly closingLines?: readonly string[];
}): ChatMessage | undefined {
  const offersCalls = step.finalStep !== true && step.tools.length > 0 && step.toolChoice !== "none" && typeof step.toolChoice !== "object";
  const stepCalls = offersCalls ? instructions?.stepCallsInstruction ?? DEFAULT_STEP_CALLS_INSTRUCTION : undefined;
  const text = [stepCalls, instructions?.closingInstruction, ...(step.closingLines ?? [])].filter((line) => line?.trim()).join("\n");
  return text ? stepInstruction(text, STEP_INSTRUCTION_PROVENANCE.language) : undefined;
}

export function isStepInstruction(message: ChatMessage): boolean {
  return message.role === "system" && PROVENANCES.has(message.context?.provenance ?? "");
}
