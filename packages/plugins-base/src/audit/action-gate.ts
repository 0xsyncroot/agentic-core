import type { JsonValue, TurnControlPolicy, TurnControlServices, TurnControlState, TurnTerminalDecision } from "@0xsyncroot/contracts";
import { ACTION_GATE_QUESTIONS } from "./action-gate-questions.js";
import { turnEvidence } from "./completion-audit.js";

/**
 * A check of each write the agent proposes, before it runs: is it what the user asked for, are its
 * values stated by the user or the evidence, and is its target the one the request means?
 *
 * The turn's fast judge reads the request, the evidence and the call — not the agent's prose — and
 * the answer is journaled by core as `action-gate`. Only a confident doubt sends the call back, with
 * the instruction to ask the user through the form tool rather than guess; anything less, a failed
 * judgment or no judge at all lets the call through to the approval the write needs anyway. Until a
 * deployment has measured it, the gate runs in `shadow`: it asks and journals, and never blocks.
 */
export const ACTION_GATE_THRESHOLDS = Object.freeze({ requestedBelow: 0.2, inventedAbove: 0.8, ambiguousAbove: 0.8 });

const REASONS = {
  requested: "the user's request does not ask for this change on this target",
  invented: "a value in it is stated by neither the user nor the evidence",
  ambiguous: "the request could mean more than one target, and nothing settles which one this call uses",
} as const;

const MAX_WRITES_JUDGED = 3;
const DESCRIPTION_CHARS = 800;
const PLANNING_TOOL = /(?:^|_)plan_(?:update|mark)$/u;

export interface ActionGateOptions {
  /** `shadow` (default) asks and journals without blocking; `on` sends a confidently doubted write back. */
  readonly mode?: "shadow" | "on";
  /** The sentence the user reads if the turn ends on a refused write, in the product's language. */
  readonly fallback: string;
  /** Called with each judged write, for telemetry. */
  readonly onJudged?: (record: { readonly tool: string; readonly probabilities: Readonly<Record<string, number>>; readonly reasons: readonly string[] }) => void;
  readonly isPlanningTool?: (toolId: string) => boolean;
  /**
   * Which calls are data writes to check. Default: none — a product names its own, because "has a
   * side effect" also covers actions that are not data writes (a click that opens a month on a
   * screen) and the questions are about a change the user asked for; a navigation click judged as a
   * write is refused, and so is every screen step.
   */
  readonly gates?: (toolId: string) => boolean;
  /**
   * What the tool is and the units its arguments take, as its definition says; the judge reads it beside the call. Asked
   * with the reviewed step's state, so a composition whose runtimes differ in their catalog answers for `state.runtime`.
   */
  readonly describeTool?: (toolId: string, state: TurnControlState) => string | undefined;
}

export function withActionGate(policy: TurnControlPolicy, options: ActionGateOptions): TurnControlPolicy {
  const mode = options.mode ?? "shadow";
  const isPlanningTool = options.isPlanningTool ?? ((id: string) => PLANNING_TOOL.test(id));
  const reviewToolCalls: NonNullable<TurnControlPolicy["reviewToolCalls"]> = async (input, signal, services: TurnControlServices = {}) => {
    const inner = await policy.reviewToolCalls?.(input, signal, services) ?? { decision: "accept" as const };
    const judge = services.judge;
    if (inner.decision === "continue" || !judge) return inner;
    const sideEffect = new Map(input.availableTools.map((tool) => [tool.id, tool]));
    const gated = options.gates ?? (() => false);
    const writes = input.toolCalls.filter((call) => gated(call.name) && (sideEffect.get(call.name)?.sideEffect ?? "none") !== "none").slice(0, MAX_WRITES_JUDGED);
    if (writes.length === 0) return inner;
    const gathered = turnEvidence(input, isPlanningTool);
    const judgeWrites = async (): Promise<readonly string[]> => {
      const refused: string[] = [];
      for (const call of writes) {
        const state = { request: gathered?.request ?? "", evidence: gathered?.classifierEvidence ?? [],
          action: { tool: call.name, description: (options.describeTool?.(call.name, input) ?? "").slice(0, DESCRIPTION_CHARS), arguments: call.arguments } };
        const judged = await judge("action-gate", { state: state as unknown as JsonValue, questions: ACTION_GATE_QUESTIONS }, signal);
        if (!judged) continue;
        const p = Object.fromEntries(Object.entries(judged.answers).flatMap(([id, a]) => a.type === "noul" ? [[id, a.noul]] : [])) as Record<string, number>;
        const reasons = [
          ...(p.requested !== undefined && p.requested <= ACTION_GATE_THRESHOLDS.requestedBelow ? [REASONS.requested] : []),
          ...(p.invented !== undefined && p.invented >= ACTION_GATE_THRESHOLDS.inventedAbove ? [REASONS.invented] : []),
          ...(p.ambiguous !== undefined && p.ambiguous >= ACTION_GATE_THRESHOLDS.ambiguousAbove ? [REASONS.ambiguous] : []),
        ];
        options.onJudged?.({ tool: call.name, probabilities: p, reasons });
        if (reasons.length) refused.push(`${call.name}: ${reasons.join("; ")}`);
      }
      return refused;
    };
    // In shadow the verdict changes nothing, so the write does not wait for it (as `StepClaimReview` in shadow): it is journaled
    // and reported when it comes, and a failure is only lost data — a judgment that outlives the turn is refused by the writer's
    // lease fence and lands here. Awaited, every gated write would pay the judge's latency for a result thrown away.
    if (mode !== "on") { judgeWrites().catch(() => undefined); return inner; }
    const refused = await judgeWrites();
    if (refused.length === 0) return inner;
    return {
      decision: "continue", fallback: options.fallback,
      feedback: `Write check before running: ${refused.join(". ")}. Do not run this write as it stands. `
        + "If a value or the target is not stated by the user or the evidence, ask the user through the form tool, offering the nearest choices the evidence shows; "
        + "if the user did not ask for this change, do not make it and answer the request as asked.",
    } satisfies TurnTerminalDecision;
  };
  return {
    id: policy.id, revision: `${policy.revision}+action-gate-${mode}`,
    ...(policy.keepDraftsAsNarration !== undefined ? { keepDraftsAsNarration: policy.keepDraftsAsNarration } : {}),
    beforeModelStep: (input, signal, services) => policy.beforeModelStep(input, signal, services),
    reviewToolCalls,
    reviewTerminal: (input, signal, services) => policy.reviewTerminal(input, signal, services),
    ...(policy.fallbackText ? { fallbackText: policy.fallbackText.bind(policy) } : {}),
  };
}
