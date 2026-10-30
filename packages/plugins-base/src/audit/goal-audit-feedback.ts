import { endingFeedback } from "./answer-ending.js";
import type { GoalAuditInput, GoalAuditVerdict } from "./completion-audit.js";
import { splitCriterion } from "./procedure-audit.js";

/** The objection the model reads when the audit finds the request not yet complete. */
export function goalAuditFeedback(verdict: GoalAuditVerdict, input?: GoalAuditInput): string {
  // A report that leaves out what the procedure asks for is completed from what was already read; told to re-read before
  // stating any figure, agents go back to the screen round after round while the missing section stays missing.
  if (verdict.criteria) {
    return [
      `Completion audit: your answer does not yet meet these completion criteria of the procedure you are following: ${verdict.missing.map((line, index) => {
        const { condition, requirement } = splitCriterion(line);
        return `(${index + 1}) ${requirement.replace(/[.;\s]+$/u, "")}${condition ? ` (required because your answer does this: ${condition})` : ""}.`;
      }).join(" ")}`,
      "Add what is missing to the answer, from the results you already have; call a tool only for what those results do not hold.",
      "If what a criterion asks about does not occur in this case, say so in one line instead of leaving it out.",
      "Do not answer with a progress note or a promise: the next answer is the completed one.",
    ].join(" ");
  }
  const flags = verdict.flags ?? [];
  // The judge's verdict names its objections; the model audit's carries text only, and what it lists as unsupported is a value.
  const figures = verdict.flags ? flags.includes("contradicted") || flags.includes("unsupportedAbsence") : verdict.unsupported.length > 0;
  const parts = [
    "Completion audit: your answer does not yet complete the user's request.",
    ...endingFeedback(flags, input?.attempts),
    ...(verdict.missing.length ? [`Still to do: ${verdict.missing.join("; ")}.`] : []),
    ...(verdict.unsupported.length ? [`Contradicted by the evidence: ${verdict.unsupported.join("; ")}.`] : []),
    "Continue the work yourself with the tools you have: do what is still to do.",
    // A contradicted figure is checked against what was read; a figure added up by hand is computed, from results already kept.
    // "Re-read before stating any figure" would send agents back to read a file they already have, draft after draft.
    ...(figures ? ["Check a figure the evidence contradicts against the stored result it came from (read_result) before stating it again."] : []),
    // Screen steps written from memory: where a step comes from is a result that shows or describes it.
    ...(flags.includes("screensUnsupported") ? ["State where something is in the application and how to operate it (menus, tabs, buttons, fields, steps) only as a tool result shows or describes it: get it from the tool that holds it, or leave it out."] : []),
    ...(flags.includes("computedFigure") ? [`A figure added up from several rows comes from ${input?.computingTools?.length ? input.computingTools.join(" or ") : "a computing tool"} run on the stored results: they are kept whole, so compute — do not read them again.`] : []),
    "State only figures a tool returned; never add or compare by hand. Do not answer with a progress note, a promise, or a question the evidence already answers.",
  ];
  return parts.join(" ");
}
