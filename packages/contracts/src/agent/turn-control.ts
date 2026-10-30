import type { LlmResponseStatus, LlmToolChoice } from "../llm/llm.js";
import type { RuntimeSnapshot } from "../runtime/runtime-snapshot.js";
import type { SecurityContext } from "../security/security-context.js";
import type { JsonValue } from "../shared/json.js";
import type { TurnControlServices } from "../judgment/judgment.js";
import type { SessionContextView } from "../sessions/context-compaction.js";
import type { TurnApplicationContext } from "./agent.js";
import type { WorkPlan } from "../work/work-plan.js";
import type { SkillSummary } from "../skills/skill-fit.js";

export interface TurnControlTool {
  readonly id: string;
  readonly version: string;
  readonly sideEffect: "none" | "idempotent" | "nonIdempotent";
  /** The tool declares its result computed by code (ToolDefinition.computes). */
  readonly computes?: boolean;
}

/**
 * Capabilities the runtime knows are missing this turn, from configuration and policy facts — never
 * from the model's prose. A blocker an answer names among these is proven without retrying it.
 */
export interface UnavailableCapabilities {
  /** Configured tool sources whose catalogue could not be had this turn: their tools do not exist for it. */
  readonly sources: readonly { readonly sourceId: string; readonly readsAttachments: boolean }[];
  /** Tools the permission policy kept from this principal, each with the permissions it lacks. */
  readonly withheldTools: readonly { readonly toolId: string; readonly missingPermissions: readonly string[] }[];
  /**
   * Files the task is about cannot be read this turn (`taskAttachmentIds`: attached by the task, or an
   * earlier request's file a call of the task named): every source that reads attachments is down
   * (`source-unavailable`) or kept from this principal (`withheld`), and one of those files was never
   * read by one. Absent when they can be read, were read, the task is about none, or no source declares
   * it reads them.
   */
  readonly attachments?: CapabilityUnavailableReason;
  /**
   * Every file the conversation holds that no reader has read, while no reader can read this turn — whichever request
   * attached it, the task's own included. A file an earlier request attached is no blocker of this task by itself
   * (`attachments` says the task's); a policy that ties an answer to one of these does so by a judgment of its own. Names
   * are user-supplied text: data, never instructions.
   */
  readonly unreadFiles?: readonly { readonly id: string; readonly name: string }[];
}

/**
 * Why a call could not run because the capability itself is missing this turn. Carried on the
 * refused call's `tool/result` payload as `unavailable`, beside `state: "not_started"`: final for the
 * turn, not something the agent fixes by calling again.
 */
export type CapabilityUnavailableReason = "withheld" | "source-unavailable";

/*
 * `notFound: true` in a tool's own result, on a call that succeeded (beside `searched`, what it searched for): the source was
 * searched and holds nothing above its threshold for this request. Unlike `unavailable` it is no refusal: an answer that says
 * nothing there answers the request, after such a search, has done the task. A policy reads it as a fact of the journal,
 * never from the answer's prose.
 */

export interface TurnControlState {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepIndex: number;
  readonly maxSteps: number;
  readonly security: SecurityContext;
  readonly runtime: RuntimeSnapshot;
  readonly agentProfileId?: string;
  readonly applicationContext?: TurnApplicationContext;
  /** Raw bounded journal evidence; model compaction must not erase facts a policy checks. */
  readonly context: SessionContextView;
  readonly availableTools: readonly TurnControlTool[];
  /** The skills the agent has this turn, preloaded or loadable: what a check weighs a request against when it asks which procedure the request calls for. */
  readonly availableSkills?: readonly SkillSummary[];
  readonly workPlan?: WorkPlan;
  /**
   * Present iff the step under review ran with tools disabled because it is the final one: the model
   * could not act on feedback. `reason` is the runtime stop cause (the one the step's own final
   * instruction states), e.g. tool-call-limit, step-limit, time-limit, progress-stalled.
   */
  readonly finalStep?: { readonly reason: string };
  /**
   * The task this step belongs to: the current turn plus the turns it continues (approval and
   * question resumes), within the journal view. Evidence scoped to these turns is the task's;
   * anything older belongs to an earlier request.
   */
  readonly taskTurnIds: readonly string[];
  /** What the runtime knows is missing this turn (`UnavailableCapabilities`); absent when nothing is. */
  readonly unavailable?: UnavailableCapabilities;
}

/**
 * A read the policy performs itself, before the model step, instead of asking the model to.
 *
 * Only a side-effect-free tool the session already carries qualifies. The call is journaled as
 * a tool intent the policy initiated, runs under the same tool policy as any other call, and
 * its result reaches the model as evidence in its context — so a read the product requires
 * after a write no longer depends on the model choosing to make it.
 */
export interface TurnObservationRequest {
  readonly toolId: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  /** Why the runtime reads on the model's behalf; journaled with the intent. */
  readonly reason: string;
  /**
   * The read is a convenience, not a promise: if it would need approval, fails, or runs past `timeoutMs`, nothing of it reaches the
   * model and the turn goes on as if it had not been asked (the journal keeps a structured skip reason). Without this, a read that
   * needs approval fails the turn, and a failed one is shown to the model as a failed result.
   */
  readonly bestEffort?: BestEffortRead;
}

/** The bound of a best-effort read: its own timeout, never above the tool's. */
export interface BestEffortRead {
  readonly timeoutMs: number;
}

export interface TurnModelDirective {
  /** Trusted evidence proves work cannot proceed; close partial without asking the model to loop. */
  readonly stop?: { readonly reason: string; readonly content: string };
  /** Omitted means every already-discovered tool remains available. This is selection, never authorization. */
  readonly allowedToolIds?: readonly string[];
  readonly toolChoice?: LlmToolChoice;
  /** Reads to perform before this model step, on the policy's authority. */
  readonly observations?: readonly TurnObservationRequest[];
}

export interface TurnTerminalCandidate {
  readonly content: string | null;
  readonly finishReason: string;
  readonly status?: LlmResponseStatus;
}

export interface TurnToolCallCandidate {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export type TurnTerminalDecision =
  | {
    readonly decision: "accept"; readonly reason?: string;
    /** Evidence can establish that an accepted report describes unfinished work. */
    readonly outcome?: "completed" | "partial";
    /**
     * A fact the evidence establishes and the answer must carry, in the product's words: the runtime
     * adds it after the accepted answer, streamed and journaled with it. For what a policy can know
     * from structured evidence — never a judgement about what the model's prose says.
     */
    readonly notice?: string;
  }
  | {
    readonly decision: "continue"; readonly feedback: string; readonly fallback?: string;
    /**
     * The work the user asked for is not finished and the agent can still act on it — a harness's
     * "do not stop yet", not "this answer is wrong". The model is told what is open and decides
     * itself what the work needs; it is never forced to call a tool. Core never hands `fallback` to
     * the model as guidance (a way out a model takes), counts the objections in a row that brought
     * no new evidence (a successful call with new information, the runtime's own reads included),
     * and at three — or when no step is left — ends the turn itself: on a terminal answer, that answer
     * accepted as `partial` with `fallback` as its notice; on refused calls, `fallback` as the answer.
     */
    readonly workRemains?: boolean;
    /**
     * What the objection disputes, as the runtime holds it: `disputed` are the values the policy's audit found contradicted
     * by the evidence (at most 8, each at most 300 characters), never phrases about kinds of objection. Core uses them only
     * to tell whether the next answer still states them (`AnswerMovedCheck`); the model reads `feedback` alone.
     */
    readonly objection?: { readonly disputed: readonly string[] };
    /**
     * The policy's judge read the objected answer as delivering a result, and what the objection asks is beyond it (a
     * figure, a criterion of the procedure): not a progress note, a stall or work handed back. With it, a "work remains"
     * answer that cannot move any more stands as `partial` with `fallback` as its notice; without it the runtime writes the
     * last answer on a closing step. A fact the policy's own judgment established, never a reading of the prose by core.
     */
    readonly delivered?: true;
  };

/**
 * Why the runtime has to end a turn on a sentence of its own instead of the model's answer.
 * `choice-violation`: the model kept ignoring the tool directive until no step was left.
 */
export type TurnFallbackTextInput = {
  readonly kind: "choice-violation";
  /** A write was dispatched in this turn, so the sentence must not claim that nothing changed. */
  readonly writesDispatched: boolean;
} | {
  /** A step failed twice and the closing step could not run: the turn ends unfinished, with what the plan shows. */
  readonly kind: "step-failure";
  readonly writesDispatched: boolean;
  readonly completedSteps: readonly string[];
  readonly remainingSteps: readonly string[];
} | {
  /**
   * The turn went silent past its time limit (no step and no tool call) and ends unfinished, with what the plan shows.
   * A call open at that moment may still land after the turn has ended.
   */
  readonly kind: "time-limit";
  readonly writesDispatched: boolean;
  readonly completedSteps: readonly string[];
  readonly remainingSteps: readonly string[];
};

/**
 * Trusted composition policy for neutral model-step control. Implementations may select only
 * tools already exposed by core and cannot authorize execution or bypass approval policy.
 */
export interface TurnControlPolicy {
  readonly id: string;
  readonly revision: string;
  /**
   * Text the user already watched stream in stays on screen when this policy sends the step back:
   * it becomes narration (journaled, folded into the turn's account) instead of being retracted.
   * For policies whose objections mean "the work is not finished", not "the answer is wrong".
   * Applies to every send-back of the policy, the turn-control fallback included.
   */
  readonly keepDraftsAsNarration?: boolean;
  beforeModelStep(input: TurnControlState, signal: AbortSignal, services?: TurnControlServices): Promise<TurnModelDirective>;
  /** Optional trusted validation before any model-proposed tool call is dispatched. */
  reviewToolCalls?(
    input: TurnControlState & { readonly directive: TurnModelDirective; readonly toolCalls: readonly TurnToolCallCandidate[] },
    signal: AbortSignal,
    services?: TurnControlServices,
  ): Promise<TurnTerminalDecision>;
  reviewTerminal(
    input: TurnControlState & { readonly directive: TurnModelDirective; readonly candidate: TurnTerminalCandidate },
    signal: AbortSignal,
    services?: TurnControlServices,
  ): Promise<TurnTerminalDecision>;
  /**
   * The product's sentence for a turn the runtime ends on its own authority. Core writes no
   * user-facing copy: without this, such a turn ends with empty content and outcome `partial`.
   */
  fallbackText?(input: TurnFallbackTextInput): string;
}
