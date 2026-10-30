/**
 * Which earlier narration of a turn leaves the chat once a step without progress has told its own.
 *
 * A step that makes progress adds its sentence; only when
 * a step has run without progress does the stuck sentence before it leave, so the chat keeps the
 * last stuck sentence and every progressing one. It is decided after the step's outcome, never when
 * its sentence is told. Whether a step made progress is the runtime's own record of it — a dispatched
 * call returned an observation the turn had not seen (`StepBudget.recordStepOutcome`) — never the words
 * of either sentence. A step that only planned, or whose every call was refused or unavailable, made none.
 *
 * Only the narration told beside the model's own work takes part. A draft a policy kept on screen
 * never reaches the chain, and the plan announcement opens the turn's account: it is never superseded.
 */
export class NarrationChain {
  /** The latest work narration whose step has ended, and whether any step since it was told made progress. */
  #latest: { readonly id: string; readonly progressed: boolean } | undefined;
  /** The work narration of the step now running, until that step's outcome is recorded. */
  #told: string | undefined;

  /** A narration was journaled for the step now running; the announcement is no work narration and starts the chain afresh. */
  narrated(narrationId: string, work: boolean): void {
    if (work) {
      this.#told = narrationId;
      return;
    }
    this.#latest = undefined;
    this.#told = undefined;
  }

  /**
   * The step now running ended; `progressed` is the runtime's verdict on it. Returns the narration this step's own one
   * supersedes: the previous one, when this step told a sentence, made no progress, and no step since the previous was told made any.
   */
  settle(progressed: boolean): { readonly narrationId: string; readonly by: string } | undefined {
    const told = this.#told;
    const previous = this.#latest;
    this.#told = undefined;
    if (told === undefined) {
      if (progressed && previous) this.#latest = { id: previous.id, progressed: true };
      return undefined;
    }
    this.#latest = { id: told, progressed };
    return !progressed && previous && !previous.progressed ? { narrationId: previous.id, by: told } : undefined;
  }
}
