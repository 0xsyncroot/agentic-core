import type { TurnTerminalDecision } from "@0xsyncroot/contracts";
import { normalizedContentHash, type TurnOutputReview } from "./turn-control.js";
import type { Objections } from "./turn-end-facts.js";

/**
 * The completion gate for a policy that says the user's work is not finished: a harness's "do not
 * stop yet", the way a Stop hook blocks with a reason — never a forced tool call, which reasoning
 * models reject or ignore. The model is sent on with the objection and decides what the work needs.
 * The policy's `fallback` is never offered to it as guidance: a model handed the way out takes it.
 * Once the turn's objections are spent (`objectionsHeard`: three sent back with no new evidence the runtime brought itself),
 * or with no step left, the runtime ends the work itself — on a terminal answer, that answer accepted as partial with
 * `fallback` as its notice; on refused calls, nothing dispatched and `fallback` as the answer.
 *
 * The same answer coming back ends the work too: an answer that did not change after an objection, with no new result and no
 * work call in between, has answered it, and another lap — a model call and a draft on screen each — cannot move it. The same is the
 * identical text, or (`judgedUnmoved`) one the judge read as unmoved on what the objection asked (`AnswerMovedCheck`).
 *
 * Where it ends depends on what the policy's judge found the answer to be (`delivered`). An answer that delivers a result, with
 * only a figure or a criterion still open, stands as partial with `fallback` as its notice when it comes back unmoved, and is
 * never sent back to a step that may not call tools (`noToolStepAfter`): a closing step written after it wrote no better
 * answer, and the rewrite dropped what the draft held. Any other answer — a progress note, a stall, work handed back — ends on
 * a closing step, as do objections spent on answers that kept moving: no tools, the stop cause and what remains in its
 * final-step instruction, the way LangChain's early_stopping_method "generate" makes one last pass over the steps taken,
 * since ending on a progress note told the user neither what was found nor what to do next. That closing answer is reviewed
 * as any final step is, so `fallback` still goes under it. A step that may call tools always has a step after it, so the
 * closing step needs no room of its own; on a final step every answer stands, as partial.
 */
export function workRemainsReview(
  phase: "terminal" | "tool-call", decision: Extract<TurnTerminalDecision, { readonly decision: "continue" }>,
  objections: Objections, finalBudgetStep: boolean, content: string | null, judgedUnmoved = false,
): TurnOutputReview {
  const sameAnswer = phase === "terminal" && objections.objectedAnswer !== undefined
    && (judgedUnmoved || normalizedContentHash(content) === objections.objectedAnswer);
  const delivered = decision.delivered === true;
  const lastToolStep = finalBudgetStep || (delivered && objections.noToolStepAfter === true);
  const ended = finalBudgetStep || objections.spent || sameAnswer;
  const marked = delivered ? { delivered: true } as const : {};
  if (phase === "terminal" && (lastToolStep || (delivered && sameAnswer))) {
    // The model's own answer stands — it is what the user has been reading — and what is still open goes under it.
    return { kind: "proceed", terminalDecision: Object.freeze({ decision: "accept", outcome: "partial",
      reason: lastToolStep ? "work-remains-final-step" : "work-remains-unmoved",
      ...(decision.fallback ? { notice: decision.fallback } : {}) }), ...marked };
  }
  if (ended && phase === "terminal") {
    return { kind: "close", feedback: decision.feedback, reason: "work-remains-unmoved", noticeFollows: Boolean(decision.fallback?.trim()), ...marked };
  }
  return { kind: "continue", phase, feedback: decision.feedback, workRemains: true,
    ...(ended ? { fallback: decision.fallback ?? "", exhausted: true } : decision.fallback ? { fallback: decision.fallback } : {}),
    ...(decision.objection ? { disputed: decision.objection.disputed } : {}), ...marked };
}
