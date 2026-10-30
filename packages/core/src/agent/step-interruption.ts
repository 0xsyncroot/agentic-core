import { AgenticError } from "@0xsyncroot/contracts";
import { classifyError } from "./error-classifier.js";
import { interjectionFits } from "./turn-end.js";
import type { TurnLoop } from "./turn-step-loop-input.js";

/** A step's watch over the user's mid-turn input while its model call runs. */
export interface StepInterruption {
  /** Aborts when input arrives; the model call listens to it beside the turn's own signal. */
  readonly signal: AbortSignal;
  /**
   * Whether the call was cut for input, the turn itself still running: a cancel, a silence timeout or a lost lease wins. With
   * `error`, also whether that error is the cut (its abort reason, or a cancellation an adapter wrapped it in), so a store or
   * budget failure that comes after the input is never taken for it.
   */
  cut(error?: unknown): boolean;
  dispose(): void;
}

/**
 * Watches for input the user adds while the step waits for its model.
 *
 * A step during which input arrived throws its output away (`interjected`, step-disposition.ts), so waiting for that output
 * only delays the user's words by the rest of the call: a thinking model takes tens of seconds. The call is cut as soon as the
 * input arrives, and the step ends as interjected; the next step reads the words first. Armed only while the model runs —
 * never over a tool, whose write must finish — and only when the allowance has a step to give the input
 * (`interjectionFits`); otherwise the input waits for the next boundary or the turn's end, as before.
 */
export function watchInterjections(loop: TurnLoop, stepIndex: number): StepInterruption {
  const queue = loop.turn.input.interjections;
  const controller = new AbortController();
  const inert: StepInterruption = { signal: controller.signal, cut: () => false, dispose: () => undefined };
  if (!queue?.subscribe || !interjectionFits(loop.ledger, loop.bounds, stepIndex)) return inert;
  const reason = new AgenticError("cancelled", "Model call cut: the user added input", false);
  const fire = (): void => { if (!controller.signal.aborted) controller.abort(reason); };
  let unsubscribe: () => void;
  // A queue that fails to be watched only loses the shortcut: its input is still read at the next boundary.
  try {
    unsubscribe = queue.subscribe(fire);
    // Input that arrived while the step read before its model (the policy's reads, a judgment) is as new to this call.
    if ((queue.pending ?? 0) > 0) fire();
  } catch { return inert; }
  const fired = (): boolean => controller.signal.aborted && !loop.turn.signal.aborted;
  return {
    signal: controller.signal,
    cut: (error) => fired() && (error === undefined || error === reason || classifyError(error).code === "cancelled"),
    dispose: () => { try { unsubscribe(); } catch { /* Unwatching is best effort. */ } },
  };
}
