import type { ChatMessage, LlmStreamEvent, LlmToolChoice } from "@0xsyncroot/contracts";
import { STEP_INSTRUCTION_PROVENANCE, stepInstruction } from "./step-instruction.js";
import type { ModelInstructions } from "./context-budget-text.js";

/** The choice, as words, for a provider that will not take it as a parameter. */
export function toolChoiceInstruction(choice: LlmToolChoice, instructions?: ModelInstructions): ChatMessage {
  const content = instructions?.toolChoice?.(choice) ?? (typeof choice === "object"
    ? `This step must call the tool \`${choice.name}\` before anything else; a work-plan update may accompany it, no other tool may. Do not answer until it has run.`
    : "This step must call one of the offered tools before answering.");
  return stepInstruction(content, STEP_INSTRUCTION_PROVENANCE.toolChoice);
}

/** An adapter that had to resend without tool_choice says so in its provider state; the journal keeps it. */
export function rejectedToolChoice(final: Extract<LlmStreamEvent, { type: "final" }>): { readonly toolChoiceRejected?: string } {
  const payload = final.providerState?.payload;
  const rejected = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>).toolChoiceRejected : undefined;
  return typeof rejected === "string" && rejected ? { toolChoiceRejected: rejected } : {};
}
