import { randomUUID } from "node:crypto";
import { AgenticError, type ChatMessage, type ToolCall, type TurnControlPolicy, type TurnControlState, type TurnModelDirective } from "@0xsyncroot/contracts";
import type { ToolBatchExecutor } from "./tool-batch-executor.js";
import type { TurnJournalView } from "./turn-journal-view.js";

/**
 * The reads a turn-control policy asked for, performed before the model sees the step.
 *
 * A product that needs a read after a write used to get it by restricting the step to reads and
 * requiring a call. That works on a model that honours `tool_choice`; the production model
 * answered in prose twice instead, and the turn ended on a fallback denying a write the journal
 * showed had succeeded. Nothing about that read depends on the model: the policy knows which
 * tool and which scope, so the runtime makes the call itself, journals it as the policy's, and
 * the model reads the evidence like any other tool result.
 *
 * Runs through the ordinary batch executor, so the tool policy, permissions, timeouts and the
 * result budget all apply. A read that turns out to need approval is a misconfiguration, and
 * the turn fails rather than silently skipping the verification it was promised. A read the
 * policy marks best-effort is the opposite promise: it is bounded in time, and when it would
 * pause, fails or runs out of time, the model sees nothing of it and the turn goes on (the
 * journal keeps `skipped`).
 *
 * Returns the state the policy's later reviews judge the step by, and whether a read brought a new result — by the batch's own
 * measure of progress: that is the runtime's evidence, the one thing that resets the turn's objections (`objectionsHeard`).
 */
export interface PolicyReads {
  readonly state: TurnControlState;
  readonly progressed: boolean;
}

export async function observeBeforeModel(input: {
  readonly policy: TurnControlPolicy;
  readonly directive: TurnModelDirective;
  readonly state: TurnControlState;
  readonly toolBatch: ToolBatchExecutor;
  readonly view: TurnJournalView;
  readonly stepId: string;
  /** Which round of the step's reads this is; the first keeps the step's own journal key. */
  readonly round?: number;
  readonly runtimeRouteRevision: string;
  readonly signal: AbortSignal;
}): Promise<PolicyReads> {
  const requested = input.directive.observations ?? [];
  if (requested.length === 0) return { state: input.state, progressed: false };
  // A best-effort read never decides the turn: it runs apart from the reads the policy needs, so a pause or a failure of one
  // cannot reach the other, and the policy's own reads keep exactly the behaviour below.
  const required = requested.filter((observation) => !observation.bestEffort);
  const bounds = [...new Set(requested.flatMap((observation) => observation.bestEffort ? [observation.bestEffort.timeoutMs] : []))];
  const groups = [
    { key: "", timeoutMs: undefined, observations: required },
    ...bounds.map((timeoutMs) => ({ key: `:best-effort:${timeoutMs}`, timeoutMs, observations: requested.filter((observation) => observation.bestEffort?.timeoutMs === timeoutMs) })),
  ];
  const round = input.round && input.round > 1 ? `:${input.round}` : "";
  let progressed = false;
  for (const { key, timeoutMs, observations } of groups) {
    if (observations.length === 0) continue;
    const calls: ToolCall[] = observations.map((observation) => ({
      id: `observe-${randomUUID()}`, name: observation.toolId, arguments: JSON.stringify(observation.arguments),
    }));
    // The batch renders tool messages for the step it belongs to; here the journal is the
    // channel, and the next context preparation projects the results from it.
    const scratch: ChatMessage[] = [];
    const batch = await input.toolBatch.execute(calls, {
      sessionId: input.state.sessionId, turnId: input.state.turnId, stepId: input.stepId, stepIndex: input.state.stepIndex,
      security: input.state.security, runtime: input.state.runtime, runtimeRouteRevision: input.runtimeRouteRevision,
      ...(input.state.agentProfileId ? { agentProfileId: input.state.agentProfileId } : {}),
      ...(timeoutMs !== undefined ? { bestEffort: { timeoutMs } } : {}),
      initiator: { policyId: input.policy.id, reason: observations.map((observation) => observation.reason).join("; ") },
    }, scratch, input.signal, `observation:${input.stepId}${key}${round}`);
    if (batch.kind !== "completed") {
      throw new AgenticError("validation", `Turn-control observation cannot pause the turn: ${batch.kind}`);
    }
    if (timeoutMs === undefined) progressed ||= batch.progressed;
  }
  // The policy's later reviews judge this step by what the journal holds; the state it was
  // handed predates its own reads.
  return { state: Object.freeze({ ...input.state, context: await input.view.evidence() }), progressed };
}
