import type { TurnControlPolicy, TurnControlState, TurnTerminalDecision } from "@0xsyncroot/contracts";

/** Opens the feedback of every refusal: the journal's `turn/control-decision` reason is counted by it. */
export const WRITE_PRECONDITION_MARKER = "Write precondition unmet:";

export interface ToolPreconditionOptions {
  /**
   * Write tool id → the tool ids that must have a succeeded result in the task before that write is proposed (the skills'
   * `preconditions`, merged). Read on every review with the reviewed step's state, so a composition can bind it once the
   * catalog is loaded and, where runtimes differ in their catalog, answer for the runtime the step runs on (`state.runtime`).
   */
  readonly preconditions: (state: TurnControlState) => ReadonlyMap<string, readonly string[]> | Readonly<Record<string, readonly string[]>>;
  /** The sentence the user reads if the turn ends on a refused write, in the product's language. */
  readonly fallback: string;
}

/** The tool ids with a succeeded result in the task the step belongs to. */
function succeededInTask(state: TurnControlState): ReadonlySet<string> {
  const task = new Set(state.taskTurnIds.length ? state.taskTurnIds : [state.turnId]);
  const succeeded = new Set<string>();
  for (const event of state.context.events) {
    if (event.type !== "tool/result" || !task.has(event.turnId ?? "")) continue;
    const payload = event.payload as Record<string, unknown> | null;
    if (payload?.state === "succeeded" && typeof payload.toolId === "string") succeeded.add(payload.toolId);
  }
  return succeeded;
}

/**
 * A write a procedure orders after other calls is refused until those calls have succeeded in the task.
 *
 * The declaration is data (a skill's `preconditions`) and the check is a journal fact, so it holds whatever else is
 * mounted: no judge, a judge that cannot be reached, an action gate in shadow, standing approval. It runs first, before
 * the wrapped policy and before any approval: a refused step is held back whole and never reaches a card. The model is
 * told which calls are missing and decides itself how to get them; the runtime never makes them on its behalf.
 * Under standing approval no card stands between the model and an out-of-order write; this check does.
 */
export function withToolPreconditions(policy: TurnControlPolicy, options: ToolPreconditionOptions): TurnControlPolicy {
  const declared = (state: TurnControlState): ReadonlyMap<string, readonly string[]> => {
    const value = options.preconditions(state);
    return value instanceof Map ? value : new Map(Object.entries(value));
  };
  const reviewToolCalls: NonNullable<TurnControlPolicy["reviewToolCalls"]> = async (input, signal, services) => {
    const preconditions = declared(input);
    const writes = [...new Set(input.toolCalls.map((call) => call.name).filter((name) => preconditions.has(name)))];
    if (writes.length > 0) {
      const succeeded = succeededInTask(input);
      const unmet = writes.map((write) => ({ write, missing: preconditions.get(write)!.filter((id) => !succeeded.has(id)) }))
        .filter((entry) => entry.missing.length > 0);
      if (unmet.length > 0) {
        const missing = [...new Set(unmet.flatMap((entry) => entry.missing))];
        return {
          decision: "continue", fallback: options.fallback,
          feedback: `${WRITE_PRECONDITION_MARKER} ${unmet.map((entry) => `${entry.write} needs a succeeded ${entry.missing.join(" and ")} in this task first`).join("; ")}. `
            + `None of this step's calls ran. Call ${missing.join(", ")} in a step of its own, without the write, `
            + `and propose the write again only after ${missing.length === 1 ? "it has" : "they have"} succeeded.`,
        } satisfies TurnTerminalDecision;
      }
    }
    return await policy.reviewToolCalls?.(input, signal, services) ?? { decision: "accept" };
  };
  return {
    id: policy.id, revision: `${policy.revision}+preconditions`,
    ...(policy.keepDraftsAsNarration !== undefined ? { keepDraftsAsNarration: policy.keepDraftsAsNarration } : {}),
    beforeModelStep: (input, signal, services) => policy.beforeModelStep(input, signal, services),
    reviewToolCalls,
    reviewTerminal: (input, signal, services) => policy.reviewTerminal(input, signal, services),
    ...(policy.fallbackText ? { fallbackText: policy.fallbackText.bind(policy) } : {}),
  };
}
