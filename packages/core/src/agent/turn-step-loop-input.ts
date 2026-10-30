import type {
  TurnControlServices,
  ChatMessage,
  FormInteractionRequest,
  LlmAdapter,
  LlmUsage,
  ResolvedLlmModel,
  ToolDefinition,
  TurnControlPolicy,
  TurnControlState,
  TurnControlTool,
  SkillSummary,
  TurnModelDirective,
  UnavailableCapabilities,
  SessionEvent,
} from "@0xsyncroot/contracts";
import type { ContextCalibration } from "./context-calibration.js";
import type { AgentOutputChannel } from "./agent-output-channel.js";
import type { ResultReviewer } from "./observation-review.js";
import type { StepClaimReview } from "./step-claim-review.js";
import type { AnswerMovedCheck } from "./answer-moved.js";
import type { AgentReasoningChannel } from "./agent-reasoning-channel.js";
import type { ClaimedTurn } from "./claimed-turn.js";
import type { ModelContextPreparer } from "./model-context-preparer.js";
import type { NarrationChain } from "./narration-chain.js";
import type { StepRecord, TurnEndBounds, TurnLedger, TurnNext } from "./turn-end-facts.js";
import type { TurnSetup } from "./turn-setup.js";
import type { GroupLoad } from "./tool-selection.js";
import type { RuntimeCalls } from "./runtime-calls.js";

export interface TurnStepLoopInput {
  readonly turn: ClaimedTurn;
  readonly setup: TurnSetup;
  readonly startStepIndex?: number;
  readonly skipMemoryContext?: boolean;
}

/** What the loop keeps across the model steps of one turn. */
export interface TurnLoop {
  readonly turn: ClaimedTurn;
  readonly setup: TurnSetup;
  readonly llm: LlmAdapter;
  /** Re-resolved after a provider refusal, so learned bounds apply throughout this turn. */
  route: ResolvedLlmModel;
  /** The characters a token of this route really is, learned from the provider's counts and kept across turns. */
  readonly calibration: ContextCalibration;
  readonly controlPolicy: TurnControlPolicy | undefined;
  readonly controlTools: readonly TurnControlTool[];
  /**
   * What a step may offer the model before its policy narrows it: the turn's tool selection and the groups loaded since
   * (`stepToolOffer`), or the whole surface. Policies still read the whole surface (`controlTools`).
   */
  readonly offerTools: (stepId: string) => Promise<readonly ToolDefinition[]>;
  /** For a call to a tool of a group the turn left out: the loader call that offers it, said in the refusal. */
  readonly groupLoad?: (toolId: string) => GroupLoad | undefined;
  /** The skills the agent has this turn, as turn-control checks weigh a request against them. */
  readonly controlSkills: readonly SkillSummary[];
  /** What the policy is lent on every call: the turn's journaled judge, when a judgment provider is mounted. */
  readonly services: TurnControlServices;
  /** The observation review every model-initiated result passes through, when that seam is on or in shadow. */
  readonly reviewResult: ResultReviewer | undefined;
  readonly stepClaims: StepClaimReview | undefined;
  /** The judged "same answer" beside the work-remains gate's content hash, when that seam is on or in shadow. */
  readonly answerMoved: AnswerMovedCheck | undefined;
  readonly contextPreparer: ModelContextPreparer;
  /** The composition's step bounds, as `decide()` applies them. */
  readonly bounds: TurnEndBounds;
  /** What the turn has spent; each `decide()` replaces it. */
  ledger: TurnLedger;
  /** What the last `decide()` said follows; the next step starts from it. */
  next: TurnNext;
  /** What the step under way did before its outcome, until its `decide()`; a step failing part-way is decided on it. */
  step: StepRecord | undefined;
  /** What the turn lacks (`TurnControlState.unavailable`): discovery's facts, and the task's files when none can be read. */
  readonly unavailable: UnavailableCapabilities | undefined;
  /** The closing lines of the skills in effect for a step, from the journal as it stands (`skillClosingLines`). */
  readonly skillClosings: (events: readonly SessionEvent[]) => readonly string[];
  /** The task this turn belongs to; fixed for the operation, since its chain was written before it began. */
  readonly taskTurnIds: readonly string[];
  /** Objections and instructions for the next step, which the journal does not carry. */
  readonly controlFeedback: ChatMessage[];
  /** Calls the runtime makes in the model's place before a step: the judged skill, and the reads tools named (`RuntimeCalls`). */
  readonly runtimeCalls: RuntimeCalls;
  /** How many of `controlFeedback` were raised before the model's latest tool step; the rest it has not acted on yet. */
  answeredFeedback: number;
  readonly reasoningDraft: AgentReasoningChannel;
  usage: Required<LlmUsage>;
  /** Text the model wrote beside a tool call, which the user never saw; a forced answer quotes it back. */
  withheldText: string | null;
  /**
   * Every text the model wrote beside its tool calls in this turn, oldest first. The final step's
   * instruction carries them as reminders. They do not replace tool observations as evidence.
   */
  readonly workNotes: string[];
  /** Whether a model-initiated, non-planning call has been dispatched yet — narration condition (b). */
  modelDispatchedWork: boolean;
  /** The plan announcement's own text, once narrated, so later planning text is not announced again. */
  narratedText: string | undefined;
  /** The last draft a policy that keeps drafts left on screen as narration; the same text again is not narrated twice. */
  keptDraft: string | undefined;
  /** The latest work narration and whether a step made progress since it: what a step without progress supersedes. */
  readonly narrationChain: NarrationChain;
  /** What the work-remains gate found still open when it closed the work: the closing step's instruction says it. */
  closing: { readonly remaining: string; readonly noticeFollows: boolean } | undefined;
  /** The product's question whether to go on, asked when `decide()` ends the turn partial with work left; none without its wording. */
  readonly continueQuestion: FormInteractionRequest | undefined;
}

/** One model step, from the moment its output arrives until it is disposed of. */
export interface StepFrame {
  readonly stepId: string;
  readonly stepIndex: number;
  readonly finalBudgetStep: boolean;
  readonly stopReason?: string;
  readonly directive: TurnModelDirective;
  readonly modelTools: readonly ToolDefinition[];
  /** The policy's state as its reviews judge this step: including the reads it made before it. */
  readonly reviewState: TurnControlState;
  readonly messages: ChatMessage[];
  readonly answerDraft: AgentOutputChannel;
}
