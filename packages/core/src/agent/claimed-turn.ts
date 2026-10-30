import { AgenticError, type AgentTelemetrySink, type RunTurnInput, type RunTurnResult, type SessionStore, type TurnClaimResult, type TurnContextOperation, type TurnControlPolicy } from "@0xsyncroot/contracts";
import type { RuntimeViewLease } from "../runtime-provider.js";
import type { AgentRuntimeOptions } from "./agent-options.js";
import type { ContinueQuestionWording } from "./runtime-question.js";
import { silenceFallback } from "./step-failure-recovery.js";
import { TurnEventWriter } from "./turn-event-writer.js";
import type { TurnJournalView } from "./turn-journal-view.js";
import { TurnTerminator } from "./turn-terminator.js";

/** A turn this runtime holds the lease of: what every part of its execution writes and reads through. */
export interface ClaimedTurn {
  readonly input: RunTurnInput;
  readonly turnId: string;
  readonly writer: TurnEventWriter;
  readonly view: TurnJournalView;
  readonly terminator: TurnTerminator;
  readonly runtimeLease: RuntimeViewLease;
  readonly operation: TurnContextOperation;
  readonly telemetry?: AgentTelemetrySink;
  /** Aborts on the caller's signal, a stretch of silence, or the lease being lost. */
  readonly signal: AbortSignal;
  /** The turn produced a step or a tool call. Restarts the silence clock; does not extend a hung one. */
  readonly noteProgress: () => void;
}

export interface ClaimedTurnContext {
  readonly sessions: SessionStore;
  readonly options: AgentRuntimeOptions;
  readonly input: RunTurnInput;
  readonly turnId: string;
  readonly claim: Extract<TurnClaimResult, { readonly kind: "acquired" }>;
  readonly view: TurnJournalView;
  readonly runtimeLease: RuntimeViewLease;
  readonly operation: TurnContextOperation;
  readonly telemetry?: AgentTelemetrySink;
  /** The product's policy, whose sentence a turn the silence watch stopped ends on. */
  readonly turnControlPolicy?: TurnControlPolicy;
  /** The product's words for asking whether to go on, asked under a turn the silence watch stopped. */
  readonly continueQuestion?: ContinueQuestionWording;
}

/**
 * Runs the work of an acquired turn under its lease, the same way for all three operations.
 *
 * The lease is renewed on a heartbeat and its loss aborts the work. The silence clock aborts it
 * only after `turnTimeoutMs` with no step and no tool call; activity restarts that clock. A turn
 * that clock stopped ends `partial` with reason `time-limit` (`silenceFallback`). The view follows
 * the writer, and whatever else the work throws ends the turn through the terminator, which closes
 * the calls left open and writes `turn/failed` — or, when even that cannot be written, throws both
 * failures.
 */
/** A clock that fires only after `timeoutMs` with no `noteProgress`. Working turns never meet it. */
export function createSilenceWatch(timeoutMs: number): { readonly signal: AbortSignal; noteProgress: () => void; stop: () => void } {
  const controller = new AbortController();
  let timer = arm();
  function arm(): ReturnType<typeof setTimeout> {
    const next = setTimeout(() => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      controller.abort(error);
    }, timeoutMs);
    next.unref();
    return next;
  }
  return {
    signal: controller.signal,
    noteProgress() {
      if (controller.signal.aborted) return;
      clearTimeout(timer);
      timer = arm();
    },
    stop() { clearTimeout(timer); },
  };
}

export async function runClaimedTurn(context: ClaimedTurnContext, work: (turn: ClaimedTurn) => Promise<RunTurnResult>): Promise<RunTurnResult> {
  const { input, turnId, options } = context;
  const writer = new TurnEventWriter(context.sessions, input.sessionId, input.security, context.runtimeLease.snapshot, context.claim.seq, context.claim.lease);
  context.view.follow(writer);
  const terminator = new TurnTerminator({
    input, turnId, writer, view: context.view, runtimeLease: context.runtimeLease, interactionTtlMs: options.interactionTtlMs,
    ...(context.telemetry ? { telemetry: context.telemetry } : {}),
  });
  const leaseLost = new AbortController();
  const silence = createSilenceWatch(options.turnTimeoutMs);
  const signals = [silence.signal, leaseLost.signal];
  if (input.signal) signals.push(input.signal);
  const signal = AbortSignal.any(signals);
  let settled = false;
  let renewing: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (renewing || settled) return;
    renewing = writer.renew(options.leaseTtlMs)
      .catch((error: unknown) => { if (!settled) leaseLost.abort(error); })
      .finally(() => { renewing = undefined; });
  }, options.leaseRenewIntervalMs);
  heartbeat.unref();
  const turn: ClaimedTurn = {
    input, turnId, writer, view: context.view, terminator, runtimeLease: context.runtimeLease, operation: context.operation, signal,
    noteProgress: () => silence.noteProgress(),
    ...(context.telemetry ? { telemetry: context.telemetry } : {}),
  };
  try {
    const result = await work(turn);
    settled = true;
    return result;
  } catch (error) {
    // Only the silence clock firing first ends the turn unfinished; a caller's cancel and a lost lease stay failures.
    const silenced = silence.signal.aborted && signal.reason === silence.signal.reason;
    let ending: unknown;
    if (silenced) {
      try {
        const result = await silenceFallback(turn, silence.signal.reason, context);
        settled = true;
        return result;
      } catch (endingError) {
        ending = endingError;
      }
    }
    const failure = await terminator.fail(error);
    settled = true;
    if (ending === undefined) throw failure;
    throw new AgenticError(failure.code, failure.message, failure.retryable, {
      cause: new AggregateError([failure, ending], `Turn ${turnId} went silent and its unfinished ending could not be written`),
      ...(failure.outcome ? { outcome: failure.outcome } : {}), ...(failure.reason ? { reason: failure.reason } : {}),
    });
  } finally {
    silence.stop();
    clearInterval(heartbeat);
    await renewing?.catch(() => undefined);
  }
}
