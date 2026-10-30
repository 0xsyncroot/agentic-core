import type { ChatMessage, RunTurnInput } from "@0xsyncroot/contracts";
import { report } from "./operation-observers.js";
import { STEP_INSTRUCTION_PROVENANCE, stepInstruction } from "./step-instruction.js";
import type { TurnEventWriter } from "./turn-event-writer.js";

export interface ModelResponseRecoveryCommand {
  readonly input: RunTurnInput;
  readonly turnId: string;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly attemptId: string;
  readonly writer: TurnEventWriter;
  readonly controlFeedback: ChatMessage[];
  readonly discardDraftAnswer: () => void;
  /** Text the model wrote beside a tool call earlier in this turn, which the user never saw. */
  readonly withheldAnswer?: string;
  /** The step being re-asked asked for a tool where only an answer could go. */
  readonly calledATool: boolean;
  readonly finalBudgetStep: boolean;
}

/**
 * What the model is told when it spent its last step asking for tools instead of answering.
 *
 * It is a system message rather than invented prose, because the model still has to write the
 * answer — in the user's language, from what it observed. The loop never composes that itself.
 */
const FINAL_ANSWER_TEXT = "No tools remain available for this turn. Answer the user now, in their language, from the"
  + " observations you already have, and state plainly which parts you could not complete and why."
  + " Do not request a tool, and do not reply with an empty message.";

/**
 * Said when the reply being re-asked for was a tool call — natively, or written out as text.
 *
 * On the last step that is not a slip: the model is still inside its task and takes the next call
 * as the obvious move. Telling it again that no tools remain did not change that; naming what its
 * reply was, and that it reached no one, does.
 */
const CALLED_A_TOOL_TEXT = "\n\nYour previous reply was a tool call — possibly written out as text — and nothing else. It did"
  + " not run and the user saw nothing. Do not write another one, in any form: write the answer itself, in plain prose.";

/**
 * A model that goes silent has usually already said what it meant to say — beside a tool call,
 * where the runtime did not deliver it. From the transcript that text looks sent, so the model
 * has nothing to add and returns nothing. Told that it was never delivered, it sends it again.
 */
function recoveryInstruction(withheldAnswer: string | undefined, calledATool: boolean, finalBudgetStep: boolean): ChatMessage {
  const withheld = withheldAnswer?.trim()
    ? "\n\nYour last message in this turn was not delivered to the user, because it was sent together with a tool call. It read:\n"
      + `"""\n${withheldAnswer.trim().slice(0, 4_000)}\n"""\n`
      + "If that was your answer or your question to the user, send it again now, updated with what you have learned since; otherwise write the answer now."
    : "";
  const instruction = finalBudgetStep ? FINAL_ANSWER_TEXT
    : "Your previous response was empty and the user received no answer. Continue the task using the available tools if needed, or answer the user from verified observations. Do not return an empty response.";
  return stepInstruction(instruction + (calledATool ? CALLED_A_TOOL_TEXT : "") + withheld, STEP_INSTRUCTION_PROVENANCE.finalAnswer);
}

/** One bounded recovery: ordinary silence keeps tools available; a resource stop only asks for a summary. */
export async function requestModelResponseRecovery(command: ModelResponseRecoveryCommand): Promise<true> {
  const { input, turnId, stepId, stepIndex, writer } = command;
  // The step's usage was journaled with its assistant message; only its end is left to record.
  await writer.append([
    { type: "step/end", turnId, stepId, payload: { status: "completed", reason: command.finalBudgetStep ? "forced-final-answer" : "empty-response-recovery" } },
  ], `response-recovery:${command.attemptId}`);
  command.discardDraftAnswer();
  command.controlFeedback.push(recoveryInstruction(command.withheldAnswer, command.calledATool, command.finalBudgetStep));
  report(input, { type: "step-completed", turnId, step: stepIndex });
  return true;
}
