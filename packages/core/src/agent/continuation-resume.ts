import { randomUUID } from "node:crypto";
import { AgenticError, type AgentTelemetrySink, type EventDraft, type RunTurnInput, type RunTurnResult, type SessionStore, type TurnControlPolicy } from "@0xsyncroot/contracts";
import { sha256 } from "../hash.js";
import type { AgentRuntimeOptions } from "./agent-options.js";
import type { RuntimeAcquire } from "./agent-operation.js";
import type { ContinueQuestionWording } from "./runtime-question.js";
import type { StoredToolInteraction } from "./approval-continuation.js";
import { runClaimedTurn, type ClaimedTurn } from "./claimed-turn.js";
import { ContinuationBinding, findPause, routePin, startedTurnFor, type ContinuationRequest, type PauseRecord } from "./continuation-binding.js";
import { report } from "./operation-observers.js";
import type { PreparedToolExecution, ToolExecutionContext } from "./tool-execution-coordinator.js";
import { TurnJournalView } from "./turn-journal-view.js";
import { replayClaimedTurn } from "./turn-replay.js";
import type { TurnSetup } from "./turn-setup.js";
import type { TurnStepLoop } from "./turn-step-loop.js";

export interface ResumeContext {
  readonly sessions: SessionStore;
  readonly options: AgentRuntimeOptions;
  readonly runtimeOwnerId: string;
  readonly operation: "resume-approval" | "resume-interaction";
  /** The resume's command; its idempotency key is required and names this resume. */
  readonly command: RunTurnInput;
  /** Leases the resume's runtime; called once the pause is found, with the route revision the pause recorded. */
  readonly acquire: RuntimeAcquire;
  /** Which pause is answered, and by whom; bound to the runtime once that is leased. */
  readonly pause: ContinuationRequest;
  /** What distinguishes this resume from another answer to the same pause, for the claim's fingerprint. */
  readonly submission: Readonly<Record<string, unknown>>;
  readonly telemetry?: AgentTelemetrySink;
  /** The product's policy, whose sentence a turn the silence watch stopped ends on. */
  readonly turnControlPolicy?: TurnControlPolicy;
  /** The product's words for asking whether to go on, asked under a turn the silence watch stopped. */
  readonly continueQuestion?: ContinueQuestionWording;
}

/**
 * The shared shape of both resumes, up to the point where the paused call runs.
 *
 * One bounded read seeds the operation's view and finds the pause, before any runtime is leased:
 * the lease asks for the route revision the pause was raised under, taken from the journal and
 * never from the request. The pause is then verified on the seeded view before anything is
 * written: a refusal — expired, stale, the wrong person, an invalid answer — leaves the journal
 * exactly as it was. A retry of a resume that already started skips that check and replays it,
 * since what it answered is resolved by now. The claim then records where the resume comes from
 * and carries the task's context forward; once acquired, the view catches up with what the claim
 * wrote and the pause is verified again, authoritatively.
 */
export async function runResume(context: ResumeContext, work: (turn: ClaimedTurn, record: PauseRecord) => Promise<RunTurnResult>): Promise<RunTurnResult> {
  const { sessions, command } = context;
  const noun = context.operation === "resume-approval" ? "approval" : "interaction";
  const key = command.idempotencyKey!;
  const view = await TurnJournalView.open(sessions, command.sessionId, command.security);
  const seeded = await view.events();
  const record = findPause(context.pause, seeded);
  const runtimeLease = await context.acquire(routePin(record));
  const binding = new ContinuationBinding(context.pause, runtimeLease);
  if (!startedTurnFor(seeded, key)) binding.verify(seeded);
  const turnId = randomUUID();
  const claim = await sessions.claimTurn({
    sessionId: command.sessionId, turnId, ownerId: context.runtimeOwnerId, idempotencyKey: key,
    requestFingerprint: sha256({
      tenantId: command.security.tenantId, actorId: command.security.actorId,
      grantRevision: command.security.grantRevision ?? "unspecified", sessionId: command.sessionId,
      agentProfileId: command.agentProfileId ?? "default", ...context.submission,
    }),
    agentProfileId: command.agentProfileId ?? "default", leaseTtlMs: context.options.leaseTtlMs,
    startEvents: binding.startEvents(turnId, key, record, seeded),
  }, { security: command.security, runtime: runtimeLease.snapshot });
  if (claim.kind === "completed") {
    // The seed predates the claim; the turn it names may have finished after it was read.
    await view.refresh();
    const replay = await replayClaimedTurn({ view, store: sessions, sessionId: command.sessionId, security: command.security, turnId: claim.turnId });
    if (replay) return replay;
    throw new AgenticError("conflict", `Completed ${noun} continuation cannot be reconstructed: ${claim.turnId}`);
  }
  if (claim.kind !== "acquired") throw new AgenticError("conflict", `${noun === "approval" ? "Approval" : "Interaction"} continuation is ${claim.kind}: ${claim.turnId}`);
  const applicationContext = binding.applicationContext(record, seeded);
  const input = { ...command, ...(applicationContext ? { applicationContext } : {}) };
  report(input, { type: "turn-started", turnId, continuation: binding.continuation(record, seeded) });
  return runClaimedTurn({
    sessions, options: context.options, input, turnId, claim, view, runtimeLease, operation: context.operation,
    ...(context.telemetry ? { telemetry: context.telemetry } : {}),
    ...(context.turnControlPolicy ? { turnControlPolicy: context.turnControlPolicy } : {}),
    ...(context.continueQuestion ? { continueQuestion: context.continueQuestion } : {}),
  }, async (turn) => work(turn, binding.verify(await view.events())));
}

/** Where a resumed call is prepared: under the resuming turn, keeping the execution the pause recorded. */
export function resumedCallContext(turn: ClaimedTurn, stepId: string, record: PauseRecord): ToolExecutionContext {
  return {
    sessionId: turn.input.sessionId, turnId: turn.turnId, stepId, security: turn.input.security,
    runtime: turn.runtimeLease.snapshot, executionIdOverride: String(record.payload.executionId),
    ...(turn.input.applicationContext ? { applicationContext: turn.input.applicationContext } : {}),
  };
}

/** The rest of a resumed turn: the loop, from the step after the one the resume spent on the call. */
export function continueResumedTurn(stepLoop: TurnStepLoop, turn: ClaimedTurn, setup: TurnSetup): Promise<RunTurnResult> {
  return stepLoop.execute({ turn, setup, startStepIndex: 2, skipMemoryContext: true });
}

/**
 * Runs the call a resume let through the batch executor, then continues the turn — or ends it on
 * the question that call raised in turn.
 */
export async function dispatchResumedCall(context: {
  readonly stepLoop: TurnStepLoop;
  readonly turn: ClaimedTurn;
  readonly setup: TurnSetup;
  readonly stepId: string;
  readonly prepared: PreparedToolExecution;
  readonly leadingDrafts: readonly EventDraft[];
  readonly interaction?: StoredToolInteraction;
  readonly authorizationOutcome: "allow" | "require_approval";
  /** Why the resume's first step ended, for the journal. */
  readonly stepEndReason: string;
}): Promise<RunTurnResult> {
  const { turn, setup, stepId } = context;
  const outcome = await setup.toolBatch.executeAuthorized({
    prepared: context.prepared, leadingDrafts: context.leadingDrafts, authorizationOutcome: context.authorizationOutcome,
    context: setup.batchContext(stepId, 1), signal: turn.signal, ...(context.interaction ? { interaction: context.interaction } : {}),
  });
  if (outcome.kind === "awaiting_interaction") return turn.terminator.finishAwaiting({ stepId, stepIndex: 1, pending: outcome });
  await turn.writer.append([{
    type: "step/end", turnId: turn.turnId, stepId, payload: { status: "completed", reason: context.stepEndReason },
  }], `step-end:${stepId}`);
  report(turn.input, { type: "step-completed", turnId: turn.turnId, step: 1 });
  return continueResumedTurn(context.stepLoop, turn, setup);
}
