import type { ChatMessage, WorkPlan } from "@0xsyncroot/contracts";
import { STEP_INSTRUCTION_PROVENANCE, stepInstruction } from "./step-instruction.js";

/** What the turn has to show for itself when its last step comes: the model's own record of it. */
export interface TurnProgress {
  /** Text the model wrote beside its tool calls in this turn, oldest first. */
  readonly notes: readonly string[];
  /**
   * The work plan, with the ids of its steps the results attributed to them show done (`SubGoalLedger.shownSteps`): the
   * digest lists each step's status as the model claims it beside what the results show.
   */
  readonly plan?: { readonly plan: WorkPlan; readonly shown: ReadonlySet<string> };
  readonly stopReason?: string;
  /**
   * Set when the work-remains gate ended the turn: the policy's own account of what is still open.
   * The step then closes the work for the user rather than only reporting a budget stop.
   */
  readonly closing?: { readonly remaining: string; readonly noticeFollows: boolean; readonly askTools?: readonly string[] };
  /** The tools still offered on the last step: each puts something to the user, as a form, never as a sentence. */
  readonly askTools?: readonly string[];
}

/** Bounds on the digest, so a long turn's notes cannot crowd the answer out of the window. */
const MAX_NOTES = 40;
const MAX_NOTE_CHARS = 400;
const MAX_DIGEST_CHARS = 8_000;

/**
 * The instruction a model reads on the step that must answer.
 *
 * It has to land as an instruction, not as one more line of a long transcript. A model deep in a
 * repetitive task — thirty scroll-and-read steps — takes its own last pattern as the strongest
 * signal it has, and with no tools offered it wrote its next call out as text instead of an
 * answer. So the message says what the step is (no tools exist any more, a call written as text
 * runs nowhere and is never shown), what the answer must contain (the results, how far the work
 * got, what is left), and what it must not do (promise to keep going in this turn).
 *
 * The digest is there because by the last step the context budget has usually dropped the
 * earliest results. Notes help orient the model but cannot replace those results as evidence. Each plan step carries its
 * claimed status beside whether the results attributed to it show it done, so the answer can tell the user which parts are
 * done from what the model only marked done.
 */
export function finalStepInstruction(progress: TurnProgress): ChatMessage {
  const askTools = progress.askTools ?? progress.closing?.askTools ?? [];
  const lines = [
    askTools.length > 0
      ? `This is the last model step of this turn. ${offeredTools(askTools)}`
        + " any other tool call, in any form — including as text or markup in your reply — runs nowhere and is never shown. Do not continue the task."
      : "This is the last model step of this turn. No tools exist any more: none are offered, and a tool call written in any form —"
        + " including as text or markup in your reply — runs nowhere and is never shown to the user. Do not continue the task.",
    `Runtime stop cause: ${progress.stopReason ?? "step allowance"}. This is not evidence that the task is complete. Explain the practical reason and remaining work.`,
    "Write your answer to the user now, in the language of the conversation, from what you have already observed in this turn:",
    "- the concrete results found so far — figures, names, dates, identifiers — not a description of looking;",
    "- how far the work got and exactly which part was not covered, so the user can see where the result is incomplete;",
    progress.closing
      // Closing a stalled turn: "send me another message and I will continue" hands the work back to the user.
      ? "- if work remains, say what remains; never ask the user to send another message or to do a step so you can continue;"
      // The client asks the user whether to go on under a turn that ended unfinished; an answer that also says what to type
      // ("send 'continue'") repeats that question in prose.
      : "- if work remains, say what remains; the user is asked separately whether to continue, so never tell them what to send"
        + " or do to continue, and never say it is being done now or will be done later in this turn;",
    askTools.length > 0
      // With only "ask only if the work cannot go on", a prose answer is the one path the model sees and a tool that hands
      // the finished work to the user goes uncalled; naming it as a way the result reaches the user gets it called
      // (docs/incidents/2026-10-16-core-final-step-handoff-tool.md).
      ? "- the result reaches the user either as your answer or through an offered tool whose description fits; when that description says it hands"
        + " this work to the user, call it now instead of describing the hand-over in prose. Ask the user something only if the work cannot go on without their answer."
      : "- ask the user something only if the work cannot go on without their answer.",
    "Earlier tool results may no longer be in your context: the notes and plan below are your own record of this turn and"
      + " are reminders, not independent evidence. Use only facts supported by tool results still available in context; otherwise say they could not be verified. Explain the practical reason for stopping without exposing internal tool names.",
  ];
  if (progress.closing) lines.push(...closingLines(progress.closing.remaining, progress.closing.noticeFollows, askTools));
  const digest = progressDigest(progress);
  return stepInstruction(digest ? `${lines.join("\n")}\n\n${digest}` : lines.join("\n"), STEP_INSTRUCTION_PROVENANCE.budget);
}

/** Names the offered tools by what they do, not by the one use of asking a blocking fact: a tool may hand a result over instead. */
function offeredTools(askTools: readonly string[]): string {
  return askTools.length === 1
    ? `The only tool still offered is ${askTools[0]}: it puts something to the user, as its own description says;`
    : `The only tools still offered are ${askTools.join(", ")}: each puts something to the user, as its own description says;`;
}

/**
 * What a closing step adds: the turn stopped because the last attempts moved nothing, so the user
 * needs the work closed out — where it stands, why it stopped, what would unblock it — not a
 * progress note. The runtime still appends what it established from evidence; the model is told
 * so, so that it explains instead of repeating that list.
 */
function closingLines(remaining: string, noticeFollows: boolean, askTools: readonly string[]): readonly string[] {
  return [
    "",
    "Why this turn stops: your last attempts brought no new information, and the work is not finished. What remains, as the runtime"
      + ` sees it:\n"""\n${remaining.trim().slice(0, 2_000)}\n"""`,
    "Close the work for the user, in this order: the result you do have; what you did to get it; where it stopped and the"
      + " practical reason; then the one concrete next step — what you would do next, or, only if a fact that neither the screen nor"
      + (askTools.length > 0
        ? ` any tool can give is what blocks the work, ask for exactly that fact, offering the likely values so the user can pick one or type another,`
          + ` or hand the result to the user, with ${askTools.length === 1 ? askTools[0] : "the offered tool whose description fits"}.`
        : " any tool can give is what blocks the work, ask the user for exactly that fact in one sentence.")
      + " Never ask the user to do a step for you.",
    ...(noticeFollows ? ["The runtime adds its own list of what is still open under your message. Do not repeat that list; explain it and say what comes next."] : []),
  ];
}

function progressDigest(progress: TurnProgress): string {
  const sections: string[] = [];
  const steps = progress.plan?.plan.steps ?? [];
  const shown = progress.plan?.shown ?? new Set<string>();
  if (steps.length > 0) {
    sections.push(["Your work plan, each step as [the status you gave it / whether the results attributed to it show it done]:",
      ...steps.map((step) => `- [${step.status} / ${shown.has(step.id) ? "shown" : "not shown"}] ${step.description}${step.outcome ? ` — ${step.outcome}` : ""}`)].join("\n"));
  }
  const notes = progress.notes.map((note) => note.trim()).filter(Boolean).slice(-MAX_NOTES)
    .map((note) => note.length > MAX_NOTE_CHARS ? `${note.slice(0, MAX_NOTE_CHARS)}…` : note);
  if (notes.length > 0) {
    sections.push(["What you wrote while working in this turn (oldest first):", ...notes.map((note) => `- ${note}`)].join("\n"));
  }
  const digest = sections.join("\n\n");
  // The newest part matters most: a cut keeps the end, where the latest results are.
  return digest.length > MAX_DIGEST_CHARS ? `…${digest.slice(digest.length - MAX_DIGEST_CHARS)}` : digest;
}
