import type { CoreEventPayloadMap, EventDraft, LlmAdapter, MemoryQuery, MemoryReader, ResolvedLlmModel, MemoryContext, SecurityContext, SystemPromptProvider, TurnJudge, WorkPlan } from "@0xsyncroot/contracts";
import { skillToolIds, type TurnToolSelection } from "./tool-selection.js";
import { resolveLlmModel } from "./llm-model-context.js";
import type { JudgmentMemo } from "./judgment-memo.js";
import type { JudgmentSeamMode } from "./observation-review.js";
import { SkillFit, skippedSkills, suggestedSkills, type SuggestedSkill } from "./skill-relevance.js";
import { createSkillFitFallback } from "./skill-fit-fallback.js";
import type { TurnEventWriter } from "./turn-event-writer.js";

export interface OpenWaitsInput {
  readonly llm: LlmAdapter;
  readonly memory: MemoryReader | undefined;
  /** Undefined when the turn selects no memory context. */
  readonly memoryQuery: MemoryQuery | undefined;
  readonly judge: TurnJudge | undefined;
  readonly skillSeam: JudgmentSeamMode | undefined;
  readonly prompts: readonly SystemPromptProvider[];
  readonly request: string;
  readonly loader: SystemPromptProvider["skillLoader"];
  readonly loadedSkills: ReadonlySet<string>;
  readonly memo: { readonly verdicts: JudgmentMemo; readonly scope: string };
  readonly offeredToolIds: ReadonlySet<string>;
  /** The turn's tool selection, when the composition declares tool groups: judged beside the skills, settled once they are. */
  readonly tools?: TurnToolSelection;
  /** The task's plan as the turn opens: what the tool-relevance judge reads beside the request. */
  readonly plan?: WorkPlan;
  readonly security: SecurityContext;
  readonly signal: AbortSignal;
  /** Where a skill-fit answer the chat model gives in the judge's place is journaled. */
  readonly writer: TurnEventWriter;
  readonly turnId: string;
  /** How long the memory search is waited for (`AgentOptions.memoryContextTimeoutMs`). */
  readonly memoryTimeoutMs: number;
  /** How long the advisory skill and tool-group judgments are waited for (`AgentOptions.advisorySetupBudgetMs`). */
  readonly advisoryBudgetMs: number;
  /** The model the skill-fit fallback asks; undefined means the chat model. */
  readonly fallbackModel?: string;
}

export interface OpenWaits {
  readonly skipped: ReadonlySet<string>;
  readonly suggested: readonly SuggestedSkill[];
  /** The tools the turn offers the model, which the system text was rendered for. */
  readonly offeredToolIds: ReadonlySet<string>;
  readonly systemText: string;
  readonly memoryContext: MemoryContext | undefined;
  /** The one memory row this open journals: the records selected, or why there is no memory context; undefined when no search ran. */
  readonly memoryDraft: EventDraft | undefined;
  readonly route: ResolvedLlmModel;
}

/**
 * The three waits a turn's open does that do not depend on one another, run together: the skill and tool-group judgments and the system
 * prompt they shape, the memory search, and the model route. Each took its turn one after another, so the open cost their sum;
 * on a gateway that queues the judgments alone are seconds.
 *
 * Every branch settles before a failure leaves; the error thrown is the first in the order the waits had when they ran serially
 * (skills, memory, route). The advisory judgments (skill and tool relevance) are waited for only up to the setup budget
 * (`withinBudget`): one still open then is left to finish on its own, and the turn is offered everything it would trim. Memory is advisory context:
 * its search is not awaited to settle but raced with a bound and the turn's signal (`recallMemory`), so a store that rejects or
 * hangs costs the turn its memory and nothing else; only the turn's own abort leaves from that branch. The journal appends that
 * follow stay with the caller, in their old order.
 */
export async function openWaits(input: OpenWaitsInput): Promise<OpenWaits> {
  const { judge, skillSeam, prompts, request, memo, signal } = input;
  const [skillOutcome, memoryOutcome, routeOutcome] = await Promise.allSettled([
    (async () => {
      // One set of skill-fit answers for both skill seams: each skill is asked once, whichever reads it first.
      const fit = judge ? new SkillFit(judge, prompts, request, signal, memo) : undefined;
      const [skipped, suggested] = await Promise.all([
        withinBudget(skippedSkills(judge, skillSeam, prompts, request, signal, memo, fit), new Set<string>(), input.advisoryBudgetMs),
        input.loader ? suggestedSkills(judge, skillSeam, prompts, request, input.loadedSkills, signal, memo, createSkillFitFallback(input.llm, input.writer, input.turnId, input.fallbackModel), fit) : Promise.resolve([]),
        // Past the budget the selection settles with no verdicts: every group is offered.
        input.tools && judge ? withinBudget(input.tools.judge(judge, request, input.plan, signal, memo), undefined, input.advisoryBudgetMs) : undefined,
      ]);
      // Groups after skills: a skill the turn keeps pins the groups of the tools it requires, whatever the judge said of them.
      input.tools?.settle(skillToolIds(prompts, { ...(skipped.size ? { skippedSkills: skipped } : {}), loadedSkills: input.loadedSkills }));
      const offeredToolIds = input.tools?.offeredToolIds ?? input.offeredToolIds;
      const systemText = (await Promise.all(prompts.map((prompt) => prompt.render(input.security, { ...(skipped.size ? { skippedSkills: skipped } : {}), offeredToolIds }))))
        .filter(Boolean).join("\n\n");
      return { skipped, suggested, offeredToolIds, systemText };
    })(),
    input.memory && input.memoryQuery ? recallMemory(input.memory, input.memoryQuery, input.security, signal, input.memoryTimeoutMs) : Promise.resolve(undefined),
    resolveLlmModel(input.llm, signal),
  ]);
  if (skillOutcome.status === "rejected") throw skillOutcome.reason;
  if (memoryOutcome.status === "rejected") throw memoryOutcome.reason;
  if (routeOutcome.status === "rejected") throw routeOutcome.reason;
  const recall = memoryOutcome.value;
  return {
    ...skillOutcome.value, memoryContext: recall && "context" in recall ? recall.context : undefined,
    memoryDraft: recall ? memoryDraft(input.turnId, recall) : undefined, route: routeOutcome.value,
  };
}

/**
 * An advisory judgment waited for at most `budgetMs`, then `unjudged`: the result of having no verdict, which offers the turn
 * everything. A judgment that fails before the budget (the turn's abort) fails the wait. One abandoned at the budget runs on
 * to its own deadline, journals its row and keeps its verdict in the memo for a resume; its later rejection lands on the race,
 * which has settled, so it is never an unhandled one.
 */
export async function withinBudget<T>(judging: Promise<T>, unjudged: T, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([judging, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(unjudged), budgetMs); })]);
  } finally {
    clearTimeout(timer);
  }
}

export type MemoryRecall = { readonly context: MemoryContext } | { readonly unavailable: CoreEventPayloadMap["memory/context-unavailable"] };

class MemorySearchTimeout extends Error {
  constructor(readonly boundMs: number) { super(`Memory search exceeded ${boundMs} ms`); }
}

/**
 * Asks the store once and waits for its answer, the bound or the turn's abort, whichever comes first. A rejection or the
 * bound is "no memory" with the cause kept for the journal; the abort is rethrown as it is. The timer and the listener
 * are gone when it returns, and a search that fails after it was given up on is already handled by the race.
 */
export async function recallMemory(memory: MemoryReader, query: MemoryQuery, security: SecurityContext, signal: AbortSignal, boundMs: number): Promise<MemoryRecall> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const stopped = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new MemorySearchTimeout(boundMs)), boundMs);
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return { context: await Promise.race([memory.search(query, security), stopped]) };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return { unavailable: unavailableMemory(error) };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function unavailableMemory(error: unknown): CoreEventPayloadMap["memory/context-unavailable"] {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return {
    reason: error instanceof MemorySearchTimeout ? "timeout" : "error",
    ...(typeof code === "string" ? { code: code.slice(0, 64) } : {}),
    message: errorText(error).slice(0, 300),
  };
}

function errorText(error: unknown): string {
  try { return String(error instanceof Error ? error.message : error); } catch { return ""; }
}

function memoryDraft(turnId: string, recall: MemoryRecall): EventDraft {
  if ("unavailable" in recall) return { type: "memory/context-unavailable", turnId, payload: recall.unavailable };
  return { type: "memory/context-selected", turnId, payload: {
    records: recall.context.records.map((record) => ({ id: record.id, revision: record.revision })),
    contextHash: recall.context.contextHash,
  } };
}
