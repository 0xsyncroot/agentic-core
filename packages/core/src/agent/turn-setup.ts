import { AgenticError, type StandingApprovalSource, type ToolDefinition, type ToolExecutionBroker, type ToolExecutionPolicy, type ToolGroupCatalog, type ToolResultSpool, type UnavailableCapabilities, type WorkPlanningProvider } from "@0xsyncroot/contracts";
import { TOOL_CAPABILITY, WORK_PLANNING_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import { resolveContextualToolSurface, type AttachmentReader } from "../tools/contextual-tool-resolver.js";
import type { AgentRuntimeOptions } from "./agent-options.js";
import type { ClaimedTurn } from "./claimed-turn.js";
import { observe, report } from "./operation-observers.js";
import { taskTurnIdsFor } from "./task-turns.js";
import { coveringApproval, type ApprovalCoverLookup } from "./approval-cover.js";
import { standingApprovalLookup } from "./standing-approval.js";
import { ToolBatchExecutor } from "./tool-batch-executor.js";
import { SubGoalLedger } from "./sub-goal-ledger.js";
import type { ToolBatchContext } from "./tool-call-drafts.js";
import { ToolExecutionCoordinator } from "./tool-execution-coordinator.js";
import { loaderOnSurface } from "./tool-loader-surface.js";
import { WorkPlanLedger } from "./work-plan-ledger.js";
import { WorkStateTracker } from "./work-state-tracker.js";

/** What running tools in one operation needs, built once: a resumed call and the loop share it. */
export interface TurnSetup {
  /** The tool surface this turn may use, discovered and policy-filtered once. */
  readonly tools: readonly ToolDefinition[];
  /** What discovery established is missing this turn: sources that did not answer, tools withheld for a permission. */
  readonly unavailable?: UnavailableCapabilities;
  /** The sources that read attached files, and whether each can this turn. */
  readonly attachmentReaders: readonly AttachmentReader[];
  readonly workPlanning: WorkPlanningProvider | undefined;
  readonly workState: WorkStateTracker;
  readonly planLedger: WorkPlanLedger;
  /** This operation's own task chain, computed once so the loop does not read the view again for it. */
  readonly taskTurnIds: readonly string[];
  readonly coordinator: ToolExecutionCoordinator;
  readonly toolBatch: ToolBatchExecutor;
  /** What the results attributed to each plan step show: the batch executor feeds it, a turn's end and its last step read it. */
  readonly subGoals: SubGoalLedger;
  /** Where a call of this turn runs, for a given step. */
  batchContext(stepId: string, stepIndex: number): ToolBatchContext;
}

/**
 * Resolves the turn's tools and builds the executors every call of the operation goes through.
 *
 * A resume used to resolve the tools for the call it resumed and the loop then resolved them again,
 * with a coordinator and an observation set of its own: the resumed call was counted, fingerprinted
 * and reported apart from everything after it. Built once, before a resumed call is dispatched,
 * the same coordinator, observations and journal path serve both.
 */
export async function prepareTurnSetup(turn: ClaimedTurn, dependencies: {
  readonly options: AgentRuntimeOptions;
  readonly toolPolicy: ToolExecutionPolicy;
  readonly toolExecutionBroker?: ToolExecutionBroker;
  readonly toolResultSpool?: ToolResultSpool;
  /** The actor's standing approval, read for each new call the policy would ask about (`AgentRuntimeDependencies.standingApproval`). */
  readonly standingApproval?: StandingApprovalSource;
  /** The composition's tool groups: the loader's result then lists only tools this turn's surface holds. */
  readonly toolGroups?: ToolGroupCatalog;
}): Promise<TurnSetup> {
  const { input, turnId, runtimeLease, signal } = turn;
  const capabilities = runtimeLease.capabilities;
  const mountedTools = capabilities.all(TOOL_CAPABILITY);
  const surface = await resolveContextualToolSurface(capabilities, {
    security: input.security, runtime: runtimeLease.snapshot, sessionId: input.sessionId, turnId,
    ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}),
    ...(input.applicationContext ? { applicationContext: input.applicationContext } : {}),
  }, dependencies.toolPolicy, signal);
  const { unavailable, attachmentReaders } = surface;
  const tools = loaderOnSurface(surface.tools, dependencies.toolGroups);
  const mountedWorkPlanning = capabilities.optional(WORK_PLANNING_CAPABILITY);
  const isPlanningTool = (tool: ToolDefinition) =>
    mountedWorkPlanning !== undefined && tool.id === mountedWorkPlanning.definition.id && tool.version === mountedWorkPlanning.definition.version;
  if (mountedWorkPlanning && !mountedTools.some(isPlanningTool)) {
    throw new AgenticError("validation", `Work-planning provider tool is not mounted: ${mountedWorkPlanning.definition.id}@${mountedWorkPlanning.definition.version}`);
  }
  // Planning exists for this turn only when the policy left its tool in the turn's surface.
  const workPlanning = tools.some(isPlanningTool) ? mountedWorkPlanning : undefined;
  const workState = new WorkStateTracker();
  const events = await turn.view.events();
  const taskTurnIds = taskTurnIdsFor(events, turnId);
  // Restored after the pause closure (a new turn) or the post-claim re-verify (a resume), per
  // §10.5: both already ran by the time this is called, since the loop and each resume's `#resume`
  // build the turn's setup only once they hold the claim and have settled what it answers.
  const subGoals = SubGoalLedger.restore(events, taskTurnIds);
  const planLedger = WorkPlanLedger.restore({
    turnId, isUserTurn: turn.operation === "run-turn", workPlanning, events, taskTurnIds,
    report: (event) => report(input, event), evidence: subGoals,
  });
  turn.terminator.attach(planLedger);
  // An approval the user gave earlier in this task covers a repeat of its call (approval-cover), read from the journal as it stands.
  const approvalCover: ApprovalCoverLookup = async (tool, args, decision) => coveringApproval(await turn.view.events(), taskTurnIds, {
    toolId: tool.id, rows: tool.repeatableRows ?? {}, arguments: args, actionDigest: decision.actionDigest,
    binding: {
      actorId: input.security.actorId, grantRevision: input.security.grantRevision ?? "unspecified", agentProfileId: input.agentProfileId ?? "default",
      runtimeSnapshotId: runtimeLease.snapshot.id, runtimeRouteRevision: runtimeLease.binding.routeRevision, policyRevision: decision.policyRevision,
    },
  }, Date.now());
  // Read live for every such call, not once a turn: a person who turns it off mid-turn is asked at the next write.
  const standingApproval = dependencies.standingApproval
    ? standingApprovalLookup(dependencies.standingApproval, { security: input.security, sessionId: input.sessionId }, signal) : undefined;
  const coordinator = new ToolExecutionCoordinator(tools, dependencies.options, dependencies.toolPolicy, dependencies.toolExecutionBroker,
    undefined, undefined, dependencies.toolResultSpool, (name) => planLedger.isPlanningCall(name), { approvalCover, ...(standingApproval ? { standingApproval } : {}) });
  const toolBatch = new ToolBatchExecutor(coordinator, workState, planLedger, turn.writer, (event) => report(input, event), dependencies.options,
    (call, mark) => observe(turn.telemetry, {
      type: "agent.tool.truncated", tenantId: input.security.tenantId, sessionId: input.sessionId, correlationId: input.security.correlationId,
      turnId, toolId: call.name, path: mark.path, shown: mark.shown, total: mark.total,
      limitChars: tools.find((tool) => tool.id === call.name)?.maxResultChars ?? dependencies.options.maxToolResultChars,
      occurredAt: new Date().toISOString(),
    }), () => turn.noteProgress(), subGoals);
  return Object.freeze({
    tools, ...(unavailable ? { unavailable } : {}), attachmentReaders, workPlanning, workState, planLedger, taskTurnIds, coordinator, toolBatch, subGoals,
    batchContext: (stepId: string, stepIndex: number): ToolBatchContext => ({
      sessionId: input.sessionId, turnId, stepId, stepIndex, security: input.security, runtime: runtimeLease.snapshot,
      runtimeRouteRevision: runtimeLease.binding.routeRevision, ...(unavailable ? { unavailable } : {}),
      ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}),
      ...(input.applicationContext ? { applicationContext: input.applicationContext } : {}),
    }),
  });
}
