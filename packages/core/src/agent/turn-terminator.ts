import {
  AgenticError,
  createInterruptedToolResults,
  type AgentTelemetrySink,
  type ApprovalChallenge,
  type EventDraft,
  type FormInteractionRequest,
  type HumanInteractionChallenge,
  type LlmUsage,
  type RunTurnInput,
  type RunTurnResult,
  type TurnEndDecision,
} from "@0xsyncroot/contracts";
import { agenticError, classifyError } from "./error-classifier.js";
import type { RuntimeViewLease } from "../runtime-provider.js";
import { observe, report } from "./operation-observers.js";
import { createRuntimeQuestion } from "./runtime-question.js";
import type { TurnEventWriter } from "./turn-event-writer.js";
import type { TurnJournalView } from "./turn-journal-view.js";

/**
 * How a turn ended, as the collaborators that close its work see it. `asksUser` marks a partial end
 * that left the runtime's own question open: the work waits on the user's answer, as on a card.
 */
export type TurnTerminalOutcome =
  | { readonly kind: "answer"; readonly outcome: "completed" | "partial"; readonly decision: TurnEndDecision; readonly asksUser?: true }
  | { readonly kind: "awaiting"; readonly outcome: "awaiting_approval" | "awaiting_interaction" }
  | { readonly kind: "fallback"; readonly asksUser?: true }
  | { readonly kind: "failed"; readonly code: string };

/**
 * Work a turn has open that its end must settle — a plan, for one — journaled in the same append
 * that precedes the terminal event, so no reader ever sees the turn ended and its work still open.
 * A collaborator reports its own progress from `close`, which runs before the turn's final frames.
 */
export interface TurnWorkCloser {
  close(outcome: TurnTerminalOutcome): Promise<readonly EventDraft[]>;
}

export type TurnAwaiting =
  | { readonly kind: "awaiting_approval"; readonly approval: ApprovalChallenge }
  | { readonly kind: "awaiting_interaction"; readonly interaction: HumanInteractionChallenge };

interface TurnTerminatorContext {
  readonly input: RunTurnInput;
  readonly turnId: string;
  readonly writer: TurnEventWriter;
  readonly view: TurnJournalView;
  readonly telemetry?: AgentTelemetrySink;
  /** What a question the runtime asks is bound to, and how long it stays answerable; required only to ask one. */
  readonly runtimeLease?: RuntimeViewLease;
  readonly interactionTtlMs?: number;
}

/**
 * The only writer of `turn/end` and `turn/failed`.
 *
 * A turn used to end from eight places — the loop, the planning answer, the policy fallback, each
 * resume's inline pauses, three catch blocks — each writing its own terminal, and they drifted: the
 * resumes' catch blocks let a failed terminal write replace the error that caused it, and none closed
 * the calls a failing turn left open. Every ending now goes through here: the step's end and
 * whatever the attached closers settle go in one append, then the terminal, then the reports, then
 * the result, whose events are this turn's own taken from the operation's view.
 */
export class TurnTerminator {
  readonly #closers: TurnWorkCloser[] = [];

  constructor(private readonly turn: TurnTerminatorContext) {}

  /** Why the turn ended, for the operator: `outcome` alone does not say whether a partial was budget, cut-off or policy. */
  #observeEnd(outcome: "completed" | "partial", decision: string, reason: string, steps: number): void {
    const { input, turnId, telemetry } = this.turn;
    observe(telemetry, {
      type: "agent.turn.ended", tenantId: input.security.tenantId, sessionId: input.sessionId, correlationId: input.security.correlationId,
      turnId, outcome, decision, reason, steps, occurredAt: new Date().toISOString(),
    });
  }

  /** Adds work the turn's end must close; with none attached, ending a turn closes nothing extra. */
  attach(closer: TurnWorkCloser): void {
    this.#closers.push(closer);
  }

  /**
   * Ends the turn on an answer. A `question` is the runtime's own, put to the user when a partial
   * turn left work (`turn-end.ts`): it is journaled with the step's end and the turn still ends `partial`,
   * its answer and decision kept — the user reads what was done, then chooses whether to go on.
   */
  async finishAnswer(command: {
    readonly stepId: string; readonly stepIndex: number; readonly content: string; readonly finishReason: string;
    readonly outcome: "completed" | "partial"; readonly decision: TurnEndDecision; readonly usage: Required<LlmUsage>;
    readonly reason?: string; readonly question?: FormInteractionRequest;
  }): Promise<RunTurnResult> {
    const { input, turnId, writer } = this.turn;
    const { stepId, stepIndex, outcome, decision } = command;
    const reason = command.reason ?? command.finishReason;
    const asked = command.question && outcome === "partial" ? this.#ask(stepId, command.question) : undefined;
    const closing = await this.#close({ kind: "answer", outcome, decision, ...(asked ? { asksUser: true as const } : {}) });
    await writer.append([
      ...(asked ? [asked.draft] : []),
      { type: "step/end", turnId, stepId, payload: { status: "completed", reason: command.finishReason } }, ...closing,
    ], `step-end:${stepId}`);
    await writer.finish({ type: "turn/end", turnId, payload: { status: outcome, reason, steps: stepIndex, decision } });
    if (asked) report(input, { type: "interaction-requested", turnId, step: stepIndex, interaction: asked.challenge });
    report(input, { type: "step-completed", turnId, step: stepIndex });
    report(input, { type: "work-decision", turnId, step: stepIndex, decision });
    report(input, { type: "turn-completed", turnId, steps: stepIndex, outcome });
    this.#observeEnd(outcome, decision, reason, stepIndex);
    return {
      content: command.content, sessionId: input.sessionId, turnId, outcome, usage: command.usage, events: await this.#turnEvents(),
      ...(asked ? { interaction: asked.challenge } : {}),
    };
  }

  /** Ends the turn on something the user has to answer first: an approval card, or a question. */
  async finishAwaiting(command: {
    readonly stepId: string; readonly stepIndex: number; readonly pending: TurnAwaiting;
    readonly usage?: Required<LlmUsage>; readonly reason?: string;
  }): Promise<RunTurnResult> {
    const { input, turnId, writer } = this.turn;
    const { stepId, stepIndex, pending } = command;
    const reason = command.reason ?? (pending.kind === "awaiting_approval" ? "approval-required" : "interaction-required");
    const closing = await this.#close({ kind: "awaiting", outcome: pending.kind });
    await writer.append([{ type: "step/end", turnId, stepId, payload: { status: pending.kind, reason } }, ...closing], `step-end:${stepId}`);
    await writer.finish({ type: "turn/end", turnId, payload: { status: pending.kind, reason, steps: stepIndex } });
    report(input, { type: "step-completed", turnId, step: stepIndex });
    report(input, { type: "turn-completed", turnId, steps: stepIndex, outcome: pending.kind });
    // No content either way: the card carries its own words. A question's message used to be the
    // turn's content as well, and the user read it twice — as an answer, then on the card.
    const base = { sessionId: input.sessionId, turnId, content: "", ...(command.usage ? { usage: command.usage } : {}), events: await this.#turnEvents() };
    return pending.kind === "awaiting_approval"
      ? { ...base, outcome: pending.kind, approval: pending.approval }
      : { ...base, outcome: pending.kind, interaction: pending.interaction };
  }

  /**
   * Ends the turn on the runtime's own content, after the drafts that record why (a policy's
   * fallback decision and the message it stands for). Always `partial`: the agent did not do what
   * it set out to do. A `question` is asked as on an answer, when the runtime's own bound ended work left.
   */
  async finishFallback(command: {
    readonly stepId: string; readonly stepIndex: number; readonly content: string;
    readonly drafts: readonly EventDraft[]; readonly usage: Required<LlmUsage>;
    readonly reason?: string; readonly question?: FormInteractionRequest;
  }): Promise<RunTurnResult> {
    const { input, turnId, writer } = this.turn;
    const { stepId, stepIndex } = command;
    const reason = command.reason ?? "turn-control-fallback";
    const asked = command.question ? this.#ask(stepId, command.question) : undefined;
    const closing = await this.#close({ kind: "fallback", ...(asked ? { asksUser: true as const } : {}) });
    await writer.append([
      ...command.drafts,
      ...(asked ? [asked.draft] : []),
      { type: "step/end", turnId, stepId, payload: { status: "completed", reason } },
      ...closing,
    ], `turn-control:fallback:${stepId}`);
    await writer.finish({ type: "turn/end", turnId, payload: { reason, steps: stepIndex, status: "partial", decision: "partial" } });
    if (asked) report(input, { type: "interaction-requested", turnId, step: stepIndex, interaction: asked.challenge });
    report(input, { type: "step-completed", turnId, step: stepIndex });
    report(input, { type: "work-decision", turnId, step: stepIndex, decision: "partial" });
    report(input, { type: "turn-completed", turnId, steps: stepIndex, outcome: "partial" });
    this.#observeEnd("partial", "partial", reason, stepIndex);
    return {
      content: command.content, sessionId: input.sessionId, turnId, outcome: "partial", usage: command.usage, events: await this.#turnEvents(),
      ...(asked ? { interaction: asked.challenge } : {}),
    };
  }

  /**
   * Ends the turn as failed and returns the error for the caller to throw.
   *
   * Every call this turn left without a result is closed first — `outcome_unknown` once it crossed
   * the dispatch boundary, `not_started` before — so no call of a failed turn stays open for the
   * next model request to trip over. Closing needs the turn's events: when the journal cannot be
   * read (the very failure that may have ended the turn), the events the view already holds stand
   * in, which closes every call it knows of and leaves only calls it never saw.
   *
   * The returned error always carries the original failure's code, reason, outcome and
   * retryability, so the caller reports what went wrong with the turn and not that its ending was
   * hard to write. When writing the ending failed too, `cause` holds both failures.
   */
  async fail(error: unknown): Promise<AgenticError> {
    const { input, turnId, writer, view } = this.turn;
    const details = classifyError(error);
    let persistence: unknown;
    try {
      const events = await view.events().catch((readError: unknown) => { persistence = readError; return view.held; });
      const closing = [...createInterruptedToolResults(events.filter((event) => event.turnId === turnId), turnId), ...await this.#close({ kind: "failed", code: details.code })];
      if (closing.length > 0) await writer.append(closing, `turn-failed-closure:${turnId}`);
      await writer.finish({ type: "turn/failed", turnId, payload: { ...details } });
      report(input, { type: "turn-failed", turnId, code: details.code });
    } catch (terminalError) {
      persistence = persistence === undefined ? terminalError : new AggregateError([persistence, terminalError], "Reading the journal and writing the turn's ending both failed");
    }
    if (persistence === undefined) return agenticError(error);
    return new AgenticError(details.code, details.message, details.retryable, {
      cause: new AggregateError([error, persistence], `Turn ${turnId} failed and its ending could not be recorded as usual`),
      ...(details.outcome ? { outcome: details.outcome } : {}), ...(details.reason ? { reason: details.reason } : {}),
    });
  }

  /** The runtime's own question, bound to this turn's person, grants and runtime like any card. */
  #ask(stepId: string, request: FormInteractionRequest): ReturnType<typeof createRuntimeQuestion> {
    const { input, turnId, runtimeLease, interactionTtlMs } = this.turn;
    if (!runtimeLease || interactionTtlMs === undefined) throw new AgenticError("permanent", "A runtime question requires the turn's runtime lease and interaction TTL");
    return createRuntimeQuestion({
      sessionId: input.sessionId, turnId, stepId, request, runtime: runtimeLease.snapshot, runtimeRouteRevision: runtimeLease.binding.routeRevision,
      security: input.security, ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}), ttlMs: interactionTtlMs,
    });
  }

  async #close(outcome: TurnTerminalOutcome): Promise<readonly EventDraft[]> {
    const drafts: EventDraft[] = [];
    for (const closer of this.#closers) drafts.push(...await closer.close(outcome));
    return drafts;
  }

  /** This turn's own events, from the view: what the result carries and a replay reproduces. */
  async #turnEvents(): Promise<RunTurnResult["events"]> {
    return (await this.turn.view.events()).filter((event) => event.turnId === this.turn.turnId);
  }
}
