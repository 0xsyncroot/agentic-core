import { randomUUID } from "node:crypto";
import { AgenticError, type ChatMessage, type JudgmentAnswer, type ToolCall, type ToolDefinition, type TurnControlState, type TurnJudge } from "@0xsyncroot/contracts";
import { NEXT_CALL_INITIATOR, NEXT_CALL_SEAM, nextCallCandidates } from "./next-call.js";
import { nextCallClears, nextCallRuns, nextCallThreshold, type NextCallAsk } from "./next-call-questions.js";
import type { JudgmentSeamMode } from "./observation-review.js";
import type { PolicyReads } from "./turn-observations.js";
import type { TurnLoop } from "./turn-step-loop-input.js";

/** Who the journal says loaded a skill the request matches: the runtime, on the skill-suggestion judgment (`tool/intent.policyId`). */
export const SUGGESTED_SKILL_INITIATOR = "runtime:skill-suggestion";

/** A skill the judge alone named for this request, and the note the model reads instead when the runtime cannot load it. */
export interface RuntimeSkillLoad {
  readonly toolId: string;
  readonly argument: string;
  readonly skill: { readonly id: string; readonly name: string };
  readonly note: ChatMessage;
}

/**
 * Calls the runtime makes in the model's place before a model step, when facts already decide them: the skill the judge
 * found the request asks for (the step that would only load it is skipped), and a read a tool named from its own result that
 * every one of the judge's questions about it clears (`next-call`). Each runs through the batch as a best-effort read under
 * the runtime's own initiator: the tool policy applies, and a call that would wait for approval or input, fails or runs out
 * of time is skipped, never shown, and never pauses the turn. Nothing here writes: only tools that change nothing are called.
 */
export class RuntimeCalls {
  #skillLoad: RuntimeSkillLoad | undefined;

  constructor(private readonly input: {
    readonly judge: TurnJudge | undefined;
    readonly nextCall: JudgmentSeamMode | undefined;
    /** The composition's other places the data lives, which the judge weighs against the attached files (`nextCallSources`). */
    readonly sources: Readonly<Record<string, string>> | undefined;
    readonly skillLoad?: RuntimeSkillLoad;
    /** Tools never called in the model's place (loaders, planning). */
    readonly excluded: (toolId: string) => boolean;
  }) {
    this.#skillLoad = input.skillLoad;
  }

  /** The first step loads the judged skill; a load that did not succeed leaves the model the note naming it, as before. */
  async loadSkill(loop: TurnLoop, stepId: string, stepIndex: number): Promise<void> {
    const load = this.#skillLoad;
    this.#skillLoad = undefined;
    if (!load) return;
    const definition = loop.setup.tools.find((tool) => tool.id === load.toolId);
    const call: ToolCall = { id: `runtime-skill-${randomUUID()}`, name: load.toolId, arguments: JSON.stringify({ [load.argument]: load.skill.id }) };
    if (definition) await this.#run(loop, stepId, stepIndex, call, definition, `the request matches the skill "${load.skill.name}"`, SUGGESTED_SKILL_INITIATOR, `runtime-skill:${stepId}`);
    const loaded = (await loop.turn.view.events()).some((event) => event.type === "tool/result" && event.callId === call.id &&
      (event.payload as Record<string, unknown>).state === "succeeded" && (event.payload as Record<string, unknown>).skipped === undefined);
    if (!loaded) loop.controlFeedback.push(load.note);
  }

  /**
   * The reads tools named in the previous step (`nextCallCandidates`). Each candidate's questions are asked in parallel, one
   * judge call and one `judgment/classified` row each (`item`: the question id, then the call); in `on` a read every answer
   * clears is made now (`nextCallRuns`), and its result reaches the model with the rest. Shadow asks and journals, and runs
   * nothing. A new result among them is the runtime's evidence, as a policy's read is.
   */
  async followUp(loop: TurnLoop, stepId: string, stepIndex: number, offered: readonly ToolDefinition[], state: TurnControlState): Promise<PolicyReads> {
    const { judge, nextCall: mode } = this.input;
    if (!judge || !mode || mode === "off") return { state, progressed: false };
    const { turnId, view, signal } = loop.turn;
    const candidates = nextCallCandidates(await view.events(), {
      turnId, stepId, sources: this.input.sources ?? {}, offered, excluded: (toolId) => this.input.excluded(toolId) || loop.setup.planLedger.isPlanningCall(toolId),
    });
    let progressed = false;
    for (const [index, candidate] of candidates.entries()) {
      const item = `${candidate.call.toolId} ${JSON.stringify(candidate.call.arguments)}`;
      const ask = async (question: NextCallAsk): Promise<JudgmentAnswer | undefined> => (await judge(NEXT_CALL_SEAM,
        { state: question.state, questions: { [question.id]: question.question } }, signal, {
          verdict: (answers) => {
            const clears = nextCallClears(question, answers[question.id]);
            return clears === undefined ? undefined
              : { label: clears ? "run" : "skip", threshold: nextCallThreshold(question), mode, sameHash: false, item: `${question.id} ${item}`.slice(0, 300) };
          },
        }))?.answers[question.id];
      const answers = await Promise.all(candidate.asks.map(ask));
      if (mode !== "on" || !nextCallRuns(candidate.asks, answers)) continue;
      const call: ToolCall = { id: `next-call-${randomUUID()}`, name: candidate.call.toolId, arguments: JSON.stringify(candidate.call.arguments) };
      progressed = await this.#run(loop, stepId, stepIndex, call, candidate.definition, candidate.call.why, NEXT_CALL_INITIATOR, `next-call:${stepId}:${index}`, offered) || progressed;
    }
    return progressed || candidates.length ? { state: Object.freeze({ ...state, context: await view.evidence() }), progressed } : { state, progressed };
  }

  async #run(loop: TurnLoop, stepId: string, stepIndex: number, call: ToolCall, definition: ToolDefinition, reason: string, policyId: string,
    key: string, offered?: readonly ToolDefinition[]): Promise<boolean> {
    const { turn } = loop;
    const { input } = turn;
    const batch = await loop.setup.toolBatch.execute([call], {
      sessionId: input.sessionId, turnId: turn.turnId, stepId, stepIndex, security: input.security,
      runtime: turn.runtimeLease.snapshot, runtimeRouteRevision: turn.runtimeLease.binding.routeRevision,
      ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}),
      ...(input.applicationContext ? { applicationContext: input.applicationContext } : {}),
      ...(offered ? { selectedToolIds: new Set(offered.map((tool) => tool.id)) } : {}),
      bestEffort: { timeoutMs: definition.timeoutMs }, initiator: { policyId, reason },
    }, [], turn.signal, key);
    // A best-effort call never pauses: one that would is skipped by the batch. Anything else breaks that promise.
    if (batch.kind !== "completed") throw new AgenticError("validation", `A runtime call cannot pause the turn: ${batch.kind}`);
    return batch.progressed;
  }
}
