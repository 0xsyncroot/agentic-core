/**
 * @internal Pure mapping from the server's own plan/tool state to the checklist mark it renders as.
 *
 * Nothing here reads a phrase or guesses an ending: the runtime is the one system that knows
 * whether a step is still running, paused for the user, or was abandoned, and it says so
 * directly in `plan.state`/`step.status`/`tool.status`. This module only turns that into the
 * `TraceState` dataset value the existing checklist CSS already knows how to draw — see the
 * rendering table in spec §3.7 and its §10.10 amendment.
 */

/** A plan step's checklist mark. `undefined` means "not listed" (a pending step). */
function planStepMark(status: AgentChatWorkPlanStep["status"], planState: AgentChatWorkPlanState | undefined, live: boolean): TraceState | undefined {
  if (status === "completed") return "done";
  if (status !== "in_progress") return undefined;
  if (planState === "stopped") return "partial";
  if (planState === "failed") return "error";
  // Live and still open: the step really is running now. Anything else that is still open —
  // loaded from history, or waiting on the user even while live — never claims to be running.
  if (live && planState === "active") return "active";
  return "paused";
}

/** A tool call's row mark, straight from the status the runtime published — never inferred. */
function toolStatusMark(status: AgentChatToolStatus): TraceState {
  if (status === "succeeded") return "done";
  if (status === "cancelled" || status === "not_started") return "muted";
  return "error"; // failed | denied | outcome_unknown
}

/** A history turn with no card and no terminal status stays open, showing one faded line. */
function historyTurnOpen(status: AgentChatHistoryStatus | undefined): boolean {
  return status === "awaiting_approval" || status === "awaiting_interaction" || status === "in_progress";
}
